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
  return { ok: false, reason: `Sunshine answered ${r.status}.` };
}

// The whole point of this module. The client shows a PIN; this sends it.
async function submitPin(pin, deviceName, creds) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) {
    return { ok: false, reason: 'A pairing PIN is four digits.' };
  }
  const r = await request('POST', '/api/pin', {
    ...creds,
    body: { pin: String(pin), name: deviceName || 'Clarity Stream device' }
  });
  if (r.status === 401) return { ok: false, reason: 'Sunshine rejected the credentials.' };
  if (!r.ok) return { ok: false, reason: r.error ?? `Sunshine answered ${r.status}.` };

  // Sunshine answers 200 with {"status": false} when the PIN does not match a
  // waiting request, so the status code alone is not the answer.
  const accepted = r.json?.status === true || r.json?.status === 'true';
  return accepted
    ? { ok: true }
    : {
        ok: false,
        reason: 'Sunshine did not accept that PIN. It expires quickly, and the client has to be ' +
                'waiting when you send it.'
      };
}

async function listClients(creds) {
  const r = await request('GET', '/api/clients/list', creds);
  if (!r.ok) return { ok: false, reason: r.error ?? `Sunshine answered ${r.status}.`, clients: [] };
  const certs = r.json?.named_certs ?? [];
  return {
    ok: true,
    clients: certs.map((c) => ({ name: c.name || '(unnamed)', uuid: c.uuid, enabled: c.enabled !== false }))
  };
}

async function unpairClient(uuid, creds) {
  if (!uuid) return { ok: false, reason: 'No device given.' };
  const r = await request('POST', '/api/clients/unpair', { ...creds, body: { uuid } });
  if (!r.ok) return { ok: false, reason: r.error ?? `Sunshine answered ${r.status}.` };
  return { ok: r.json?.status !== false, reason: r.json?.status === false ? 'Sunshine refused.' : null };
}

module.exports = { request, checkCredentials, submitPin, listClients, unpairClient, HOST, PORT };
