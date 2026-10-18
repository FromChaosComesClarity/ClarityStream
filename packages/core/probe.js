'use strict';
// Reads the machine. No opinions here, no fixes, no defaults invented: every
// field is something that was actually looked at, and anything that could not
// be read comes back null so the diagnosis can say "unknown" out loud.

const fs = require('node:fs');
const path = require('node:path');
const { tryExec, which } = require('./run');

const readText = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const readDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// ---------------------------------------------------------------- GPUs

function probeGpus() {
  const cards = [];
  for (const entry of readDir('/sys/class/drm')) {
    if (!/^card\d+$/.test(entry)) continue;
    const base = `/sys/class/drm/${entry}`;
    let driver = null, pciId = null, pciAddr = null;
    try {
      driver = path.basename(fs.realpathSync(`${base}/device/driver`));
    } catch { /* leave null */ }
    try {
      pciAddr = path.basename(fs.realpathSync(`${base}/device`));
      const vendor = readText(`${base}/device/vendor`);
      const device = readText(`${base}/device/device`);
      if (vendor && device) pciId = `${vendor.replace('0x', '')}:${device.replace('0x', '')}`;
    } catch { /* leave null */ }

    // Connectors belong to a card by name prefix: card1-DP-1 and so on.
    const connectors = [];
    for (const c of readDir('/sys/class/drm')) {
      if (!c.startsWith(`${entry}-`)) continue;
      const status = readText(`/sys/class/drm/${c}/status`);
      const enabled = readText(`/sys/class/drm/${c}/enabled`);
      // The DRM object id, which is what Sunshine prints when it says which
      // connector it bound. Needed for every connector, not just the
      // connected ones, or a stream bound to an empty port cannot be named.
      const idRaw = readText(`/sys/class/drm/${c}/connector_id`);
      // The mode the connector prefers, which is what a headless or
      // switched-off output can still tell us about itself.
      const modes = readText(`/sys/class/drm/${c}/modes`);
      connectors.push({
        preferredMode: modes ? modes.split('\n')[0].trim() || null : null,
        name: c.slice(entry.length + 1),
        sysfs: c,
        connectorId: idRaw === null ? null : Number(idRaw),
        status,
        enabled,
        // Writeback connectors are not displays and must never be offered as
        isWriteback: /Writeback/i.test(c)
      });
    }

    // Match the render node through by-path, which is the only link that is
    // stable across boots.
    let renderNode = null;
    if (pciAddr) {
      const p = `/dev/dri/by-path/pci-${pciAddr}-render`;
      try { renderNode = fs.realpathSync(p); } catch { /* leave null */ }
    }

    cards.push({
      card: entry,
      devNode: `/dev/dri/${entry}`,
      driver,
      pciId,
      pciAddr,
      renderNode,
      connectors,
      connectedCount: connectors.filter((c) => c.status === 'connected').length,
      spareConnectors: connectors
        .filter((c) => c.status === 'disconnected' && !c.isWriteback)
        .map((c) => c.name)
    });
  }
  cards.sort((a, b) => a.card.localeCompare(b.card));
  return cards;
}

