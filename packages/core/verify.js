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
const { tryExec, tryExecBinary, which } = require('./run');

// Anything at or below this, across the whole frame, counts as black. 8-bit
// video black is 16 for studio range, so the bar sits just above it.
const BLACK_CEILING = 18;

// Below this spread, a frame carries almost no detail. A real desktop sits
// far above it; a loading screen or a solid fill sits below. Measured on this
// machine: Moonlight's "Starting Desktop..." placeholder gave stddev 3.32,
// a genuine streamed desktop gave 32.7.
const DETAIL_FLOOR = 8;

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
  // Raw pixels, read as bytes. Reading them as text loses every sample above
  // 127, which is most of a bright frame.
  const r = tryExecBinary('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', imagePath,
    '-vf', `format=gray,scale=${grid}:${grid}:flags=area`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'
  ], { timeout: 20000 });

  if (!r.ok) return { ok: false, reason: `ffmpeg could not decode the frame: ${r.stderr?.trim()}` };

  const buf = r.stdout;
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

  // A cheap content signature, so two frames can be compared without keeping
  // the pixels around. Identical signatures mean nothing moved.
  let signature = 0;
  for (let i = 0; i < grid * grid; i++) {
    signature = ((signature * 31) + buf[i]) >>> 0;
  }

  const isBlack = max <= BLACK_CEILING;
  const lowDetail = stddev < DETAIL_FLOOR;

  return {
    ok: true,
    mean: Number(mean.toFixed(2)),
    max, min,
    stddev: Number(stddev.toFixed(2)),
    signature,
    isBlack,
    // Not black, but carrying so little detail that it is more likely a fill
    // or a client-side loading screen than a desktop. This is deliberately
    // not called "live": a single non-black frame is not proof of a stream.
    lowDetail: !isBlack && lowDetail,
    verdict: isBlack ? 'black' : (lowDetail ? 'low-detail' : 'detailed')
  };
}

// One frame cannot tell a stream from a still. Two frames, a moment apart,
// can: a real session moves, even if only the clock or the cursor.
//
// This exists because a single-frame check was fooled here. Moonlight's own
// "Starting Desktop..." placeholder measured peak 104 and was reported live,
// while no video had arrived at all.
function compareFrames(a, b) {
  if (!a?.ok || !b?.ok) {
    return { ok: false, reason: 'Need two readable frames to compare.' };
  }
  const identical = a.signature === b.signature;
  if (a.isBlack && b.isBlack) {
    return { ok: true, verdict: 'black', text: 'Both frames are black. Nothing is being captured.' };
  }
  if (identical) {
    // Identical frames are only a problem when there is nothing in them. A
    // detailed frame that does not change is a real picture of something
    // standing still, which is exactly what an idle display looks like, and
    // it already proves the capture path is not black. Calling that "static"
    // reads as a fault and it is not one.
    if (a.lowDetail) {
      return {
        ok: true,
        verdict: 'stuck',
        text: 'Both frames are identical and nearly featureless, which looks like a placeholder ' +
              'or a loading screen rather than a picture.'
      };
    }
    return {
      ok: true,
      verdict: 'still',
      text: `A real picture, not changing between frames (stddev ${a.stddev}). ` +
            'Normal for a display with nothing moving on it; the capture path is working.'
    };
  }
  if (a.lowDetail && b.lowDetail) {
    return { ok: true, verdict: 'low-detail', text: 'The picture is changing but carries almost no detail. Likely a loading screen.' };
  }
  return {
    ok: true,
    verdict: 'live',
    text: `Live picture, changing between frames (stddev ${a.stddev} and ${b.stddev}).`
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

// Streaming the same display the client window is sitting on makes the
// capture include the client, which is showing the capture. The loop locks
// onto whatever it started with, and since it starts before the first decoded
// frame, it locks onto black. Measured here: streaming DP-2 with the client
// full-screen on DP-2 gave mean 0.97 and two byte-identical frames, while the
// same host streaming DP-1 gave a real picture at stddev 32.7.
//
// It looks exactly like a broken capture and it is not one, so it is worth
// ruling out before anyone goes chasing drivers.
function loopbackWarning({ streamedConnector, clientOnConnector }) {
  if (!streamedConnector || !clientOnConnector) return null;
  if (streamedConnector !== clientOnConnector) return null;
  return {
    risk: 'loopback',
    text: `The client window is on ${clientOnConnector}, which is the display being streamed. ` +
          'That feeds the capture back into itself and reads as a black stream. ' +
          'Move the client to another display, or stream a different one, before trusting this result.'
  };
}

module.exports = {
  measureImage, captureGrim, kmsgrabCommand, verifyDesktopIsDrawing, explain,
  interpretKmsgrabFailure, compareFrames, loopbackWarning,
  BLACK_CEILING, DETAIL_FLOOR
};
