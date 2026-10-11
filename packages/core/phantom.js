'use strict';
// The phantom stream display.
//
// The idea everybody tries first is a compositor-side virtual output
// (`hyprctl output create headless`). It does not work for streaming on
// NVIDIA: a headless output has no CRTC, so there is no scanout buffer, and
// KMS capture — the only capture path that is not black on NVIDIA — has
// nothing to read. See the `headless-output-cannot-be-captured` fault.
//
// So instead we lie to the kernel. An unused physical connector is forced on
// with a synthetic EDID, which gives a real connector, a real CRTC and a real
// scanout buffer at exactly the resolution the client asked for, while the
// desktop monitors are left completely alone.
//
// Three facts learned the hard way, all encoded below:
//
//   1. `drm.edid_firmware=` alone is silently ignored by the NVIDIA driver.
//      It only takes effect together with `video=<CONNECTOR>:e`.
//   2. The EDID file is read during early boot, so it has to be inside the
//      initramfs, not merely present on the root filesystem.
//   3. NVIDIA does not hot-reload a firmware EDID, so arming the phantom
//      always costs one reboot. There is no way around this; promising
//      otherwise would be a lie.

const fs = require('node:fs');
const path = require('node:path');
const { buildEdid } = require('./edid');
const { planAddParams, planRemoveParams } = require('./bootloader');
const { tryExec } = require('./run');

const FIRMWARE_DIR = '/lib/firmware/edid';
const MKINITCPIO_DROPIN = '/etc/mkinitcpio.conf.d/clarity-stream.conf';

function edidFileName(connector) {
  return `clarity-stream-${connector}.bin`;
}

// Rank the connectors we could force. The phantom has to live on the card
// that drives the real displays, otherwise the compositor renders it on one
// GPU while capture reads another.
function candidates(facts) {
  const card = facts.gpus.find((g) => g.connectedCount > 0);
  if (!card) return { card: null, ranked: [] };

  const rank = (name) => {
    // DisplayPort first: DP connectors accept arbitrary CVT timings most
    // readily. HDMI is constrained to CEA modes on some driver versions.
    if (/^DP-/.test(name)) return 0;
    if (/^HDMI/.test(name)) return 1;
    return 2;
  };
  const ranked = [...card.spareConnectors].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { card, ranked };
}

// Produces the complete, declarative plan to arm the phantom. Nothing here
// touches the system; the caller shows this to the user, who approves it, and
// a single privileged helper executes the steps.
function planArm(facts, { connector, width, height, refresh = 60, name } = {}) {
  const { card, ranked } = candidates(facts);
  if (!card) {
    return { ok: false, reason: 'No GPU on this machine is driving a display.' };
  }
  const conn = connector ?? ranked[0];
  if (!conn) {
    return {
      ok: false,
      reason: `No spare connector on ${card.card}. A phantom display needs an unused physical connector to force on.`
    };
  }
  if (!card.spareConnectors.includes(conn)) {
    return {
      ok: false,
      reason: `${conn} is not an unused connector on ${card.card}. ` +
              `Available: ${card.spareConnectors.join(', ') || 'none'}.`
    };
  }

  const { bytes, timing } = buildEdid({ width, height, refresh, name: name ?? 'Clarity Strm' });
  const file = edidFileName(conn);
  const target = path.join(FIRMWARE_DIR, file);

  const params = [
    // Order is deliberate: the override is useless without the force-enable.
    `drm.edid_firmware=${conn}:edid/${file}`,
    `video=${conn}:e`
  ];
  const boot = planAddParams(params);

  // Order matters and is not obvious. Every file has to be in place first;
  // then the initramfs is rebuilt so it contains the EDID; only then is the
  // boot entry regenerated, because under a UKI that step bakes the initramfs
  // and the kernel command line together into one image. Running the
  // bootloader's regenerate before mkinitcpio produces a UKI carrying the new
  // command line and the old initramfs, so the kernel is told to load an EDID
  // that is not there, and the connector stays dark.
  const writes = (boot.steps ?? []).filter((s) => s.kind !== 'run');
  const regenerate = (boot.steps ?? []).filter((s) => s.kind === 'run');

  const steps = [
    { kind: 'write-file', path: target, contents: bytes, mode: 0o644, binary: true },
    {
      kind: 'write-file',
      path: MKINITCPIO_DROPIN,
      mode: 0o644,
      contents: [
        '# Clarity Stream. The phantom display EDID is read during early boot,',
        '# so it has to live inside the initramfs, not just on disk.',
        '# Delete this file and rebuild the initramfs to undo it.',
        `FILES+=(${target})`,
        ''
      ].join('\n')
    },
    ...writes,
    { kind: 'run', argv: ['mkinitcpio', '-P'] },
    ...regenerate
  ];

  return {
    ok: true,
    connector: conn,
    card: card.card,
    edidPath: target,
    edidBytes: bytes,
    timing,
    kernelParams: params,
    bootloader: boot.bootloader,
    alreadyActive: Boolean(boot.alreadyActive),
    // Always true on NVIDIA, and said out loud rather than discovered later.
    rebootRequired: true,
    steps,
    // Arming the phantom adds an output, and adding an output makes the
    // compositor re-apply its monitor configuration, which silently discards
    // any runtime monitor state. Measured on Hyprland 0.56.2: a monitor left
    // at a runtime 165 Hz snapped back to the 60 Hz in its config file.
    monitorStateAtRisk: true,
    monitorSnapshot: snapshotMonitors()
  };
}