function probeNvidia() {
  const loaded = readText('/proc/modules') || '';
  const present = /\bnvidia\b/.test(loaded);
  if (!present) return { present: false };

  const version = readText('/proc/driver/nvidia/version');
  const smi = tryExec('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);

  // modeset reads empty on recent drivers where it is no longer a tunable;
  // the authoritative signal is whether nvidia_drm is driving connectors.
  const modesetParam = readText('/sys/module/nvidia_drm/parameters/modeset');
  const modprobeConf = readDir('/etc/modprobe.d')
    .map((f) => readText(`/etc/modprobe.d/${f}`) || '')
    .join('\n');

  return {
    present: true,
    driverVersion: smi.ok ? (smi.stdout.split(',')[1] || '').trim() : (version || '').match(/Kernel Module\s+(\S+)/)?.[1] ?? null,
    model: smi.ok ? smi.stdout.split(',')[0].trim() : null,
    isOpenModule: /nvidia_open|nvidia-open/.test(tryExec('sh', ['-c', 'pacman -Qq 2>/dev/null | grep -i nvidia-open']).stdout || ''),
    modesetParam,
    modesetConfigured: /nvidia[-_]drm\s+modeset=1|nvidia_drm\.modeset=1/.test(modprobeConf) ||
                       /nvidia[-_]drm\.modeset=1/.test(readText('/proc/cmdline') || ''),
    nvencPresent: fs.existsSync('/usr/lib/libnvidia-encode.so.1') ||
                  readDir('/usr/lib').some((f) => f.startsWith('libnvidia-encode.so'))
  };
}

// ------------------------------------------------------- compositor

function probeCompositor() {
  const sessionType = process.env.XDG_SESSION_TYPE ?? null;
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? null;
  const hyprSig = process.env.HYPRLAND_INSTANCE_SIGNATURE ?? null;

  let hyprVersion = null, monitors = null, hyprPid = null, workspaceList = null;
  if (which('hyprctl')) {
    const v = tryExec('hyprctl', ['version']);
    if (v.ok) hyprVersion = (v.stdout.match(/Hyprland\s+(\S+)/) || [])[1] ?? null;
    const m = tryExec('hyprctl', ['-j', 'monitors']);
    if (m.ok) {
      try {
        monitors = JSON.parse(m.stdout).map((x) => ({
          name: x.name, width: x.width, height: x.height,
          refresh: x.refreshRate, scale: x.scale, x: x.x, y: x.y,
          focused: x.focused, description: x.description, disabled: x.disabled
        }));
      } catch { monitors = null; }
    }
    const p = tryExec('pidof', ['Hyprland']);
    if (p.ok) hyprPid = Number(p.stdout.trim().split(/\s+/)[0]) || null;
    const w = tryExec('hyprctl', ['-j', 'workspaces']);
    if (w.ok) {
      try { workspaceList = JSON.parse(w.stdout).map((x) => ({ id: x.id, monitor: x.monitor, windows: x.windows })); }
      catch { workspaceList = null; }
    }
  }

  // Which GPU is the compositor actually rendering on? The open file
  // descriptors say so without having to trust a log file that may have
  // rotated. This is what decides whether capture is pointed at the right
  // card, so it is read, not assumed.
  let renderNodesOpen = [];
  if (hyprPid) {
    for (const fd of readDir(`/proc/${hyprPid}/fd`)) {
      try {
        const target = fs.readlinkSync(`/proc/${hyprPid}/fd/${fd}`);
        if (target.startsWith('/dev/dri/')) renderNodesOpen.push(target);
      } catch { /* fd vanished between readdir and readlink */ }
    }
    renderNodesOpen = [...new Set(renderNodesOpen)].sort();
  }

  return {
    sessionType, desktop, hyprVersion, hyprPid, monitors, renderNodesOpen,
    workspaces: workspaceList,
    isWayland: sessionType === 'wayland',
    isHyprland: /hyprland/i.test(desktop || '') || Boolean(hyprSig)
  };
}

// ---------------------------------------------------------- sunshine

const SUNSHINE_CONF_DIRS = [
  path.join(process.env.HOME || '/root', '.config/sunshine'),
  '/etc/sunshine'
];

// Sunshine names the DRM connector it bound, and the config does not: a
// resolved index is not the same as the index we asked for. This reads the
// most recent startup block only, so a connector from a previous boot or a
// previous monitor layout is never reported as current.
function readSunshineLog(logPath) {
  const text = readText(logPath);
  if (text === null) return { logReadable: false, boundConnectorId: null, kmsListEmpty: null };

  // Each start logs the version banner, so the last one marks the live run.
  const lines = text.split('\n');
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('Sunshine version:')) { from = i; break; }
  }
  const run = lines.slice(from);

  const ids = run
    .map((l) => l.match(/Found connector ID \[(\d+)\]/))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  // Which capture backend the running build chose. A host on the Wayland path
  // never logs a connector id at all, and that is not the same as never
  // having started.
  const capturedWith = run.some((l) => /Screencasting with KMS/i.test(l)) ? 'kms'
    : run.some((l) => /Screencasting with Wayland/i.test(l)) ? 'wayland'
    : null;
  const sunshineStarted = run.some((l) => /Sunshine version:/.test(l));
  const cudaWarningAtLastStart = run.some((l) => /without CUDA support/i.test(l));

  // An empty list means Sunshine could not enumerate displays through KMS at
  // all, which is why output_name then resolves to nothing.
  const start = run.findIndex((l) => l.includes('Start of KMS monitor list'));
  const end = run.findIndex((l) => l.includes('End of KMS monitor list'));
  const kmsListEmpty = start === -1 || end === -1 ? null : end === start + 1;

  return {
    logReadable: true,
    sunshineStarted,
    capturedWith,
    cudaWarningAtLastStart,
    boundConnectorId: ids.length ? ids[ids.length - 1] : null,
    kmsListEmpty
  };
}

