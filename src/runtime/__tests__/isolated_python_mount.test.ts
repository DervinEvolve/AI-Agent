import {
  EXECUTION_POLICY_ARGV,
  MAX_OUTPUT_BYTES,
  classifyRunCode,
  containerName,
  drainBoundedOutput,
  mountIsolatedPython,
  probeIsolatedPython,
  type DockerCli,
  type DockerInfo,
} from '../isolated_python_mount.js';

function makeDockerCli(overrides: Partial<DockerCli> = {}): DockerCli {
  return {
    async info(): Promise<DockerInfo> {
      return {
        SecurityOptions: ['name=rootless'],
        CgroupVersion: '2',
        DelegatedControllers: ['memory', 'pids', 'cpu'],
      };
    },
    async run() {
      return {
        exitCode: 0,
        stdout: `${256 * 1024 * 1024}\n---\n64\n---\n50000 100000\n`,
        stderr: '',
      };
    },
    async kill() {},
    async inspect() {
      return { exists: false };
    },
    async rm() {},
    ...overrides,
  };
}

describe('isolated_python_mount', () => {
  it('sanitizes containerName to docker naming rules', () => {
    const name = containerName('call/with:invalid*chars!and-very-long-suffix-' + 'x'.repeat(50));
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('probeIsolatedPython passes full EXECUTION_POLICY_ARGV and never -v or --mount', async () => {
    let capturedArgv: string[] = [];
    const docker = makeDockerCli({
      async run(argv) {
        capturedArgv = argv;
        return {
          exitCode: 0,
          stdout: `${256 * 1024 * 1024}\n---\n64\n---\n50000 100000\n`,
          stderr: '',
        };
      },
    });

    const report = await probeIsolatedPython(docker);
    expect(report.ok).toBe(true);
    for (const flag of EXECUTION_POLICY_ARGV) {
      expect(capturedArgv).toContain(flag);
    }
    expect(capturedArgv).not.toContain('-v');
    expect(capturedArgv).not.toContain('--mount');
  });

  it('rejects rootful, cgroup v1, missing cpu controller, and unenforced limits', async () => {
    const rootful = await probeIsolatedPython(
      makeDockerCli({
        info: async () => ({
          SecurityOptions: ['name=seccomp'],
          CgroupVersion: '2',
          DelegatedControllers: ['memory', 'pids', 'cpu'],
        }),
      }),
    );
    expect(rootful).toEqual({ ok: false, code: 'rootless_unavailable' });

    const cgroupV1 = await probeIsolatedPython(
      makeDockerCli({
        info: async () => ({
          SecurityOptions: ['name=rootless'],
          CgroupVersion: '1',
          DelegatedControllers: ['memory', 'pids', 'cpu'],
        }),
      }),
    );
    expect(cgroupV1).toEqual({ ok: false, code: 'cgroup_v2_unavailable' });

    const noCpu = await probeIsolatedPython(
      makeDockerCli({
        info: async () => ({
          SecurityOptions: ['name=rootless'],
          CgroupVersion: '2',
          DelegatedControllers: ['memory', 'pids'],
        }),
      }),
    );
    expect(noCpu).toEqual({ ok: false, code: 'cpu_controller_not_delegated' });

    const memMax = await probeIsolatedPython(
      makeDockerCli({
        run: async () => ({ exitCode: 0, stdout: 'max\n---\n64\n---\n50000 100000\n', stderr: '' }),
      }),
    );
    expect(memMax).toEqual({ ok: false, code: 'limits_not_enforced' });

    const cpuRatioHigh = await probeIsolatedPython(
      makeDockerCli({
        run: async () => ({
          exitCode: 0,
          stdout: `${256 * 1024 * 1024}\n---\n64\n---\n60000 100000\n`,
          stderr: '',
        }),
      }),
    );
    expect(cpuRatioHigh).toEqual({ ok: false, code: 'limits_not_enforced' });
  });

  it('mountIsolatedPython requires digest-pinned image', async () => {
    const docker = makeDockerCli();
    const unpinned = await mountIsolatedPython(docker, 'python:3.12-slim');
    expect(unpinned).toEqual({ mounted: false, code: 'unpinned_image' });

    const pinned = await mountIsolatedPython(
      docker,
      'python@sha256:' + 'a'.repeat(64),
    );
    expect(pinned.mounted).toBe(true);
  });

  it('classifyRunCode enforces termination_confirmed and cleanup_confirmed', () => {
    expect(
      classifyRunCode({
        status: 'ok',
        termination_confirmed: false,
        cleanup_confirmed: true,
        output: { outcome: 'completed', exit_code: 0 },
      }),
    ).toBe('unknown');

    expect(
      classifyRunCode({
        status: 'ok',
        termination_confirmed: true,
        cleanup_confirmed: false,
        output: { outcome: 'completed', exit_code: 0 },
      }),
    ).toBe('unknown');

    expect(
      classifyRunCode({
        status: 'ok',
        termination_confirmed: true,
        cleanup_confirmed: true,
        output: { outcome: 'completed', exit_code: 0 },
      }),
    ).toBe('success');

    expect(
      classifyRunCode({
        status: 'timeout',
        termination_confirmed: true,
        cleanup_confirmed: true,
        output: { outcome: 'timeout', exit_code: null },
      }),
    ).toBe('known_failure');
  });

  it('drainBoundedOutput caps at 256 KiB and sets truncated=true', () => {
    const big = 'a'.repeat(MAX_OUTPUT_BYTES + 1024);
    const res = drainBoundedOutput([big]);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.text, 'utf8')).toBe(MAX_OUTPUT_BYTES);
  });
});
