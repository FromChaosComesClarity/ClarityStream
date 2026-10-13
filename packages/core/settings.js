'use strict';
// Host settings that outlive a single run, kept where both the CLI and the
// window can read them, because they disagree about nothing if they read the
// same file.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE = path.join(os.homedir(), '.config', 'clarity-stream', 'settings.json');

const DEFAULTS = {
  // How a client gets its own resolution.
  //
  //   resize   set the streamed monitor to the client's resolution for the
  //            duration of the session, and put it back afterwards. The
  //            desktop visibly reflows, twice. Nothing to install, no reboot.
  //   phantom  force an unused connector on with a generated EDID, so the
  //            client gets a screen of its own and the desktop is untouched.
  //            Costs a kernel parameter and a reboot, and the compositor has
  //            opinions about the extra output.
  //   none     stream whatever the monitor already is and let the client
  //            scale or letterbox.
  strategy: 'resize'
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
