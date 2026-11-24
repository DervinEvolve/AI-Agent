import { describe, it, expect } from 'vitest';
import { GUI_CAPS } from '../types';
import { validateGuiAction } from '../validate_action';

const viewport = { width: GUI_CAPS.viewportWidth, height: GUI_CAPS.viewportHeight };

describe('unmounted GUI argument validation', () => {
  it('accepts inclusive coordinates and scroll limits', () => {
    const action = { scroll: { x: viewport.width - 1, y: viewport.height - 1, delta_y: -GUI_CAPS.scrollDelta } };
    expect(validateGuiAction(action, viewport)).toEqual(action);
    expect(validateGuiAction({ click: { x: 0, y: 0 } }, viewport)).toEqual({ click: { x: 0, y: 0 } });
  });

  it('counts UTF-8 bytes and preserves literal text', () => {
    const text = 'é'.repeat(GUI_CAPS.textBytes / 2);
    expect(validateGuiAction({ type: { text } }, viewport)).toEqual({ type: { text } });
    expect(() => validateGuiAction({ type: { text: text + 'a' } }, viewport)).toThrow('invalid_args');
  });

  it('rejects ambiguous unions, extra fields, controls and out-of-range values', () => {
    const invalid = [
      {}, { click: { x: 0, y: 0 }, key: { key: 'Enter' } },
      { click: { x: viewport.width, y: 0 } }, { click: { x: 0.5, y: 0 } },
      { click: { x: 0, y: -1 } }, { click: { x: NaN, y: 0 } },
      { scroll: { x: 0, y: 0, delta_y: 0 } },
      { scroll: { x: 0, y: 0, delta_y: GUI_CAPS.scrollDelta + 1 } },
      { key: { key: 'Control+Enter' } }, { key: { key: 'Enter', repeat: 2 } },
      { type: { text: 'hello\n' } }, { type: { text: '\u007f' } },
      { type: { text: '\ud800' } }, { type: { text: '\udc00' } },
    ];
    for (const value of invalid) expect(() => validateGuiAction(value, viewport)).toThrow('invalid_args');
  });

  it('allows hosts to narrow but not widen the key allowlist', () => {
    expect(() => validateGuiAction({ key: { key: 'Enter' } }, viewport, ['Tab'])).toThrow('invalid_args');
    expect(validateGuiAction({ key: { key: 'Tab' } }, viewport, ['Tab'])).toEqual({ key: { key: 'Tab' } });
  });

  it('does not invoke payload accessors and returns detached values', () => {
    let reads = 0;
    const accessor = { get text() { reads++; return 'unsafe'; } };
    expect(() => validateGuiAction({ type: accessor }, viewport)).toThrow('invalid_args');
    expect(reads).toBe(0);
    const input = { click: { x: 1, y: 2 } };
    const result = validateGuiAction(input, viewport);
    input.click.x = 9;
    expect(result).toEqual({ click: { x: 1, y: 2 } });
  });
});
