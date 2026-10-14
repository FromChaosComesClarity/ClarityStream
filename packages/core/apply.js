'use strict';
// Applies the fixes a diagnosis found.
//
// The split that matters: anything inside the user's own session is done here
// and now, because it needs no privilege and can be undone as easily. Anything
// touching the system comes back as a plan of declarative steps for a
// privileged helper, which the user sees in full before approving.
//
// Every fix reports what actually changed, including "nothing", so a report
// can never claim a change that did not happen.

const fs = require('node:fs');
const conf = require('./sunshine-conf');
const { tryExec } = require('./run');

const PRIVILEGED = new Set(['install-package', 'setcap', 'modprobe-conf']);

function isPrivileged(fix) {
  return PRIVILEGED.has(fix?.kind);
}

// Collapses every sunshine.conf change across all findings into one write.
// Patching the file once per finding would back it up five times and make the
// diff impossible to read.
// Settings to delete rather than set. A pin that should not exist cannot be
// fixed by writing a different value to it.
function collectConfRemovals(findings) {
  const remove = new Set();
  for (const f of findings) {
    if (f.fix?.kind === 'unpin-output') remove.add('output_name');
  }
  return [...remove];
}

function collectConfChanges(findings, { outputName } = {}) {
  const changes = {};
  for (const f of findings) {
    if (f.fix?.kind === 'sunshine-conf') Object.assign(changes, f.fix.changes);
    if (f.fix?.kind === 'choose-output' && outputName) {
      if (!f.fix.candidates.includes(outputName)) {
        throw new Error(`Output ${outputName} is not one of ${f.fix.candidates.join(', ')}.`);
      }
      changes.output_name = outputName;
    }
  }
  return changes;
}

function applyConf(facts, changes, { dryRun = false, remove = [] } = {}) {
  if (!Object.keys(changes).length && !remove.length) {
    return { kind: 'sunshine-conf', skipped: true, applied: [] };
  }
  const confPath = facts.sunshine.confPath;
  const before = facts.sunshine.confExists ? fs.readFileSync(confPath, 'utf8') : '';
  const stripped = remove.length ? conf.remove(before, remove) : { text: before, removed: [] };
  const { text, applied: set } = conf.apply(stripped.text, changes);
  const applied = [
    ...stripped.removed.map((r) => ({ key: r.key, from: r.was, to: null, action: 'removed' })),
    ...set
  ];
  const changed = applied.filter((a) => a.action !== 'unchanged');
  if (!dryRun && changed.length) conf.write(confPath, text);
  return {
    kind: 'sunshine-conf', path: confPath, applied, changed: changed.length,
    created: !facts.sunshine.confExists, dryRun
  };
}

// Sunshine's packaged unit sets StartLimitBurst=5 over StartLimitIntervalSec=500.
// Tuning capture settings means restarting it a few times in a row, which
// trips that limit and leaves the unit `failed` for reasons that have nothing
// to do with the configuration. systemd will not start it again until the
// failure is cleared, so clearing it first is part of starting it, not a
// workaround.
function clearStartLimit(unit) {
  const active = tryExec('systemctl', ['--user', 'is-active', unit]);
  const state = (active.stdout || '').trim();
  if (state !== 'failed' && state !== 'activating') return { cleared: false, state };
  const r = tryExec('systemctl', ['--user', 'reset-failed', unit], { timeout: 15000 });
  return { cleared: r.ok, state, detail: r.ok ? null : (r.stderr || '').trim() };
}

function applyUserService(unit, { dryRun = false } = {}) {
  if (dryRun) return { kind: 'user-service', unit, dryRun: true };
  const limit = clearStartLimit(unit);
  // enable --now both links the unit into graphical-session.target and starts
  // it, which is what "it should just be running" means.
  const r = tryExec('systemctl', ['--user', 'enable', '--now', unit], { timeout: 30000 });
  return {
    kind: 'user-service', unit, ok: r.ok,
    startLimitCleared: limit.cleared,
    detail: r.ok
      ? (limit.cleared ? 'start limit cleared, then enabled and started' : 'enabled and started')
      : (r.stderr || '').trim()
  };
}

function restartUserService(unit) {
  const limit = clearStartLimit(unit);
  const r = tryExec('systemctl', ['--user', 'restart', unit], { timeout: 30000 });
  return {
    kind: 'user-service-restart', unit, ok: r.ok,
    startLimitCleared: limit.cleared,
    detail: r.ok
      ? (limit.cleared ? 'start limit cleared, then restarted' : 'restarted')
      : (r.stderr || '').trim()
  };
}

// Runs what it can, plans what it cannot.
function applyAll(facts, result, { outputName, dryRun = false, startService = true } = {}) {
  const done = [];
  const deferred = [];

  const changes = collectConfChanges(result.findings, { outputName });
  const removals = collectConfRemovals(result.findings);
  if (Object.keys(changes).length || removals.length) {
    done.push(applyConf(facts, changes, { dryRun, remove: removals }));
  }

  for (const f of result.findings) {
    const fix = f.fix ?? {};
    if (['sunshine-conf', 'choose-output', 'unpin-output'].includes(fix.kind)) continue; // folded in above
    if (fix.kind === 'none') continue;
    if (isPrivileged(fix)) { deferred.push({ id: f.id, title: f.title, fix }); continue; }
    if (fix.kind === 'user-service') {
      if (!startService) { deferred.push({ id: f.id, title: f.title, fix }); continue; }
      done.push({ id: f.id, ...applyUserService(fix.unit, { dryRun }) });
      continue;
    }
    deferred.push({ id: f.id, title: f.title, fix, reason: `No applier for ${fix.kind}.` });
  }

  return { done, deferred, dryRun };
}

// Sunshine reads its config once, at startup. A config change with no restart
// is a change that has not taken effect, and reporting it as fixed would be a
// lie of exactly the kind this project exists to stop.
function needsRestart(applyResult) {
  return applyResult.done.some((d) => d.kind === 'sunshine-conf' && d.changed > 0);
}

module.exports = { applyAll, applyConf, applyUserService, restartUserService, clearStartLimit, collectConfChanges, collectConfRemovals, isPrivileged, needsRestart };
