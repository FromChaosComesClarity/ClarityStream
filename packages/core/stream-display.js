'use strict';
// Resizing a real monitor for the duration of a stream.
//
// Sunshine hands a prep-cmd the resolution the client asked for, in
// SUNSHINE_CLIENT_WIDTH, SUNSHINE_CLIENT_HEIGHT and SUNSHINE_CLIENT_FPS. So
// the host can set its own display to that mode when a session starts and put
// it back when the session ends, which is what Steam's remote play does.
//
// The cost is honest and unavoidable: the desktop visibly reflows, twice, and
// anything laid out by pixel position moves. The gain is that the client gets
// its own resolution without a phantom display, a kernel parameter or a
// reboot.
//
// Two things this has to get right or it is worse than useless:
//
//   1. Record the current mode BEFORE changing anything, somewhere that
//      survives the session, so the undo has something to restore.
//   2. Never leave the desktop resized. If the undo does not run, because
//      Sunshine died or the machine lost power mid-session, the state file is
//      still there and the host app can offer to put it back.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'clarity-stream');
const STATE_FILE = path.join(STATE_DIR, 'display-before-stream.json');

// Hyprland reports modes as "3440x1440@165.00Hz".
function parseModes(list) {
  return (list ?? []).map((m) => {
    const hit = /^(\d+)x(\d+)@([\d.]+)Hz$/.exec(String(m).trim());
    if (!hit) return null;
    return { width: Number(hit[1]), height: Number(hit[2]), refresh: Number(hit[3]), raw: m };
  }).filter(Boolean);
}

// Which of the monitor's real modes best serves what the client asked for.
//
// Only an exact resolution match is offered: a monitor set to "nearly" the
// requested size still makes Sunshine scale, and it has moved the user's
// desktop for nothing. Better to leave the mode alone and let the scaling
// happen without disturbing anything.
function chooseMode(available, want) {
  const modes = parseModes(available);
  const sameSize = modes.filter((m) => m.width === want.width && m.height === want.height);
  if (!sameSize.length) return null;

  const wantFps = Number(want.fps) || 60;
  // Closest to what the client asked for, tie broken upwards. Picking the
  // lowest refresh that merely clears the request chooses 59.94 over an
  // available 60.00, and picking the fastest drives a 165Hz panel for a 60fps
  // client. A 120fps client with only 60 and 144 available wants 144.
  return [...sameSize].sort((a, b) => {
    const da = Math.abs(a.refresh - wantFps);
    const db = Math.abs(b.refresh - wantFps);
    return da === db ? b.refresh - a.refresh : da - db;
  })[0];
}

function readSaved() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  return STATE_FILE;
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); return true; } catch { return false; }
}

// A desktop left at the wrong size because an undo never ran. The host app
// reports this and offers to put it back.
function strandedResize() {
  const saved = readSaved();
  if (!saved) return null;
  return {
    connector: saved.connector,
    was: `${saved.width}x${saved.height}@${Number(saved.refresh).toFixed(2)}`,
    since: saved.at ?? null,
    scale: saved.scale,
    position: saved.position
  };
}

const SCRIPT_PATH = path.join(os.homedir(), '.local', 'share', 'clarity-stream', 'stream-display');

// The script Sunshine runs. It is a file rather than an inline command
// because a prep-cmd is split on whitespace, and this needs Lua full of
// braces and quotes.
function scriptContents({ cliPath }) {
  return `#!/bin/sh
# Written by Clarity Stream.
#
# Sunshine runs this around a session. On the way in it sets the streamed
# monitor to whatever resolution the client asked for; on the way out it puts
# the monitor back exactly as it was.
#
# Sunshine passes SUNSHINE_CLIENT_WIDTH, SUNSHINE_CLIENT_HEIGHT and
# SUNSHINE_CLIENT_FPS in the environment. The work is done by the Clarity
# Stream CLI so the mode-picking and the saved state live in one place rather
# than being reimplemented in shell.
set -u

CLI="${cliPath}"

case "\${1:-}" in
  start)
    exec "\$CLI" stream-display start \\
      --width "\${SUNSHINE_CLIENT_WIDTH:-0}" \\
      --height "\${SUNSHINE_CLIENT_HEIGHT:-0}" \\
      --fps "\${SUNSHINE_CLIENT_FPS:-60}"
    ;;
  stop)
    # Must not fail the session teardown, whatever happens here.
    "\$CLI" stream-display stop || true
    ;;
  *)
    echo "usage: $(basename "\$0") start|stop" >&2
    exit 2
    ;;
esac
`;
}

function installScript({ cliPath }) {
  fs.mkdirSync(path.dirname(SCRIPT_PATH), { recursive: true });
  fs.writeFileSync(SCRIPT_PATH, scriptContents({ cliPath }), { mode: 0o755 });
  return SCRIPT_PATH;
}

module.exports = {
  parseModes, chooseMode, readSaved, saveState, clearState, strandedResize,
  installScript, scriptContents, STATE_FILE, SCRIPT_PATH
};
