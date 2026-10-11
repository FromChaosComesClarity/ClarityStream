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
Type=oneshot
RemainAfterExit=yes
# The command waits for Hyprland to answer before doing anything, because
# graphical-session.target can be reached before the compositor is listening.
ExecStart=${nodePath} ${cliPath} phantom --park --wait 30
# Deliberately no ExecStop. Taking the phantom down when this unit stops
# would mean restarting this unit silently kills capture for a live Sunshine
# session, and Hyprland drops the output at logout regardless. Use
# "clarity-stream phantom --unpark" when removing it is actually wanted.

[Install]
WantedBy=graphical-session.target
`;
}

function install({ nodePath, cliPath, sunshineUnit }) {
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(UNIT_PATH, unitText({ nodePath, cliPath, sunshineUnit }), { mode: 0o644 });
  const reload = tryExec('systemctl', ['--user', 'daemon-reload'], { timeout: 20000 });
  const enable = tryExec('systemctl', ['--user', 'enable', UNIT_NAME], { timeout: 20000 });
  return {
    path: UNIT_PATH,
    reloaded: reload.ok,
    enabled: enable.ok,
    detail: enable.ok ? null : (enable.stderr || '').trim()
  };
}

function status() {
  const enabled = tryExec('systemctl', ['--user', 'is-enabled', UNIT_NAME]);
  const active = tryExec('systemctl', ['--user', 'is-active', UNIT_NAME]);
  return {
    installed: fs.existsSync(UNIT_PATH),
    enabled: (enabled.stdout || '').trim() || 'not-found',
    active: (active.stdout || '').trim() || 'unknown'
  };
}

module.exports = { install, status, unitText, UNIT_NAME, UNIT_PATH };
