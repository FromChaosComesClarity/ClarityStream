'use strict';
// Talking to a streaming host, and to the Moonlight that will connect to it.
//
// Pairing state deliberately comes from Moonlight's own configuration rather
// than from the host. The host's /serverinfo over plain HTTP reports
// PairStatus 0 even for a client that is paired, because pairing is proven
// with a client certificate over HTTPS on 47984. Moonlight stores the host's
// certificate once paired, so the presence of that is the honest signal.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tryExec, which } = require('./run');

const MOONLIGHT_CONF = path.join(
  os.homedir(), '.config', 'Moonlight Game Streaming Project', 'Moonlight.conf');

function tag(xml, name) {
  const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(xml ?? '');
  return m ? m[1] : null;
}

// What the host says about itself. Works unpaired, which is the point: this
// is how a host shows up as reachable before anyone has paired with it.
function serverInfo(address, port = 47989, { uniqueId = '0123456789ABCDEF', timeout = 5000 } = {}) {
  const url = `http://${address}:${port}/serverinfo?uniqueid=${uniqueId}`;
  const r = tryExec('curl', ['-s', '-m', String(Math.ceil(timeout / 1000)), url], { timeout: timeout + 2000 });
  if (!r.ok || !r.stdout) return { reachable: false, reason: 'No answer from the host.' };
  const xml = r.stdout;
  const currentGame = tag(xml, 'currentgame');
  return {
    reachable: true,
    hostname: tag(xml, 'hostname'),
    version: tag(xml, 'appversion'),
    state: tag(xml, 'state'),
    // A session already in progress refuses a new one, and the message a
    // client shows for that is unhelpfully generic, so it is named here.
    busy: /BUSY/i.test(tag(xml, 'state') ?? ''),
    currentGameId: currentGame && currentGame !== '0' ? currentGame : null,
    mac: tag(xml, 'mac')
  };
}

// Moonlight keeps hosts in a Qt .conf: "1\hostname=omarchy" and so on.
function readMoonlightHosts() {
  let text;
  try { text = fs.readFileSync(MOONLIGHT_CONF, 'utf8'); } catch { return []; }

  const hosts = new Map();
  const get = (i) => {
    if (!hosts.has(i)) hosts.set(i, { index: i, apps: [] });
    return hosts.get(i);
  };

  for (const line of text.split('\n')) {
    const m = /^(\d+)\\(.+?)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, idx, key, value] = m;
    const h = get(Number(idx));

    const appMatch = /^apps\\(\d+)\\(.+)$/.exec(key);
    if (appMatch) {
      const [, appIdx, field] = appMatch;
      const n = Number(appIdx) - 1;
      h.apps[n] = h.apps[n] ?? {};
      if (field === 'name') h.apps[n].name = value;
      if (field === 'id') h.apps[n].id = value;
      if (field === 'hidden') h.apps[n].hidden = value === 'true';
      continue;
    }

    if (key === 'hostname') h.hostname = value;
    if (key === 'uuid') h.uuid = value;
    if (key === 'manualaddress') h.manualAddress = value || null;
    if (key === 'localaddress') h.localAddress = value || null;
    if (key === 'remoteaddress') h.remoteAddress = value || null;
    if (key === 'manualport') h.port = Number(value) || 47989;
    // The server certificate only exists once pairing has completed.
    if (key === 'srvcert') h.paired = value.trim().length > 20;
  }

  return [...hosts.values()]
    .filter((h) => h.hostname)
    .map((h) => ({
      ...h,
      apps: h.apps.filter(Boolean).filter((a) => a.name && !a.hidden),
      address: h.manualAddress || h.localAddress || h.remoteAddress || h.hostname,
      paired: Boolean(h.paired)
    }));
}

// Pairing needs the same PIN on both ends. The client picks it, tells
// Moonlight, and the host has to accept it: on a Clarity Stream host that is
// one call to its own API, which is why the PIN is generated here rather than
// read off a dialog nobody can script.
function randomPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function pairCommand(address, pin) {
  return ['moonlight', 'pair', address, '--pin', pin];
}

// How Moonlight gets out of the way of the client's own compositor.
//
//   never       the compositor keeps its shortcuts; Super+W closes the stream
//               window instead of reaching the host
//   fullscreen  shortcuts go to the host while the stream is fullscreen
//   always      shortcuts go to the host even windowed
//
// On Wayland this needs the compositor to implement
// keyboard-shortcuts-inhibit-unstable-v1, which Hyprland does. Whatever the
// setting, Ctrl+Alt+Shift+Q always ends the session: Moonlight reserves it so
// there is a way out of a capture that is working.
const CAPTURE_KEYS = ['never', 'fullscreen', 'always'];
const ESCAPE_COMBO = 'Ctrl+Alt+Shift+Q';

function streamCommand(address, appName, opts = {}) {
  const args = ['stream', address, appName];
  if (opts.captureSystemKeys && CAPTURE_KEYS.includes(opts.captureSystemKeys)) {
    args.push('--capture-system-keys', opts.captureSystemKeys);
  }
  if (opts.resolution) args.push('--resolution', opts.resolution);
  if (opts.fps) args.push('--fps', String(opts.fps));
  if (opts.bitrate) args.push('--bitrate', String(opts.bitrate));
  if (opts.displayMode) args.push('--display-mode', opts.displayMode);
  if (opts.vsync === false) args.push('--no-vsync');
  if (opts.audioConfig) args.push('--audio-config', opts.audioConfig);
  if (opts.multiController === false) args.push('--no-multi-controller');
  if (opts.quitAfter) args.push('--quit-after');
  return ['moonlight', ...args];
}

// Ends the session on the host. Closing the client's window does not: the
// host stays busy and refuses the next connection until its own timeout gives
// up, which is long enough to look like a fault.
function quitCommand(address) {
  return ['moonlight', 'quit', address];
}

function moonlightPresent() {
  return Boolean(which('moonlight'));
}

module.exports = {
  serverInfo, readMoonlightHosts, randomPin, pairCommand, streamCommand,
  quitCommand, moonlightPresent, CAPTURE_KEYS, ESCAPE_COMBO, MOONLIGHT_CONF
};
