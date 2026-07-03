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

export function validateToolName(name: string): boolean {
  if (!name.startsWith("custom_")) return false;
  const snakeCaseRegex = /^custom_[a-z0-9_]+$/;
  return snakeCaseRegex.test(name);
}

export function staticAnalyzePython(sourceCode: string, safetyProfile?: SafetyProfile): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check for blocked keywords/modules
  const blockedKeywords = [
    "import subprocess", "from subprocess import",
    "import ctypes", "from ctypes import",
    "import socket", "from socket import",
    "import urllib", "from urllib import",
    "eval(", "exec(", "compile("
  ];

  for (const keyword of blockedKeywords) {
    if (sourceCode.includes(keyword)) {
      errors.push(`Forbidden instruction or module usage detected: "${keyword}"`);
    }
  }

  if (!safetyProfile?.requires_network) {
    const networkKeywords = ["import requests", "from requests import", "urllib.request", "http.client"];
    for (const keyword of networkKeywords) {
      if (sourceCode.includes(keyword)) {
        errors.push(`Network access is not enabled in safety profile, but detected: "${keyword}"`);
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors
  };
}

export async function registerCustomTool(
  sessionId: string,
  inputs: DynamicToolInventionInputs
): Promise<DynamicToolInventionOutputs> {
  const errors: string[] = [];
  const conformance: ConformanceResults = {
    syntax_valid: true,
    static_analysis_passed: true,
    isolated_test_run_passed: true,
    policy_compliance_passed: true
  };

  // 1. Tool name validation
  if (!validateToolName(inputs.proposed_tool_name)) {
    errors.push("Tool name must start with 'custom_' and be in lowercase snake_case format.");
    return {
      registration_status: "validation_failed",
      validation_errors: errors,
      conformance_results: { ...conformance, syntax_valid: false },
      registered_tool_metadata: null
    };
  }

  // 2. Static analysis
  const analysis = staticAnalyzePython(inputs.source_code, inputs.safety_profile);
  if (!analysis.passed) {
    errors.push(...analysis.errors);
    conformance.static_analysis_passed = false;
    conformance.policy_compliance_passed = false;
  }

  // 3. Syntax validation check (basic Python def match for custom tool name)
  const defPattern = new RegExp(`def\\s+${inputs.proposed_tool_name}\\b`);
  if (!defPattern.test(inputs.source_code)) {
    errors.push(`The source code must define a function named '${inputs.proposed_tool_name}'.`);
    conformance.syntax_valid = false;
  }

  // 4. Isolated Conformance Run (using executeCode sandbox)
  if (conformance.syntax_valid && conformance.static_analysis_passed) {
    try {
      // Generate a harness to execute the tool code safely with mock inputs
      const mockInputArgs = JSON.stringify(inputs.input_schema.properties ? 
        Object.keys(inputs.input_schema.properties).reduce((acc, key) => {
          const prop = inputs.input_schema.properties[key];
          if (prop.type === "string") acc[key] = "test_value";
          else if (prop.type === "integer" || prop.type === "number") acc[key] = 42;
          else if (prop.type === "boolean") acc[key] = true;
          else acc[key] = null;
          return acc;
        }, {} as Record<string, any>) : {}
      );

      const testHarness = `
${inputs.source_code}
import json
try:
    res = ${inputs.proposed_tool_name}(**json.loads('${mockInputArgs}'))
    print(json.dumps({"success": True, "result": res}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

      const timeout = inputs.safety_profile?.execution_timeout_s || 10;
      const runResult = await executeCode("python", testHarness, timeout);

      if (runResult.exitCode !== 0) {
        conformance.isolated_test_run_passed = false;
        errors.push(`Conformance test run failed: ${runResult.stderr || runResult.stdout}`);
      } else {
        try {
          const outputObj = JSON.parse(runResult.stdout.trim());
          if (!outputObj.success) {
            conformance.isolated_test_run_passed = false;
            errors.push(`Conformance run runtime error: ${outputObj.error}`);
          }
        } catch (e) {
          conformance.isolated_test_run_passed = false;
          errors.push("Conformance run output was not valid JSON format.");
        }
      }
    } catch (err: any) {
      conformance.isolated_test_run_passed = false;
      errors.push(`Conformance sandbox execution error: ${err.message}`);
    }
  }

  const registration_status = (errors.length === 0 && conformance.isolated_test_run_passed)
    ? "registered"
    : "rejected";

  const safety: SafetyProfile = {
    requires_network: inputs.safety_profile?.requires_network ?? false,
    restricted_paths: inputs.safety_profile?.restricted_paths ?? [],
    execution_timeout_s: inputs.safety_profile?.execution_timeout_s ?? 10
  };

  const registered_tool_metadata = registration_status === "registered" ? {
    tool_name: inputs.proposed_tool_name,
    functional_description: inputs.functional_description,
    input_schema: inputs.input_schema,
    output_schema: inputs.output_schema,
    safety_profile: safety
  } : null;

  if (registration_status === "registered") {
    const registry = DynamicToolRegistry.getSessionRegistry(sessionId);
    registry.register(inputs.proposed_tool_name, {
      source_code: inputs.source_code,
      functional_description: inputs.functional_description,
      input_schema: inputs.input_schema,
      output_schema: inputs.output_schema,
      safety_profile: safety
    });
  }

  return {
    registration_status,
    validation_errors: errors,
    conformance_results: conformance,
    registered_tool_metadata
  };
}
