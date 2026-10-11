'use strict';
const { execFile, execFileSync } = require('node:child_process');

// Every probe reads something real. When a command is missing or fails we
// record that it failed rather than substituting a plausible default: a
// guessed fact is worse than a missing one, because the diagnosis trusts it.
function tryExec(cmd, args = [], opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 5000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout, cmd: [cmd, ...args].join(' ') };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message),
      code: err.status ?? null,
      cmd: [cmd, ...args].join(' ')
    };
  }
}

// Raw bytes, for commands whose output is not text. Decoding binary as UTF-8
// silently replaces every byte above 127, which corrupts pixel data without
// raising anything: measured here as 3977 usable samples out of 4096.
function tryExecBinary(cmd, args = [], opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 20000,
      maxBuffer: 64 * 1024 * 1024
    });
    return { ok: true, stdout, cmd: [cmd, ...args].join(' ') };
  } catch (err) {
    return {
      ok: false,
      stdout: Buffer.isBuffer(err.stdout) ? err.stdout : Buffer.alloc(0),
      stderr: err.stderr ? String(err.stderr) : String(err.message),
      code: err.status ?? null,
      cmd: [cmd, ...args].join(' ')
    };
  }
}

function exec(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      resolve(err
        ? { ok: false, stdout: stdout || '', stderr: stderr || String(err.message), code: err.code ?? null }
        : { ok: true, stdout, stderr });
    });
  });
}

function which(bin) {
  const r = tryExec('sh', ['-c', `command -v ${bin}`]);
  return r.ok ? r.stdout.trim() : null;
}

module.exports = { tryExec, tryExecBinary, exec, which };
