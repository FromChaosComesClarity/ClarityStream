'use strict';
// Finding Clarity, without hardcoding where it lives.
//
// It moved from ~/Clarity to ~/Applications between one session and the next,
// and a hardcoded path simply produced an app list with the Couch Mode tile
// quietly missing. Nothing errored. So the AppImage is searched for, every
// candidate is checked for existence and executability, and when it cannot be
// found that is reported rather than papered over.
//
// The desktop entry is read as a hint, not as truth: ~/.local/share/
// applications/clarity-couch.desktop still pointed at the old location after
// the move, so trusting it alone would have been just as wrong.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

const SEARCH_DIRS = [
  path.join(HOME, 'Applications'),
  path.join(HOME, 'Clarity'),
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, 'Games', 'Clarity')
];

const DESKTOP_FILES = [
  path.join(HOME, '.local/share/applications/clarity-couch.desktop'),
  path.join(HOME, '.local/share/applications/clarity.desktop')
];

function usable(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Pull the executable out of an Exec= line, which may be quoted and may carry
// arguments and desktop-entry field codes.
function execFromDesktop(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const line = text.split('\n').find((l) => /^Exec=/.test(l));
  if (!line) return null;
  const rest = line.slice(5).trim();
  const quoted = rest.match(/^"([^"]+)"/);
  const candidate = quoted ? quoted[1] : rest.split(/\s+/)[0];
  return candidate || null;
}

function find() {
  const tried = [];

  for (const dir of SEARCH_DIRS) {
    const p = path.join(dir, 'Clarity.AppImage');
    tried.push(p);
    if (usable(p)) return { found: true, path: p, via: 'search', tried };
  }

  for (const d of DESKTOP_FILES) {
    const p = execFromDesktop(d);
    if (!p) continue;
    tried.push(`${p} (from ${path.basename(d)})`);
    if (usable(p)) return { found: true, path: p, via: 'desktop-entry', tried };
  }

  return { found: false, path: null, tried };
}

// Desktop entries that name a Clarity binary which is no longer there. Not
// something to fix silently, since these files belong to Clarity, but worth
// reporting: a launcher that points at a deleted path just fails.
function staleDesktopEntries() {
  const stale = [];
  for (const d of DESKTOP_FILES) {
    if (!fs.existsSync(d)) continue;
    const target = execFromDesktop(d);
    if (target && !usable(target)) stale.push({ file: d, target });
  }
  return stale;
}

function couchCommand(appImage) {
  return `${appImage} --couch`;
}

module.exports = { find, staleDesktopEntries, couchCommand, SEARCH_DIRS };
