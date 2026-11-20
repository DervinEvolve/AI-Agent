import { describe, it, expect } from 'vitest';
import {
  validateRunCommandArgs,
  SHELL_BASENAMES,
} from '../run_command_mount';

describe('run_command argument validation edge cases', () => {
  it('passes metacharacters through verbatim as literal argv entries', () => {
    const argv = ['printf', '%s\n', 'a;b|c', '; rm -rf'];
    const result = validateRunCommandArgs({ argv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(argv);
    }
  });

  it('rejects shell basenames as a dispatcher heuristic', () => {
    for (const shell of SHELL_BASENAMES) {
      const result = validateRunCommandArgs({ argv: [shell, '-c', 'echo hi'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('rejected');
      }
    }
  });

  it('rejects absolute cwd paths', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: '/etc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects parent traversal in cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: '../outside' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects NUL bytes in cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: 'sub\0dir' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects NUL bytes in argv entries', () => {
    const result = validateRunCommandArgs({ argv: ['echo', 'bad\0arg'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects unknown top-level keys', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], extra: true } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects argv with more than 64 entries', () => {
    const argv = Array.from({ length: 65 }, (_, i) => `arg${i}`);
    const result = validateRunCommandArgs({ argv });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('accepts a bounded relative cwd', () => {
    const result = validateRunCommandArgs({ argv: ['make'], cwd: 'src/build' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cwd).toBe('src/build');
    }
  });
});
