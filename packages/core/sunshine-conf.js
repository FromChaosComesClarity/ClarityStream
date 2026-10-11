'use strict';
// sunshine.conf is a flat "key = value" file. We edit it in place, preserving
// comments, ordering, and every key we do not understand. A rewrite that
// drops an unrecognised setting is how a manager earns a reputation for
// breaking things, so the parser keeps the original lines and patches them.

const fs = require('node:fs');
const path = require('node:path');

function parse(text) {
  const lines = (text ?? '').split('\n');
  const entries = new Map(); // key -> { value, lineIndex }
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)([A-Za-z0-9_]+)(\s*)=(\s*)(.*?)(\s*)$/);
    if (!m) return;                      // comment, blank, or malformed
    if (/^\s*#/.test(line)) return;      // commented-out setting
    entries.set(m[2], { value: m[5], lineIndex: i });
  });
  return { lines, entries };
}

function get(text, key) {
  return parse(text).entries.get(key)?.value ?? null;
}

// Returns the new text plus a per-key record of what changed, so the UI can
// show the diff before anything is written.
function apply(text, changes, { comment = 'Clarity Stream' } = {}) {
  const { lines, entries } = parse(text ?? '');
  const out = [...lines];
  const applied = [];

  for (const [key, value] of Object.entries(changes)) {
    const want = String(value);
    const existing = entries.get(key);
    if (existing) {
      if (existing.value === want) {
        applied.push({ key, from: existing.value, to: want, action: 'unchanged' });
        continue;
      }
      out[existing.lineIndex] = `${key} = ${want}`;
      applied.push({ key, from: existing.value, to: want, action: 'changed' });
    } else {
      // Append, grouped under one header so a human can see who did this.
      if (!out.some((l) => l.includes(`# ${comment}`))) {
        // Only separate from existing content, never open the file with a
        // blank line.
        if (out.some((l) => l.trim() !== '') && out[out.length - 1].trim() !== '') out.push('');
        out.push(`# ${comment} managed settings. Edit freely; they are`);
        out.push('# re-checked, not blindly overwritten.');
      }
      out.push(`${key} = ${want}`);
      applied.push({ key, from: null, to: want, action: 'added' });
    }
  }
  return { text: tidy(out).join('\n'), applied };
}

// Removing a key leaves the blank lines that surrounded it, and repeated
// edits otherwise accumulate gaps. This is purely cosmetic and that is the
// point: the user is invited to edit this file, so it should not look like
// something was done to it carelessly.
function tidy(lines) {
  const out = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

// Deletes keys outright rather than setting them to a default, so a setting
// Clarity Stream once managed leaves no trace once it is no longer wanted.
// Lines we did not write are never touched.
function remove(text, keys) {
  const { lines, entries } = parse(text ?? '');
  const drop = new Set();
  const removed = [];
  for (const key of keys) {
    const e = entries.get(key);
    if (!e) continue;
    drop.add(e.lineIndex);
    removed.push({ key, was: e.value });
  }
  const out = tidy(lines.filter((_, i) => !drop.has(i)));
  return { text: out.join('\n'), removed };
}

// Writes atomically and keeps one backup, because the file being edited is
// the only thing standing between a working stream and a black one.
function write(confPath, text) {
  const dir = path.dirname(confPath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(confPath)) {
    fs.copyFileSync(confPath, `${confPath}.clarity-stream.bak`);
  }
  const tmp = `${confPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o644 });
  fs.renameSync(tmp, confPath);
}

module.exports = { parse, get, apply, remove, write, tidy };
