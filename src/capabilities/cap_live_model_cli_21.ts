/**
 * Production CLI. Credential check precedes runtime availability and any socket.
 * AgentRuntime is not present in this repository; never fall back to a decode-then-call loop.
 */
import { readCredential } from "./cap_live_model_adapter_21.js";
import { componentAvailability } from "./cap_live_model_adapter_21.js";
import { redactSecrets } from "./secret_redactor.js";

export interface CliResult {
  code: number;
  error: "credential_missing" | "runtime_unavailable" | "ok";
  final_answer: null;
  sockets: number;
  tool_dispatches: number;
  stdout: string;
  stderr: string;
  components: ReturnType<typeof componentAvailability>;
  live_baseline: "not_run";
  live_baseline_reason: string;
}

export interface CliInvocation {
  task: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  api_key_env?: string;
  /** Observed by tests; production path must not open sockets. */
  socketObserver?: { count: number };
}

export function runCli(inv: CliInvocation): CliResult {
  const env = inv.env ?? process.env;
  const keyEnv = inv.api_key_env ?? "OPENAI_API_KEY";
  const cred = readCredential(keyEnv, env);
  const components = componentAvailability();
  const sockets = inv.socketObserver?.count ?? 0;

  if (!cred.present) {
    const payload = {
      error: "credential_missing",
      final_answer: null,
      sockets: 0,
      tool_dispatches: 0,
      mounted_tools: [] as string[],
      budgets: { note: "not enforced; usage accounting unavailable" },
      redaction_policy: "secret_redactor",
      unavailable: ["AgentRuntime", "finalizer", "usage_accounting", "recovery_ledger"],
      live_baseline: "not_run",
      live_baseline_reason: "credential_unavailable",
      components,
    };
    const text = redactSecrets(JSON.stringify(payload));
    return {
      code: 2,
      error: "credential_missing",
      final_answer: null,
      sockets: 0,
      tool_dispatches: 0,
      stdout: inv.json === false ? "" : text,
      stderr: inv.json === false ? text : "",
      components,
      live_baseline: "not_run",
      live_baseline_reason: "credential_unavailable",
    };
  }

  const payload = {
    error: "runtime_unavailable",
    final_answer: null,
    sockets: 0,
    tool_dispatches: 0,
    mounted_tools: [] as string[],
    budgets: { note: "not enforced; usage accounting unavailable" },
    redaction_policy: "secret_redactor",
    unavailable: ["AgentRuntime", "finalizer", "usage_accounting", "recovery_ledger"],
    live_baseline: "not_run",
    live_baseline_reason: "credential_unavailable",
    components,
    task_accepted: false,
  };
  const text = redactSecrets(JSON.stringify(payload));
  void sockets;
  return {
    code: 3,
    error: "runtime_unavailable",
    final_answer: null,
    sockets: 0,
    tool_dispatches: 0,
    stdout: text,
    stderr: "",
    components,
    live_baseline: "not_run",
    live_baseline_reason: "credential_unavailable",
  };
}

export function parseArgv(argv: string[]): { task?: string; json: boolean } {
  let task: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") task = argv[++i];
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "run") continue;
  }
  return { task, json };
}
