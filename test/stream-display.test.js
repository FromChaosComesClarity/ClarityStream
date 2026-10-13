'use strict';
// Resizing a real monitor for a session. The dangerous part is not setting
// the mode, it is putting it back, so most of this is about that.
const { test } = require('node:test');
const assert = require('node:assert');
const { chooseMode, parseModes } = require('../packages/core/stream-display');

// Shaped like the development machine's ultrawide: a 21:9 native mode and a
// ladder of 16:9 and 16:10 ones under it.
const MODES = [
  '3440x1440@165.00Hz', '3440x1440@144.00Hz', '3440x1440@60.00Hz',
  '2560x1440@60.00Hz',
  '1920x1080@144.00Hz', '1920x1080@60.00Hz', '1920x1080@59.94Hz',
  '1600x900@60.00Hz', '1280x720@60.00Hz',
  '1920x1200@59.88Hz', '1280x800@59.81Hz'
];

test('an exact resolution is preferred, because nothing scales anywhere', () => {
  assert.strictEqual(chooseMode(MODES, { width: 1920, height: 1080, fps: 60 }).raw, '1920x1080@60.00Hz');
  assert.strictEqual(chooseMode(MODES, { width: 1280, height: 720, fps: 60 }).raw, '1280x720@60.00Hz');
});

test('without an exact mode, the same aspect ratio is used', () => {
  // What makes the picture right on the client is the shape, not the size. A
  // 16:9 client fed a 21:9 capture is letterboxed and most of the bitrate
  // goes on black bars. The panel may look stretched; nobody is watching it.
  const m = chooseMode(MODES, { width: 1366, height: 768, fps: 60 });
  assert.ok(m, '16:9 has other sizes available');
  assert.strictEqual(m.width / m.height, 16 / 9);
});

test('the smallest mode that is big enough wins, so the client never upscales', () => {
  // 1366x768 could take 1280x720 or 1600x900. 1600x900 is the first that does
  // not make the client enlarge the picture.
  assert.strictEqual(chooseMode(MODES, { width: 1366, height: 768, fps: 60 }).raw, '1600x900@60.00Hz');
});

test('when every same-shape mode is smaller, the largest is used', () => {
  const small = ['1280x720@60.00Hz', '1600x900@60.00Hz'];
  assert.strictEqual(chooseMode(small, { width: 3840, height: 2160, fps: 60 }).raw, '1600x900@60.00Hz');
});

test('a shape the monitor cannot make is left alone', () => {
  // Nothing here would improve on letting Sunshine scale, and changing the
  // mode would disturb the desktop for no gain.
  assert.strictEqual(chooseMode(MODES, { width: 800, height: 480, fps: 60 }), null);
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
