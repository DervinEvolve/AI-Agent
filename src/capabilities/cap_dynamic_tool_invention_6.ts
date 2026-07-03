import { executeCode } from "./cap_code_execution_1";

export interface SafetyProfile {
  requires_network?: boolean;
  restricted_paths?: string[];
  execution_timeout_s?: number;
}

export interface DynamicToolInventionInputs {
  proposed_tool_name: string;
  functional_description: string;
  source_code: string;
  input_schema: Record<string, any>;
  output_schema: Record<string, any>;
  safety_profile?: SafetyProfile;
}

export interface ConformanceResults {
  syntax_valid: boolean;
  static_analysis_passed: boolean;
  isolated_test_run_passed: boolean;
  policy_compliance_passed: boolean;
}

export interface DynamicToolInventionOutputs {
  registration_status: "registered" | "rejected" | "validation_failed";
  validation_errors: string[];
  conformance_results: ConformanceResults;
  registered_tool_metadata: {
    tool_name: string;
    functional_description: string;
    input_schema: Record<string, any>;
    output_schema: Record<string, any>;
    safety_profile: SafetyProfile;
  } | null;
}

// Session-based registry to prevent cross-session pollution
export class DynamicToolRegistry {
  private static instances = new Map<string, DynamicToolRegistry>();
  private tools = new Map<string, {
    source_code: string;
    functional_description: string;
    input_schema: Record<string, any>;
    output_schema: Record<string, any>;
    safety_profile: SafetyProfile;
  }>();

  public static getSessionRegistry(sessionId: string): DynamicToolRegistry {
    if (!this.instances.has(sessionId)) {
      this.instances.set(sessionId, new DynamicToolRegistry());
    }
    return this.instances.get(sessionId)!;
  }

  public static clearSession(sessionId: string): void {
    this.instances.delete(sessionId);
  }

  public register(name: string, tool: any): void {
    this.tools.set(name, tool);
  }

  public getTool(name: string) {
    return this.tools.get(name);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public listTools() {
    return Array.from(this.tools.keys());
  }
}

/**
 * Static analysis of Python code using simple pattern analysis mimicking AST verification.
 * Blocks dangerous operations (exec, eval, getattr, __dict__, __subclasses__, forbidden imports).
 */
export function staticAnalyzePython(code: string, safetyProfile?: SafetyProfile): string[] {
  const errors: string[] = [];

  // Check for forbidden functions/keywords
  const forbiddenPatterns = [
    /\bexec\b/,
    /\beval\b/,
    /\bgetattr\b/,
    /\bsetattr\b/,
    /\b__import__\b/,
    /\b__dict__\b/,
    /\b__subclasses__\b/,
    /\b__class__\b/,
    /\b__globals__\b/,
    /\bctypes\b/,
    /\bsubprocess\b/,
    /\bos\b/,
    /\bsys\b/,
    /\bcompile\b/,
    /\bshutil\b/,
    /\bbuiltins\b/
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(code)) {
      errors.push(`Forbidden pattern or keyword detected matching: ${pattern.toString()}`);
    }
  }

  // Forbidden imports
  const forbiddenImports = [
    "socket",
    "urllib",
    "requests",
    "httpx",
    "ftplib",
    "smtplib",
    "subprocess",
    "ctypes",
    "os",
    "sys"
  ];

  for (const imp of forbiddenImports) {
    const importRegex = new RegExp(`\\b(import|from)\\s+${imp}\\b`);
    if (importRegex.test(code)) {
      // Exception: network libraries allowed if safety_profile explicitly allows network
      if (["urllib", "requests", "httpx", "socket"].includes(imp) && safetyProfile?.requires_network) {
        continue;
      }
      errors.push(`Forbidden import detected: ${imp}`);
    }
  } 

  return errors;
}

/**
 * Validates the tool name requirements.
 */
export function validateToolName(name: string): string[] {
  const errors: string[] = [];
  if (!name.startsWith("custom_")) {
    errors.push("Tool name must be prefixed with 'custom_'");
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    errors.push("Tool name must be in snake_case (lowercase, numbers, and underscores only)");
  }
  return errors;
}

/**
 * Main dynamic tool registration and invention pipeline.
 */
