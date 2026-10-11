'use strict';
// Proving a stream is not black.
//
// Every guide to this problem ends at "set capture = kms and restart". That
// is where the trouble starts, because a misconfigured Sunshine does not
// error: it negotiates, encodes and sends a flawless stream of pure black.
// Configuring something is not evidence that it works. So Clarity Stream
// captures a frame through the same path Sunshine will use and measures the
// pixels.
//
// Two capture paths, and the difference between them is diagnostic:
//
//   grim    - wlr-screencopy into a shared-memory buffer. Works on NVIDIA,
//             because the compositor does the readback. Proves the desktop
//             is producing pixels, and nothing more.
//   kmsgrab - ffmpeg reading the scanout buffer straight out of DRM. This is
//             the same path as Sunshine's `capture = kms`, so a non-black
//             frame here is real evidence about the real stream. Privileged.
//
// A bright grim frame next to a black kmsgrab frame is the signature of the
// capture being aimed at the wrong GPU.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tryExec, which } = require('./run');

// Anything at or below this, across the whole frame, counts as black. 8-bit
// video black is 16 for studio range, so the bar sits just above it.
const BLACK_CEILING = 18;

function tmpFile(ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-stream-'));
  return { dir, file: path.join(dir, `frame.${ext}`) };
}

// Decodes to a small greyscale raster and measures it in process. Reading the
// pixels ourselves avoids trusting ffmpeg filter metadata, and a 64x64
// downscale is both ample to spot a live desktop and cheap.
function measureImage(imagePath, { grid = 64 } = {}) {
  if (!fs.existsSync(imagePath)) {
    return { ok: false, reason: `No frame at ${imagePath}` };
  }
  const r = tryExec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', imagePath,
    '-vf', `format=gray,scale=${grid}:${grid}:flags=area`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
  ], { timeout: 20000 });

  if (!r.ok) return { ok: false, reason: `ffmpeg could not decode the frame: ${r.stderr?.trim()}` };

  const buf = Buffer.from(r.stdout, 'binary');
  if (buf.length < grid * grid) {
    return { ok: false, reason: `Expected ${grid * grid} samples, got ${buf.length}.` };
  }

  let sum = 0, max = 0, min = 255;
  for (let i = 0; i < grid * grid; i++) {
    const v = buf[i];
    sum += v;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const mean = sum / (grid * grid);
  let variance = 0;
  for (let i = 0; i < grid * grid; i++) variance += (buf[i] - mean) ** 2;
  const stddev = Math.sqrt(variance / (grid * grid));

  return {
    ok: true,
    mean: Number(mean.toFixed(2)),
    max, min,
    stddev: Number(stddev.toFixed(2)),
    // Black means nothing anywhere is bright. A dark but live desktop still
    // has a bright cursor, a panel, a window edge, so max carries the verdict
    // and stddev catches a uniform grey that is also not a real picture.
    isBlack: max <= BLACK_CEILING,
    isFlat: stddev < 1.0,
    verdict: max <= BLACK_CEILING
      ? 'black'
      : (stddev < 1.0 ? 'flat' : 'live')
  };
}

// Unprivileged baseline. Does not prove the stream works; proves the desktop
// is not itself blank, which separates "capture is broken" from "nothing is
// being drawn".
function captureGrim(output) {
  if (!which('grim')) return { ok: false, reason: 'grim is not installed.' };
  const { dir, file } = tmpFile('png');
  const args = output ? ['-o', output, file] : [file];
  const r = tryExec('grim', args, { timeout: 15000 });
  if (!r.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `grim failed: ${r.stderr?.trim()}` };
  }
  return { ok: true, file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// The command that captures through DRM, exactly as Sunshine's kms backend
// does. Returned rather than run, because it needs CAP_SYS_ADMIN and the
// engine never escalates on its own.
function kmsgrabCommand(cardDevNode, outFile) {
  return [
    'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-f', 'kmsgrab',
    '-device', cardDevNode,
    '-framerate', '5',
    '-i', '-',
    // kmsgrab hands over a DRM prime frame; it has to come back to system
    // memory before anything can look at it.
    '-vf', 'hwdownload,format=bgr0',
    '-frames:v', '1',
    '-y', outFile
  ];
}

// kmsgrab's failures are distinguishable, and telling them apart saves the
// user from "fixing" the wrong thing. Measured on this machine: running it
// without the capability prints exactly the first signature below.
function interpretKmsgrabFailure(stderr) {
  const text = String(stderr ?? '');
  if (/No handle set on framebuffer|additional capabilities/i.test(text)) {
    return {
      cause: 'missing-capability',
      text: 'DRM capture was refused for lack of privilege, not because the screen is black. ' +
            'ffmpeg needs CAP_SYS_ADMIN here, exactly as Sunshine does.'
    };
  }
  if (/Permission denied/i.test(text)) {
    return { cause: 'permission', text: 'The DRM device could not be opened at all.' };
  }
  if (/No such file or directory/i.test(text)) {
    return { cause: 'no-device', text: 'That DRM card does not exist on this machine.' };
  }
  if (/Could not find any kms frame|no.*plane/i.test(text)) {
    return {
      cause: 'no-active-plane',
      text: 'The card has no active scanout plane. On a multi-GPU machine this is the ' +
            'signature of capturing the GPU that drives nothing.'
    };
  }
  return { cause: 'unknown', text: text.trim().split('\n')[0] || 'kmsgrab failed without a message.' };
}

function verifyDesktopIsDrawing(output) {
  const cap = captureGrim(output);
  if (!cap.ok) return { path: 'grim', ok: false, reason: cap.reason };
  try {
    const m = measureImage(cap.file);
    return { path: 'grim', output: output ?? '(all outputs)', ...m };
  } finally {
    cap.cleanup();
  }
}

// Interprets the pair of measurements. This is the whole point of taking two.
function explain({ grim, kms }) {
  if (grim && grim.ok && kms && kms.ok) {
    if (!grim.isBlack && kms.isBlack) {
      return {
        conclusion: 'capture-path-broken',
        text: 'The desktop is drawing, but the DRM scanout buffer reads black. ' +
              'Capture is almost certainly aimed at a GPU that is not driving the display, ' +
              'or at a connector with nothing on it.'
      };
    }
    if (grim.isBlack && kms.isBlack) {
      return {
        conclusion: 'nothing-drawn',
        text: 'Both paths read black, so the problem is upstream of capture: ' +
              'the output is blanked, asleep, or showing nothing.'
      };
    }
    if (!kms.isBlack) {
      return {
        conclusion: 'capture-works',
        text: `DRM capture returned a live frame (mean ${kms.mean}, peak ${kms.max}). ` +
              'This is the same path Sunshine uses, so the stream will not be black.'
      };
    }
  }
  return {
    conclusion: 'inconclusive',
    text: 'Not enough measurements to draw a conclusion. The privileged DRM capture is the one that matters.'
  };
}

module.exports = {
  measureImage, captureGrim, kmsgrabCommand, verifyDesktopIsDrawing, explain,
  interpretKmsgrabFailure, BLACK_CEILING
};
