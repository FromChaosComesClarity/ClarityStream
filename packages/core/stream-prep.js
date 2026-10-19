'use strict';
// Removing what an older version left in Sunshine's configuration.
//
// Clarity Stream used to install a script and point `global_prep_cmd` at it,
// so the streamed display was resized for the duration of a session. That is
// gone: on a desktop where another tool owns the Hyprland monitor config and
// rewrites it from live state, a resize that is correct while it lasts gets
// captured as though it were a deliberate choice, and the restore afterwards
// cannot undo what was written to disk.
//
// This cannot simply be forgotten about. **Sunshine aborts any session whose
// prep command exits non-zero**, so a `global_prep_cmd` left pointing at a
// script that is no longer installed does not merely fail to resize: it stops
// every stream from starting.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const conf = require('./sunshine-conf');

// The path the old versions installed to, and the only one we may remove.
const OLD_SCRIPT = path.join(os.homedir(), '.local', 'share', 'clarity-stream', 'stream-display');

function currentValue(facts) {
  const raw = facts.sunshine.confRaw ?? '';
  const m = /^\s*global_prep_cmd\s*=\s*(.+?)\s*$/m.exec(raw);
  return m ? m[1] : null;
}

// Only ours. A global_prep_cmd the user wrote is theirs, and an entry naming
// something else in it stays exactly as it is.
function isOurs(entry) {
  return typeof entry?.do === 'string' && entry.do.includes(OLD_SCRIPT);
}

function leftover(facts) {
  const value = currentValue(facts);
  if (value === null) return { present: false, scriptPresent: fs.existsSync(OLD_SCRIPT) };
  let parsed;
  try { parsed = JSON.parse(value); } catch { return { present: false, unreadable: true, value }; }
  if (!Array.isArray(parsed)) return { present: false, unreadable: true, value };
  const ours = parsed.filter(isOurs);
  return {
    present: ours.length > 0,
    value,
    entries: parsed,
    remaining: parsed.filter((e) => !isOurs(e)),
    scriptPresent: fs.existsSync(OLD_SCRIPT)
  };
}

// Removes our entry and leaves anything else in place. An empty list removes
// the setting rather than writing `[]`, because an empty prep command is a
// setting Sunshine then has to parse for no reason.
function remove(facts) {
  const state = leftover(facts);
  if (!state.present) return { changed: false };
  const before = facts.sunshine.confExists
    ? fs.readFileSync(facts.sunshine.confPath, 'utf8') : '';
  let text;
  if (state.remaining.length) {
    ({ text } = conf.apply(before, { global_prep_cmd: JSON.stringify(state.remaining) }));
  } else {
    ({ text } = conf.remove(before, ['global_prep_cmd']));
  }
  conf.write(facts.sunshine.confPath, text);
  try { fs.unlinkSync(OLD_SCRIPT); } catch { /* already gone */ }
  return { changed: true, removed: state.entries.filter(isOurs), kept: state.remaining };
}

module.exports = { leftover, remove, currentValue, isOurs, OLD_SCRIPT };
