'use strict';
// The script Sunshine runs to bring the phantom up and down around a stream.
//
// It is a file rather than an inline command because Sunshine splits a
// prep-cmd on whitespace, and the Lua this has to pass to hyprctl is full of
// spaces, braces and quotes. Inlining it produces a command that looks right
// and is torn into pieces before it runs.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(process.env.HOME || '', '.local', 'share', 'clarity-stream');
const SCRIPT = path.join(DIR, 'phantom');

function contents({ connector, mode, position, scale = 1 }) {
  return `#!/bin/sh
# Written by Clarity Stream. Brings the phantom stream display up for the
# duration of a stream and takes it down afterwards, so it holds no workspace
# and catches no stray pointer while idle.
#
# Hyprland under a Lua config refuses 'hyprctl keyword', so this uses eval.
# Note 'disabled = false': hl.monitor has no 'enabled' field, and setting a
# mode without clearing disabled leaves the output off while still saying ok.
set -eu

CONNECTOR="${connector}"
MODE="${mode}"
POSITION="${position}"
SCALE="${scale}"

case "\${1:-}" in
  on)
    exec hyprctl eval "hl.monitor({ output = \\"\$CONNECTOR\\", disabled = false, mode = \\"\$MODE\\", position = \\"\$POSITION\\", scale = \$SCALE })"
    ;;
  off)
    exec hyprctl eval "hl.monitor({ output = \\"\$CONNECTOR\\", disabled = true })"
    ;;
  *)
    echo "usage: $(basename "\$0") on|off" >&2
    exit 2
    ;;
esac
`;
}

function install(opts) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SCRIPT, contents(opts), { mode: 0o755 });
  return SCRIPT;
}

module.exports = { install, contents, SCRIPT, DIR };
