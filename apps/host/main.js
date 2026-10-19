'use strict';
// Clarity Stream, host UI.
//
// The window is a face over packages/core. Every answer it shows comes from
// the same engine the CLI uses, so the UI cannot drift from what
// `clarity-stream doctor` reports, and nothing is computed twice in two
// places with two sets of bugs.
//
// The renderer gets no node integration. Everything crosses through preload
// as a named channel, which keeps the privileged surface small and explicit.

const { app, BrowserWindow, ipcMain, shell, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { probe } = require('../../packages/core/probe');
const { diagnose } = require('../../packages/core/diagnose');
const { applyAll, restartUserService } = require('../../packages/core/apply');
const { enumerateOutputs, defaultOutput } = require('../../packages/core/outputs');
const verify = require('../../packages/core/verify');
const sunshineApps = require('../../packages/core/sunshine-apps');
const clarityApp = require('../../packages/core/clarity-app');
const paths = require('../../packages/core/paths');
const sunshineApi = require('../../packages/core/sunshine-api');

// Set explicitly, not inherited. Launched from a checkout as `electron .`,
// Electron reads the app name out of package.json and the Wayland class comes
// out right by accident. Launched the way the package does it, as
// `electron /opt/clarity-stream/app/apps/host/main.js`, the app directory is
// the one holding main.js, there is no package.json there, and the window
// arrives with the class "electron". Desktop entries and window rules that
// name clarity-stream then match nothing.
app.setName('clarity-stream');
app.setDesktopName('clarity-stream.desktop');

// ------------------------------------------------------- credentials
//
// Accepting a pairing PIN means calling Sunshine's own API, which wants the
// web interface's username and password. They are kept through the OS keyring
// when there is one. Where there is not, Electron's safeStorage falls back to
// obfuscation rather than encryption, and the UI is told so rather than
// implying a safety that is not there.

const CREDS_FILE = () => path.join(app.getPath('userData'), 'sunshine-credentials.json');

function credentialsState() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE(), 'utf8'));
    return { stored: true, username: raw.username ?? null, encrypted: Boolean(raw.enc) };
  } catch {
    return { stored: false, username: null, encrypted: false };
  }
}

function readCredentials() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CREDS_FILE(), 'utf8')); } catch { return null; }
  if (raw.enc) {
    try {
      return { username: raw.username, password: safeStorage.decryptString(Buffer.from(raw.enc, 'base64')) };
    } catch {
      // A keyring that has moved on cannot be recovered from, and silently
      // treating it as "no credentials" is the honest outcome.
      return null;
    }
  }
  return raw.username ? { username: raw.username, password: raw.password ?? '' } : null;
}

