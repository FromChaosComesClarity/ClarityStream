'use strict';
// Detectors are tested against made-up machines, because a detector that
// never fires looks exactly like one that works on a healthy host. Each case
// here is a state this project actually hit on real hardware.
const { test } = require('node:test');
const assert = require('node:assert');
const { FAULTS } = require('../packages/core/faults');
const { diagnose } = require('../packages/core/diagnose');

const byId = (id) => FAULTS.find((f) => f.id === id);

// A healthy NVIDIA host, as this machine ended up.
function healthy() {
  return {
    gpus: [
      { card: 'card0', driver: 'amdgpu', renderNode: '/dev/dri/renderD129', connectedCount: 0, spareConnectors: ['DP-4'], connectors: [] },
      {
        card: 'card1', driver: 'nvidia', renderNode: '/dev/dri/renderD128', connectedCount: 3,
        spareConnectors: [],
        connectors: [
          { name: 'DP-1', sysfs: 'card1-DP-1', connectorId: 826, status: 'connected', enabled: 'enabled', isWriteback: false },
          { name: 'DP-2', sysfs: 'card1-DP-2', connectorId: 830, status: 'connected', enabled: 'enabled', isWriteback: false },
          { name: 'DP-3', sysfs: 'card1-DP-3', connectorId: 834, status: 'connected', enabled: 'enabled', isWriteback: false }
        ]
      }
    ],
    nvidia: { present: true, nvencPresent: true, modesetConfigured: true },
    compositor: {
      isWayland: true, isHyprland: true,
      monitors: [
        { name: 'DP-1', width: 1440, height: 900, scale: 1, x: 0, y: 0, refresh: 75 },
        { name: 'DP-2', width: 3440, height: 1440, scale: 1.25, x: 900, y: 0, refresh: 165, focused: true },
        { name: 'DP-3', width: 1920, height: 1080, scale: 1, x: 9652, y: 0, refresh: 60 }
      ],
      workspaces: [{ id: 1, monitor: 'DP-2' }, { id: 11, monitor: 'DP-3' }]
    },
    sunshine: {
      installed: true, realBin: '/usr/bin/sunshine', capabilitiesReadable: true,
      capabilities: '/usr/bin/sunshine cap_sys_admin,cap_sys_nice=p',
      unitFound: true, unitName: 'app-dev.lizardbyte.app.Sunshine.service',
      unitEnabled: 'enabled', unitActive: 'active', cudaLinked: true,
      confRaw: 'capture = kms\nadapter_name = /dev/dri/renderD128\nencoder = nvenc\noutput_name = 2\n',
      logReadable: true, boundConnectorId: 830, kmsListEmpty: false
    },
    moonlight: { installed: true }
  };
}

// enumerateOutputs reads real sysfs for connector ids, so these cases assert
// on faults that do not depend on it where possible.
test('a healthy host reports no blockers', () => {
  const r = diagnose(healthy());
  assert.strictEqual(r.blockers.length, 0, JSON.stringify(r.blockers.map((b) => b.id)));
  assert.strictEqual(r.streamable, true);
});

test('wlr capture on NVIDIA Wayland is a blocker, kms is not', () => {
  const f = healthy();
  f.sunshine.confRaw = 'capture = wlr\n';
  const hit = byId('nvidia-wlr-capture-is-black').detect(f);
  assert.ok(hit, 'wlr should fire');
  assert.deepStrictEqual(hit.fix.changes, { capture: 'kms' });

  f.sunshine.confRaw = 'capture = kms\n';
  assert.strictEqual(byId('nvidia-wlr-capture-is-black').detect(f), null);
});

test('unset capture on NVIDIA Wayland still fires, because the default is wlr', () => {
  const f = healthy();
  f.sunshine.confRaw = '';
  const hit = byId('nvidia-wlr-capture-is-black').detect(f);
  assert.ok(hit);
  assert.match(hit.evidence, /unset/);
});

test('a missing capability is caught, and a present one is not', () => {
  const f = healthy();
  f.sunshine.capabilities = null;
  assert.ok(byId('kms-missing-capability').detect(f));
  f.sunshine.capabilities = '/usr/bin/sunshine cap_sys_admin,cap_sys_nice=p';
  assert.strictEqual(byId('kms-missing-capability').detect(f), null);
});

