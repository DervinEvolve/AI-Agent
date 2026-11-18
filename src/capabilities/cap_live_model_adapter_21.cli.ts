import {
  LiveModelAdapter,
  AgentRuntime,
  ToolRegistry,
  UsageLedger,
  redactSecrets,
  HostConfig,
  UsageCap,
  RunReport,
} from './cap_live_model_adapter_21';

export type OutputSink = { write(chunk: string): void };

function parseArgs(argv: string[]): {
  task?: string;
  json: boolean;
  max_turns: number;
  usage_cap?: UsageCap;
} {
  const args = argv.slice(2);
  let task: string | undefined;
  let json = false;
  let max_turns = 1;
  let usage_cap: UsageCap | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--task' && i + 1 < args.length) {
      task = args[++i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--max-turns' && i + 1 < args.length) {
      max_turns = parseInt(args[++i], 10);
      if (!Number.isFinite(max_turns) || max_turns < 1) max_turns = 1;
    } else if (arg === '--usage-cap-tokens' && i + 1 < args.length) {
      const limit = parseInt(args[++i], 10);
      if (Number.isFinite(limit) && limit > 0) {
        usage_cap = { type: 'token', limit };
      }
    }
  }

  return { task, json, max_turns, usage_cap };
}

function loadHostConfig(env: NodeJS.ProcessEnv): HostConfig {
  return {
    base_url: env.LIVE_MODEL_BASE_URL ?? 'https://api.openai.com/v1/chat/completions',
    model: env.LIVE_MODEL_MODEL ?? 'gpt-4o-mini',
    api_key_env: env.LIVE_MODEL_API_KEY_ENV ?? 'LIVE_MODEL_API_KEY',
    timeout_ms: 30000,
    max_response_bytes: 4 * 1024 * 1024,
    finalization_reserve_ms: 1000,
  };
}

function formatReport(report: RunReport): string {
  const lines = [
    `status: ${report.status}`,
    `final_answer: ${report.final_answer ?? ''}`,
    `tool_results: ${report.tool_results.length}`,
    `usage: ${JSON.stringify(report.usage)}`,
    `journal:`,
    ...report.journal.map((line) => `  ${line}`),
    `diagnostics:`,
    ...report.diagnostics.map((line) => `  ${line}`),
  ];
  return lines.join('\n');
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdout: OutputSink = process.stdout
): Promise<number> {
  const args = parseArgs(argv);
  if (!args.task) {
    stdout.write('Usage: node cap_live_model_adapter_21.cli.ts --task "<plain-language task>" [--json] [--max-turns N] [--usage-cap-tokens N]\n');
    return 1;
  }

  const config = loadHostConfig(env);
  const ledger = new UsageLedger();
  const adapter = new LiveModelAdapter(config, undefined, ledger);
  const tools = new ToolRegistry();
  const runtime = new AgentRuntime(adapter, tools, { tools: [] });

  const report = await runtime.run(args.task, {
    max_turns: args.max_turns,
    usage_cap: args.usage_cap,
  });

  const secrets = [
    env.LIVE_MODEL_API_KEY,
    env.OPENAI_API_KEY,
    env.AGENT_API_KEY,
  ].filter((v): v is string => !!v);

  const output = args.json ? JSON.stringify(report, null, 2) : formatReport(report);
  stdout.write(redactSecrets(output, secrets) + '\n');

  return report.status === 'completed' ? 0 : 1;
}
