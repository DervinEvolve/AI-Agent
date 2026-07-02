import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computeSubtraction } from './cap_basic_subtraction_5';

test('subtraction computes correctly', () => {
  assert.equal(computeSubtraction('-', [10, 3]).value, 7);
  assert.equal(computeSubtraction('-', [5, 2, 1]).value, 2);
});

test('subtraction rejects booleans before coercion', () => {
  const r = computeSubtraction('-', [true, 1]);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V101');
});

test('subtraction rejects string operands', () => {
  const r = computeSubtraction('-', ['5', 3]);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V101');
});

test('subtraction rejects non-finite', () => {
  const r = computeSubtraction('-', [5, Infinity]);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V102');
});

test('subtraction rejects non-integer', () => {
  const r = computeSubtraction('-', [5.5, 1]);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V103');
});

test('subtraction rejects empty operands', () => {
  const r = computeSubtraction('-', []);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V104');
});

test('subtraction rejects unsupported operator', () => {
  const r = computeSubtraction('+', [5, 3]);
  assert.equal(r.ok, false);
  assert.equal(r.errors![0].code, 'V105');
});