test('an unreadable capability reports unknown rather than assuming the good case', () => {
  const f = healthy();
  f.sunshine.capabilitiesReadable = false;
  f.sunshine.capabilities = null;
  const hit = byId('kms-missing-capability').detect(f);
  assert.ok(hit);
  assert.strictEqual(hit.unknown, true);
});

test('capture pinned to the idle GPU is caught', () => {
  const f = healthy();
  f.sunshine.confRaw = 'capture = kms\nadapter_name = /dev/dri/renderD129\n';
  const hit = byId('capture-aimed-at-idle-card').detect(f);
  assert.ok(hit);
  assert.strictEqual(hit.fix.changes.adapter_name, '/dev/dri/renderD128');
});

test('a headless output as the stream target is a blocker', () => {
  const f = healthy();
  f.sunshine.confRaw = 'output_name = HEADLESS-1\n';
  const hit = byId('headless-output-cannot-be-captured').detect(f);
  assert.ok(hit);
  assert.match(hit.detail, /no CRTC|cannot see/i);
});

test('NVENC without CUDA is reported, and a CUDA build is not', () => {
  const f = healthy();
  f.sunshine.cudaLinked = false;
  assert.ok(byId('nvenc-without-cuda').detect(f));
  f.sunshine.cudaLinked = true;
  assert.strictEqual(byId('nvenc-without-cuda').detect(f), null);
  // Unknown linkage must not be reported as a fault.
  f.sunshine.cudaLinked = null;
  assert.strictEqual(byId('nvenc-without-cuda').detect(f), null);
});

test('capture bound to a port with nothing on it is a blocker', () => {
  // Measured on the development machine: a monitor was unplugged, the kernel
  // left its connector disconnected but still enabled, and Sunshine kept
  // binding it across restarts. Config alone cannot see this; only the log
  // says which port Sunshine actually chose.
  const f = healthy();
  f.sunshine.boundConnectorId = 826;                   // DP-1
  f.compositor.monitors = [{ name: 'DP-2', width: 3440, height: 1440, scale: 1, x: 0, y: 0, refresh: 60 }];
  f.gpus[1].connectors[0].status = 'disconnected';

  const hit = byId('capture-bound-to-undriven-connector').detect(f);
  assert.ok(hit, 'binding an unplugged port is a blocker');
  assert.match(hit.evidence, /826 \(DP-1\)/);
  assert.match(hit.evidence, /disconnected but still enabled/);
  assert.match(hit.evidence, /driving DP-2/);
  assert.match(hit.detail, /Rebooting clears it/);
  assert.strictEqual(hit.fix.kind, 'reboot-to-clear-connectors');
  assert.strictEqual(diagnose(f).streamable, false);
});

test('capture bound to a display the compositor is driving says nothing', () => {
  const f = healthy();
  f.sunshine.boundConnectorId = 830;                   // DP-2, which is driven
  assert.strictEqual(byId('capture-bound-to-undriven-connector').detect(f), null);
});

test('a Sunshine that has never started is not reported as mis-bound', () => {
  // No log, or a log with no connector line, is not evidence of a fault. It
  // is the absence of evidence, and those are reported differently.
  const f = healthy();
  f.sunshine.boundConnectorId = null;
  assert.strictEqual(byId('capture-bound-to-undriven-connector').detect(f), null);

  const g = healthy();
  g.sunshine.logReadable = false;
  g.sunshine.boundConnectorId = null;
  assert.strictEqual(byId('capture-bound-to-undriven-connector').detect(g), null);
});

test('an unreachable compositor cannot confirm the bound port either', () => {
  const f = healthy();
  f.sunshine.boundConnectorId = 826;
  f.compositor.monitors = null;
  const hit = byId('capture-bound-to-undriven-connector').detect(f);
  assert.ok(hit);
  assert.strictEqual(hit.unknown, true);
  assert.match(hit.title, /could not check/i);
  assert.ok(!diagnose(f).blockers.map((b) => b.id).includes('capture-bound-to-undriven-connector'));
});

test('fixes are ordered by dependency: the capability precedes the capture switch', () => {
  const f = healthy();
  f.sunshine.confRaw = '';
  f.sunshine.capabilities = null;
  const ids = diagnose(f).findings.map((x) => x.id);
  const cap = ids.indexOf('kms-missing-capability');
  const capture = ids.indexOf('nvidia-wlr-capture-is-black');
  assert.ok(cap !== -1 && capture !== -1);
  assert.ok(cap < capture, `capability (${cap}) must come before capture (${capture})`);
});

