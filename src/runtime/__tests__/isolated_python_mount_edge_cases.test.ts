import {
  MAX_MEMORY_BYTES,
  MAX_PIDS_LIMIT,
  classifyRunCode,
  containerName,
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
        stdout: `${MAX_MEMORY_BYTES}\n---\n${MAX_PIDS_LIMIT}\n---\n50000 100000\n`,
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

describe('isolated_python_mount edge cases', () => {
  describe('classifyRunCode', () => {
    it('returns unknown when termination_confirmed or cleanup_confirmed is not true', () => {
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
    });

    it('returns success only when status is ok, outcome is completed, exit_code is 0, and both confirmations are true', () => {
      expect(
        classifyRunCode({
          status: 'ok',
          termination_confirmed: true,
          cleanup_confirmed: true,
          output: { outcome: 'completed', exit_code: 0 },
        }),
      ).toBe('success');
    });

    it('returns known_failure when both confirmations are true but outcome is timeout or exit_code is non-zero', () => {
      expect(
        classifyRunCode({
          status: 'timeout',
          termination_confirmed: true,
          cleanup_confirmed: true,
          output: { outcome: 'timeout', exit_code: null },
        }),
      ).toBe('known_failure');

      expect(
        classifyRunCode({
          status: 'ok',
          termination_confirmed: true,
          cleanup_confirmed: true,
          output: { outcome: 'completed', exit_code: 2 },
        }),
      ).toBe('known_failure');
    });
  });

  describe('mountIsolatedPython', () => {
    const validImage = `python@sha256:${'a'.repeat(64)}`;

    it('rejects unpinned or tag-based images without invoking docker', async () => {
      let called = false;
      const docker = makeDockerCli({
        info: async () => {
          called = true;
          return {};
        },
      });

      const latestResult = await mountIsolatedPython(docker, 'python:latest');
      expect(latestResult.mounted).toBe(false);
      expect(called).toBe(false);

      const bareResult = await mountIsolatedPython(docker, 'python');
      expect(bareResult.mounted).toBe(false);
      expect(called).toBe(false);
    });

    it('mounts a digest-pinned image when preflight passes', async () => {
      const result = await mountIsolatedPython(makeDockerCli(), validImage);
      expect(result.mounted).toBe(true);
      if (result.mounted) {
        expect(result.image).toBe(validImage);
        expect(result.preflight.ok).toBe(true);
      }
    });

    it('returns blocker codes when preflight fails on cgroup v1, missing cpu controller, or cpu ratio > 0.5', async () => {
      const cgroupV1 = await probeIsolatedPython(
        makeDockerCli({
          info: async () => ({
            SecurityOptions: ['name=rootless'],
            CgroupVersion: '1',
            DelegatedControllers: ['memory', 'pids', 'cpu'],
          }),
        }),
      );
      expect(cgroupV1.ok).toBe(false);
      expect(cgroupV1.code).toBe('cgroup_v2_unavailable');

      const noCpu = await probeIsolatedPython(
        makeDockerCli({
          info: async () => ({
            SecurityOptions: ['name=rootless'],
            CgroupVersion: '2',
            DelegatedControllers: ['memory', 'pids'],
          }),
        }),
      );
      expect(noCpu.ok).toBe(false);
      expect(noCpu.code).toBe('cpu_controller_not_delegated');

      const highCpu = await probeIsolatedPython(
        makeDockerCli({
          run: async () => ({
            exitCode: 0,
            stdout: `${MAX_MEMORY_BYTES}\n---\n${MAX_PIDS_LIMIT}\n---\n75000 100000\n`,
            stderr: '',
          }),
        }),
      );
      expect(highCpu.ok).toBe(false);
      expect(highCpu.code).toBe('limits_not_enforced');
    });
  });

  describe('containerName', () => {
    it('handles empty or symbol-only callIds safely', () => {
      const name = containerName('///:::');
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
    });
  });
});
