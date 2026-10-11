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
// Modes a phantom should advertise beyond its preferred one. NVIDIA reads a
// firmware EDID only at boot, so a mode missing from here costs a reboot
// later. These cover the clients people actually stream to.
const DEFAULT_EXTRA_MODES = [
  [2560, 1440, 60],
  [1600, 900, 60],
  [1280, 800, 60],
  [1280, 720, 60],
  [1024, 768, 60]
];

function planArm(facts, { connector, width, height, refresh = 60, name, extraModes } = {}) {
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

  const built = buildEdid({
    width, height, refresh,
    name: name ?? 'Clarity Strm',
    extraModes: extraModes ?? DEFAULT_EXTRA_MODES
  });
  const { bytes, timing } = built;
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
    advertised: built.advertised,
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

// After a reboot: did the connector actually come up with our EDID?
//
// "Connected" alone is not proof, because a connector can report connected for
// reasons of its own. The decisive check is comparing the EDID the kernel is
// handing out against the file we wrote: identical bytes mean the override was
// honoured and nothing else explains it.
function verifyArmed(connector) {
  const base = '/sys/class/drm';
  const match = fs.existsSync(base)
    ? fs.readdirSync(base).find((d) => d.endsWith(`-${connector}`))
    : null;
  if (!match) return { armed: false, connector, reason: `No sysfs entry for connector ${connector}.` };

  const read = (f) => { try { return fs.readFileSync(`${base}/${match}/${f}`); } catch { return null; } };
  const status = read('status')?.toString().trim() ?? null;
  const live = read('edid');
  const modes = (read('modes')?.toString() ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  const ours = (() => {
    try { return fs.readFileSync(path.join(FIRMWARE_DIR, edidFileName(connector))); } catch { return null; }
  })();

  const edidLength = live ? live.length : 0;
  // A firmware EDID may be padded or truncated to the block size by the
  // driver, so compare the first 128 bytes, which is the whole base block.
  const edidMatches = Boolean(live && ours && live.length >= 128 && ours.length >= 128 &&
    live.subarray(0, 128).equals(ours.subarray(0, 128)));

  const armed = status === 'connected' && edidMatches;
  return {
    armed, connector, sysfs: match, status, edidLength, edidMatches, modes,
    ourEdidPresent: Boolean(ours),
    reason: armed ? null
      : status !== 'connected'
        ? `${connector} reports ${status}; the kernel did not force it on.`
        : edidLength === 0
          ? `${connector} is connected but exposes no EDID.`
          : !ours
            ? `${connector} is connected, but our EDID file is not on disk to compare against.`
            : `${connector} is connected but its EDID is not the one we wrote, so something else is driving it.`
  };
}

// Serialises a plan into the shape the privileged helper accepts. Binary
// contents travel as base64 because a plan is JSON on its way through sudo.
function toHelperPlan(plan, description) {
  return {
    description,
    rebootRequired: Boolean(plan.rebootRequired),
    steps: (plan.steps ?? []).map((s) => {
      if (s.kind !== 'write-file') return s;
      const { contents, binary, ...rest } = s;
      return Buffer.isBuffer(contents)
        ? { ...rest, base64: contents.toString('base64') }
        : { ...rest, contents };
    })
  };
}

module.exports = {
  candidates, planArm, planDisarm, verifyArmed, toHelperPlan, DEFAULT_EXTRA_MODES,
  snapshotMonitors, restoreMonitorsCommands,
  FIRMWARE_DIR, MKINITCPIO_DROPIN, edidFileName
};
