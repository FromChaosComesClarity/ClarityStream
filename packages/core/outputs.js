'use strict';
// Which monitor actually gets streamed.
//
// Every guide says to put a connector name in `output_name`, like DP-2. For
// Sunshine's KMS backend that is wrong, and wrong in the worst way: the name
// matches nothing, no error is raised, and it quietly streams whichever
// monitor it enumerated first.
//
// Measured on this machine, with Sunshine's own debug logging:
//
//   output_name = 0  ->  crtc_id(200), connector 826, crtc(1440, 900)
//   output_name = 1  ->  crtc_id(392), connector 830, crtc(3440, 1440)
//
// So it is a numeric index. And sysfs exposes `connector_id` per connector
// (DP-1 = 826, DP-2 = 830 here), which matches that order exactly, so the
// index can be derived without parsing a log: connected connectors on the
// capture card, sorted by ascending connector_id.
//
// Sunshine 2026.516 printed an empty "KMS monitor list", which is why this
// mapping had to be worked out rather than read off. 2026.914 populates it
// ("Monitor 0 is DP-2"), so the derivation is now checkable against Sunshine's
// own answer rather than being the only source.
//
// Nothing here touches the filesystem. It was reading /sys/class/drm directly,
// which made it depend on the hardware of whatever machine it ran on: the test
// fixture described two monitors and the function answered about the real ones,
// so a test passed on the development desktop and failed everywhere else. The
// AMD laptop running this suite found it. Facts come from the probe; this
// decides what they mean.

// Returns the streamable outputs in Sunshine's own index order, annotated
// with what the compositor says is on each one.
function enumerateOutputs(facts) {
  const card = facts.gpus.find((g) => g.connectedCount > 0);
  if (!card) return [];

  const monitors = facts.compositor.monitors ?? [];
  const connected = card.connectors
    .filter((c) => c.status === 'connected' && !c.isWriteback)
      .map((c) => ({
        connector: c.name,
        connectorId: c.connectorId ?? null,
        preferredMode: c.preferredMode ?? null,
        monitor: monitors.find((m) => m.name === c.name) ?? null
      }));

  // A connector whose id could not be read cannot be placed in the order, and
  // guessing its position would mean recommending the wrong monitor. Those go
  // last and are flagged.
  const known = connected.filter((c) => c.connectorId !== null).sort((a, b) => a.connectorId - b.connectorId);
  const unknown = connected.filter((c) => c.connectorId === null);

  return [...known, ...unknown].map((c, index) => ({
    index,
    ...c,
    orderKnown: c.connectorId !== null,
    label: (c.monitor
      ? `${c.connector} ${c.monitor.width}x${c.monitor.height} (${c.monitor.description || 'unknown make'})`
      : `${c.connector} ${c.preferredMode ?? ''}`.trim())
  }));
}

function indexForConnector(facts, connectorName) {
  const found = enumerateOutputs(facts).find((o) => o.connector === connectorName);
  return found ? found.index : null;
}

// The biggest output by pixel count, which is almost always the main display
// and the one a person means by "my monitor".
//
// Biggest first, focus only as a tie-break. Preferring the focused monitor
// made the answer change as the user moved between windows, so the doctor's
// suggestion and the monitor a stream resized could differ from one minute to
// the next. Area is stable.
function defaultOutput(facts) {
  const outs = enumerateOutputs(facts);
  if (!outs.length) return null;
  const driven = outs.filter((o) => o.monitor);
  const pool = driven.length ? driven : outs;
  const area = (o) => (o.monitor?.width ?? 0) * (o.monitor?.height ?? 0);
  return pool.reduce((best, o) => {
    if (area(o) !== area(best)) return area(o) > area(best) ? o : best;
    return o.monitor?.focused ? o : best;
  }, pool[0]);
}

module.exports = { enumerateOutputs, indexForConnector, defaultOutput };
