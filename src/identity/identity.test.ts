import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get_description } from './identity';

test('get_description returns all required fields', () => {
  const d = get_description();
  assert.ok(typeof d.purpose === 'string' && d.purpose.length > 0);
  assert.ok(typeof d.domain === 'string' && d.domain.length > 0);
  assert.ok(typeof d.operators === 'string' && d.operators.length > 0);
  assert.ok(typeof d.safety === 'string' && d.safety.length > 0);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});

test('purpose field contains the word "purpose"', () => {
  const d = get_description();
  assert.ok(
    d.purpose.toLowerCase().includes('purpose'),
    'purpose field must contain the word "purpose"',
  );
});

test('domain field contains the word "domain"', () => {
  const d = get_description();
  assert.ok(
    d.domain.toLowerCase().includes('domain'),
    'domain field must contain the word "domain"',
  );
});

test('summary includes both "purpose" and "domain"', () => {
  const d = get_description();
  const lower = d.summary.toLowerCase();
  assert.ok(lower.includes('purpose'), 'summary must contain "purpose"');
  assert.ok(lower.includes('domain'), 'summary must contain "domain"');
});

test('summary is a concatenation of all component fields', () => {
  const d = get_description();
  assert.equal(d.summary, `${d.purpose} ${d.domain} ${d.operators} ${d.safety}`);
});

test('description mentions both supported operators', () => {
  const d = get_description();
  assert.ok(d.operators.includes('+'), 'operators field must mention +');
  assert.ok(d.operators.includes('-'), 'operators field must mention -');
});

test('description mentions input validation / safety', () => {
  const d = get_description();
  const lower = d.safety.toLowerCase();
  assert.ok(
    lower.includes('valid') || lower.includes('reject'),
    'safety field must describe validation or rejection of bad inputs',
  );
});

test('calling get_description multiple times is stable', () => {
  const a = get_description();
  const b = get_description();
  assert.deepEqual(a, b);
});
