'use strict';
// Builds a 128-byte EDID 1.4 base block describing a display that does not
// exist. The kernel's DRM core will hand this to the compositor in place of
// whatever a connector reports, which is how the phantom display gets a real
// CRTC at exactly the client's resolution.
//
// Every field here is checked by edid-decode in the test suite. Do not
// "simplify" a reserved byte: a malformed EDID is rejected silently and the
// connector just stays dark, which is the exact failure this project exists
// to stop happening.

const { cvtReducedBlanking } = require('./cvt');

const EDID_SIZE = 128;

// Three letters, packed five bits each, big-endian, 'A' == 1.
function packManufacturer(id) {
  if (!/^[A-Z]{3}$/.test(id)) throw new Error(`edid: bad manufacturer id ${id}`);
  const v = ((id.charCodeAt(0) - 64) << 10) |
            ((id.charCodeAt(1) - 64) << 5) |
            (id.charCodeAt(2) - 64);
  return [(v >> 8) & 0xff, v & 0xff];
}

// Chromaticity is ten 10-bit fractions crammed into 10 bytes: two bytes of
// low bits, then eight bytes of high bits.
function encodeChromaticity(c) {
  const q = (f) => Math.round(f * 1024) & 0x3ff;
  const rx = q(c.redX), ry = q(c.redY);
  const gx = q(c.greenX), gy = q(c.greenY);
  const bx = q(c.blueX), by = q(c.blueY);
  const wx = q(c.whiteX), wy = q(c.whiteY);
  return [
    ((rx & 3) << 6) | ((ry & 3) << 4) | ((gx & 3) << 2) | (gy & 3),
    ((bx & 3) << 6) | ((by & 3) << 4) | ((wx & 3) << 2) | (wy & 3),
    rx >> 2, ry >> 2, gx >> 2, gy >> 2, bx >> 2, by >> 2, wx >> 2, wy >> 2
  ];
}

// sRGB primaries. The sRGB flag in the feature byte is deliberately NOT set,
// because setting it obliges these to match the sRGB definition exactly and
// the 10-bit quantisation means they do not.
const SRGB = {
  redX: 0.640, redY: 0.330,
  greenX: 0.300, greenY: 0.600,
  blueX: 0.150, blueY: 0.060,
  whiteX: 0.3127, whiteY: 0.3290
};

function detailedTiming(t, widthMm, heightMm) {
  const clock = Math.round(t.pixelClockMHz * 100); // units of 10 kHz
  if (clock < 1 || clock > 0xffff) throw new Error(`edid: pixel clock ${t.pixelClockMHz} MHz will not fit`);

  const b = new Array(18).fill(0);
  b[0] = clock & 0xff;
  b[1] = (clock >> 8) & 0xff;

  b[2] = t.hActive & 0xff;
  b[3] = t.hBlank & 0xff;
  b[4] = ((t.hActive >> 8) & 0x0f) << 4 | ((t.hBlank >> 8) & 0x0f);

  b[5] = t.vActive & 0xff;
  b[6] = t.vBlank & 0xff;
  b[7] = ((t.vActive >> 8) & 0x0f) << 4 | ((t.vBlank >> 8) & 0x0f);

  b[8] = t.hFrontPorch & 0xff;
  b[9] = t.hSync & 0xff;
  b[10] = ((t.vFrontPorch & 0x0f) << 4) | (t.vSync & 0x0f);
  b[11] = ((t.hFrontPorch >> 8) & 3) << 6 |
          ((t.hSync >> 8) & 3) << 4 |
          ((t.vFrontPorch >> 4) & 3) << 2 |
          ((t.vSync >> 4) & 3);

  b[12] = widthMm & 0xff;
  b[13] = heightMm & 0xff;
  b[14] = ((widthMm >> 8) & 0x0f) << 4 | ((heightMm >> 8) & 0x0f);

  b[15] = 0; // horizontal border
  b[16] = 0; // vertical border

  // Digital separate sync, with the polarities CVT-RB calls for.
  b[17] = 0x18 | (t.vSyncPositive ? 0x04 : 0) | (t.hSyncPositive ? 0x02 : 0);
  return b;
}

