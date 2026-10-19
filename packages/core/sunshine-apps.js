'use strict';
// apps.json is what Moonlight shows as a grid of tiles. Sunshine owns the
// file's schema; the user owns its contents. So entries Clarity Stream adds
// are tagged by name and only those are ever rewritten. Anything else in
// there, including Sunshine's own stock entries and anything added by hand,
// is left exactly as found.

const fs = require('node:fs');
const path = require('node:path');

// Every managed entry starts with this, which is how they are found again.
const PREFIX = 'Clarity';

// Sunshine's stock entries. Listed so they can be reported, not so they can
// be deleted behind the user's back.
const STOCK_NAMES = ['Desktop', 'Low Res Desktop', 'Steam Big Picture'];

function read(appsPath) {
  if (!fs.existsSync(appsPath)) return { env: {}, apps: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
    if (!Array.isArray(parsed.apps)) parsed.apps = [];
    return parsed;
  } catch (err) {
    // A corrupt apps.json must not be silently replaced with a fresh one:
    // that is how someone loses a carefully built list.
    throw new Error(`${appsPath} is not valid JSON (${err.message}). Refusing to overwrite it.`);
  }
}

function write(appsPath, doc) {
  fs.mkdirSync(path.dirname(appsPath), { recursive: true });
  if (fs.existsSync(appsPath)) fs.copyFileSync(appsPath, `${appsPath}.clarity-stream.bak`);
  const tmp = `${appsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 4)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, appsPath);
}

function isManaged(app) {
  return typeof app?.name === 'string' && app.name.startsWith(PREFIX);
}

// Replaces a managed entry in place, keeping its position in the grid, or
// appends it. Position matters: Moonlight shows them in file order and a tile
// that jumps around between syncs is its own small annoyance.
function upsert(doc, entry) {
  const i = doc.apps.findIndex((a) => a.name === entry.name);
  if (i === -1) { doc.apps.push(entry); return { action: 'added', name: entry.name }; }
  const before = JSON.stringify(doc.apps[i]);
  doc.apps[i] = entry;
  return { action: before === JSON.stringify(entry) ? 'unchanged' : 'updated', name: entry.name };
}

function removeManaged(doc) {
  const removed = doc.apps.filter(isManaged).map((a) => a.name);
  doc.apps = doc.apps.filter((a) => !isManaged(a));
  return removed;
}

function stockPresent(doc) {
  return doc.apps.filter((a) => STOCK_NAMES.includes(a.name)).map((a) => {
    // The stock "Low Res Desktop" drives xrandr, which does nothing on a
    // Wayland session. Worth naming rather than leaving as a tile that
    // silently fails.
    const usesXrandr = JSON.stringify(a.prep_cmd ?? a['prep-cmd'] ?? []).includes('xrandr');
    return { name: a.name, brokenOnWayland: usesXrandr };
  });
}

function pruneStock(doc) {
  const removed = doc.apps.filter((a) => STOCK_NAMES.includes(a.name)).map((a) => a.name);
  doc.apps = doc.apps.filter((a) => !STOCK_NAMES.includes(a.name));
  return removed;
}

// An entry, optionally carrying the step that runs around a session.
//
// Under the resize strategy that step sets the streamed monitor to whatever
// resolution the client asked for and puts it back afterwards. Sunshine hands
// it SUNSHINE_CLIENT_WIDTH, HEIGHT and FPS in the environment, which is the
// only way the host can know what the client chose.
function buildEntry({ name, cmd, imagePath, detached = false }) {
  const entry = { name };
  if (imagePath) entry['image-path'] = imagePath;
  if (detached) entry.detached = [cmd];
  else if (cmd) entry.cmd = cmd;
  return entry;
}

module.exports = {
  read, write, upsert, removeManaged, isManaged, stockPresent, pruneStock,
  buildEntry, PREFIX, STOCK_NAMES
};
