'use strict';
// Detectors are tested against made-up machines, because a detector that
// never fires looks exactly like one that works on a healthy host. Each case
// here is a state this project actually hit on real hardware.
const { test } = require('node:test');
const assert = require('node:assert');
const { FAULTS } = require('../packages/core/faults');
const { diagnose } = require('../packages/core/diagnose');

const byId = (id) => FAULTS.find((f) => f.id === id);

// A healthy NVIDIA host with a parked phantom, as this machine ended up.
function healthy() {
  return {
    gpus: [
      { card: 'card0', driver: 'amdgpu', renderNode: '/dev/dri/renderD129', connectedCount: 0, spareConnectors: ['DP-4'], connectors: [] },
      {
        card: 'card1', driver: 'nvidia', renderNode: '/dev/dri/renderD128', connectedCount: 3,
        spareConnectors: [],
        connectors: [
          { name: 'DP-1', sysfs: 'card1-DP-1', status: 'connected', isWriteback: false },
          { name: 'DP-2', sysfs: 'card1-DP-2', status: 'connected', isWriteback: false },
          { name: 'DP-3', sysfs: 'card1-DP-3', status: 'connected', isWriteback: false }
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
      confRaw: 'capture = kms\nadapter_name = /dev/dri/renderD128\nencoder = nvenc\noutput_name = 2\n'
    },
    moonlight: { installed: true },
    phantom: {
      kernelCmdline: 'root=/dev/x drm.edid_firmware=DP-3:edid/clarity-stream-DP-3.bin video=DP-3:e',
      parkService: { installed: true, enabled: 'enabled', active: 'active' }
    }
  };
}

// enumerateOutputs reads real sysfs for connector ids and the phantom EDID,
// so these cases assert on faults that do not depend on it where possible,
// and tolerate it reporting no phantom where they do.
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

test('a phantom that will come back unparked is caught', () => {
  const f = healthy();
  f.phantom.parkService = { installed: false, enabled: 'not-found' };
  const hit = byId('phantom-not-parked-at-login').detect(f);
  assert.ok(hit);
  assert.match(hit.detail, /re-applies its config/);

  f.phantom.parkService = { installed: true, enabled: 'enabled' };
  assert.strictEqual(byId('phantom-not-parked-at-login').detect(f), null);
});

test('no phantom armed means the park faults stay quiet', () => {
  const f = healthy();
  f.phantom.kernelCmdline = 'root=/dev/x';
  assert.strictEqual(byId('phantom-armed-but-absent').detect(f), null);
  assert.strictEqual(byId('phantom-not-parked-at-login').detect(f), null);
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
  // Run outside the graphical session, hyprctl answers nothing. Reporting
  // that as "the phantom is down" is a false blocker, and the whole point of
  // this project is that a confident wrong answer is the expensive failure.
  const f = healthy();
  f.compositor.monitors = null;
  f.compositor.workspaces = null;

  const absent = byId('phantom-armed-but-absent').detect(f);
  assert.ok(absent, 'it should still say something');
  assert.strictEqual(absent.unknown, true);
  assert.strictEqual(absent.fix.kind, 'none');
  assert.match(absent.evidence, /did not answer/i);
  assert.match(absent.title, /could not check/i);

  assert.strictEqual(byId('phantom-holds-a-user-workspace').detect(f), null);
  assert.strictEqual(byId('phantom-touches-the-desktop').detect(f), null);

  // And it must not be counted as something that stops a stream.
  const r = diagnose(f);
  const ids = r.blockers.map((b) => b.id);
  assert.ok(!ids.includes('phantom-holds-a-user-workspace'));
  assert.ok(!ids.includes('phantom-touches-the-desktop'));
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
  const finding = diagnose(f).findings.find((x) => x.id === 'phantom-armed-but-absent');
  assert.ok(finding);
  // The title must not claim the thing the evidence says was never checked.
  assert.doesNotMatch(finding.title, /does not have it up/i);
  assert.match(finding.title, /could not check/i);
});