export async function registerCustomTool(
  sessionId: string,
  inputs: DynamicToolInventionInputs
): Promise<DynamicToolInventionOutputs> {
  const errors: string[] = [];
  const conformance: ConformanceResults = {
    syntax_valid: false,
    static_analysis_passed: false,
    isolated_test_run_passed: false,
    policy_compliance_passed: false
  };

  const { proposed_tool_name, functional_description, source_code, input_schema, output_schema } = inputs;
  const safety = inputs.safety_profile || { requires_network: false, execution_timeout_s: 10 };

  // Step 1: Validate name
  const nameErrors = validateToolName(proposed_tool_name);
  if (nameErrors.length > 0) {
    errors.push(...nameErrors);
    return {
      registration_status: "validation_failed",
      validation_errors: errors,
      conformance_results: conformance,
      registered_tool_metadata: null
    };
  }

  // Step 2: Syntax Validation (can it be parsed/compiled structurally?)
  // We use the sandboxed execution environment to run a syntax check.
  try {
    const checkResult = await executeCode(
      `compile(${JSON.stringify(source_code)}, '<string>', 'exec')`,
      "python"
    );
    if (checkResult.error) {
      errors.push(`Syntax error or compilation failure: ${checkResult.error}`);
      conformance.syntax_valid = false;
    } else {
      conformance.syntax_valid = true;
    }
  } catch (err: any) {
    errors.push(`Syntax verification failed to execute: ${err.message}`);
    conformance.syntax_valid = false;
  }

  // Step 3: Static Analysis (AST Evasion / Forbidden Imports / Builtins)
  const staticErrors = staticAnalyzePython(source_code, safety);
  if (staticErrors.length > 0) {
    errors.push(...staticErrors);
    conformance.static_analysis_passed = false;
  } else {
    conformance.static_analysis_passed = true;
  }

  // Step 4: Policy Compliance (No forbidden pathways, matching schemas)
  if (!functional_description || functional_description.trim().length < 10) {
    errors.push("Functional description must be clear and at least 10 characters long");
  }
  if (!input_schema || typeof input_schema !== "object") {
    errors.push("Input schema must be a valid JSON schema object");
  }
  if (!output_schema || typeof output_schema !== "object") {
    errors.push("Output schema must be a valid JSON schema object");
  }

  if (errors.length === 0) {
    conformance.policy_compliance_passed = true;
  } else {
    conformance.policy_compliance_passed = false;
  }

  // Step 5: Isolated Conformance Sandbox Executions
  if (conformance.syntax_valid && conformance.static_analysis_passed) {
    try {
      // Generate a mock test run by constructing minimal parameters matching input_schema
      const mockInputs: Record<string, any> = {};
      if (input_schema.properties) {
        for (const [key, prop] of Object.entries<any>(input_schema.properties)) {
          if (prop.type === "string") mockInputs[key] = "test_val";
          else if (prop.type === "number" || prop.type === "integer") mockInputs[key] = 42;
          else if (prop.type === "boolean") mockInputs[key] = true;
          else if (prop.type === "array") mockInputs[key] = [];
          else if (prop.type === "object") mockInputs[key] = {};
        }
      }

      // Construct test execution script
      const testWrapper = `
${source_code}

import json
# Execute target entrypoint
result = ${proposed_tool_name}(**${JSON.stringify(mockInputs)})
print(json.dumps({"result": result}))
`;

      const testResult = await executeCode(testWrapper, "python");
      if (testResult.error) {
        errors.push(`Isolated conformance test execution failed: ${testResult.error}`);
        conformance.isolated_test_run_passed = false;
      } else {
        conformance.isolated_test_run_passed = true;
      }
    } catch (testErr: any) {
      errors.push(`Isolated conformance execution throw: ${testErr.message}`);
      conformance.isolated_test_run_passed = false;
    }
  }

  const allPassed = 
    conformance.syntax_valid &&
    conformance.static_analysis_passed &&
    conformance.policy_compliance_passed &&
    conformance.isolated_test_run_passed;

  if (allPassed) {
    const registry = DynamicToolRegistry.getSessionRegistry(sessionId);
    const toolMetadata = {
      tool_name: proposed_tool_name,
      functional_description,
      input_schema,
      output_schema,
      safety_profile: safety
    };
    registry.register(proposed_tool_name, {
      source_code,
      ...toolMetadata
    });

    return {
      registration_status: "registered",
      validation_errors: [],
      conformance_results: conformance,
      registered_tool_metadata: toolMetadata
    };
  } else {
    return {
      registration_status: errors.some(e => e.includes("Forbidden") || e.includes("syntax")) ? "rejected" : "validation_failed",
      validation_errors: errors,
      conformance_results: conformance,
      registered_tool_metadata: null
    };
  }
}
