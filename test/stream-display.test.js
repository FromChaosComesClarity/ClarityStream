'use strict';
// Resizing a real monitor for a session. The dangerous part is not setting
// the mode, it is putting it back, so most of this is about that.
const { test } = require('node:test');
const assert = require('node:assert');
const { chooseMode, parseModes } = require('../packages/core/stream-display');

const MODES = [
  '3440x1440@165.00Hz', '3440x1440@144.00Hz', '3440x1440@60.00Hz',
  '1920x1080@144.00Hz', '1920x1080@60.00Hz', '1920x1080@59.94Hz',
  '2560x1440@60.00Hz', '1280x720@60.00Hz'
];

test('a mode is only offered when the resolution matches exactly', () => {
  // "Nearly" the right size still makes Sunshine scale, and has moved the
  // desktop for nothing.
  assert.strictEqual(chooseMode(MODES, { width: 1366, height: 768, fps: 60 }), null);
  assert.strictEqual(chooseMode(MODES, { width: 3840, height: 2160, fps: 60 }), null);
  assert.ok(chooseMode(MODES, { width: 1920, height: 1080, fps: 60 }));
});

test('the refresh closest to the request wins', () => {
  // 59.94 also clears a 60fps request; 60.00 is the better answer.
  assert.strictEqual(chooseMode(MODES, { width: 1920, height: 1080, fps: 60 }).raw, '1920x1080@60.00Hz');
  // A 120fps client is better served by 144 than by 60.
  assert.strictEqual(chooseMode(MODES, { width: 1920, height: 1080, fps: 120 }).raw, '1920x1080@144.00Hz');
  assert.strictEqual(chooseMode(MODES, { width: 3440, height: 1440, fps: 165 }).raw, '3440x1440@165.00Hz');
});

test('a missing or unreadable mode list is not a crash', () => {
  assert.strictEqual(chooseMode(undefined, { width: 1920, height: 1080, fps: 60 }), null);
  assert.strictEqual(chooseMode([], { width: 1920, height: 1080, fps: 60 }), null);
  assert.strictEqual(chooseMode(['nonsense', ''], { width: 1920, height: 1080, fps: 60 }), null);
});

test('parseModes ignores what it cannot read rather than inventing it', () => {
  const parsed = parseModes(['1920x1080@60.00Hz', 'rubbish', '800x600@75.00Hz']);
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(parsed[0], { width: 1920, height: 1080, refresh: 60, raw: '1920x1080@60.00Hz' });
});

test('an fps the client did not give falls back to 60', () => {
  assert.strictEqual(chooseMode(MODES, { width: 1920, height: 1080 }).raw, '1920x1080@60.00Hz');
});

test('the prep-cmd script can never fail the session', () => {
  // Sunshine aborts a launch when a prep-cmd returns non-zero. Resizing is an
  // improvement to the stream, not a condition of it: a client that cannot
  // have its exact resolution should still get a scaled picture.
  const { scriptContents } = require('../packages/core/stream-display');
  const text = scriptContents({ cliPath: '/usr/bin/clarity-stream' });
  assert.doesNotMatch(text, /exec\s+"\$CLI"/, 'exec would hand its exit status to Sunshine');
  for (const action of ['start', 'stop']) {
    const line = new RegExp(`stream-display ${action}[\\s\\S]*?\\|\\| true`);
    assert.match(text, line, `${action} must not fail the session`);
  }
});

test('the script names an absolute CLI', () => {
  // sudo and systemd both reset PATH, and this machine has no system node.
  const { scriptContents } = require('../packages/core/stream-display');
  assert.match(scriptContents({ cliPath: '/usr/bin/clarity-stream' }), /CLI="\/usr\/bin\/clarity-stream"/);
});
