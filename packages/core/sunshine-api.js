'use strict';
// Sunshine's local web API.
//
// This is how a device gets paired without anyone opening a browser: the
// client picks a PIN and shows it, and the host sends that same PIN here.
//
// Requests go through node's https rather than curl on purpose. `curl -u
// user:pass` puts the password in the process arguments, where every other
// user on the machine can read it out of /proc. An Authorization header does
// not have that problem.
//
// The certificate is Sunshine's own self-signed one, so verification is
// disabled for 127.0.0.1 and only for 127.0.0.1. This talks to the local
// machine or it does not talk at all.

const https = require('node:https');

const HOST = '127.0.0.1';
const PORT = 47990;

function request(method, path, { username, password, body, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (username !== undefined) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request({
      host: HOST, port: PORT, path, method, headers,
      // Self-signed, and only ever to loopback.
      rejectUnauthorized: false,
      timeout
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not every answer is JSON */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: data });
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Are these credentials the right ones? Asked before anything is stored, so a
// typo is reported as a typo rather than resurfacing later as a pairing that
// mysteriously does nothing.
async function checkCredentials(creds) {
  const r = await request('GET', '/api/apps', creds);
  if (r.ok) return { ok: true };
  if (r.status === 401) return { ok: false, reason: 'Sunshine did not accept that username and password.' };
  if (r.status === 0) return { ok: false, reason: `Could not reach Sunshine on ${HOST}:${PORT}. Is it running?` };
  return { ok: false, reason: explain(r) };
}

// What a failed request actually said, rather than only its status code.
// "Sunshine answered 400." sent somebody looking in the wrong place for an
// hour when Sunshine was explaining itself in the body the whole time.
function explain(r, fallback) {
  const said = r.json?.error ?? r.json?.message ?? r.json?.status_message
    ?? (typeof r.raw === 'string' && r.raw.trim() && !r.raw.trim().startsWith('<')
      ? r.raw.trim().slice(0, 200) : null);
  return said ? `Sunshine answered ${r.status}: ${said}` : (fallback ?? `Sunshine answered ${r.status}.`);
}

// Sunshine 2026.914 changed pairing. A client that asks to pair creates a
// PENDING PAIRING with an id, and the PIN has to be submitted against that
// id. Submitting a PIN alone, which is what every earlier version wanted and
// what this module used to send, is now a 400.
//
// Taken from Sunshine's own web UI rather than guessed:
//   GET    /api/pin  -> { pairings: [ { id, ... } ] }
//   POST   /api/pin  <- { pairing_id, pin, name }
//   DELETE /api/pin  <- { pairing_id }
async function listPendingPairings(creds, { request: send = request } = {}) {
  const r = await send('GET', '/api/pin', creds);
  if (r.status === 401) return { ok: false, reason: 'Sunshine rejected the credentials.' };
  if (r.status === 404) {
    return {
      ok: false,
      reason: 'This Sunshine does not list pending pairings, so it is older than 2026.914. ' +
              'Pairing through this window needs that version or newer.'
    };
  }
  if (!r.ok) return { ok: false, reason: explain(r) };
  return { ok: true, pairings: Array.isArray(r.json?.pairings) ? r.json.pairings : [] };
}

// The whole point of this module. The client shows a PIN; this sends it.
async function submitPin(pin, deviceName, creds, { pairingId, request: send = request } = {}) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) {
    return { ok: false, reason: 'A pairing PIN is four digits.' };
  }

  // Which pending request this PIN belongs to. With one waiting there is no
  // choice to make, which is also what Sunshine's own interface does.
  let id = pairingId;
  if (!id) {
    const pending = await listPendingPairings(creds, { request: send });
    if (!pending.ok) return pending;
    if (pending.pairings.length === 0) {
      return {
        ok: false,
        reason: 'No device is waiting to pair. Press Pair on the other device first, ' +
                'then type the four digits it shows.'
      };
    }
    if (pending.pairings.length > 1) {
      return {
        ok: false,
        reason: `${pending.pairings.length} devices are waiting to pair. Finish or cancel the ` +
                'others first, so the PIN cannot be matched to the wrong one.',
        pairings: pending.pairings
      };
    }
    id = pending.pairings[0].id;
  }

  const r = await send('POST', '/api/pin', {
    ...creds,
    body: { pairing_id: id, pin: String(pin), name: deviceName || 'Clarity Stream device' }
  });
  if (r.status === 401) return { ok: false, reason: 'Sunshine rejected the credentials.' };
  if (!r.ok) return { ok: false, reason: explain(r) };

  // Sunshine answers 200 with {"status": false} when the PIN does not match a
  // waiting request, so the status code alone is not the answer.
  const accepted = r.json?.status === true || r.json?.status === 'true';
  return accepted
    ? { ok: true, pairingId: id }
    : {
        ok: false,
        reason: 'Sunshine did not accept that PIN. It expires quickly, and the client has to be ' +
                'waiting when you send it.'
      };
}