// Descriptor 0xFC: the name the compositor will show for this output.
function nameDescriptor(name) {
  const b = [0x00, 0x00, 0x00, 0xfc, 0x00];
  const text = name.slice(0, 13);
  for (let i = 0; i < 13; i++) {
    b.push(i < text.length ? text.charCodeAt(i) : 0x0a); // 0x0A terminates, then pad
  }
  return b;
}

// Descriptor 0xFD: display range limits. Required reading for anything that
// wants to drive a non-preferred mode, and cheap to include.
function rangeDescriptor(t, timings = [t], stdSlots = []) {
  // Every advertised mode has to fall inside these limits, including the ones
  // written as standard timings, whose line rates are estimated from CVT.
  const all = [...timings];
  for (const s of stdSlots) {
    try { all.push(require('./cvt').cvtReducedBlanking(s.w, s.h, s.hz)); } catch { /* skip */ }
  }
  const refreshes = all.map((x) => x.actualRefreshHz);
  const lineRates = all.map((x) => (x.pixelClockMHz * 1000) / x.totalPixels);
  const clocks = all.map((x) => x.pixelClockMHz);

  const vMin = Math.max(1, Math.floor(Math.min(...refreshes)) - 1);
  const vMax = Math.ceil(Math.max(...refreshes)) + 1;
  const hMin = Math.max(1, Math.floor(Math.min(...lineRates)) - 1);
  const hMax = Math.ceil(Math.max(...lineRates)) + 1;
  const clockMax = Math.ceil(Math.max(...clocks) / 10); // units of 10 MHz
  return [
    0x00, 0x00, 0x00, 0xfd, 0x00,
    vMin & 0xff, vMax & 0xff, hMin & 0xff, hMax & 0xff, clockMax & 0xff,
    // 0x01 = range limits only. 0x00 would claim default GTF support, which
    // is untrue of a CVT reduced-blanking timing.
    0x01,
    0x0a, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20
  ];
}

// Descriptor 0x10: explicitly unused. Padding a descriptor slot with plain
// zeroes is not legal; it has to be a dummy descriptor.
function dummyDescriptor() {
  return [0x00, 0x00, 0x00, 0x10, 0x00, ...new Array(13).fill(0x00)];
}

// Standard Timing Identifiers: two bytes each, eight slots. A cheap way to
// advertise extra modes beyond the detailed descriptors, which are limited to
// four slots and mostly spoken for.
//
// The encoding is tight and it constrains what can be expressed:
//   byte 0 = (horizontal active / 8) - 31, so width must be a multiple of 8
//            and between 256 and 2288. 2560 does not fit and needs a DTD.
//   byte 1 = aspect ratio in bits 7..6, then (refresh - 60) in bits 5..0.
// Only four aspect ratios exist, so a mode whose ratio is not one of them
// cannot be written here at all.
const ASPECTS = [
  [16 / 10, 0],
  [4 / 3, 1],
  [5 / 4, 2],
  [16 / 9, 3]
];

function standardTiming(width, height, refresh) {
  if (width % 8 !== 0 || width < 256 || width > 2288) return null;
  if (refresh < 60 || refresh > 123) return null;
  // A standard timing stores the width and an aspect ratio; the height is
  // implied by them. So the height has to be exactly what the ratio implies,
  // or the mode advertised is not the mode asked for. Matching on a tolerance
  // alone would turn 1920x1081 into 1920x1080 without saying so, which is the
  // same silent substitution refused for widths in cvt.js.
  const match = ASPECTS.find(([r]) => Math.round(width / r) === height);
  if (!match) return null;
  return [(width / 8) - 31, (match[1] << 6) | ((Math.round(refresh) - 60) & 0x3f)];
}

