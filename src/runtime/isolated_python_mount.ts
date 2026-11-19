export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const MAX_PIDS_LIMIT = 64;
export const MAX_CPU_RATIO = 0.5;

export const EXECUTION_POLICY_ARGV: readonly string[] = [
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--user',
  '65534:65534',
  '--memory',
  '256m',
  '--memory-swap',
  '256m',
  '--cpus',
  '0.5',
  '--pids-limit',
  '64',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,nodev,size=32m',
];

export interface DockerInfo {
  SecurityOptions?: string[];
  CgroupVersion?: string | number;
  CgroupDriver?: string;
  DelegatedControllers?: string[];
}

export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated?: boolean;
  createError?: boolean;
}

export interface DockerInspectResult {
  exists: boolean;
  status?: string;
  labels?: Record<string, string>;
}

export interface DockerCli {
  info(): Promise<DockerInfo>;
  run(argv: string[], stdin?: string): Promise<DockerRunResult>;
  kill(name: string): Promise<void>;
  inspect(name: string): Promise<DockerInspectResult>;
  rm(name: string): Promise<void>;
}

export interface PreflightReport {
  ok: boolean;
  code?: string;
  memoryMax?: number;
  pidsMax?: number;
  cpuQuota?: number;
  cpuPeriod?: number;
}

export interface MountResult {
  mounted: true;
  image: string;
  preflight: PreflightReport;
}

export type MountOutcome = MountResult | { mounted: false; code: string };

export interface ToolResultLike {
  status?: string;
  termination_confirmed?: boolean;
  cleanup_confirmed?: boolean;
  output?: {
    outcome?: string;
    exit_code?: number | null;
    stdout?: string;
    stderr?: string;
    output_truncated?: boolean;
    container_name?: string;
  };
}

const DIGEST_IMAGE_RE = /^[^\s@:]+(?:\/[^\s@:]+)*@sha256:[a-f0-9]{64}$/;

export function containerName(callId: string): string {
  const sanitized = callId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const prefixed = /^[a-zA-Z0-9]/.test(sanitized) ? sanitized : `c_${sanitized}`;
  return prefixed.slice(0, 63);
}

export function isDigestPinnedImage(image: string): boolean {
  return DIGEST_IMAGE_RE.test(image);
}

export function drainBoundedOutput(
  chunks: readonly (string | Uint8Array)[],
  maxBytes: number = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  let collected = 0;
  let truncated = false;
  const parts: string[] = [];
  const decoder = new TextDecoder();

  for (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    if (collected >= maxBytes) {
      if (bytes.byteLength > 0) {
        truncated = true;
      }
      continue;
    }
    const remaining = maxBytes - collected;
    if (bytes.byteLength <= remaining) {
      parts.push(decoder.decode(bytes, { stream: true }));
      collected += bytes.byteLength;
    } else {
      parts.push(decoder.decode(bytes.subarray(0, remaining), { stream: true }));
      collected += remaining;
      truncated = true;
    }
  }
  parts.push(decoder.decode());
  return { text: parts.join(''), truncated };
}

export async function probeIsolatedPython(docker: DockerCli): Promise<PreflightReport> {
  const info = await docker.info();
  const secOpts = info.SecurityOptions ?? [];
  const isRootless = secOpts.some((opt) => opt.toLowerCase().includes('rootless'));
  if (!isRootless) {
    return { ok: false, code: 'rootless_unavailable' };
  }

  const cgroupVersion = String(info.CgroupVersion ?? '');
  if (cgroupVersion !== '2') {
    return { ok: false, code: 'cgroup_v2_unavailable' };
  }

  const controllers = info.DelegatedControllers ?? [];
  if (!controllers.includes('cpu')) {
    return { ok: false, code: 'cpu_controller_not_delegated' };
  }
  if (!controllers.includes('memory') || !controllers.includes('pids')) {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const probeScript =
    'cat /sys/fs/cgroup/memory.max && echo "---" && cat /sys/fs/cgroup/pids.max && echo "---" && cat /sys/fs/cgroup/cpu.max';
  const argv = [
    'run',
    '--rm',
    ...EXECUTION_POLICY_ARGV,
    'alpine:latest',
    'sh',
    '-c',
    probeScript,
  ];

  const res = await docker.run(argv);
  if (res.exitCode !== 0) {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const sections = res.stdout.split('---').map((s) => s.trim());
  if (sections.length !== 3) {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const [memRaw, pidsRaw, cpuRaw] = sections;
  if (memRaw === 'max' || pidsRaw === 'max') {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const memoryMax = Number(memRaw);
  const pidsMax = Number(pidsRaw);
  if (
    !Number.isFinite(memoryMax) ||
    memoryMax <= 0 ||
    memoryMax > MAX_MEMORY_BYTES ||
    !Number.isFinite(pidsMax) ||
    pidsMax <= 0 ||
    pidsMax > MAX_PIDS_LIMIT
  ) {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const cpuParts = cpuRaw.split(/\s+/);
  if (cpuParts.length !== 2 || cpuParts[0] === 'max') {
    return { ok: false, code: 'limits_not_enforced' };
  }

  const cpuQuota = Number(cpuParts[0]);
  const cpuPeriod = Number(cpuParts[1]);
  if (
    !Number.isFinite(cpuQuota) ||
    !Number.isFinite(cpuPeriod) ||
    cpuPeriod <= 0 ||
    cpuQuota / cpuPeriod > MAX_CPU_RATIO
  ) {
    return { ok: false, code: 'limits_not_enforced' };
  }

  return {
    ok: true,
    memoryMax,
    pidsMax,
    cpuQuota,
    cpuPeriod,
  };
}

export async function mountIsolatedPython(
  docker: DockerCli,
  image: string,
): Promise<MountOutcome> {
  if (!isDigestPinnedImage(image)) {
    return { mounted: false, code: 'unpinned_image' };
  }

  const preflight = await probeIsolatedPython(docker);
  if (!preflight.ok) {
    return { mounted: false, code: preflight.code ?? 'preflight_failed' };
  }

  return {
    mounted: true,
    image,
    preflight,
  };
}

export function classifyRunCode(
  result: ToolResultLike,
): 'success' | 'known_failure' | 'unknown' {
  if (result.termination_confirmed !== true || result.cleanup_confirmed !== true) {
    return 'unknown';
  }
  if (
    result.status === 'ok' &&
    result.output?.outcome === 'completed' &&
    result.output?.exit_code === 0
  ) {
    return 'success';
  }
  return 'known_failure';
}
