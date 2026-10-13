'use strict';
// Whether anything can actually reach this host.
//
// Sunshine binds 0.0.0.0 and says nothing more about it, so a host with a
// default-deny firewall looks perfectly healthy from the machine itself and
// is invisible from every other one. The client reports "not answering", the
// pairing PIN never arrives because the pairing request never arrives, and
// nothing anywhere mentions a firewall.
//
// Ports are Sunshine's documented set. 47990, the web interface, is
// deliberately NOT opened: it is the administrative interface, Moonlight does
// not use it, and Clarity Stream talks to it over loopback.

const fs = require('node:fs');
const { tryExec } = require('./run');

const PORTS = {
  tcp: [47984, 47989, 48010],
  udp: [47998, 47999, 48000, 48002, 48010]
};

const ALL_PORT_SPECS = [
  ...PORTS.tcp.map((p) => ({ port: p, proto: 'tcp' })),
  ...PORTS.udp.map((p) => ({ port: p, proto: 'udp' }))
];

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// Reads one ufw rules file. Returns which of Sunshine's ports it allows, and
// the source scopes those rules carry.
//
// Two refusals matter here, both found by the session on the other machine:
//
//   A rule scoped by DESTINATION does not count. `-d 172.17.0.1 --dport 47989`
//   allows that port only on a docker bridge address no client can reach, and
//   counting it leaves someone with a host that reports itself open and
//   answers nobody. A missed rule only costs a redundant suggestion; a false
//   "open" costs an evening.
//
//   A rule scoped by SOURCE does count, because that is how a sensible person
//   opens a port on a laptop, but the scope is kept so it can be shown.
function parseUfwRules(text) {
  const allowed = new Map();      // "tcp/47989" -> [scopes]
  if (!text) return allowed;

  for (const line of text.split('\n')) {
    // The IPv6 chain is ufw6-user-input, not ufw-user-input. Matching only
    // the first reported every port as missing over IPv6 on a host where all
    // of them were open, which is the false positive this whole project
    // exists to avoid, and I shipped it.
    if (!/^-A ufw6?-user-input /.test(line) || !/-j ACCEPT/.test(line)) continue;
    if (/\s-d\s/.test(line)) continue;                       // destination-scoped
    const proto = (/-p (tcp|udp)/.exec(line) || [])[1];
    if (!proto) continue;
    const ports = (/--dports? ([\d:,]+)/.exec(line) || [])[1];
    if (!ports) continue;
    const scope = (/\s-s (\S+)/.exec(line) || [])[1] ?? 'anywhere';

    const add = (port) => {
      const key = `${proto}/${port}`;
      allowed.set(key, [...(allowed.get(key) ?? []), scope]);
    };
    for (const part of ports.split(',')) {
      if (part.includes(':')) {
        // A range that covers a port counts, or a host behind
        // "allow 47000:48500" is told to add rules it already has.
        const [lo, hi] = part.split(':').map(Number);
        for (const spec of ALL_PORT_SPECS) {
          if (spec.proto === proto && spec.port >= lo && spec.port <= hi) add(spec.port);
        }
      } else {
        add(Number(part));
      }
    }
  }
  return allowed;
}

// ufw's rules files are world-readable, so this works without being root.
// That matters: the check has to run in the ordinary diagnosis, not behind a
// password prompt.
function ufwState() {
  const active = (tryExec('systemctl', ['is-active', 'ufw']).stdout || '').trim() === 'active';
  if (!active) return { present: false };

  const defaults = readText('/etc/default/ufw') ?? '';
  const policy = (/^DEFAULT_INPUT_POLICY="?(\w+)"?/m.exec(defaults) || [])[1] ?? 'unknown';

  // Kept apart by family. Merging them reports a host as open when every rule
  // is IPv4 and the client arrives over IPv6, which is a silent failure.
  const v4text = readText('/etc/ufw/user.rules');
  const v6text = readText('/etc/ufw/user6.rules');
  const readable = Boolean(v4text || v6text);

  const v4 = parseUfwRules(v4text);
  const v6 = parseUfwRules(v6text);

  const missing = ALL_PORT_SPECS.filter((s) => !v4.has(`${s.proto}/${s.port}`));
  const missingV6 = ALL_PORT_SPECS.filter((s) => !v6.has(`${s.proto}/${s.port}`));
  const scopes = [...new Set([...v4.values()].flat())];

  return {
    present: true, kind: 'ufw', active: true, policy, rulesReadable: readable,
    blocking: policy.toUpperCase() === 'DROP' || policy.toUpperCase() === 'REJECT',
    missing,
    missingV6,
    // Shown rather than judged: a rule scoped to one network is correct on a
    // laptop and wrong on a desktop, and only the owner knows which.
    scopes,
    // Without the rules we cannot say what is open, and claiming either way
    // would be a guess.
    unknown: !readable
  };
}

