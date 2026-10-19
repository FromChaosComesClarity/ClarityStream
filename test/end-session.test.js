'use strict';
// The client's Stop button used to spawn `moonlight quit` detached, ignore its
// output, never wait, and return ok. It then told you the session had been
// stopped, whether or not anything had happened.
//
// `moonlight quit` is documented as "Quit the currently running app", which is
// not the same as releasing the session. So the command's success is not the
// answer and never was. What the host reports afterwards is.
const { test } = require('node:test');
const assert = require('node:assert');
const { endSession } = require('../packages/core/host-link');

const ok = () => ({ ok: true, stdout: '', stderr: '' });
const busy = { reachable: true, busy: true, state: 'SUNSHINE_SERVER_BUSY' };
const free = { reachable: true, busy: false, state: 'SUNSHINE_SERVER_FREE' };

// A host that reports busy for the first `n` polls, then free.
function hostFreeAfter(n) {
  let calls = 0;
  return () => (calls++ < n ? busy : free);
}

test('a host with no session is reported as such, and nothing is run', async () => {
  let ran = false;
  const r = await endSession('x', {
    probeHost: () => free, haveMoonlight: () => true,
    run: () => { ran = true; return ok(); }
  });
  assert.strictEqual(r.ended, true);
  assert.strictEqual(r.alreadyFree, true);
  assert.strictEqual(ran, false, 'nothing to quit, so nothing should be asked');
});

test('an unreachable host is not reported as stopped', async () => {
  const r = await endSession('x', {
    probeHost: () => ({ reachable: false }), haveMoonlight: () => true, run: ok
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ended, null, 'unknown, not false: nothing was asked');
  assert.match(r.reason, /did not answer/i);
});

test('a missing Moonlight is said plainly rather than silently succeeding', async () => {
  const r = await endSession('x', {
    probeHost: () => busy, haveMoonlight: () => false, run: ok
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ended, false);
  assert.match(r.reason, /not installed/i);
});

test('a session that ends is confirmed from the host, not from the command', async () => {
  const r = await endSession('x', {
    probeHost: hostFreeAfter(2), haveMoonlight: () => true, run: ok,
    pollMs: 1, timeout: 5000
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ended, true);
  assert.ok(typeof r.waitedMs === 'number');
});

test('a session that does NOT end is reported as a failure', async () => {
  // The whole point. The command ran, exited fine, and the host is still
  // held. The old code called this success.
  const r = await endSession('x', {
    probeHost: () => busy, haveMoonlight: () => true, run: ok,
    pollMs: 1, timeout: 60
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ended, false);
  assert.strictEqual(r.commandOk, true, 'the command succeeded and that was never the question');
  assert.match(r.reason, /still reports a session/i);
  assert.match(r.reason, /from the host window/i, 'it should say what does work');
});

test('a command that fails but a session that ends is still a success', async () => {
  // The host's state decides. Moonlight exits non-zero in cases that have
  // nothing to do with whether the session went away.
  const r = await endSession('x', {
    probeHost: hostFreeAfter(1), haveMoonlight: () => true,
    run: () => ({ ok: false, stderr: 'something' }),
    pollMs: 1, timeout: 5000
  });
  assert.strictEqual(r.ended, true);
  assert.strictEqual(r.commandOk, false);
});

// The host's own Stop button had a quieter version of the same fault: it
// reported that Sunshine ACCEPTED the close, which happens before the session
// is actually gone, and said "Session stopped." on the strength of it.
const { closeSessionAndConfirm } = require('../packages/core/sunshine-api');

test("the host's stop confirms from Sunshine rather than from the acknowledgement", async () => {
  let polls = 0;
  const r = await closeSessionAndConfirm({ username: 'u', password: 'p' }, {
    pollMs: 1, timeout: 5000,
    close: async () => ({ ok: true }),
    state: async () => ({ ok: true, busy: polls++ < 2 })
  });
  assert.strictEqual(r.ended, true);
  assert.ok(polls >= 2, 'it should keep asking until the session is actually gone');
});

test("a session Sunshine accepts closing but never closes is a failure", async () => {
  const r = await closeSessionAndConfirm({ username: 'u', password: 'p' }, {
    pollMs: 1, timeout: 60,
    close: async () => ({ ok: true }),
    state: async () => ({ ok: true, busy: true })
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ended, false);
  assert.match(r.reason, /accepted the request but still reports a session/i);
});

test('credentials Sunshine rejects are reported, and nothing is claimed about the session', async () => {
  const r = await closeSessionAndConfirm({ username: 'u', password: 'wrong' }, {
    pollMs: 1, timeout: 60,
    close: async () => ({ ok: false, reason: 'Sunshine rejected the credentials.' }),
    state: async () => { throw new Error('should not be asked'); }
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ended, false);
  assert.match(r.reason, /rejected the credentials/i);
});