function buildEdid(opts) {
  const {
    width, height, refresh = 60,
    name = 'Clarity Strm',
    manufacturer = 'CST',
    productCode = 0x0001,
    serial = 0x00000001,
    week = 1,
    year = 2026,
    widthMm, heightMm,
    // Extra modes the phantom should also accept, as [w, h, hz]. They matter
    // because changing the preferred mode means regenerating the EDID, and
    // NVIDIA only reads it at boot. Anything advertised here can be selected
    // at runtime instead, with no reboot.
    extraModes = []
  } = opts;

  const t = cvtReducedBlanking(width, height, refresh);

  // Modes that cannot go in a standard timing slot are candidates for the one
  // spare detailed descriptor. Oversized widths such as 2560 land here.
  const extras = extraModes
    .map(([w, h, hz = 60]) => ({ w, h, hz, std: standardTiming(w, h, hz) }))
    .filter((m) => !(m.w === t.hActive && m.h === t.vActive));
  const stdSlots = extras.filter((m) => m.std).slice(0, 8);
  const dtdCandidate = extras.find((m) => !m.std) ?? null;
  const secondTiming = dtdCandidate
    ? cvtReducedBlanking(dtdCandidate.w, dtdCandidate.h, dtdCandidate.hz)
    : null;

  // Physical size is a lie we have to tell consistently: the compositor uses
  // it to pick a scale factor, so we claim a size that yields ~96 DPI and
  // therefore scale 1. A phantom display that reports 0x0 mm makes Hyprland
  // fall back to guessing.
  const wMm = widthMm ?? Math.round((t.hActive / 96) * 25.4);
  const hMm = heightMm ?? Math.round((t.vActive / 96) * 25.4);

  const e = new Uint8Array(EDID_SIZE);
  let i = 0;
  const put = (...bytes) => { for (const b of bytes) e[i++] = b & 0xff; };

  put(0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00);       // header
  put(...packManufacturer(manufacturer));                     // 8..9
  put(productCode & 0xff, (productCode >> 8) & 0xff);          // 10..11 little-endian
  put(serial & 0xff, (serial >> 8) & 0xff,
      (serial >> 16) & 0xff, (serial >> 24) & 0xff);           // 12..15
  put(week);                                                   // 16
  put(year - 1990);                                            // 17
  put(0x01, 0x04);                                             // 18..19 EDID 1.4

  // Digital input, 8 bits per colour, DisplayPort. The colour-depth field
  // is an enum, not a count: 8 bits is 0b010. Writing 0b001 here claims a
  // 6-bit panel, which edid-decode reports and clients believe.
  put(0x80 | (0x02 << 4) | 0x05);                              // 20

  put(Math.round(wMm / 10), Math.round(hMm / 10));             // 21..22 cm
  put(0x78);                                                   // 23 gamma 2.2
  // Active-off supported, preferred timing is the first DTD. RGB 4:4:4.
  put(0x20 | 0x02);                                            // 24

  put(...encodeChromaticity(SRGB));                            // 25..34
  put(0x00, 0x00, 0x00);                                       // 35..37 no established timings
  for (let n = 0; n < 8; n++) {                                // 38..53
    // 0x01 0x01 is the "unused" marker; a zeroed slot is not legal.
    if (n < stdSlots.length) put(...stdSlots[n].std);
    else put(0x01, 0x01);
  }

  put(...detailedTiming(t, wMm, hMm));                         // 54..71
  // The range limits have to cover every mode advertised, not just the
  // preferred one, or the modes outside them are rejected.
  put(...rangeDescriptor(t, [t, ...(secondTiming ? [secondTiming] : [])], stdSlots)); // 72..89
  put(...nameDescriptor(name));                                // 90..107
  put(...(secondTiming
    ? detailedTiming(secondTiming, wMm, hMm)
    : dummyDescriptor()));                                     // 108..125

  put(0x00);                                                   // 126 no extension blocks

  let sum = 0;
  for (let n = 0; n < 127; n++) sum = (sum + e[n]) & 0xff;
  e[127] = (256 - sum) & 0xff;                                 // 127 checksum

  if (i !== 127) throw new Error(`edid: wrote ${i} bytes before the checksum, expected 127`);
  return {
    bytes: Buffer.from(e),
    timing: t,
    widthMm: wMm,
    heightMm: hMm,
    advertised: [
      { width: t.hActive, height: t.vActive, refresh: t.actualRefreshHz, how: 'preferred' },
      ...(secondTiming ? [{ width: secondTiming.hActive, height: secondTiming.vActive, refresh: secondTiming.actualRefreshHz, how: 'detailed' }] : []),
      ...stdSlots.map((m) => ({ width: m.w, height: m.h, refresh: m.hz, how: 'standard' }))
    ],
    rejected: extras.filter((m) => !m.std && m !== dtdCandidate)
      .map((m) => ({ width: m.w, height: m.h, refresh: m.hz }))
  };
}

module.exports = { buildEdid, packManufacturer, standardTiming, EDID_SIZE };
