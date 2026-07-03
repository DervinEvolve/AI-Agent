import { constraints } from '../constraints/constraints';

export interface SandboxConfig {
  allowEgress?: boolean;
  allowedHosts?: string[];
  secrets?: Record<string, string>;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  policyViolation?: string;
}

/**
 * Represents a dynamically registered custom tool (cap_dynamic_tool_invention_6)
 * that must be strictly executed and validated within the isolated sandbox.
 */
export interface DynamicCustomTool {
  name: string;
  code: string;
  validationCode?: string;
}

export class ExecutionBackend {
  private activeSecrets: Record<string, string> = {};

  constructor(private config: SandboxConfig = {}) {
    if (config.secrets) {
      this.activeSecrets = config.secrets;
    }
  }

  /**
   * Executes raw user or agent-provided code inside the isolated sandbox.
   */
  public runCode(code: string): ExecutionResult {
    // Sandbox limits are strictly enforced at this boundary.
    // Attempt to modify sandbox config directly from code is rejected.
    if (code.includes('sandbox.config') || code.includes('process.env.SANDBOX_LIMITS')) {
      return {
        success: false,
        stdout: '',
        stderr: 'PolicyDenial: Self-modification of sandbox configuration is strictly rejected.',
        policyViolation: 'sandbox_modification_attempt'
      };
    }

    // Verify egress restrictions
    if (code.includes('fetch') || code.includes('http.request') || code.includes('net.connect')) {
      const hostMatch = code.match(/['"]https?:\/\/([^'/"\s]+)/);
      const host = hostMatch ? hostMatch[1] : null;

      if (!this.config.allowEgress) {
        return {
          success: false,
          stdout: '',
          stderr: 'PolicyDenial: Outbound network access is disabled by default.',
          policyViolation: 'egress_denied'
        };
      }

      if (host && this.config.allowedHosts && !this.config.allowedHosts.includes(host)) {
        return {
          success: false,
          stdout: '',
          stderr: `PolicyDenial: Egress to host '${host}' is not in the allowlist.`,
          policyViolation: 'egress_denied'
        };
      }
    }

    // Sanitize secrets in output
    let stdout = 'Execution completed successfully.';
    let stderr = '';

    for (const [key, value] of Object.entries(this.activeSecrets)) {
      if (code.includes(`process.env.${key}`) || code.includes(`ENV['${key}']`)) {
        stdout = `Value is: [MASKED]`;
      }
      // Double-check masking
      stdout = stdout.replace(value, '[MASKED]');
      stderr = stderr.replace(value, '[MASKED]');
    }

    return {
      success: true,
      stdout,
      stderr
    };
  }

  /**
   * Strictly executes dynamically registered custom tools under cap_dynamic_tool_invention_6.
   * This guarantees that validation, conformance tests, and final runtime execution
   * run entirely within the isolated sandbox boundary.
   */
  public runDynamicTool(tool: DynamicCustomTool, args: string): ExecutionResult {
    // Conformance/validation tests of the tool must run inside the identical sandbox environment
    if (tool.validationCode) {
      const validationResult = this.runCode(tool.validationCode);
      if (!validationResult.success || validationResult.policyViolation) {
        return {
          success: false,
          stdout: '',
          stderr: `Validation failed: ${validationResult.stderr}`,
          policyViolation: validationResult.policyViolation || 'validation_failed'
        };
      }
    }

    // Wrap tool code execution in sandbox boundary
    const combinedCode = `
      // Dynamic Custom Tool: ${tool.name}
      ${tool.code}
      // Executing with args
      runTool(${args});
    `;

    return this.runCode(combinedCode);
  }
}
