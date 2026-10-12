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

const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('node:path');

const { probe } = require('../../packages/core/probe');
const { diagnose } = require('../../packages/core/diagnose');
const { applyAll, restartUserService } = require('../../packages/core/apply');
const { enumerateOutputs, defaultOutput } = require('../../packages/core/outputs');
const phantom = require('../../packages/core/phantom');
const phantomService = require('../../packages/core/phantom-service');
const hypr = require('../../packages/core/hypr');
const verify = require('../../packages/core/verify');
const sunshineApps = require('../../packages/core/sunshine-apps');
const phantomScript = require('../../packages/core/phantom-script');
const clarityApp = require('../../packages/core/clarity-app');

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
  const ph = outputs.find((o) => o.isPhantom) ?? null;
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
      isPhantom: o.isPhantom, connectorId: o.connectorId,
      width: o.monitor?.width ?? null, height: o.monitor?.height ?? null,
      present: Boolean(o.monitor),
      streamed: streamedIndex !== null && String(o.index) === streamedIndex
    })),
    phantom: ph ? {
      connector: ph.connector,
      present: Boolean(ph.monitor),
      position: ph.monitor ? `${ph.monitor.x}x${ph.monitor.y}` : null,
      mode: ph.monitor ? `${ph.monitor.width}x${ph.monitor.height}@${Math.round(ph.monitor.refresh)}` : null,
      modes: (() => { const v = phantom.verifyArmed(ph.connector); return v.modes ?? []; })(),
      workspaces: (f.compositor.workspaces ?? []).filter((w) => w.monitor === ph.connector).map((w) => w.id),
      service: f.phantom.parkService
    } : null,
    phantomCandidates: (() => {
      const c = phantom.candidates(f);
      return { card: c.card?.card ?? null, spare: c.ranked };
    })(),
    armed: /drm\.edid_firmware=/.test(f.phantom.kernelCmdline ?? ''),
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

ipcMain.handle('phantom:plan', (_e, { width, height, refresh, connector } = {}) => {
  const f = facts({ fresh: true });
  const plan = phantom.planArm(f, { width, height, refresh, connector });
  if (!plan.ok) return plan;
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = path.join(os.homedir(), '.cache', 'clarity-stream');
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, 'phantom-plan.json');
  fs.writeFileSync(planFile, JSON.stringify(
    phantom.toHelperPlan(plan, `Arm the phantom display on ${plan.connector} (${width}x${height})`), null, 2));
  const helper = path.join(__dirname, '..', '..', 'bin', 'clarity-stream-helper');
  return {
    ...plan,
    edidBytes: undefined,                      // not serialisable, not needed
    planFile,
    // sudo resets PATH, and this machine has no system node, so the absolute
    // interpreter is the only form that works.
    command: `sudo ${process.execPath} ${helper} ${planFile}`
  };
});

ipcMain.handle('phantom:park', () => {
  const f = facts({ fresh: true });
  const ph = enumerateOutputs(f).find((o) => o.isPhantom);
  if (!ph) return { ok: false, reason: 'No phantom display is armed.' };
  const r = hypr.park(ph.connector, { mode: `${ph.preferredMode ?? '1920x1080'}@60` });
  cache.at = 0;
  return r;
});

ipcMain.handle('phantom:unpark', () => {
  const f = facts({ fresh: true });
  const ph = enumerateOutputs(f).find((o) => o.isPhantom);
  if (!ph) return { ok: false, reason: 'No phantom display is armed.' };
  const r = hypr.disable(ph.connector);
  cache.at = 0;
  return r;
});

ipcMain.handle('phantom:installService', () => {
  const f = facts();
  const r = phantomService.install({
    nodePath: process.execPath,
    cliPath: path.join(__dirname, '..', '..', 'bin', 'clarity-stream'),
    sunshineUnit: f.sunshine.unitName
  });
  cache.at = 0;
  return r;
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

  const ph = enumerateOutputs(f).find((o) => o.isPhantom);
  if (ph && apply) {
    const m = ph.monitor;
    phantomScript.install({
      connector: ph.connector,
      mode: m ? `${m.width}x${m.height}@${Number(m.refresh).toFixed(2)}` : `${ph.preferredMode ?? '1920x1080'}@60`,
      position: m ? `${m.x}x${m.y}` : 'auto',
      scale: m ? m.scale : 1
    });
  }

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
