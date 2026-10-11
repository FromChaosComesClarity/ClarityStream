'use strict';
// VESA Coordinated Video Timings, used to invent a timing for whatever
// resolution a client asks for. Reduced blanking v1 (CVT-RB) is what we emit:
// it keeps the pixel clock low, which matters because the phantom display's
// timing is never actually driven down a cable, it only has to be legal.

const CELL_GRAN = 8;

// Reduced-blanking v1 constants, from the CVT spec.
const RB_MIN_V_BLANK = 460; // microseconds
const RB_H_BLANK = 160;     // pixels, = 80 back porch + 32 sync + 48 front porch
const RB_H_SYNC = 32;
const RB_H_FRONT_PORCH = 48;
const RB_V_FRONT_PORCH = 3;
const RB_MIN_V_BACK_PORCH = 6;
const CLOCK_STEP = 0.25;    // MHz

// Vertical sync width is chosen by aspect ratio, not freely. Anything that
// is not a recognised ratio gets 10 lines, per the spec's catch-all.
function vSyncWidth(hPixels, vLines) {
  const r = hPixels / vLines;
  const near = (a, b) => Math.abs(a - b) < 0.02;
  if (near(r, 4 / 3)) return 4;
  if (near(r, 16 / 9)) return 5;
  if (near(r, 16 / 10)) return 6;
  if (near(r, 5 / 4)) return 7;
  if (near(r, 15 / 9)) return 7;
  return 10;
}

// Returns a complete timing, in the shape an EDID detailed timing
// descriptor needs. Throws rather than rounding silently on nonsense input.
// `exact` keeps the requested width even when it is not a multiple of 8.
// CVT's 8-pixel granularity is a constraint of the formula, not of EDID, and
// 1366x768 is far too common a client resolution to silently serve as 1360.
// We take CVT's blanking and sync figures, then restore the true width and
// recompute the clock from the real totals.
function cvtReducedBlanking(hPixels, vLines, refreshHz, { exact = true } = {}) {
  if (!Number.isFinite(hPixels) || hPixels < 64 || hPixels > 16384) {
    throw new Error(`cvt: horizontal ${hPixels} out of range`);
  }
  if (!Number.isFinite(vLines) || vLines < 64 || vLines > 16384) {
    throw new Error(`cvt: vertical ${vLines} out of range`);
  }
  if (!Number.isFinite(refreshHz) || refreshHz < 20 || refreshHz > 480) {
    throw new Error(`cvt: refresh ${refreshHz} out of range`);
  }

  const hRnd = Math.floor(hPixels / CELL_GRAN) * CELL_GRAN;
  const vRnd = Math.floor(vLines);
  const vSync = vSyncWidth(hRnd, vRnd);

  // Estimate the line period, then see how many blanking lines fit in the
  // minimum vertical blanking interval.
  const hPeriodEst = (1000000 / refreshHz - RB_MIN_V_BLANK) / vRnd;
  const vbiLines = Math.floor(RB_MIN_V_BLANK / hPeriodEst) + 1;
  const minVbi = RB_V_FRONT_PORCH + vSync + RB_MIN_V_BACK_PORCH;
  const actualVbi = vbiLines < minVbi ? minVbi : vbiLines;

  const totalVLines = actualVbi + vRnd;
  const totalPixels = RB_H_BLANK + hRnd;

  // The pixel clock is quantised to 0.25 MHz, downwards, so the real refresh
  // comes out a hair under what was asked for. That is correct per the spec.
  const hActive = exact ? Math.floor(hPixels) : hRnd;
  const totalPixelsExact = RB_H_BLANK + hActive;

  const rawClock = (refreshHz * totalVLines * totalPixelsExact) / 1000000;
  const pixelClockMHz = CLOCK_STEP * Math.floor(rawClock / CLOCK_STEP);
  if (pixelClockMHz <= 0) throw new Error('cvt: computed a zero pixel clock');

  return {
    hActive,
    hBlank: RB_H_BLANK,
    hFrontPorch: RB_H_FRONT_PORCH,
    hSync: RB_H_SYNC,
    hBackPorch: RB_H_BLANK - RB_H_SYNC - RB_H_FRONT_PORCH,
    vActive: vRnd,
    vBlank: actualVbi,
    vFrontPorch: RB_V_FRONT_PORCH,
    vSync,
    vBackPorch: actualVbi - RB_V_FRONT_PORCH - vSync,
    pixelClockMHz,
    // CVT reduced blanking is positive hsync, negative vsync.
    hSyncPositive: true,
    vSyncPositive: false,
    actualRefreshHz: (pixelClockMHz * 1000000) / (totalPixelsExact * totalVLines),
    totalPixels: totalPixelsExact,
    totalVLines
  };
}

module.exports = { cvtReducedBlanking, vSyncWidth };
