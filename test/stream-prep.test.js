'use strict';
// Sunshine aborts any session whose prep command exits non-zero, before the
// stream starts. So a global_prep_cmd left pointing at the resize script an
// older Clarity Stream installed does not merely fail to resize: it stops
// every launch. Removing the feature without removing this would have been
// worse than leaving the feature in.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const prep = require('../packages/core/stream-prep');

const OURS = path.join(os.homedir(), '.local', 'share', 'clarity-stream', 'stream-display');

function facts(value) {
  return {
    sunshine: {
      installed: true,
      confExists: true,
      confPath: '/nonexistent/sunshine.conf',
      confRaw: value === null ? 'capture = kms\n' : `capture = kms\nglobal_prep_cmd = ${value}\n`
    }
  };
}

test('our own leftover prep command is found', () => {
  const v = JSON.stringify([{ do: `${OURS} start`, undo: `${OURS} stop` }]);
  const state = prep.leftover(facts(v));
  assert.strictEqual(state.present, true);
  assert.strictEqual(state.remaining.length, 0);
});

test("somebody else's prep command is left entirely alone", () => {
  const v = JSON.stringify([{ do: '/usr/local/bin/my-own-thing start', undo: '/usr/local/bin/my-own-thing stop' }]);
  const state = prep.leftover(facts(v));
  assert.strictEqual(state.present, false, 'a prep command we did not write is not ours to remove');
});

test('ours is removed from a list and the rest is kept', () => {
  const v = JSON.stringify([
    { do: `${OURS} start`, undo: `${OURS} stop` },
    { do: '/usr/local/bin/keep-me start', undo: '/usr/local/bin/keep-me stop' }
  ]);
  const state = prep.leftover(facts(v));
  assert.strictEqual(state.present, true);
  assert.strictEqual(state.remaining.length, 1);
  assert.match(state.remaining[0].do, /keep-me/);
});

test('no prep command at all is not a fault', () => {
  assert.strictEqual(prep.leftover(facts(null)).present, false);
});

test('an unparseable prep command is reported, not rewritten', () => {
  // Rewriting something we cannot read is how a working config gets broken.
  const state = prep.leftover(facts('this is not json'));
  assert.strictEqual(state.present, false);
  assert.strictEqual(state.unreadable, true);
});
