'use strict';
// Clarity Stream, client.
//
// A face over moonlight-qt rather than a reimplementation of it. Moonlight
// already does the hard part well: it decodes, it handles input, it owns the
// pairing certificates. What it does not do is make the common case one
// click, and that is all this adds. Everything it knows about hosts is read
// from Moonlight's own configuration, so the two never disagree about what is
// paired.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const discovery = require('../../packages/core/discovery');
const hostLink = require('../../packages/core/host-link');

// A separate identity from the host app, so the two never share a userData
// directory or a window class.
app.setName('clarity-stream-client');
app.setDesktopName('clarity-stream-client.desktop');

const DEV = process.argv.includes('--dev');
let win = null;

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = {
  resolution: '1920x1080',
  fps: 60,
  bitrate: 20000,
  displayMode: 'fullscreen',
  vsync: true,
  preferredApp: 'Clarity Couch Mode'
};

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 720, minHeight: 540,
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    title: 'Clarity Stream Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// Merges what the network advertises with what Moonlight already knows.
// A host can be in either, both, or neither, and each combination means
// something different to the person looking at the list.
function hosts() {
  const found = discovery.discover();
  const known = hostLink.readMoonlightHosts();
  const byName = new Map();

  for (const k of known) {
    byName.set(k.hostname.toLowerCase(), {
      name: k.hostname,
      address: k.address,
      port: k.port ?? 47989,
      paired: k.paired,
      apps: k.apps,
      known: true,
      discovered: false
    });
  }
  for (const d of found.hosts) {
    const key = d.name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.discovered = true;
      // A discovered address beats a stored one: the stored address may be
      // "localhost" from a test, or an address the machine no longer has.
      if (!d.loopback) { existing.address = d.address; existing.port = d.port; }
    } else {
      byName.set(key, {
        name: d.name, address: d.address, port: d.port,
        paired: false, apps: [], known: false, discovered: true
      });
    }
  }

  return [...byName.values()].map((h) => {
    const info = hostLink.serverInfo(h.address, h.port, { timeout: 2500 });
    return {
      ...h,
      reachable: info.reachable,
      busy: Boolean(info.busy),
      state: info.state ?? null,
      version: info.version ?? null,
      currentGameId: info.currentGameId ?? null
    };
  });
}

ipcMain.handle('hosts', () => ({
  hosts: hosts(),
  moonlight: hostLink.moonlightPresent(),
  settings: readSettings()
}));

ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch ?? {}));

// Pairing needs the same four digits at both ends. The client picks them and
// tells Moonlight; a Clarity Stream host can accept them from its own window,
// and any other host needs them typed into its web interface.
ipcMain.handle('pair:start', (_e, { address }) => {
  const pin = hostLink.randomPin();
  const [cmd, ...args] = hostLink.pairCommand(address, pin);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { pin, address };
});

ipcMain.handle('launch', (_e, { address, appName, settings }) => {
  const s = { ...readSettings(), ...(settings ?? {}) };
  const [cmd, ...args] = hostLink.streamCommand(address, appName, {
    resolution: s.resolution,
    fps: s.fps,
    bitrate: s.bitrate,
    displayMode: s.displayMode,
    vsync: s.vsync
  });
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, command: [cmd, ...args].join(' ') };
});

ipcMain.handle('open:moonlight', () => {
  const child = spawn('moonlight', [], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
});

ipcMain.handle('open:external', (_e, url) => {
  if (!/^https?:\/\//i.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
