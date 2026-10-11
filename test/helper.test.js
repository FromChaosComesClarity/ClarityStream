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

const legalWrite = {
  kind: 'write-file',
  path: '/lib/firmware/edid/clarity-stream-DP-3.bin',
  base64: Buffer.alloc(128).toString('base64')
};

test('a legitimate plan passes validation', () => {
  const r = runPlan({ steps: [legalWrite, { kind: 'run', argv: ['mkinitcpio', '-P'] }] });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dry run: nothing was changed/);
});

test('writing outside the allowlist is refused', () => {
  for (const p of [
    '/etc/passwd',
    '/etc/sudoers.d/clarity-stream',
    '/lib/firmware/edid/../../../etc/shadow',
    '/etc/mkinitcpio.conf',
    '/boot/vmlinuz-linux',
    '/lib/firmware/edid/somebody-else.bin'
  ]) {
    const r = runPlan({ steps: [{ ...legalWrite, path: p }] });
    assert.notStrictEqual(r.code, 0, `${p} was NOT refused`);
    assert.match(r.stderr, /Refused|refusing/, `${p}: ${r.stderr}`);
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
  const r = runPlan({ steps: [legalWrite, { kind: 'run', argv: ['bash', '-c', 'id'] }] });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /refusing to run/);
});

test('an empty or malformed plan is rejected', () => {
  assert.notStrictEqual(runPlan({ steps: [] }).code, 0);
  assert.notStrictEqual(runPlan({}).code, 0);
});