// The network this machine is on, for a fix that does not open the ports to
// every café it ever joins.
function lanCidr() {
  const r = tryExec('sh', ['-c', "ip -4 -o route show default | head -1 | awk '{print $5}'"]);
  const iface = (r.stdout || '').trim();
  if (!iface) return null;
  const a = tryExec('sh', ['-c', `ip -4 -o addr show dev ${iface} | awk '{print $4}' | head -1`]);
  const cidr = (a.stdout || '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) return null;
  // Network address, not the host's own: 192.168.0.127/24 -> 192.168.0.0/24
  const [ip, bits] = cidr.split('/');
  const octets = ip.split('.').map(Number);
  const maskBits = Number(bits);
  const mask = [0, 1, 2, 3].map((i) => {
    const take = Math.min(8, Math.max(0, maskBits - i * 8));
    return (0xff << (8 - take)) & 0xff;
  });
  return `${octets.map((o, i) => o & mask[i]).join('.')}/${maskBits}`;
}

function firewalldState() {
  const active = (tryExec('systemctl', ['is-active', 'firewalld']).stdout || '').trim() === 'active';
  if (!active) return { present: false };
  const r = tryExec('firewall-cmd', ['--list-ports']);
  if (!r.ok) return { present: true, kind: 'firewalld', active: true, unknown: true, missing: ALL_PORT_SPECS };
  const open = new Set(r.stdout.trim().split(/\s+/));
  const missing = ALL_PORT_SPECS.filter((s) => !open.has(`${s.port}/${s.proto}`));
  return { present: true, kind: 'firewalld', active: true, blocking: true, missing, unknown: false };
}

function detect() {
  const ufw = ufwState();
  if (ufw.present) return ufw;
  const fd = firewalldState();
  if (fd.present) return fd;

  // nftables or iptables driven by hand: we can see that something is active
  // but not reliably judge it, and a wrong verdict here sends someone off
  // editing firewall rules they did not need to touch.
  const nft = (tryExec('systemctl', ['is-active', 'nftables']).stdout || '').trim() === 'active';
  const ipt = (tryExec('systemctl', ['is-active', 'iptables']).stdout || '').trim() === 'active';
  if (nft || ipt) {
    return { present: true, kind: nft ? 'nftables' : 'iptables', active: true, unknown: true, missing: [] };
  }
  return { present: false };
}

// The commands that open the ports, for the privileged helper.
function openCommands(state, { scope = null } = {}) {
  if (state.kind === 'ufw') {
    if (scope) {
      // One rule per protocol rather than per port, which is how ufw's own
      // documentation writes a scoped allow and keeps the rule list short.
      const byProto = ['tcp', 'udp'].map((proto) => {
        const ports = (state.missing ?? []).filter((s) => s.proto === proto).map((s) => s.port);
        return ports.length
          ? ['ufw', 'allow', 'from', scope, 'to', 'any', 'port', ports.join(','), 'proto', proto]
          : null;
      }).filter(Boolean);
      return byProto;
    }
    return (state.missing ?? []).map((s) => ['ufw', 'allow', `${s.port}/${s.proto}`]);
  }
  if (state.kind === 'firewalld') {
    const add = (state.missing ?? []).map((s) => ['firewall-cmd', '--permanent', `--add-port=${s.port}/${s.proto}`]);
    return add.concat([['firewall-cmd', '--reload']]);
  }
  return [];
}

// A helper plan, in the same shape the phantom uses, so one privileged path
// serves both rather than two.
function planOpen(state, opts = {}) {
  const cmds = openCommands(state, opts);
  if (!cmds.length) return { ok: false, reason: 'Nothing to open, or an unsupported firewall.' };
  return require('./plan').stamp({
    ok: true,
    description: opts.scope
      ? `Open Sunshine's ports in ${state.kind}, for ${opts.scope} only`
      : `Open Sunshine's ports in ${state.kind}`,
    rebootRequired: false,
    steps: cmds.map((argv) => ({ kind: 'run', argv }))
  });
}

module.exports = { detect, openCommands, planOpen, parseUfwRules, lanCidr, PORTS, ALL_PORT_SPECS };
