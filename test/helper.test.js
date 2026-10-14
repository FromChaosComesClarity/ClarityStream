'use strict';
// The helper is the only thing here that runs as root, so what it REFUSES
// matters more than what it does. These plans are all things a buggy or
// tampered engine might ask for.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'bin', 'clarity-stream-helper');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-helper-'));

function runPlan(plan) {
  const f = path.join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(plan));
  try {
    const stdout = execFileSync('node', [HELPER, f, '--dry-run'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('a legitimate plan passes validation', () => {
  const r = runPlan({ steps: [{ kind: 'run', argv: ['ufw', 'allow', '47984/tcp'] }] });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dry run: nothing was changed/);
});

// The phantom display was the only thing that needed root to touch a file or
// the boot path. With it gone those step kinds are gone rather than merely
// emptied of legal targets, and they have to stay gone: this helper runs as
// root, and the smallest thing it can do is the best thing it can do.
test('touching a file is refused outright, whatever the path', () => {
  const paths = [
    '/lib/firmware/edid/clarity-stream-DP-3.bin',   // formerly legal
    '/etc/mkinitcpio.conf.d/clarity-stream.conf',   // formerly legal
    '/etc/limine-entry-tool.d/clarity-stream.conf', // formerly legal
    '/etc/passwd'
  ];
  for (const p of paths) {
    for (const kind of ['write-file', 'remove-file']) {
      const step = kind === 'write-file'
        ? { kind, path: p, base64: Buffer.alloc(8).toString('base64') }
        : { kind, path: p };
      const r = runPlan({ steps: [step] });
      assert.notStrictEqual(r.code, 0, `${kind} ${p} was NOT refused`);
      assert.match(r.stderr, /Refused|refusing|unknown step kind/, `${kind} ${p}: ${r.stderr}`);
    }
  }
});

test('the boot path is refused outright', () => {
  // These four were legal while the phantom existed. Nothing emits them now,
  // and an unreachable way to rebuild someone's initramfs as root is still a
  // way to rebuild someone's initramfs as root.
  for (const argv of [
    ['mkinitcpio', '-P'],
    ['limine-update'],
    ['limine-mkinitcpio'],
    ['bootctl', 'update'],
    ['grub-mkconfig', '-o', '/boot/grub/grub.cfg']
  ]) {
    const r = runPlan({ steps: [{ kind: 'run', argv }] });
    assert.notStrictEqual(r.code, 0, `${argv.join(' ')} was NOT refused`);
    assert.match(r.stderr, /Refused|refusing/, `${argv.join(' ')}: ${r.stderr}`);
  }
});

test('running a command outside the allowlist is refused', () => {
  for (const argv of [
    ['rm', '-rf', '/'],
    ['bash', '-c', 'id'],
    ['mkinitcpio', '-P', '; id'],
    ['limine-update', '--extra'],
    ['pacman', '-S', 'anything']
  ]) {
    const r = runPlan({ steps: [{ kind: 'run', argv }] });
    assert.notStrictEqual(r.code, 0, `${argv.join(' ')} was NOT refused`);
    assert.match(r.stderr, /refusing to run/);
  }
});

test('an unknown step kind is refused', () => {
  const r = runPlan({ steps: [{ kind: 'chmod', path: '/etc/shadow', mode: 0o777 }] });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /unknown step kind/);
});

test('capabilities other than the ones KMS needs are refused', () => {
  const r = runPlan({ steps: [{ kind: 'setcap', caps: 'cap_setuid+ep', path: '/usr/bin/sunshine' }] });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /refusing capabilities/);
});

test('one illegal step invalidates the whole plan', () => {
  // The legal half must not run just because it came first.
  const r = runPlan({ steps: [{ kind: 'run', argv: ['ufw', 'allow', '47984/tcp'] },
                              { kind: 'run', argv: ['bash', '-c', 'id'] }] });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /refusing to run/);
});

test('an empty or malformed plan is rejected', () => {
  assert.notStrictEqual(runPlan({ steps: [] }).code, 0);
  assert.notStrictEqual(runPlan({}).code, 0);
});

test('a version gap is explained as a version gap, not as a forbidden step', () => {
  // The real case: a newer Clarity Stream wrote a plan the installed helper
  // had never heard of, and "refusing to run" sent the reader looking for a
  // security problem that was not there.
  const r = runPlan({
    producedBy: { name: 'clarity-stream', version: '9.9.9' },
    steps: [{ kind: 'run', argv: ['ufw', 'allow', '1234/tcp'] }]
  });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /written by Clarity Stream 9\.9\.9/);
  assert.match(r.stderr, /versions have to match/i);
  assert.doesNotMatch(r.stderr, /outside the allowlist/);
});

test('a forbidden step is still reported as forbidden when versions agree', () => {
  const { version } = require('../packages/core/plan');
  const r = runPlan({
    producedBy: { name: 'clarity-stream', version: version() },
    steps: [{ kind: 'run', argv: ['ufw', 'allow', '22/tcp'] }]
  });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /outside the allowlist/);
  assert.match(r.stderr, /22\/tcp/);
});

test('a plan from another version still runs when every step is allowed', () => {
  // Leniency where it is safe: the version only gets mentioned when something
  // actually failed, so an older plan of legal steps is not rejected.
  const r = runPlan({
    producedBy: { name: 'clarity-stream', version: '0.0.1' },
    steps: [{ kind: 'run', argv: ['ufw', 'allow', '47989/tcp'] }]
  });
  assert.strictEqual(r.code, 0, r.stderr);
});

test('the firewall allowlist covers exactly Sunshine ports', () => {
  const { ALL_PORT_SPECS } = require('../packages/core/firewall');
  for (const s of ALL_PORT_SPECS) {
    const r = runPlan({ steps: [{ kind: 'run', argv: ['ufw', 'allow', `${s.port}/${s.proto}`] }] });
    assert.strictEqual(r.code, 0, `${s.port}/${s.proto} should be allowed: ${r.stderr}`);
  }
  // The web interface is the administrative surface and stays shut.
  for (const bad of ['47990/tcp', '22/tcp', '80/tcp', '443/tcp']) {
    const r = runPlan({ steps: [{ kind: 'run', argv: ['ufw', 'allow', bad] }] });
    assert.notStrictEqual(r.code, 0, `${bad} must be refused`);
  }
});
