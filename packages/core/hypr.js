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
//      leaves it off while still answering `ok`. Measured: a phantom
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

function isPresent(connector) {
  return (monitors() ?? []).some((m) => m.name === connector);
}

// Off. A disabled monitor holds no workspace and the pointer cannot wander
// onto it, which is the whole reason the phantom spends its life switched
// off and only appears for the duration of a stream.
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

// Which workspace, if any, the phantom has taken. Hyprland gives a new output
// the next free workspace, so arming a phantom quietly moves one of the
// user's workspaces onto a monitor they cannot see.
function workspaceOn(connector) {
  return (workspaces() ?? []).filter((w) => w.monitor === connector);
}

// Where to park the phantom. Far enough from every real monitor that no edge
// touches it, because Hyprland moves the pointer between monitors by
// adjacency: leave the phantom beside the desktop and the cursor slides onto
// an invisible screen.
function parkPosition(mons) {
  const right = Math.max(...(mons ?? []).map((m) => m.x + Math.round(m.width / (m.scale || 1))), 0);
  return `${right + 6000}x0`;
}

// Bring the phantom up, park it, and give it a workspace of its own.
//
// The workspace matters more than it sounds. Hyprland hands a new output the
// first free workspace, so arming a phantom silently moves one of the user's
// workspaces onto a monitor they cannot see: here it took workspace 2. A
// persistent default rule gives it one nobody is using instead.
//
// The phantom is NOT taken down between streams. Sunshine resolves
// output_name when its service starts, so a phantom that is down at that
// moment makes every launch fail with "Couldn't find monitor [N]" and a 503
// to the client, long before any prep-cmd could raise it.
// Hyprland has no notion of a primary monitor, so a client opens wherever the
// compositor puts it, which in practice is the monitor at the origin. On this
// machine that is a rotated 1440x900 panel sitting at 0x0 while the 3440x1440
// ultrawide starts at 900x0, so Moonlight kept opening sideways on the small
// screen.
//
// The rule is applied at runtime rather than written into the user's config,
// because ~/.config/hypr/monitors.lua is rewritten by a bar panel
// (im0001gt.screens) and anything added inside its managed block is lost.
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

function park(connector, { mode, scale = 1, workspace = 11 } = {}) {
  const steps = [];
  const mons = (monitors() ?? []).filter((m) => m.name !== connector);
  const position = parkPosition(mons);

  steps.push({ what: 'reserve workspace', ...evalLua(
    `hl.workspace_rule(${luaTable({ workspace: String(workspace), monitor: connector, persistent: true, default: true })})`) });

  // A monitor already up keeps whichever workspace it grabbed, so it is
  // cycled off and on to pick up the rule. Measured: without the cycle the
  // phantom held workspace 2 even after the rule was added.
  if (isPresent(connector)) {
    steps.push({ what: 'cycle off', ...disable(connector) });
  }
  steps.push({ what: 'enable and park', ...enable(connector, { mode, position, scale }) });

  // The client should not land on whichever monitor happens to sit at the
  // origin. Done here because this runs at login, after the compositor has
  // read a config Clarity Stream deliberately does not write to.
  steps.push({ what: 'pin client', ...pinClientToLargestMonitor(undefined, { exclude: [connector] }) });

  const after = (monitors() ?? []).find((m) => m.name === connector);
  const held = workspaceOn(connector).map((w) => w.id);
  return {
    ok: Boolean(after),
    connector, position, workspace,
    present: Boolean(after),
    holdsWorkspaces: held,
    // Anything other than the reserved workspace means a real one is still
    // stranded on an invisible monitor.
    strandedWorkspaces: held.filter((id) => id !== workspace),
    steps
  };
}

// Hyprland's event socket. Parking is runtime state, and anything that makes
// the compositor re-read its config throws it away: on this machine
// monitors.lua is rewritten by a bar panel and already holds the phantom at
// its original position, flush against the desktop. Parking once at login is
// therefore not enough; it was observed drifting back mid-session.
//
// So we listen. Events arrive as "name>>payload" lines on .socket2.sock.
function eventSocketPath() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime) return null;
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const base = path.join(runtime, 'hypr');
  if (sig) {
    const p = path.join(base, sig, '.socket2.sock');
    return fs.existsSync(p) ? p : null;
  }
  // Running from a service, the signature is often not in the environment.
  // There is normally exactly one instance, so find it rather than give up.
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, '.socket2.sock'))); }
  catch { return null; }
  return dirs.length === 1 ? path.join(base, dirs[0], '.socket2.sock') : null;
}

// Calls back on events that can move or drop a monitor. Reconnects if the
// compositor restarts, because a watcher that dies quietly is worse than no
// watcher at all: the phantom drifts and nothing says so.
function watchMonitorEvents(onChange, { log = () => {} } = {}) {
  const net = require('node:net');
  const INTERESTING = /^(configreloaded|monitoradded|monitoraddedv2|monitorremoved|monitorremovedv2)/;
  let stop = false;
  let socket = null;

  const connect = () => {
    if (stop) return;
    const p = eventSocketPath();
    if (!p) { setTimeout(connect, 3000); return; }

    socket = net.createConnection(p);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (INTERESTING.test(line)) {
          log(`event: ${line.split('>>')[0]}`);
          onChange(line.split('>>')[0]);
        }
      }
    });
    socket.on('error', (err) => { log(`socket error: ${err.message}`); });
    socket.on('close', () => { if (!stop) setTimeout(connect, 2000); });
  };

  connect();
  return () => { stop = true; if (socket) socket.destroy(); };
}

module.exports = {
  evalLua, monitors, workspaces, isPresent, eventSocketPath, watchMonitorEvents,
  disable, enable, park, parkPosition, pinClientToLargestMonitor,
  snapshot, restore, workspaceOn, luaTable
};
