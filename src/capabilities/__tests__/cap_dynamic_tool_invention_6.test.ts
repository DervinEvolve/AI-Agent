import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCustomTool,
  DynamicToolRegistry,
  staticAnalyzePython,
  validateToolName
} from "../cap_dynamic_tool_invention_6";

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

  it("rejects custom tool code containing syntax errors or invalid schemas", async () => {
    const inputs = {
      proposed_tool_name: "custom_broken_tool",
      functional_description: "Has invalid Python syntax",
      source_code: `def custom_broken_tool(:
    return "broken"
`,
      input_schema: {},
      output_schema: {}
    };

    const result = await registerCustomTool(sessionId, inputs);
    expect(result.registration_status).toBe("rejected");
    expect(result.conformance_results.syntax_valid).toBe(false);
    expect(result.validation_errors.length).toBeGreaterThan(0);
  });

  it("static analyzer rejects tool code containing forbidden imports and patterns", () => {
    const badCode1 = `
import os
def custom_bad_tool():
    return os.listdir('.')
`;
    const errors1 = staticAnalyzePython(badCode1);
    expect(errors1.some(e => e.includes("Forbidden import") || e.includes("Forbidden pattern"))).toBe(true);

    const badCode2 = `
def custom_bad_tool():
    f = getattr(object, '__subclasses__')
    return f()
`;
    const errors2 = staticAnalyzePython(badCode2);
    expect(errors2.some(e => e.includes("getattr") || e.includes("__subclasses__") || e.includes("Forbidden pattern"))).toBe(true);
  });

  it("validates tool name conventions strictly", () => {
    expect(validateToolName("my_tool").length).toBeGreaterThan(0); // missing custom_ prefix
    expect(validateToolName("custom_Tool").length).toBeGreaterThan(0); // capital letters
    expect(validateToolName("custom_tool_123").length).toBe(0);
  });
});
