import { readFile, writeFile } from 'node:fs/promises';
import {
  createSupportChecker,
  qualify,
  type QualificationConfig,
  type QualificationSuite,
} from './types';

export async function runQualifyCheckerCli(args: string[]): Promise<number> {
  if (args.length < 2) {
    process.stderr.write(
      'usage: qualify-checker <suite.json> <config.json> [output.json|-]\n',
    );
    return 2;
  }

  const [suitePath, configPath, outputPath] = args;
  const suite = JSON.parse(
    await readFile(suitePath, 'utf8'),
  ) as QualificationSuite;
  const config = JSON.parse(
    await readFile(configPath, 'utf8'),
  ) as QualificationConfig;

  const client = createSupportChecker({
    endpoint: config.endpoint_origin,
    model: config.model_id,
    system_prompt: config.system_prompt ?? '',
    api_key: config.api_key,
    max_tokens: config.max_tokens,
    max_response_chars: config.max_response_chars,
    timeout_ms: config.timeout_ms,
  });

  const record = await qualify(suite, config, client);
  const json = JSON.stringify(record, null, 2);

  if (outputPath && outputPath !== '-') {
    await writeFile(outputPath, json, 'utf8');
  } else {
    process.stdout.write(`${json}\n`);
  }

  return record.pass ? 0 : 1;
}
