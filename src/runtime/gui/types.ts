/** Inclusive protocol limits. These do not grant authority to mount GUI tools. */
export const GUI_CAPS = Object.freeze({
  viewportWidth: 1280,
  viewportHeight: 960,
  textBytes: 2048,
  questionBytes: 512,
  scrollDelta: 1000,
  frameBytes: 4 * 1024 * 1024,
  retainedFrames: 32,
  retainedBytes: 64 * 1024 * 1024,
  outputBytes: 8 * 1024,
  defaultObservationAgeMs: 5000,
  maxObservationAgeMs: 10000,
  defaultAuthorizationMs: 1000,
  maxAuthorizationMs: 5000,
  defaultStaleLimit: 3,
  minStaleLimit: 1,
  maxStaleLimit: 5,
});

export const GUI_KEYS = Object.freeze([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
] as const);
export type GuiKey = typeof GUI_KEYS[number];
export type GuiAction =
  | { click: { x: number; y: number } }
  | { type: { text: string } }
  | { key: { key: GuiKey } }
  | { scroll: { x: number; y: number; delta_y: number } };

export interface GuiViewport { width: number; height: number }
