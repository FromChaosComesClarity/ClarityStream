'use strict';
// Finding hosts on the network.
//
// Sunshine advertises _nvstream._tcp over mDNS, which is what Moonlight's own
// discovery uses. Rather than implement mDNS, this drives avahi-browse, which
// is already running on any machine where Sunshine's advertisement works at
// all: if avahi is not there, neither is the advertisement, and saying so is
// more use than a hand-rolled resolver that half works.

const { tryExec } = require('./run');

const SERVICE = '_nvstream._tcp';

// avahi-browse -p emits semicolon-separated records. The resolved ones start
// with '=' and carry the address and port:
//   =;iface;IPv4;name;_nvstream._tcp;local;host.local;10.0.0.5;47989;
function parseBrowse(stdout) {
  const hosts = new Map();
  for (const line of (stdout ?? '').split('\n')) {
    const f = line.split(';');
    if (f[0] !== '=' || f.length < 9) continue;
    const [, iface, proto, name, , , fqdn, address, port] = f;

    // Loopback is this machine talking to itself. Useful for testing, noise
    // in a host list, so it is kept but flagged rather than dropped: on a
    // desktop that is both host and client it is the only address that works.
    const loopback = iface === 'lo' || address === '127.0.0.1' || address === '::1';
    const key = name;
    const existing = hosts.get(key);

    const candidate = {
      name, fqdn, address, port: Number(port) || 47989,
      ipv6: proto === 'IPv6', loopback, iface
    };

    // Prefer a real IPv4 address: link-local IPv6 needs a scope id to connect
    // to and loopback only works locally.
    const score = (h) => (h.loopback ? 0 : 1) + (h.ipv6 ? 0 : 2);
    if (!existing || score(candidate) > score(existing)) hosts.set(key, candidate);
  }
  return [...hosts.values()];
}

function discover({ timeoutMs = 4000 } = {}) {
  const r = tryExec('avahi-browse', ['-rpt', SERVICE], { timeout: timeoutMs + 2000 });
  if (!r.ok && !r.stdout) {
    return { ok: false, hosts: [], reason: 'avahi-browse found nothing, or avahi is not running.' };
  }
  return { ok: true, hosts: parseBrowse(r.stdout) };
}

module.exports = { discover, parseBrowse, SERVICE };
