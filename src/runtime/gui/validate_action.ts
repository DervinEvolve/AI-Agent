import { GUI_CAPS, GUI_KEYS, GuiAction, GuiKey, GuiViewport } from './types';

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

function invalid(): never { throw new Error('invalid_args'); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Reject lone surrogates instead of silently UTF-8 encoding them as replacement characters. */
function validUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/**
 * Validates JSON-like model arguments and returns a detached canonical action.
 * No authorization, browser interaction, or runtime registration occurs here.
 */
export function validateGuiAction(
  value: unknown,
  viewport: GuiViewport,
  allowedKeys: readonly GuiKey[] = GUI_KEYS,
): GuiAction {
  if (!integer(viewport.width, 1, GUI_CAPS.viewportWidth) ||
      !integer(viewport.height, 1, GUI_CAPS.viewportHeight)) invalid();
  if (!record(value)) invalid();
  const kinds = ['click', 'type', 'key', 'scroll'].filter(kind => Object.hasOwnProperty.call(value, kind));
  if (kinds.length !== 1 || !exact(value, kinds)) invalid();
  const kind = kinds[0];
  const payload = value[kind];
  if (!record(payload)) invalid();
  if (kind === 'type') {
    if (!exact(payload, ['text'])) invalid();
    const text = payload.text;
    if (typeof text !== 'string' || !validUnicode(text) ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(text) ||
        new TextEncoder().encode(text).byteLength > GUI_CAPS.textBytes) invalid();
    return { type: { text } };
  }
  if (kind === 'key') {
    if (!exact(payload, ['key'])) invalid();
    const key = payload.key;
    if (typeof key !== 'string' || !GUI_KEYS.includes(key as GuiKey) ||
        !allowedKeys.includes(key as GuiKey)) invalid();
    return { key: { key: key as GuiKey } };
  }
  if (!exact(payload, kind === 'click' ? ['x', 'y'] : ['x', 'y', 'delta_y'])) invalid();
  const { x, y } = payload;
  if (!integer(x, 0, viewport.width - 1) || !integer(y, 0, viewport.height - 1)) invalid();
  if (kind === 'click') return { click: { x, y } };
  const delta = payload.delta_y;
  if (!integer(delta, -GUI_CAPS.scrollDelta, GUI_CAPS.scrollDelta) || delta === 0) invalid();
  return { scroll: { x, y, delta_y: delta } };
}
