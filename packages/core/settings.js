'use strict';
// Host settings that outlive a single run, kept where both the CLI and the
// window can read them, because they disagree about nothing if they read the
// same file.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE = path.join(os.homedir(), '.config', 'clarity-stream', 'settings.json');

const DEFAULTS = {
  // Nothing persistent yet. Clarity Stream used to carry a display strategy
  // here, choosing between resizing the streamed monitor for the duration of
  // a session and leaving it alone. The resize is gone, so there is nothing
  // left to choose between.
};

function read() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  return next;
}

module.exports = { read, write, DEFAULTS, FILE };
