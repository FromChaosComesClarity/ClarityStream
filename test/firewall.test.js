'use strict';
// Reading ufw's rules. Written after the session on the other machine found
// two ways this could say "open" about a host that answers nobody.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseUfwRules, openCommands, ALL_PORT_SPECS } = require('../packages/core/firewall');

const has = (map, proto, port) => map.has(`${proto}/${port}`);

test('a plain allow counts', () => {
  const m = parseUfwRules('-A ufw-user-input -p tcp --dport 47989 -j ACCEPT');
  assert.ok(has(m, 'tcp', 47989));
  assert.deepStrictEqual(m.get('tcp/47989'), ['anywhere']);
});

test('a rule scoped by source counts, and the scope is kept', () => {
  // How a sensible person opens a port on a laptop.
  const m = parseUfwRules(
    '-A ufw-user-input -p tcp -m multiport --dports 47984,47989,48010 -s 192.168.0.0/24 -j ACCEPT');
  for (const p of [47984, 47989, 48010]) assert.ok(has(m, 'tcp', p), `${p} should count`);
  assert.deepStrictEqual(m.get('tcp/47989'), ['192.168.0.0/24']);
});

test('a rule scoped by destination does NOT count', () => {
  // -d 172.17.0.1 allows the port only on a docker bridge no client can
  // reach. Counting it reports a host as open when it answers nobody.
  const m = parseUfwRules('-A ufw-user-input -p udp -d 172.17.0.1 --dport 47998 -j ACCEPT');
  assert.ok(!has(m, 'udp', 47998), 'a destination-scoped rule must not count as open');
});

test('a range covering a port counts', () => {
  const m = parseUfwRules('-A ufw-user-input -p tcp -m multiport --dports 47000:48500 -j ACCEPT');
  for (const s of ALL_PORT_SPECS.filter((x) => x.proto === 'tcp')) {
    assert.ok(has(m, 'tcp', s.port), `${s.port} is inside the range`);
  }
});

test('the protocol has to match', () => {
  const m = parseUfwRules('-A ufw-user-input -p tcp --dport 47998 -j ACCEPT');
  assert.ok(!has(m, 'udp', 47998), 'a tcp rule does not open the udp port');
});

test('anything that is not an accept is ignored', () => {
  const m = parseUfwRules([
    '-A ufw-user-input -p tcp --dport 47989 -j DROP',
    '-A ufw-user-output -p tcp --dport 47989 -j ACCEPT',
    '### tuple ### allow tcp 47989 0.0.0.0/0 any 0.0.0.0/0 in'
  ].join('\n'));
  assert.strictEqual(m.size, 0);
});

test('an empty or missing file reads as nothing allowed', () => {
  assert.strictEqual(parseUfwRules('').size, 0);
  assert.strictEqual(parseUfwRules(null).size, 0);
});

test('a scoped fix is one rule per protocol, not one per port', () => {
  const state = {
    kind: 'ufw',
    missing: [{ port: 47984, proto: 'tcp' }, { port: 47989, proto: 'tcp' }, { port: 47998, proto: 'udp' }]
  };
  const cmds = openCommands(state, { scope: '192.168.0.0/24' });
  assert.strictEqual(cmds.length, 2);
  assert.deepStrictEqual(cmds[0],
    ['ufw', 'allow', 'from', '192.168.0.0/24', 'to', 'any', 'port', '47984,47989', 'proto', 'tcp']);
  assert.deepStrictEqual(cmds[1],
    ['ufw', 'allow', 'from', '192.168.0.0/24', 'to', 'any', 'port', '47998', 'proto', 'udp']);
});

test('an unscoped fix is still one rule per port', () => {
  const state = { kind: 'ufw', missing: [{ port: 47989, proto: 'tcp' }] };
  assert.deepStrictEqual(openCommands(state), [['ufw', 'allow', '47989/tcp']]);
});

test('IPv6 rules live in the ufw6 chain and must still count', () => {
  // ufw writes IPv6 rules into ufw6-user-input. Matching only ufw-user-input
  // reported every port as missing over IPv6 on a host where all of them were
  // open: a false "closed" that shipped in 0.4.0.
  const v6 = [
    '-A ufw6-user-input -p tcp --dport 47989 -j ACCEPT',
    '-A ufw6-user-input -p udp --dport 47998 -j ACCEPT'
  ].join('\n');
  const m = parseUfwRules(v6);
  assert.ok(has(m, 'tcp', 47989), 'the ufw6 chain must be read');
  assert.ok(has(m, 'udp', 47998));
});

test('a chain that is neither user-input chain is still ignored', () => {
  const m = parseUfwRules([
    '-A ufw-user-limit -p tcp --dport 47989 -j ACCEPT',
    '-A ufw6-user-limit -p tcp --dport 47984 -j ACCEPT',
    '-A ufw-before-input -p udp --dport 47998 -j ACCEPT'
  ].join('\n'));
  assert.strictEqual(m.size, 0);
});
