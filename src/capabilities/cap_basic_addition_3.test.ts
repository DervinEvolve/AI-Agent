import { test } from 'vitest';
import assert from 'node:assert/strict';
import { computeAddition } from './cap_basic_addition_3';

const PASS = ['+ 5 3', '+ 0 0', '+ -2 7', '+ 100 200 3', '+ 42'];

const FAIL = [
  ['+', [true, 3]],
  ['+', ['5', 3]],
  ['+', [3, NaN]],
  ['+', [3, Infinity]],
  ['+', [3.5, 1]],
  ['+', []],
  ['-', [5, 3]],
  ['', [5, 3]],
  [null, [5, 3]],
] as const;

for (const expr of PASS) {
  const [op, ...rest] = expr.split(' ');
  const ops = rest.map(Number);
  test(`addition accepts: ${expr}`, () => {
    const r = computeAddition(op, ops);
    assert.equal(r.ok, true);
    assert.ok(typeof r.value === 'number');
  });
}

for (const [op, ops] of FAIL) {
  test(`addition rejects: ${String(op)} ${JSON.stringify(ops)}`, () => {
    const r = computeAddition(op, ops);
    assert.equal(r.ok, false);
    assert.ok(r.errors && r.errors.length > 0);
  });
}

test('addition computes correctly', () => {
  assert.equal(computeAddition('+', [2, 3]).value, 5);
  assert.equal(computeAddition('+', [10, -4, 2]).value, 8);
});
