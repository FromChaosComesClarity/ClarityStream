'use strict';
// Driving Hyprland.
//
// Two things about this compositor that cost time to learn and are easy to
// get wrong:
//
//   1. Under a Lua config, `hyprctl keyword` is refused outright. It prints
//      "keyword can't work with non-legacy parsers. Use eval." and exits 0,
//      so a script that checks the exit status believes it worked.
//   2. `hl.monitor` has no `enabled` field. Turning a monitor back on means
//      `disabled = false`, and passing mode and position without that flag
//      "re-enabled" with mode and position alone stayed dark.

const fs = require('node:fs');
const path = require('node:path');
const { tryExec } = require('./run');

// hyprctl eval answers `ok` on success and `error: ...` on failure, both with
// exit status 0, so the output is the only signal worth reading.
function evalLua(lua) {
  const r = tryExec('hyprctl', ['eval', lua], { timeout: 10000 });
  const out = (r.stdout || '').trim();
  const failed = !r.ok || /^error/i.test(out) || /can't work with non-legacy/i.test(out);
  return { ok: !failed, output: out, lua };
}

function luaTable(fields) {
  const parts = Object.entries(fields).map(([k, v]) => {
    if (typeof v === 'boolean' || typeof v === 'number') return `${k} = ${v}`;
    return `${k} = "${String(v).replace(/"/g, '\\"')}"`;
  });
  return `{ ${parts.join(', ')} }`;
}

function monitors() {
  const r = tryExec('hyprctl', ['-j', 'monitors']);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function workspaces() {
  const r = tryExec('hyprctl', ['-j', 'workspaces']);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function disable(connector) {
  const r = evalLua(`hl.monitor(${luaTable({ output: connector, disabled: true })})`);
  return { ...r, present: isPresent(connector) };
}

// On, at a specific mode. `disabled = false` is not optional: without it the
// call succeeds and changes nothing.
function enable(connector, { mode, position = 'auto', scale = 1 } = {}) {
  const fields = { output: connector, disabled: false, position, scale };
  if (mode) fields.mode = mode;
  const r = evalLua(`hl.monitor(${luaTable(fields)})`);
  return { ...r, present: isPresent(connector) };
}

// Enough to put every monitor back exactly as it was. Adding or removing an
// output makes Hyprland re-apply its config and silently drop runtime state,
// so this is taken before anything is touched.
function snapshot() {
  const list = monitors();
  if (!list) return null;
  return list.map((m) => ({
    name: m.name,
    description: m.description,
    mode: `${m.width}x${m.height}@${m.refreshRate.toFixed(5)}`,
    position: `${m.x}x${m.y}`,
    scale: m.scale,
    transform: m.transform
  }));
}

function restore(snap) {
  if (!snap) return [];
  return snap.map((m) => {
    const sel = m.description ? `desc:${m.description}` : m.name;
    return evalLua(`hl.monitor(${luaTable({
      output: sel, mode: m.mode, position: m.position, scale: m.scale, disabled: false
    })})`);
  });
}

function pinClientToLargestMonitor(clientClass = 'com.moonlight_stream.Moonlight', { exclude = [] } = {}) {
  const mons = (monitors() ?? []).filter((m) => !exclude.includes(m.name));
  if (!mons.length) return { ok: false, reason: 'no monitors to choose from' };
  const target = mons.reduce((best, m) =>
    (m.width * m.height > best.width * best.height ? m : best), mons[0]);
  // hl.windowrule does not exist; the field is hl.window_rule. Verified by
  // the error the other spelling returns.
  const r = evalLua(`hl.window_rule(${luaTable({ match: clientClass, monitor: target.name })})`);
  return { ...r, monitor: target.name, clientClass };
}

module.exports = {
  evalLua, monitors, workspaces, disable, enable,
  pinClientToLargestMonitor, snapshot, restore, luaTable
};
