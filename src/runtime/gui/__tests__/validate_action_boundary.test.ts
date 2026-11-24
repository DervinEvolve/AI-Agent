import { describe, expect, it } from 'vitest';
import { GUI_CAPS } from '../types';
import { validateGuiAction } from '../validate_action';

const viewport = { width: GUI_CAPS.viewportWidth, height: GUI_CAPS.viewportHeight };

describe('GUI action object boundary', () => {
  it('rejects accessor-backed actions without executing their getters', () => {
    let reads = 0;
    const action = Object.defineProperty({}, 'click', {
      enumerable: true,
      get() {
        reads += 1;
        return { x: 0, y: 0 };
      },
    });

    expect(() => validateGuiAction(action, viewport)).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects hidden and symbol metadata rather than ignoring extra authority-bearing fields', () => {
    const hidden = Object.defineProperty({ click: { x: 0, y: 0 } }, 'principal', {
      value: 'other-principal',
      enumerable: false,
    });
    const symbolic = {
      click: { x: 0, y: 0 },
      [Symbol('authorization')]: true,
    };

    for (const action of [hidden, symbolic]) {
      expect(() => validateGuiAction(action, viewport)).toThrow();
    }
  });

  it('rejects inherited action kinds and custom prototypes', () => {
    const inherited = Object.create({ click: { x: 0, y: 0 } });
    const customPrototype = Object.assign(Object.create({ authorized: true }), {
      click: { x: 0, y: 0 },
    });

    for (const action of [inherited, customPrototype]) {
      expect(() => validateGuiAction(action, viewport)).toThrow();
    }
  });

  it('rejects invalid host viewport dimensions even when the action coordinates fit', () => {
    const action = { click: { x: 0, y: 0 } };
    const invalidViewports = [
      { width: GUI_CAPS.viewportWidth + 1, height: 1 },
      { width: 1, height: GUI_CAPS.viewportHeight + 1 },
      { width: 0, height: 1 },
      { width: 1, height: 0 },
      { width: 1.5, height: 1 },
      { width: 1, height: Number.POSITIVE_INFINITY },
      { width: Number.NaN, height: 1 },
    ];

    for (const dimensions of invalidViewports) {
      expect(() => validateGuiAction(action, dimensions)).toThrow();
    }
    expect(validateGuiAction(action, { width: 1, height: 1 })).toEqual(action);
  });
});
