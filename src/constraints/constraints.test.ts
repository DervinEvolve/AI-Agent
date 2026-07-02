import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  validateInteger,
  makeError,
  ERROR_NAMES,
  safeCompute,
  type CapabilityErrorCode,
} from './constraints';

// ── makeError / ERROR_NAMES ──────────────────────────────────────────

test('makeError returns a properly shaped CapabilityError', () => {
  const err = makeError('V101', 'bad type', 'operands[0]', 'use a number');
  assert.equal(err.code, 'V101');
  assert.equal(err.name, 'InvalidInputType');
  assert.equal(err.message, 'bad type');
  assert.equal(err.location, 'operands[0]');
  assert.equal(err.suggestion, 'use a number');
});

test('ERROR_NAMES covers all error codes', () => {
  const codes: CapabilityErrorCode[] = [
    'V101', 'V102', 'V103', 'V104', 'V105',
    'S301', 'S302', 'S303', 'S304',
  ];
  for (const c of codes) {
    assert.ok(ERROR_NAMES[c], `ERROR_NAMES missing ${c}`);
    assert.ok(typeof ERROR_NAMES[c] === 'string');
  }
});

// ── validateInteger ──────────────────────────────────────────────────

test('validateInteger accepts a normal integer', () => {
  assert.equal(validateInteger(42, 'x'), null);
  assert.equal(validateInteger(0, 'x'), null);
  assert.equal(validateInteger(-7, 'x'), null);
});

test('validateInteger rejects booleans before numeric coercion', () => {
  const err = validateInteger(true, 'operands[0]');
  assert.ok(err);
  assert.equal(err!.code, 'V101');
  assert.equal(err!.name, 'InvalidInputType');
  // Make sure it didn't slip through as a number
  assert.ok(!err!.message.includes('number'));
});

test('validateInteger rejects non-number types', () => {
  for (const v of ['5', null, undefined, {}, [], () => {}]) {
    const err = validateInteger(v, 'loc');
    assert.ok(err, `should reject ${typeof v}`);
    assert.equal(err!.code, 'V101');
  }
});

test('validateInteger rejects NaN and Infinity (non-finite)', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    const err = validateInteger(v, 'loc');
    assert.ok(err);
    assert.equal(err!.code, 'V102');
  }
});

test('validateInteger rejects non-integer floats', () => {
  for (const v of [3.5, -0.1, 1.0001, Number.EPSILON]) {
    const err = validateInteger(v, 'loc');
    assert.ok(err);
    assert.equal(err!.code, 'V103');
  }
});

test('validateInteger accepts Number.isSafeInteger values', () => {
  assert.equal(validateInteger(Number.MAX_SAFE_INTEGER, 'x'), null);
  assert.equal(validateInteger(Number.MIN_SAFE_INTEGER, 'x'), null);
});

// ── safeCompute ──────────────────────────────────────────────────────

test('safeCompute returns ok result for valid inputs', () => {
  const r = safeCompute('+', [1, 2, 3], ['+'], (ops) =>
    ops.reduce((a, b) => a + b, 0),
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).value, 6);
});

test('safeCompute rejects unsupported operator', () => {
  const r = safeCompute('*', [1, 2], ['+', '-'], (ops) => ops[0]);
  assert.equal(r.ok, false);
  assert.equal((r as any).errors[0].code, 'V105');
});

test('safeCompute rejects empty operands', () => {
  const r = safeCompute('+', [], ['+'], (ops) => ops[0]);
  assert.equal(r.ok, false);
  assert.equal((r as any).errors[0].code, 'V104');
});

test('safeCompute collects multiple validation errors', () => {
  const r = safeCompute('+', [true, 'x', NaN], ['+'], (ops) =>
    ops.reduce((a, b) => a + b, 0),
  );
  assert.equal(r.ok, false);
  const errs = (r as any).errors;
  assert.ok(errs.length >= 3, 'should report an error for each bad operand');
  assert.equal(errs[0].code, 'V101');
  assert.equal(errs[1].code, 'V101');
  assert.equal(errs[2].code, 'V102');
});

test('safeCompute does not invoke compute callback on invalid input', () => {
  let called = false;
  const r = safeCompute('+', [true, 1], ['+'], () => {
    called = true;
    return 0;
  });
  assert.equal(r.ok, false);
  assert.equal(called, false, 'callback must not run when validation fails');
});

test('safeCompute rejects boolean operand that would coerce to 1', () => {
  const r = safeCompute('+', [true, 1], ['+'], (ops) =>
    ops.reduce((a, b) => a + b, 0),
  );
  assert.equal(r.ok, false);
  // Ensure the boolean was caught, not silently added as 1
  const errs = (r as any).errors;
  assert.equal(errs[0].code, 'V101');
});

test('safeCompute handles single-operand addition', () => {
  const r = safeCompute('+', [42], ['+'], (ops) =>
    ops.reduce((a, b) => a + b, 0),
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).value, 42);
});

test('safeCompute handles negative integers correctly', () => {
  const r = safeCompute('+', [-5, -10, 3], ['+'], (ops) =>
    ops.reduce((a, b) => a + b, 0),
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).value, -12);
});

test('safeCompute subtraction-style reduce works through safeCompute', () => {
  const r = safeCompute('-', [10, 3, 2], ['-'], (ops) =>
    ops.slice(1).reduce((acc, n) => acc - n, ops[0]),
  );
  assert.equal(r.ok, true);
  assert.equal((r as any).value, 5);
});