function writeCredentials({ username, password }) {
  const dir = path.dirname(CREDS_FILE());
  fs.mkdirSync(dir, { recursive: true });
  const usable = safeStorage.isEncryptionAvailable();
  const payload = usable
    ? { username, enc: safeStorage.encryptString(password).toString('base64') }
    : { username, password };
  // 0600 either way: encrypted at rest is better, unreadable by other users
  // is the minimum.
  fs.writeFileSync(CREDS_FILE(), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { encrypted: usable };
}

function forgetCredentials() {
  try { fs.unlinkSync(CREDS_FILE()); return true; } catch { return false; }
}

const DEV = process.argv.includes('--dev');
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#11131a',
    autoHideMenuBar: true,
    title: 'Clarity Stream',
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

// A probe takes about a second, and several handlers want the same facts
// within one interaction. Cached briefly so a single refresh does not read
// the machine five times, but short enough that the UI never shows a state
// the machine has already left.
let cache = { at: 0, facts: null };
function facts({ fresh = false } = {}) {
  if (!fresh && cache.facts && Date.now() - cache.at < 1500) return cache.facts;
  cache = { at: Date.now(), facts: probe() };
  return cache.facts;
}

function snapshot({ fresh = false } = {}) {
  const f = facts({ fresh });
  const result = diagnose(f);
  const outputs = enumerateOutputs(f);
  const streamedIndex = f.sunshine.confRaw?.match(/^\s*output_name\s*=\s*(\d+)/m)?.[1] ?? null;

  let appsDoc = { apps: [] };
  try { appsDoc = sunshineApps.read(f.sunshine.appsPath); } catch { /* reported below */ }

  return {
    host: f.host,
    kernel: f.kernel,
    compositor: {
      name: f.compositor.desktop,
      version: f.compositor.hyprVersion,
      session: f.compositor.sessionType
    },
    gpus: f.gpus.map((g) => ({
      card: g.card, driver: g.driver, pciId: g.pciId, renderNode: g.renderNode,
      connected: g.connectors.filter((c) => c.status === 'connected').map((c) => c.name),
      drivesDisplay: g.connectedCount > 0
    })),
    sunshine: {
      installed: f.sunshine.installed,
      version: f.sunshine.packageVersion,
      unitName: f.sunshine.unitName,
      enabled: f.sunshine.unitEnabled,
      active: f.sunshine.unitActive,
      capabilities: f.sunshine.capabilities,
      cudaLinked: f.sunshine.cudaLinked,
      confPath: f.sunshine.confPath
    },
    moonlight: f.moonlight,
    outputs: outputs.map((o) => ({
      index: o.index, connector: o.connector, label: o.label,
      connectorId: o.connectorId,
      width: o.monitor?.width ?? null, height: o.monitor?.height ?? null,
      present: Boolean(o.monitor),
      streamed: streamedIndex !== null && String(o.index) === streamedIndex
    })),
    findings: result.findings,
    streamable: result.streamable,
    summary: result.summary,
    apps: appsDoc.apps.map((a) => ({
      name: a.name,
      managed: sunshineApps.isManaged(a),
      cmd: a.cmd ?? null,
      stock: sunshineApps.STOCK_NAMES.includes(a.name)
    })),
    clarity: clarityApp.find(),
    staleDesktopEntries: clarityApp.staleDesktopEntries()
  };
}

ipcMain.handle('status', (_e, opts) => snapshot(opts ?? {}));

ipcMain.handle('fix:apply', (_e, { outputName } = {}) => {
  const f = facts({ fresh: true });
  const result = diagnose(f);
  const out = applyAll(f, result, { outputName, dryRun: false, startService: true });
  cache.at = 0;
  return out;
});

ipcMain.handle('fix:preview', () => {
  const f = facts();
  const result = diagnose(f);
  return applyAll(f, result, { dryRun: true, startService: true });
});

ipcMain.handle('service:restart', () => {
  const f = facts();
  if (!f.sunshine.unitFound) return { ok: false, detail: 'No Sunshine user unit found.' };
  const r = restartUserService(f.sunshine.unitName);
  cache.at = 0;
  return r;
});

ipcMain.handle('firewall:plan', () => {
  const firewall = require('../../packages/core/firewall');
  const st = firewall.detect();
  const plan = firewall.planOpen(st);
  if (!plan.ok) return plan;
  const os = require('node:os');
  const dir = path.join(os.homedir(), '.cache', 'clarity-stream');
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, 'firewall-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return { ...plan, planFile, command: paths.helperCommand(planFile) };
});

// Two frames a moment apart, because one cannot tell a stream from a still.
ipcMain.handle('verify:run', async (_e, { output } = {}) => {
  const f = facts();
  const target = output ?? defaultOutput(f)?.connector ?? null;
  const a = verify.verifyDesktopIsDrawing(target);
  await new Promise((r) => setTimeout(r, 900));
  const b = verify.verifyDesktopIsDrawing(target);
  const card = f.gpus.find((g) => g.connectedCount > 0);
  return {
    output: target,
    first: a,
    second: b,
    comparison: verify.compareFrames(a, b),
    kmsCommand: card
      ? `sudo ${verify.kmsgrabCommand(card.devNode, '/tmp/clarity-stream-kms-check.png').join(' ')}`
      : null
  };
});

ipcMain.handle('apps:preview', () => buildApps(false));
ipcMain.handle('apps:apply', (_e, { pruneStock } = {}) => buildApps(true, pruneStock));

function buildApps(apply, pruneStock = false) {
  const f = facts({ fresh: apply });
  let doc;
  try { doc = sunshineApps.read(f.sunshine.appsPath); }
  catch (err) { return { ok: false, reason: err.message }; }


  // An older version pointed global_prep_cmd at a resize script. Sunshine
  // aborts any session whose prep command fails, so a leftover one stops
  // every launch rather than failing quietly.
  if (apply) require('../../packages/core/stream-prep').remove(f);

  const found = clarityApp.find();
  const entries = [];
  if (found.found) {
    entries.push(sunshineApps.buildEntry({
      name: 'Clarity Couch Mode', cmd: clarityApp.couchCommand(found.path)
    }));
  }
  entries.push(sunshineApps.buildEntry({ name: 'Clarity Desktop' }));

  const changes = entries.map((e) => sunshineApps.upsert(doc, e));
  const stock = sunshineApps.stockPresent(doc);
  let pruned = [];
  if (apply && pruneStock) pruned = sunshineApps.pruneStock(doc);

  if (!apply) return { ok: true, dryRun: true, changes, stock, clarity: found };

  sunshineApps.write(f.sunshine.appsPath, doc);
  let restarted = null;
  if (f.sunshine.unitFound) restarted = restartUserService(f.sunshine.unitName);
  cache.at = 0;
  return { ok: true, dryRun: false, changes, stock, pruned, clarity: found, restarted, path: f.sunshine.appsPath };
}

// ------------------------------------------------------------ pairing

ipcMain.handle('pairing:state', async () => {
  const state = credentialsState();
  const f = facts();
  const result = {
    ...state,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    sunshineRunning: f.sunshine.unitActive === 'active',
    // Sunshine writes a username into its own state the first time any
    // credentials are set. Without that, there is nothing to type here yet.
    sunshineHasCredentials: (() => {
      try {
        const p = path.join(path.dirname(f.sunshine.confPath), 'sunshine_state.json');
        return Boolean(JSON.parse(fs.readFileSync(p, 'utf8')).username);
      } catch { return false; }
    })(),
    webUrl: `https://localhost:${sunshineApi.PORT}`,
    clients: []
  };
  const creds = readCredentials();
  if (creds) {
    const list = await sunshineApi.listClients(creds);
    result.clients = list.clients;
    result.credentialsWork = list.ok;
    if (!list.ok) result.reason = list.reason;
  }
  return result;
});

ipcMain.handle('session:state', async () => {
  const f = facts();
  const s = await sunshineApi.sessionState();
  let appName = null;
  if (s.ok && s.currentGameId) {
    // Sunshine reports the running app by id; the name is in apps.json.
    try {
      const doc = sunshineApps.read(f.sunshine.appsPath);
      appName = doc.apps.find((a) => String(a.id ?? '') === String(s.currentGameId))?.name ?? null;
    } catch { /* the id alone will have to do */ }
  }
  return { ...s, appName, haveCredentials: Boolean(readCredentials()) };
});

ipcMain.handle('session:close', async () => {
  const creds = readCredentials();
  if (!creds) return { ok: false, reason: 'No Sunshine credentials saved yet. Set them under Devices.' };
  return sunshineApi.closeSessionAndConfirm(creds);
});

ipcMain.handle('pairing:saveCredentials', async (_e, { username, password }) => {
  const check = await sunshineApi.checkCredentials({ username, password });
  if (!check.ok) return check;              // never store something that does not work
  const { encrypted } = writeCredentials({ username, password });
  return { ok: true, encrypted };
});

ipcMain.handle('pairing:forgetCredentials', () => ({ ok: forgetCredentials() }));

ipcMain.handle('pairing:submitPin', async (_e, { pin, deviceName }) => {
  const creds = readCredentials();
  if (!creds) return { ok: false, reason: 'No Sunshine credentials saved yet.' };
  return sunshineApi.submitPin(pin, deviceName, creds);
});

ipcMain.handle('pairing:unpair', async (_e, { uuid }) => {
  const creds = readCredentials();
  if (!creds) return { ok: false, reason: 'No Sunshine credentials saved yet.' };
  return sunshineApi.unpairClient(uuid, creds);
});

ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
ipcMain.handle('open:external', (_e, url) => {
  // Only ever open http(s). A renderer bug should not become a way to launch
  // arbitrary things through the shell.
  if (!/^https?:\/\//i.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
