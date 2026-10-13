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
      connectors.push({
        name: c.slice(entry.length + 1),
        sysfs: c,
        status,
        enabled,
        // Writeback connectors are not displays and must never be offered as
        // a phantom candidate.
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

function probeSunshine() {
  const bin = which('sunshine');
  let realBin = null;
  if (bin) { try { realBin = fs.realpathSync(bin); } catch { realBin = bin; } }

  const pkg = tryExec('pacman', ['-Q', 'sunshine']);
  const caps = realBin ? tryExec('getcap', [realBin]) : null;

  // Whether this build can hand a captured frame straight to NVENC, or has to
  // copy it out to system memory and back. Matched on the library soname, not
  // on the substring "cuda": libicudata.so contains it and is unrelated.
  let cudaLinked = null;
  if (realBin) {
    const ldd = tryExec('ldd', [realBin]);
    if (ldd.ok) {
      cudaLinked = /\blibcuda\.so|\blibnvcuvid\.so|\blibnvidia-encode\.so/.test(ldd.stdout);
    }
  }

  // Prefer a config that already exists; otherwise name where one belongs.
  // Sunshine writes its own on first run, and we may need to write ours
  // before it ever starts, so this is never null.
  let confDir = SUNSHINE_CONF_DIRS.find((d) => fs.existsSync(path.join(d, 'sunshine.conf')))
    ?? SUNSHINE_CONF_DIRS[0];
  const confPath = path.join(confDir, 'sunshine.conf');
  const appsPath = path.join(confDir, 'apps.json');

  // Unit state for the user service, which is how sunshine is meant to run
  // on a Wayland session: a system unit has no seat and cannot capture.
  //
  // The unit name is discovered, never assumed. The LizardByte package calls
  // it app-dev.lizardbyte.app.Sunshine.service and declares
  // `Alias=sunshine.service`, but an alias is only created when the unit is
  // enabled. So asking about sunshine.service on a fresh install answers
  // "not-found" and a fix that names it would fail.
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
    confDir, confPath, appsPath,
    confExists: Boolean(confPath && fs.existsSync(confPath)),
    confRaw: confPath ? readText(confPath) : null,
    unitName,
    unitFound: Boolean(unitName),
    cudaLinked,
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

// ------------------------------------------------------ phantom path

function probePhantomSupport() {
  const paramPath = '/sys/module/drm/parameters/edid_firmware';
  let parkService = { installed: false, enabled: 'unknown', active: 'unknown' };
  try { parkService = require('./phantom-service').status(); } catch { /* leave defaults */ }
  return {
    parkService,
    // The DRM core's EDID override. Present does not mean honoured by every
    // driver, which is the whole question on NVIDIA, so this only reports
    // that the knob exists.
    edidFirmwareParamPresent: fs.existsSync(paramPath),
    edidFirmwareParamValue: readText(paramPath) || null,
    firmwareEdidDir: '/lib/firmware/edid',
    firmwareEdidDirExists: fs.existsSync('/lib/firmware/edid'),
    firmwareEdidFiles: readDir('/lib/firmware/edid'),
    kernelCmdline: readText('/proc/cmdline'),
    bootloader: fs.existsSync('/boot/limine.conf') ? 'limine'
      : fs.existsSync('/etc/default/grub') ? 'grub'
      : fs.existsSync('/boot/loader/loader.conf') ? 'systemd-boot'
      : null
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
    moonlight: probeMoonlight(),
    phantom: probePhantomSupport()
  };
}

module.exports = { probe, probeGpus, probeNvidia, probeCompositor, probeSunshine, probeMoonlight, probePhantomSupport };