test('a detector that throws is reported, not swallowed', () => {
  const broken = {};  // nothing a detector needs
  const r = diagnose(broken);
  assert.ok(r.findings.some((x) => x.detectorFailed), 'a thrown detector should surface');
});

test('a compositor that cannot be reached is unknown, not a fault', () => {
  // Run outside the graphical session and hyprctl answers nothing, so every
  // output looks undriven. Reporting a healthy pin as stale is a false
  // blocker, and the whole point of this project is that a confident wrong
  // answer is the expensive failure.
  const f = healthy();
  f.compositor.monitors = null;
  f.compositor.workspaces = null;

  const hit = byId('output-pin-is-stale').detect(f);
  assert.ok(hit, 'it should still say something');
  assert.strictEqual(hit.unknown, true);
  assert.strictEqual(hit.fix.kind, 'none');
  assert.match(hit.evidence, /did not answer/i);
  assert.match(hit.title, /could not check/i);

  // And it must not be counted as something that stops a stream.
  const r = diagnose(f);
  assert.ok(!r.blockers.map((b) => b.id).includes('output-pin-is-stale'));
});

test('an unknown check is reported but does not claim a stream would fail', () => {
  const f = healthy();
  f.compositor.monitors = null;
  f.compositor.workspaces = null;
  const r = diagnose(f);
  assert.strictEqual(r.blockers.length, 0, 'an unknown is not a blocker');
  assert.ok(r.unknowns.length >= 1);
  assert.strictEqual(r.streamable, null, 'neither yes nor no');
  assert.match(r.summary, /could not be made/);
});

test('a real blocker still reads as a blocker', () => {
  const f = healthy();
  f.sunshine.confRaw = 'capture = wlr\n';
  const r = diagnose(f);
  assert.strictEqual(r.streamable, false);
  assert.ok(r.blockers.some((b) => b.id === 'nvidia-wlr-capture-is-black'));
});

test('an unknown does not keep a headline that asserts the fault', () => {
  const f = healthy();
  f.compositor.monitors = null;
  const finding = diagnose(f).findings.find((x) => x.id === 'output-pin-is-stale');
  assert.ok(finding);
  // The title must not claim the thing the evidence says was never checked.
  assert.doesNotMatch(finding.title, /is not there/i);
  assert.match(finding.title, /could not check/i);
});

test('a default-deny firewall with no stream ports is a blocker', () => {
  const f = healthy();
  f.firewall = {
    present: true, kind: 'ufw', active: true, policy: 'DROP', blocking: true, unknown: false,
    missing: [{ port: 47989, proto: 'tcp' }, { port: 48010, proto: 'udp' }]
  };
  const hit = byId('ports-blocked-by-firewall').detect(f);
  assert.ok(hit, 'a host nothing can reach is a blocker');
  assert.strictEqual(hit.fix.kind, 'open-ports');
  assert.match(hit.detail, /loopback/);
  assert.strictEqual(diagnose(f).streamable, false);
});

test('a firewall with the ports already open says nothing', () => {
  const f = healthy();
  f.firewall = { present: true, kind: 'ufw', blocking: true, unknown: false, missing: [] };
  assert.strictEqual(byId('ports-blocked-by-firewall').detect(f), null);
});

test('no firewall at all says nothing', () => {
  const f = healthy();
  f.firewall = { present: false };
  assert.strictEqual(byId('ports-blocked-by-firewall').detect(f), null);
});

test('a firewall whose rules cannot be read is unknown, not a blocker', () => {
  const f = healthy();
  f.firewall = { present: true, kind: 'nftables', active: true, unknown: true, missing: [] };
  const hit = byId('ports-blocked-by-firewall').detect(f);
  assert.ok(hit);
  assert.strictEqual(hit.unknown, true);
  assert.match(hit.title, /could not tell/i);
  assert.strictEqual(diagnose(f).streamable, null);
});

test('a desktop left at a streaming resolution is reported', () => {
  const f = healthy();
  f.strandedResize = { connector: 'DP-2', was: '3440x1440@165.00', scale: 1.25, position: '900x0' };
  const hit = byId('display-left-resized').detect(f);
  assert.ok(hit);
  assert.match(hit.evidence, /never put back/);
  assert.strictEqual(hit.fix.kind, 'restore-display');
});

test('no stranded resize means nothing to say', () => {
  const f = healthy();
  f.strandedResize = null;
  assert.strictEqual(byId('display-left-resized').detect(f), null);
});
