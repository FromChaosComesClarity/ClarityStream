'use strict';
// sunshine.conf is a file the user may also have edited by hand. The one
// unforgivable bug in a config manager is silently discarding something it
// did not recognise, so that is what these tests are about.
const { test } = require('node:test');
const assert = require('node:assert');
const { parse, get, apply } = require('../packages/core/sunshine-conf');

const SAMPLE = [
  '# my own notes',
  'sunshine_name = Jose PC',
  '',
  '# something clarity stream has never heard of',
  'future_option = 42',
  'min_log_level = 2',
  '#capture = wlr',
  ''
].join('\n');

test('reads a key', () => {
  assert.strictEqual(get(SAMPLE, 'sunshine_name'), 'Jose PC');
  assert.strictEqual(get(SAMPLE, 'min_log_level'), '2');
});

test('a commented-out setting is not a setting', () => {
  assert.strictEqual(get(SAMPLE, 'capture'), null);
});

test('adding keys preserves comments, blank lines and unknown settings', () => {
  const { text, applied } = apply(SAMPLE, { capture: 'kms', encoder: 'nvenc' });
  assert.match(text, /# my own notes/);
  assert.match(text, /future_option = 42/);
  assert.match(text, /#capture = wlr/);          // the user's comment survives
  assert.strictEqual(get(text, 'capture'), 'kms');
  assert.strictEqual(get(text, 'encoder'), 'nvenc');
  assert.deepStrictEqual(applied.map((a) => a.action), ['added', 'added']);
});

test('changing an existing key edits that line, does not duplicate it', () => {
  const once = apply(SAMPLE, { min_log_level: '0' });
  assert.strictEqual(get(once.text, 'min_log_level'), '0');
  const occurrences = once.text.split('\n').filter((l) => /^min_log_level\s*=/.test(l));
  assert.strictEqual(occurrences.length, 1);
  assert.strictEqual(once.applied[0].action, 'changed');
  assert.strictEqual(once.applied[0].from, '2');
});

test('applying the same value twice reports unchanged and is idempotent', () => {
  const first = apply(SAMPLE, { capture: 'kms' });
  const second = apply(first.text, { capture: 'kms' });
  assert.strictEqual(second.applied[0].action, 'unchanged');
  assert.strictEqual(second.text, first.text);
});

test('an empty config is a legal starting point', () => {
  const { text } = apply('', { capture: 'kms' });
  assert.strictEqual(get(text, 'capture'), 'kms');
});

test('parse ignores malformed lines instead of throwing', () => {
  const { entries } = parse('this is not a setting\n= nope\nkey = value\n');
  assert.strictEqual(entries.size, 1);
  assert.strictEqual(entries.get('key').value, 'value');
});