// Letting go of a request that will never be completed, so the next one is
// unambiguous. Sunshine refuses a PIN when it cannot tell which pending
// pairing it belongs to.
async function cancelPairing(pairingId, creds, { request: send = request } = {}) {
  const r = await send('DELETE', '/api/pin', { ...creds, body: { pairing_id: pairingId } });
  if (r.status === 401) return { ok: false, reason: 'Sunshine rejected the credentials.' };
  if (!r.ok) return { ok: false, reason: explain(r) };
  return { ok: r.json?.status === true, reason: r.json?.status === true ? null : 'Sunshine refused.' };
}

async function listClients(creds) {
  const r = await request('GET', '/api/clients/list', creds);
  if (!r.ok) return { ok: false, reason: r.error ?? explain(r), clients: [] };
  const certs = r.json?.named_certs ?? [];
  return {
    ok: true,
    clients: certs.map((c) => ({ name: c.name || '(unnamed)', uuid: c.uuid, enabled: c.enabled !== false }))
  };
}

async function unpairClient(uuid, creds) {
  if (!uuid) return { ok: false, reason: 'No device given.' };
  const r = await request('POST', '/api/clients/unpair', { ...creds, body: { uuid } });
  if (!r.ok) return { ok: false, reason: r.error ?? explain(r) };
  return { ok: r.json?.status !== false, reason: r.json?.status === false ? 'Sunshine refused.' : null };
}

// What the host is doing, over plain HTTP on the streaming port. No
// credentials: this is the same endpoint a client asks before connecting.
function sessionState({ timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const req = http.get({
      host: HOST, port: 47989,
      path: '/serverinfo?uniqueid=0123456789ABCDEF',
      timeout
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const tag = (n) => (new RegExp(`<${n}[^>]*>([^<]*)</${n}>`).exec(data) || [])[1] ?? null;
        const game = tag('currentgame');
        resolve({
          ok: true,
          state: tag('state'),
          busy: /BUSY/i.test(tag('state') ?? ''),
          currentGameId: game && game !== '0' ? game : null
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timed out' }); });
    req.on('error', (err) => resolve({ ok: false, reason: err.message }));
  });
}

// Ends whatever session is running. Closing the client's window does not do
// this: Sunshine keeps the session open and the host stays busy, refusing the
// next connection until its own timeout gives up.
async function closeSession(creds) {
  const r = await request('POST', '/api/apps/close', creds);
  if (r.status === 401) return { ok: false, reason: 'Sunshine rejected the credentials.' };
  if (!r.ok) return { ok: false, reason: r.error ?? explain(r) };
  return { ok: r.json?.status !== false, reason: r.json?.status === false ? 'Sunshine refused.' : null };
}

// Asking is not the same as it having happened. `closeSession` reports that
// Sunshine accepted the request, which it does before the session is gone, so
// a window saying "Session stopped" on the strength of that is saying
// something it does not know.
//
// The same reasoning as the client's Stop button, which had a louder version
// of this: /serverinfo is the authority on whether a session is still held.
async function closeSessionAndConfirm(creds, {
  timeout = 20000, pollMs = 750,
  // Injected so what this concludes from Sunshine's state over time can be
  // tested without a Sunshine.
  state = sessionState, close = closeSession
} = {}) {
  const asked = await close(creds);
  if (!asked.ok) return { ...asked, ended: false };

  const started = Date.now();
  while (Date.now() - started < timeout) {
    const now = await state();
    if (now.ok && !now.busy) {
      return { ok: true, ended: true, waitedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    ok: false,
    ended: false,
    waitedMs: Date.now() - started,
    reason: `Sunshine accepted the request but still reports a session after ` +
            `${Math.round((Date.now() - started) / 1000)}s.`
  };
}

module.exports = {
  request, checkCredentials, submitPin, listPendingPairings, cancelPairing,
  listClients, unpairClient, explain,
  sessionState, closeSession, closeSessionAndConfirm, HOST, PORT
};
