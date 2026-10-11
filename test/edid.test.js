'use strict';
// edid-decode is the oracle here. We are not checking that our generator
// agrees with itself, we are checking that the reference EDID parser reads
// back exactly the display we asked for, with no warnings.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEdid, packManufacturer } = require('../packages/core/edid');
const { cvtReducedBlanking } = require('../packages/core/cvt');

function decode(bytes) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-edid-')), 'edid.bin');
  fs.writeFileSync(f, bytes);
  try {
    return execFileSync('edid-decode', [f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
}

const MODES = [
  [1280, 800, 60], [1920, 1080, 60], [1366, 768, 60], [2560, 1440, 120],
  [3440, 1440, 60], [1920, 1200, 90], [800, 480, 60], [3840, 2160, 60]
];

for (const [w, h, r] of MODES) {
  test(`${w}x${h}@${r} decodes as the display we asked for`, () => {
    const { bytes } = buildEdid({ width: w, height: h, refresh: r });
    assert.strictEqual(bytes.length, 128);
    const out = decode(bytes);

    // The preferred timing must be our mode, at our resolution.
    const dtd = out.match(/DTD 1:\s+(\d+)x(\d+)\s+([\d.]+) Hz/);
    assert.ok(dtd, `no DTD 1 in output:\n${out}`);
    assert.strictEqual(Number(dtd[1]), w);
    assert.strictEqual(Number(dtd[2]), h);
    // CVT quantises the clock down, so the refresh lands just under target.
    const hz = Number(dtd[3]);
    assert.ok(hz <= r && hz > r - 0.5, `refresh ${hz} not just under ${r}`);

    assert.match(out, /EDID Structure Version & Revision: 1\.4/);
    assert.match(out, /Bits per primary color channel: 8/);
    assert.match(out, /Range Limits Only/);
    assert.match(out, /Display Product Name: 'Clarity Strm'/);

    // Any complaint from edid-decode is a bug in the generator.
    assert.doesNotMatch(out, /\b(Warning|Error|Failure)\b/i, `edid-decode complained:\n${out}`);
  });
}

test('checksum is correct', () => {
  const { bytes } = buildEdid({ width: 1920, height: 1080, refresh: 60 });
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  assert.strictEqual(sum, 0, 'all 128 bytes must sum to 0 mod 256');
});

test('manufacturer id packs the way the spec says', () => {
  // Worked example: 'ACR' -> A=1, C=3, R=18.
  assert.deepStrictEqual(packManufacturer('ACR'), [(1 << 2) | 0, 0x72]);
  assert.throws(() => packManufacturer('ac'), /bad manufacturer/);
  assert.throws(() => packManufacturer('ACRE'), /bad manufacturer/);
});

test('cvt refuses nonsense instead of rounding it', () => {
  assert.throws(() => cvtReducedBlanking(0, 800, 60), /horizontal/);
  assert.throws(() => cvtReducedBlanking(1280, 0, 60), /vertical/);
  assert.throws(() => cvtReducedBlanking(1280, 800, 5), /refresh/);
});

test('known CVT-RB pixel clocks match the published values', () => {
  // These are from the VESA CVT spec's own reduced-blanking tables.
  assert.strictEqual(cvtReducedBlanking(1280, 800, 60).pixelClockMHz, 71.0);
  assert.strictEqual(cvtReducedBlanking(1920, 1080, 60).pixelClockMHz, 138.5);
  assert.strictEqual(cvtReducedBlanking(1680, 1050, 60).pixelClockMHz, 119.0);
});

// Multi-mode phantoms. The point of these is that NVIDIA reads a firmware
// EDID only at boot, so every mode the phantom should ever offer has to be in
// this one blob. A mode that silently fails to be advertised means a reboot
// the user was promised they would not need.
test('extra modes are advertised and decode back', () => {
  const { bytes, advertised } = buildEdid({
    width: 1920, height: 1080, refresh: 60,
    extraModes: [[2560, 1440, 60], [1280, 720, 60], [1600, 900, 60], [1024, 768, 60]]
  });
  assert.strictEqual(bytes.length, 128);
  const out = decode(bytes);

  assert.match(out, /DTD 1:\s+1920x1080/);
  assert.match(out, /DTD 2:\s+2560x1440/);   // too wide for a standard timing
  assert.match(out, /1280x720/);
  assert.match(out, /1600x900/);
  assert.match(out, /1024x768/);
  assert.doesNotMatch(out, /\b(Warning|Error|Failure)\b/i, out);

  assert.strictEqual(advertised[0].how, 'preferred');
  assert.ok(advertised.length >= 5);
});

test('range limits cover every advertised mode, not just the preferred one', () => {
  const { bytes } = buildEdid({
    width: 1280, height: 720, refresh: 60,
    extraModes: [[2560, 1440, 60]]
  });
  const out = decode(bytes);
  const m = out.match(/Monitor ranges \(Range Limits Only\): (\d+)-(\d+) Hz V, (\d+)-(\d+) kHz H, max dotclock (\d+) MHz/);
  assert.ok(m, `no range limits in:\n${out}`);
  // 2560x1440 needs about 89 kHz and 241.5 MHz; limits built from the
  // preferred 1280x720 alone would cut it off.
  assert.ok(Number(m[4]) >= 89, `H max ${m[4]} kHz excludes the 1440p mode`);
  assert.ok(Number(m[5]) >= 242, `dotclock max ${m[5]} MHz excludes the 1440p mode`);
});

test('standard timings refuse what they cannot encode', () => {
  const { standardTiming } = require('../packages/core/edid');
  assert.strictEqual(standardTiming(2560, 1440, 60), null);  // width over 2288
  assert.strictEqual(standardTiming(1366, 768, 60), null);   // not a multiple of 8
  assert.strictEqual(standardTiming(1920, 1081, 60), null);  // no legal aspect ratio
  assert.deepStrictEqual(standardTiming(1280, 720, 60), [129, 0xc0]);
});

test('the descriptor block is always exactly 127 bytes before the checksum', () => {
  // This guard caught a real bug: a descriptor array passed to put() without
  // being spread wrote one byte instead of eighteen.
  for (const extras of [[], [[2560, 1440, 60]], [[1280, 720, 60], [1024, 768, 60]]]) {
    const { bytes } = buildEdid({ width: 1920, height: 1080, refresh: 60, extraModes: extras });
    assert.strictEqual(bytes.length, 128);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    assert.strictEqual(sum, 0);
  }
});
