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
// Sunshine's "KMS monitor list" prints empty on this host, which is why its
// web UI cannot offer a display picker for KMS capture and why this mapping
// has to be worked out rather than read off.

const fs = require('node:fs');
const path = require('node:path');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

// An output is ours if the EDID the kernel hands out for it is the one we
// wrote. Matching on the product name in the description would be close
// enough almost always, and wrong exactly when it matters: a real monitor can
// report any name it likes. Bytes cannot be coincidence.
function isPhantomConnector(sysfsName, connectorName) {
  try {
    const live = fs.readFileSync(`/sys/class/drm/${sysfsName}/edid`);
    const ours = fs.readFileSync(path.join('/lib/firmware/edid', `clarity-stream-${connectorName}.bin`));
    return live.length >= 128 && ours.length >= 128 && live.subarray(0, 128).equals(ours.subarray(0, 128));
  } catch {
    return false;
  }
}

// Returns the streamable outputs in Sunshine's own index order, annotated
// with what the compositor says is on each one.
function enumerateOutputs(facts) {
  const card = facts.gpus.find((g) => g.connectedCount > 0);
  if (!card) return [];

  const monitors = facts.compositor.monitors ?? [];
  const connected = card.connectors
    .filter((c) => c.status === 'connected' && !c.isWriteback)
    .map((c) => {
      const idRaw = readText(`/sys/class/drm/${c.sysfs}/connector_id`);
      const mode = (readText(`/sys/class/drm/${c.sysfs}/modes`) || '').split('\n')[0] || null;
      return {
        connector: c.name,
        connectorId: idRaw === null ? null : Number(idRaw),
        preferredMode: mode,
        isPhantom: isPhantomConnector(c.sysfs, c.name),
        monitor: monitors.find((m) => m.name === c.name) ?? null
      };
    });

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
      : `${c.connector} ${c.preferredMode ?? ''}`.trim()) + (c.isPhantom ? ' [phantom]' : '')
  }));
}

function indexForConnector(facts, connectorName) {
  const found = enumerateOutputs(facts).find((o) => o.connector === connectorName);
  return found ? found.index : null;
}

// The phantom wins whenever one exists. That is the entire reason it was
// armed: streaming it leaves the desktop monitors alone and gives the client
// exactly the resolution it asked for. Falling back to the biggest real
// monitor would quietly undo the thing the user rebooted for.
//
// Otherwise the biggest output by pixel count, which is almost always the
// main display and the one a person means by "my monitor".
function defaultOutput(facts) {
  const outs = enumerateOutputs(facts);
  if (!outs.length) return null;
  const phantom = outs.find((o) => o.isPhantom);
  if (phantom) return phantom;
  const focused = outs.find((o) => o.monitor?.focused);
  if (focused) return focused;
  return outs.reduce((best, o) => {
    const area = (o.monitor?.width ?? 0) * (o.monitor?.height ?? 0);
    const bestArea = (best.monitor?.width ?? 0) * (best.monitor?.height ?? 0);
    return area > bestArea ? o : best;
  }, outs[0]);
}

module.exports = { enumerateOutputs, indexForConnector, defaultOutput };