function probeSunshine() {
  const bin = which('sunshine');
  let realBin = null;
  if (bin) { try { realBin = fs.realpathSync(bin); } catch { realBin = bin; } }

  const pkg = tryExec('pacman', ['-Q', 'sunshine']);
  const caps = realBin ? tryExec('getcap', [realBin]) : null;

  // Whether this build can hand a captured frame straight to NVENC, or has to
  // copy it out to system memory and back.
  //
  // NOT from `ldd`. That was the first test here and it was wrong: Sunshine
  // reaches CUDA through dlopen, so even a CUDA-enabled build links no CUDA
  // library, and the check reported a false fault on the very build that
  // fixes it. Measured on both packages.
  //
  // The build either contains the code path that gives up, or it does not.
  // That string is only compiled in when SUNSHINE_ENABLE_CUDA is off, so its
  // presence is the property itself rather than a proxy for it.
  const GIVE_UP = 'Attempting to use NVENC without CUDA support';
  let cudaCapable = null;
  if (realBin) {
    const strings = tryExec('grep', ['-c', GIVE_UP, realBin]);
    // grep exits 1 with no match, which is the CUDA-enabled case, so the
    // exit status cannot be used to decide whether the check worked.
    if (strings.ok || strings.code === 1) {
      cudaCapable = !(Number(strings.stdout.trim()) > 0);
    }
  }

  // What the running build actually said at its last start, which outranks
  // anything inferred from the file: a package can be swapped without the
  // service being restarted, and then the file and the behaviour disagree.
  // Prefer a config that already exists; otherwise name where one belongs.
  // Sunshine writes its own on first run, and we may need to write ours
  // before it ever starts, so this is never null.
  let confDir = SUNSHINE_CONF_DIRS.find((d) => fs.existsSync(path.join(d, 'sunshine.conf')))
    ?? SUNSHINE_CONF_DIRS[0];
  const confPath = path.join(confDir, 'sunshine.conf');
  const appsPath = path.join(confDir, 'apps.json');
  const logPath = path.join(confDir, 'sunshine.log');

  // Unit state for the user service, which is how sunshine is meant to run
  // on a Wayland session: a system unit has no seat and cannot capture.
  //
  // The unit name is discovered, never assumed. The LizardByte package calls
  // it app-dev.lizardbyte.app.Sunshine.service and declares
  // `Alias=sunshine.service`, but an alias is only created when the unit is
  // enabled. So asking about sunshine.service on a fresh install answers
  // "not-found" and a fix that names it would fail.
  // Read from the running process: limits.conf, PAM and the unit all get a
  // say, and only the result matters.
  let maxNicePriority = null;
  try {
    const pid = tryExec('pgrep', ['-x', 'sunshine']).stdout.trim().split('\n')[0];
    if (pid) {
      const limits = readText(`/proc/${pid}/limits`) ?? '';
      const row = limits.split('\n').find((l) => /Max nice priority/i.test(l));
      if (row) {
        const m = row.match(/Max nice priority\s+(\S+)/);
        if (m && m[1] !== 'unlimited') maxNicePriority = Number(m[1]);
      }
    }
  } catch { /* leave null: not knowing is not a fault */ }

  const unitName = discoverSunshineUnit();
  const unit = unitName ? tryExec('systemctl', ['--user', 'is-enabled', unitName]) : { ok: false, stdout: '' };
  const active = unitName ? tryExec('systemctl', ['--user', 'is-active', unitName]) : { ok: false, stdout: '' };

  return {
    installed: Boolean(bin),
    bin, realBin,
    packageVersion: pkg.ok ? pkg.stdout.trim().split(/\s+/)[1] : null,
    // getcap prints nothing at all when a file has no capabilities, so an
    // empty ok result means "no caps", not "could not tell".
    capabilities: caps && caps.ok ? (caps.stdout.trim() || null) : null,
    capabilitiesReadable: Boolean(caps && caps.ok),
    confDir, confPath, appsPath, logPath,
    ...readSunshineLog(logPath),
    confExists: Boolean(confPath && fs.existsSync(confPath)),
    confRaw: confPath ? readText(confPath) : null,
    unitName,
    unitFound: Boolean(unitName),
    maxNicePriority,
    cudaCapable,
    unitEnabled: unit.ok ? unit.stdout.trim() : (unit.stdout || '').trim() || 'unknown',
    unitActive: active.ok ? active.stdout.trim() : (active.stdout || '').trim() || 'unknown'
  };
}

// Finds whatever the installed package actually called its user unit.
function discoverSunshineUnit() {
  const r = tryExec('systemctl', ['--user', 'list-unit-files', '--all', '--no-legend', '--no-pager']);
  if (!r.ok) return null;
  const names = r.stdout.split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && n.endsWith('.service') && /sunshine/i.test(n));
  if (!names.length) return null;
  // Prefer the real unit over its alias, so enable/disable act on the file.
  return names.find((n) => !/^sunshine\.service$/i.test(n)) ?? names[0];
}

function probeMoonlight() {
  const bin = which('moonlight');
  const pkg = tryExec('pacman', ['-Q', 'moonlight-qt']);
  return {
    installed: Boolean(bin),
    bin,
    packageVersion: pkg.ok ? pkg.stdout.trim().split(/\s+/)[1] : null
  };
}

function probe() {
  const gpus = probeGpus();
  const compositor = probeCompositor();

  // The card that actually has a lit connector is the one capture has to be
  // aimed at. On a two-GPU desktop the other card is a decoy that produces a
  // perfectly black stream.
  const displayCards = gpus.filter((g) => g.connectedCount > 0);

  return {
    probedAt: new Date().toISOString(),
    host: readText('/etc/hostname'),
    kernel: tryExec('uname', ['-r']).stdout.trim() || null,
    gpus,
    displayCards: displayCards.map((g) => g.card),
    nvidia: probeNvidia(),
    compositor,
    sunshine: probeSunshine(),
    firewall: require('./firewall').detect(),
    network: require('./network').detect(),
    settings: require('./settings').read(),
    strandedResize: require('./stream-display').strandedResize(),
    moonlight: probeMoonlight()
  };
}

module.exports = { probe, probeGpus, probeNvidia, probeCompositor, probeSunshine, probeMoonlight };
