'use strict';
// Runs the fault catalogue against measured facts and returns findings plus
// an ordered plan. Order matters: setting capture = kms without the
// capability leaves the host worse off than before, so fixes are sequenced by
// dependency, not by severity.

const { FAULTS, SEVERITY } = require('./faults');

// Earlier entries must be applied before later ones.
const ORDER = [
  'sunshine-missing',
  'nvidia-modeset-disabled',
  'kms-missing-capability',
  'nvidia-wlr-capture-is-black',
  'capture-aimed-at-idle-card',
  'headless-output-cannot-be-captured',
  'phantom-armed-but-absent',
  'output-not-pinned',
  'encoder-not-pinned-nvenc',
  'phantom-not-armed',
  'phantom-holds-a-user-workspace',
  'phantom-touches-the-desktop',
  'phantom-not-parked-at-login',
  'service-not-running-as-user',
  'moonlight-missing'
];

function diagnose(facts) {
  const findings = [];
  for (const fault of FAULTS) {
    let hit;
    try {
      hit = fault.detect(facts);
    } catch (err) {
      // A detector that throws is a bug in us, not a fault on the host. Say
      // so rather than reporting the host as healthy.
      findings.push({
        id: fault.id, title: fault.title, severity: SEVERITY.INFO,
        detectorFailed: true, evidence: `Detector threw: ${err.message}`
      });
      continue;
    }
    if (!hit) continue;
    findings.push({
      id: fault.id,
      title: fault.title,
      severity: fault.severity,
      evidence: hit.evidence,
      detail: hit.detail ?? null,
      unknown: Boolean(hit.unknown),
      fix: hit.fix ?? { kind: 'none' }
    });
  }

  findings.sort((a, b) => {
    const ia = ORDER.indexOf(a.id), ib = ORDER.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  // A fault we could not check is not a fault we found. Counting an unknown
  // as a blocker claims a stream would fail when the honest answer is that
  // nobody looked, which is the kind of confident wrong answer this whole
  // project exists to stop giving.
  const blockers = findings.filter((f) => f.severity === SEVERITY.BLOCKER && !f.unknown);
  const unknowns = findings.filter((f) => f.unknown);

  // Three states, not two. "I could not tell" is neither yes nor no.
  const streamable = blockers.length ? false : (unknowns.length ? null : true);

  let summary;
  if (blockers.length) {
    summary = `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: a stream would fail or show black.`;
  } else if (unknowns.length) {
    summary = `Nothing is known to be wrong, but ${unknowns.length} check${unknowns.length === 1 ? '' : 's'} could not be made.`;
  } else {
    summary = findings.length
      ? 'Streaming should work. Some improvements available.'
      : 'Streaming should work. Nothing to fix.';
  }

  return { findings, blockers, unknowns, streamable, summary };
}

module.exports = { diagnose, ORDER };
