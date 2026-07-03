import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerCustomTool,
  DynamicToolRegistry,
  staticAnalyzePython,
  validateToolName
} from "../cap_dynamic_tool_invention_6";

// Mock the code execution module to avoid real process execution during unit tests
vi.mock("../cap_code_execution_1", () => ({
  executeCode: vi.fn(async (language, sourceCode, timeout) => {
    if (sourceCode.includes("def custom_invalid_syntax")) {
      return { exitCode: 1, stdout: "", stderr: "SyntaxError: invalid syntax" };
    }
    if (sourceCode.includes("def custom_runtime_error")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ success: false, error: "ValueError: Invalid input" }),
        stderr: ""
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ success: true, result: { parsed: true, input_len: 10 } }),
      stderr: ""
    };
  })
}));

describe("cap_dynamic_tool_invention_6 - Dynamic Tool Registration Pipeline", () => {
  const sessionId = "test-session-123";

  beforeEach(() => {
    DynamicToolRegistry.clearSession(sessionId);
    DynamicToolRegistry.clearSession("other-session");
  });

  it("successfully validates and registers a safe custom tool (e.g., custom_json_parser)", async () => {
    const inputs = {
      proposed_tool_name: "custom_json_parser",
      functional_description: "Parses raw input text and extracts clean key-value pairs safely.",
      source_code: `def custom_json_parser(text):
    return {"parsed": True, "input_len": len(text)}
`,
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"]
      },
      output_schema: {
        type: "object",
        properties: {
          parsed: { type: "boolean" },
          input_len: { type: "integer" }
        }
      }
    };

    const result = await registerCustomTool(sessionId, inputs);
    expect(result.registration_status).toBe("registered");
    expect(result.conformance_results.syntax_valid).toBe(true);
    expect(result.conformance_results.static_analysis_passed).toBe(true);
    expect(result.conformance_results.isolated_test_run_passed).toBe(true);
    expect(result.registered_tool_metadata).not.toBeNull();
    expect(result.registered_tool_metadata?.tool_name).toBe("custom_json_parser");

    // Verify session isolation
    const registry = DynamicToolRegistry.getSessionRegistry(sessionId);
    expect(registry.hasTool("custom_json_parser")).toBe(true);

    const otherRegistry = DynamicToolRegistry.getSessionRegistry("other-session");
    expect(otherRegistry.hasTool("custom_json_parser")).toBe(false);
  });

  it("rejects custom tool names that do not match snake_case custom_ prefix", async () => {
    const invalidInputs = {
      proposed_tool_name: "invalid_tool_name",
      functional_description: "Should fail due to prefix check.",
      source_code: "def invalid_tool_name(): pass",
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "object", properties: {} }
    };

    const result = await registerCustomTool(sessionId, invalidInputs);
    expect(result.registration_status).toBe("validation_failed");
    expect(result.validation_errors.length).toBeGreaterThan(0);
    expect(result.conformance_results.syntax_valid).toBe(false);
  });

  it("rejects custom tool code containing forbidden imports during static analysis", async () => {
    const maliciousInputs = {
      proposed_tool_name: "custom_malicious_tool",
      functional_description: "Attempts to run a system command using subprocess.",
      source_code: `def custom_malicious_tool():
    import subprocess
    subprocess.run(["ls"])
`,
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "object", properties: {} }
    };

    const result = await registerCustomTool(sessionId, maliciousInputs);
    expect(result.registration_status).toBe("rejected");
    expect(result.conformance_results.static_analysis_passed).toBe(false);
    expect(result.conformance_results.policy_compliance_passed).toBe(false);
    expect(result.validation_errors.some(e => e.includes("subprocess"))).toBe(true);
  });

  it("rejects tool registration if the conformance test runs into syntax or runtime errors", async () => {
    const syntaxErrorInputs = {
      proposed_tool_name: "custom_invalid_syntax",
      functional_description: "Fails syntax checks.",
      source_code: `def custom_invalid_syntax():
    return "unclosed string
`,
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "object", properties: {} }
    };

    const runtimeErrorInputs = {
      proposed_tool_name: "custom_runtime_error",
      functional_description: "Fails during runtime test.",
      source_code: `def custom_runtime_error():
    raise ValueError("Invalid input")
`,
      input_schema: { type: "object", properties: {} },
      output_schema: { type: "object", properties: {} }
    };

    const syntaxResult = await registerCustomTool(sessionId, syntaxErrorInputs);
    expect(syntaxResult.registration_status).toBe("rejected");
    expect(syntaxResult.conformance_results.isolated_test_run_passed).toBe(false);

    const runtimeResult = await registerCustomTool(sessionId, runtimeErrorInputs);
    expect(runtimeResult.registration_status).toBe("rejected");
    expect(runtimeResult.conformance_results.isolated_test_run_passed).toBe(false);
  });
});
