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

// ufw's rules file is world-readable, so this works without being root. That
// matters: the check has to run in the ordinary diagnosis, not behind a
// password prompt.
function ufwState() {
  const active = (tryExec('systemctl', ['is-active', 'ufw']).stdout || '').trim() === 'active';
  if (!active) return { present: false };

  const defaults = readText('/etc/default/ufw') ?? '';
  const policy = (/^DEFAULT_INPUT_POLICY="?(\w+)"?/m.exec(defaults) || [])[1] ?? 'unknown';

  const rules = (readText('/etc/ufw/user.rules') ?? '') + (readText('/etc/ufw/user6.rules') ?? '');
  const readable = rules.length > 0;

  const allowed = new Set();
  // Single ports and multiport ranges both appear; a range that covers a port
  // counts, or a host behind "allow 47000:48500" would be told to add rules
  // it already has.
  for (const m of rules.matchAll(/^-A ufw-user-input .*?-p (tcp|udp).*?--dport[s]? ([\d:,]+).*?-j ACCEPT/gm)) {
    const proto = m[1];
    for (const part of m[2].split(',')) {
      if (part.includes(':')) {
        const [lo, hi] = part.split(':').map(Number);
        for (const { port, proto: pr } of ALL_PORT_SPECS) {
          if (pr === proto && port >= lo && port <= hi) allowed.add(`${proto}/${port}`);
        }
      } else {
        allowed.add(`${proto}/${Number(part)}`);
      }
    }
  }

  const missing = ALL_PORT_SPECS.filter((s) => !allowed.has(`${s.proto}/${s.port}`));
  return {
    present: true, kind: 'ufw', active: true, policy, rulesReadable: readable,
    blocking: policy.toUpperCase() === 'DROP' || policy.toUpperCase() === 'REJECT',
    missing,
    // Without the rules we cannot say what is open, and claiming either way
    // would be a guess.
    unknown: !readable
  };
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
function openCommands(state) {
  if (state.kind === 'ufw') {
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
function planOpen(state) {
  const cmds = openCommands(state);
  if (!cmds.length) return { ok: false, reason: 'Nothing to open, or an unsupported firewall.' };
  return require('./plan').stamp({
    ok: true,
    description: `Open Sunshine's ports in ${state.kind}`,
    rebootRequired: false,
    steps: cmds.map((argv) => ({ kind: 'run', argv }))
  });
}

module.exports = { detect, openCommands, planOpen, PORTS, ALL_PORT_SPECS };
