'use strict';
// Plans carry the version that wrote them.
//
// Without that, handing a plan to an older helper fails as "refusing to run",
// the same words used when a plan asks for something genuinely forbidden.
// Those are completely different problems and they deserve different
// messages: one means upgrade, the other means something is wrong.
//
// It happened: a 0.3.1 checkout wrote a firewall plan, the installed 0.2.0
// helper had never heard of ufw, and the refusal read as a security stop.

const fs = require('node:fs');
const path = require('node:path');

function version() {
  // The package.json next to the app, whether that is a checkout or
  // /opt/clarity-stream/app.
  for (const p of [
    path.join(__dirname, '..', '..', 'package.json'),
    '/opt/clarity-stream/app/package.json'
  ]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version; } catch { /* try the next */ }
  }
  return null;
}

function stamp(plan) {
  return { ...plan, producedBy: { name: 'clarity-stream', version: version() } };
}

module.exports = { stamp, version };
