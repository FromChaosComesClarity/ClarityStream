'use strict';
// The verifier is the part of this project that is allowed to say "it works",
// so it is the part most worth distrusting. These tests are built from
// synthesised frames with known content, plus the two failure modes that were
// actually observed on the development machine.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { measureImage, compareFrames, loopbackWarning, interpretKmsgrabFailure, BLACK_CEILING } =
  require('../packages/core/verify');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-verify-'));
function lavfi(spec, name) {
  const out = path.join(dir, `${name}.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', spec, '-frames:v', '1', '-y', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

test('a black frame is called black', () => {
  const m = measureImage(lavfi('color=black:s=320x240', 'black'));
  assert.ok(m.ok);
  assert.strictEqual(m.verdict, 'black');
  assert.strictEqual(m.isBlack, true);
  assert.ok(m.max <= BLACK_CEILING);
});

test('a uniform fill is not black, but is not detail either', () => {
  const m = measureImage(lavfi('color=gray:s=320x240', 'gray'));
  assert.strictEqual(m.verdict, 'low-detail');
  assert.strictEqual(m.isBlack, false);
  // Mid grey must read as mid grey. Decoding the raw frame as text instead of
  // bytes used to report this as 253.
  assert.ok(m.mean > 120 && m.mean < 136, `mean was ${m.mean}`);
});

test('a detailed frame reads as detail', () => {
  const m = measureImage(lavfi('testsrc=s=320x240', 'busy'));
  assert.strictEqual(m.verdict, 'detailed');
  assert.ok(m.stddev > 20, `stddev was ${m.stddev}`);
});

test('every sample survives the read', () => {
  // 64x64 grid, so a complete read is 4096 samples. A short read means bytes
  // were lost in decoding and every statistic above it is wrong.
  const m = measureImage(lavfi('testsrc=s=320x240', 'busy2'));
  assert.ok(m.ok, m.reason);
  assert.ok(m.max === 255 || m.max > 200, `peak was ${m.max}, bright samples went missing`);
});

test('two identical detailed frames are a still picture, not a fault', () => {
  // An idle display legitimately shows the same thing twice. The capture
  // path is proven by the detail, not by movement.
  const a = measureImage(lavfi('testsrc=s=320x240', 'same1'));
  const b = measureImage(lavfi('testsrc=s=320x240', 'same2'));
  assert.strictEqual(a.signature, b.signature);
  const c = compareFrames(a, b);
  assert.strictEqual(c.verdict, 'still');
  assert.match(c.text, /capture path is working/);
});

test('two identical featureless frames are stuck, which is a fault', () => {
  const a = measureImage(lavfi('color=gray:s=320x240', 'flat1'));
  const b = measureImage(lavfi('color=gray:s=320x240', 'flat2'));
  assert.strictEqual(compareFrames(a, b).verdict, 'stuck');
});

test('two different frames are live', () => {
  const a = measureImage(lavfi('testsrc=s=320x240', 'diff1'));
  const b = measureImage(lavfi('testsrc2=s=320x240', 'diff2'));
  assert.notStrictEqual(a.signature, b.signature);
  assert.strictEqual(compareFrames(a, b).verdict, 'live');
});

test('two black frames are black, not merely static', () => {
  const a = measureImage(lavfi('color=black:s=320x240', 'b1'));
  const b = measureImage(lavfi('color=black:s=320x240', 'b2'));
  assert.strictEqual(compareFrames(a, b).verdict, 'black');
});

test('the loopback warning fires only when the client is on the streamed display', () => {
  assert.ok(loopbackWarning({ streamedConnector: 'DP-2', clientOnConnector: 'DP-2' }));
  assert.strictEqual(loopbackWarning({ streamedConnector: 'DP-2', clientOnConnector: 'DP-1' }), null);
  assert.strictEqual(loopbackWarning({ streamedConnector: 'DP-2' }), null);
});

test('a missing capability is not reported as a black screen', () => {
  const r = interpretKmsgrabFailure('No handle set on framebuffer: maybe you need some additional capabilities?');
  assert.strictEqual(r.cause, 'missing-capability');
  assert.strictEqual(interpretKmsgrabFailure('No such file or directory').cause, 'no-device');
});

test('a missing frame is reported, not treated as black', () => {
  const m = measureImage(path.join(dir, 'does-not-exist.png'));
  assert.strictEqual(m.ok, false);
  assert.match(m.reason, /No frame at/);
});
