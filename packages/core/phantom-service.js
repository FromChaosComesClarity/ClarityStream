'use strict';
// A user unit that parks the phantom at login, before Sunshine starts.
//
// Parking is runtime state: Hyprland re-applies its config on every start, so
// the position and the reserved workspace are gone after a reboot and the
// phantom goes back to sitting beside the desktop holding one of the user's
// workspaces. Rather than edit the user's Hyprland config, which Omarchy
// owns and writes in Lua, Clarity Stream brings its own unit.
//
// Ordering is the whole point of it. Sunshine resolves output_name when its
// service starts, so the phantom has to be up and parked before that, or
// every launch fails with "Couldn't find monitor [N]".

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tryExec } = require('./run');

const UNIT_NAME = 'clarity-stream-phantom.service';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, UNIT_NAME);

// A packaged install already ships this unit, pointing at /usr/bin paths that
// do not move. Writing a second copy into the user's directory would shadow
// it and pin the service to wherever the development checkout happened to be
// that day, so the packaged one is used when it is there.
const PACKAGED_UNIT = `/usr/lib/systemd/user/${UNIT_NAME}`;
const PACKAGED_CLI = '/usr/bin/clarity-stream';

function isPackaged() {
  return fs.existsSync(PACKAGED_UNIT) && fs.existsSync(PACKAGED_CLI);
}

function unitText({ nodePath, cliPath, sunshineUnit }) {
  return `[Unit]
Description=Clarity Stream, park the phantom stream display
Documentation=https://github.com/FromChaosComesClarity/ClarityStream
After=graphical-session.target
PartOf=graphical-session.target
# Sunshine binds its capture output when it starts, so the phantom has to
# exist and be parked before it does.
${sunshineUnit ? `Before=${sunshineUnit}\n` : ''}
[Service]
# Long-running rather than oneshot. Parking once is not enough: anything that
# makes Hyprland re-read its config drops the runtime placement, and on this
# machine monitors.lua is rewritten by a bar panel which stores the phantom at
# its original position beside the desktop. Observed drifting back mid-session
# with the oneshot version. This parks once, then watches Hyprland's event
# socket and re-parks whenever it moves.
Type=simple
# Waits for Hyprland to answer first, because graphical-session.target can be
# reached before the compositor is listening.
ExecStart=${nodePath} ${cliPath} phantom --watch --wait 30
Restart=on-failure
RestartSec=5s
# Deliberately no ExecStop. Taking the phantom down when this unit stops
# would mean restarting this unit silently kills capture for a live Sunshine
# session, and Hyprland drops the output at logout regardless. Use
# "clarity-stream phantom --unpark" when removing it is actually wanted.

[Install]
WantedBy=graphical-session.target
`;
}

function install({ nodePath, cliPath, sunshineUnit }) {
  const packaged = isPackaged();
  if (!packaged) {
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(UNIT_PATH, unitText({ nodePath, cliPath, sunshineUnit }), { mode: 0o644 });
  } else {
    // A user unit left over from a development checkout would take priority
    // over the packaged one and keep pointing at a path that may be gone.
    try { fs.unlinkSync(UNIT_PATH); } catch { /* nothing to remove */ }
  }
  const reload = tryExec('systemctl', ['--user', 'daemon-reload'], { timeout: 20000 });
  const enable = tryExec('systemctl', ['--user', 'enable', '--now', UNIT_NAME], { timeout: 30000 });
  return {
    path: packaged ? PACKAGED_UNIT : UNIT_PATH,
    packaged,
    reloaded: reload.ok,
    enabled: enable.ok,
    detail: enable.ok ? null : (enable.stderr || '').trim()
  };
}

function status() {
  const enabled = tryExec('systemctl', ['--user', 'is-enabled', UNIT_NAME]);
  const active = tryExec('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return {
    installed: fs.existsSync(UNIT_PATH) || fs.existsSync(PACKAGED_UNIT),
    packaged: isPackaged(),
    enabled: (enabled.stdout || '').trim() || 'not-found',
    active: (active.stdout || '').trim() || 'unknown'
  };
}

module.exports = { install, status, unitText, isPackaged, UNIT_NAME, UNIT_PATH, PACKAGED_UNIT };
