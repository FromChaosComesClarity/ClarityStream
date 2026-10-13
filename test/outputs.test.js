'use strict';
// Which monitor gets streamed, and the coalescing trap that stopped anything
// being chosen at all on single-monitor hosts.
const { test } = require('node:test');
const assert = require('node:assert');
const { defaultOutput } = require('../packages/core/outputs');

// enumerateOutputs reads sysfs for connector ids, so these use a machine
// whose connectors do not exist and assert on the parts that do not need it.
function facts(monitors, strategy = 'resize') {
  return {
    settings: { strategy },
    gpus: [{
      card: 'card9', driver: 'test', renderNode: '/dev/null', connectedCount: monitors.length,
      spareConnectors: [],
      connectors: monitors.map((m) => ({ name: m.name, sysfs: `card9-${m.name}`, status: 'connected', isWriteback: false }))
    }],
    compositor: { monitors }
  };
}

test('the biggest monitor wins', () => {
  const f = facts([
    { name: 'DP-1', width: 1440, height: 900, focused: true },
    { name: 'DP-2', width: 3440, height: 1440, focused: false }
  ]);
  assert.strictEqual(defaultOutput(f).connector, 'DP-2');
});

test('focus only breaks a tie, it does not win on its own', () => {
  // Preferring the focused monitor made the answer change as windows were
  // used, so the doctor's suggestion and the screen a stream resized could
  // disagree from one minute to the next.
  const f = facts([
    { name: 'DP-1', width: 1920, height: 1080, focused: false },
    { name: 'DP-2', width: 1920, height: 1080, focused: true }
  ]);
  assert.strictEqual(defaultOutput(f).connector, 'DP-2');
});

test('a single monitor is the answer whether or not it is focused', () => {
  const f = facts([{ name: 'eDP-1', width: 1920, height: 1080, focused: false }]);
  assert.strictEqual(defaultOutput(f).connector, 'eDP-1');
});

test('no monitors at all is null, not a crash', () => {
  assert.strictEqual(defaultOutput(facts([])), null);
});

test('?? does not fall through on false, which is why the target is picked in two steps', () => {
  // The bug this guards: `(idx !== undefined && find(...)) ?? fallback`
  // evaluates to false, never reaching the fallback, so every host with no
  // output_name set found no monitor and the resize never ran. That is every
  // single-monitor machine, because nothing writes output_name when there is
  // nothing to choose between.
  const fallback = { chosen: true };
  assert.strictEqual(false ?? fallback, false, 'if this ever changes, the two-step is unnecessary');
  assert.strictEqual(undefined ?? fallback, fallback);
});
