'use strict';
// Where the pieces live, which differs between a packaged install and a
// development checkout. Getting this wrong is not cosmetic: a command that
// names the wrong helper fails as root, and a systemd unit that names a
// checkout breaks the moment that directory moves.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGED_PREFIX = '/opt/clarity-stream';
const PACKAGED_HELPER = '/usr/lib/clarity-stream/helper';
const PACKAGED_CLI = '/usr/bin/clarity-stream';

function isPackaged() {
  return fs.existsSync(PACKAGED_HELPER) && fs.existsSync(PACKAGED_PREFIX);
}

// The command a user runs as root. Packaged, that is one path and nothing
// else; in a checkout it has to name the interpreter explicitly, because sudo
// resets PATH past a per-user Node and this machine has no system one.
function helperCommand(planFile, { interpreter = process.execPath, repoRoot } = {}) {
  if (isPackaged()) return `sudo ${PACKAGED_HELPER} ${planFile}`;
  const helper = path.join(repoRoot ?? path.join(__dirname, '..', '..'), 'bin', 'clarity-stream-helper');
  return `sudo ${interpreter} ${helper} ${planFile}`;
}

function cliPath({ repoRoot } = {}) {
  if (isPackaged()) return PACKAGED_CLI;
  return path.join(repoRoot ?? path.join(__dirname, '..', '..'), 'bin', 'clarity-stream');
}

module.exports = { isPackaged, helperCommand, cliPath, PACKAGED_HELPER, PACKAGED_CLI, PACKAGED_PREFIX };