function planDisarm() {
  const boot = planRemoveParams();
  return {
    ok: true,
    rebootRequired: true,
    // Same reasoning in reverse: remove the files, rebuild the initramfs,
    // then regenerate the boot entry.
    steps: [
      ...(boot.steps ?? []).filter((s) => s.kind !== 'run'),
      { kind: 'remove-file', path: MKINITCPIO_DROPIN },
      { kind: 'run', argv: ['mkinitcpio', '-P'] },
      ...(boot.steps ?? []).filter((s) => s.kind === 'run')
    ]
  };
}

// Record enough to put every monitor back exactly as it was, because we are
// about to trigger a reconfigure that will not preserve it.
function snapshotMonitors() {
  const r = tryExec('hyprctl', ['-j', 'monitors']);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout).map((m) => ({
      name: m.name, description: m.description,
      mode: `${m.width}x${m.height}@${m.refreshRate.toFixed(5)}`,
      position: `${m.x}x${m.y}`, scale: m.scale, transform: m.transform
    }));
  } catch { return null; }
}

// Hyprland under a Lua config refuses `hyprctl keyword` outright; `eval` with
// the hl.* API is the only form that applies.
function restoreMonitorsCommands(snapshot) {
  if (!snapshot) return [];
  return snapshot.map((m) => {
    const sel = m.description ? `desc:${m.description}` : m.name;
    const lua = `hl.monitor({ output = "${sel}", mode = "${m.mode}", position = "${m.position}", scale = ${m.scale} })`;
    return ['hyprctl', 'eval', lua];
  });
}

// After a reboot: did the connector actually come up with our EDID? This is
// the only honest confirmation that the phantom exists.
function verifyArmed(connector) {
  const base = `/sys/class/drm`;
  const match = fs.existsSync(base)
    ? fs.readdirSync(base).find((d) => d.endsWith(`-${connector}`))
    : null;
  if (!match) return { armed: false, reason: `No sysfs entry for connector ${connector}.` };

  const status = (() => { try { return fs.readFileSync(`${base}/${match}/status`, 'utf8').trim(); } catch { return null; } })();
  let edidLen = 0;
  try { edidLen = fs.statSync(`${base}/${match}/edid`).size; } catch { /* stays 0 */ }

  // sysfs reports EDID size as 0 for a connector with nothing attached, so a
  // non-zero length on a connector with no cable is the signature of the
  // override having been honoured.
  return {
    armed: status === 'connected' && edidLen > 0,
    connector, sysfs: match, status, edidLength: edidLen,
    reason: status !== 'connected'
      ? `${connector} reports ${status}; the kernel did not force it on.`
      : edidLen === 0
        ? `${connector} is connected but exposes no EDID.`
        : null
  };
}

module.exports = {
  candidates, planArm, planDisarm, verifyArmed,
  snapshotMonitors, restoreMonitorsCommands,
  FIRMWARE_DIR, MKINITCPIO_DROPIN, edidFileName
};
