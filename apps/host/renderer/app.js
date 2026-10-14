'use strict';
// Renderer. Reads from the engine through the preload bridge and draws it.
//
// Everything user-visible is set with textContent rather than innerHTML.
// The strings here are machine readings, not user input, but they include
// device names and file paths straight off the system, and building markup
// out of those is how an injection bug happens for no benefit at all.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let state = null;
let busy = false;

function toast(message, bad = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 4200);
}

// Any action that changes the machine disables the controls while it runs, so
// two clicks cannot race each other into a half-applied state.
async function withBusy(fn, label) {
  if (busy) return;
  busy = true;
  document.body.classList.add('spin');
  try {
    return await fn();
  } catch (err) {
    toast(label ? `${label} failed: ${err.message}` : err.message, true);
  } finally {
    busy = false;
    document.body.classList.remove('spin');
  }
}

/* ------------------------------------------------------------------ draw */

function drawHeader(s) {
  $('hostline').textContent =
    `${s.host} · ${s.compositor.name} ${s.compositor.version ?? ''} · ${s.compositor.session}`;

  const pill = $('servicePill');
  if (!s.sunshine.installed) {
    pill.textContent = 'Sunshine not installed';
    pill.className = 'pill off';
    return;
  }
  const on = s.sunshine.active === 'active';
  pill.textContent = on ? `Sunshine ${s.sunshine.version ?? ''}`.trim() : `Sunshine ${s.sunshine.active}`;
  pill.className = `pill ${on ? 'on' : 'off'}`;
}

function drawVerdict(s) {
  const v = $('verdict');
  const blockers = s.findings.filter((f) => f.severity === 'blocker' && !f.unknown);
  const unknowns = s.findings.filter((f) => f.unknown);
  const others = s.findings.length - blockers.length - unknowns.length;

  if (!blockers.length && unknowns.length) {
    v.className = 'verdict warn';
    $('verdictTitle').textContent = 'Cannot say yet';
    $('verdictSub').textContent =
      `Nothing is known to be wrong, but ${unknowns.length} check${unknowns.length === 1 ? '' : 's'} could not be made.`;
  } else if (blockers.length) {
    v.className = 'verdict blocked';
    $('verdictTitle').textContent =
      `${blockers.length} ${blockers.length === 1 ? 'thing stops' : 'things stop'} this streaming`;
    $('verdictSub').textContent = 'A stream would fail, or connect and show solid black.';
  } else if (others) {
    v.className = 'verdict warn';
    $('verdictTitle').textContent = 'Ready to stream';
    $('verdictSub').textContent = `${others} ${others === 1 ? 'improvement' : 'improvements'} available.`;
  } else {
    v.className = 'verdict ready';
    $('verdictTitle').textContent = 'Ready to stream';
    $('verdictSub').textContent = 'Nothing to fix.';
  }

  // Hidden rather than disabled when there is nothing to do. A prominent
  // button that cannot be pressed is just a question the user has to answer
  // for themselves.
  const fixable = s.findings.some((f) => ['sunshine-conf', 'user-service', 'choose-output', 'unpin-output'].includes(f.fix?.kind));
  const btn = $('applyFixes');
  btn.classList.toggle('hidden', !fixable);
  btn.disabled = false;
  btn.textContent = 'Fix what I can';

  // The heading should not claim these stop a stream when none of them does.
  $('findingsHeading').textContent = blockers.length
    ? 'What would stop a stream'
    : (unknowns.length ? 'What could not be checked' : (s.findings.length ? 'Worth improving' : 'Checks'));
}

function drawFindings(s) {
  const list = $('findings');
  list.replaceChildren();
  $('findingCount').textContent = s.findings.length
    ? `${s.findings.length} found` : '';

  if (!s.findings.length) {
    const li = el('li', 'muted pad', 'Nothing. Every check passed.');
    list.append(li);
    return;
  }

  for (const f of s.findings) {
    const li = el('li');
    const head = el('div', 'finding-head');
    // Same reasoning as the CLI: an unknown must not wear a blocker's colour.
    head.append(el('span', `dot ${f.unknown ? 'unknown' : f.severity}`));
    head.append(el('span', 'finding-title', f.title));
    head.append(el('span', 'finding-id', f.id));
    li.append(head);

    const body = el('div', 'finding-body');
    body.append(el('p', 'evidence', f.evidence));
    if (f.detail) body.append(el('p', 'muted', f.detail));
    if (f.fix && f.fix.kind !== 'none') body.append(el('p', 'fix', describeFix(f.fix)));

    // The firewall is the one blocker that cannot be fixed without root and
    // cannot be noticed from this machine, so it gets its own way out.
    if (f.fix?.kind === 'open-ports') {
      const open = el('button', 'secondary', 'Show the command to open them');
      open.style.marginTop = '8px';
      open.addEventListener('click', () => withBusy(async () => {
        const plan = await window.cs.planFirewall();
        if (!plan.ok) { toast(plan.reason, true); return; }
        showCommand('Open Sunshine\u2019s ports',
          'This adds a rule per port and nothing else. The helper refuses any port that is not ' +
          'one of Sunshine\u2019s, so it cannot be talked into opening anything else.',
          plan.command);
      }, 'Preparing'));
      body.append(open);
    }
    li.append(body);
    list.append(li);
  }
}

function describeFix(fix) {
  switch (fix.kind) {
    case 'install-package': return `install ${fix.packages.join(' ')}`;
    case 'sunshine-conf': return Object.entries(fix.changes).map(([k, v]) => `${k} = ${v}`).join(' · ');
    case 'setcap': return `setcap ${fix.caps} ${fix.path}`;
    case 'user-service': return `systemctl --user enable --now ${fix.unit}`;
    case 'install-park-service': return 'install the login service that parks it';
    case 'open-ports': return `open ${fix.ports.map((p) => `${p.port}/${p.proto}`).join(', ')} in ${fix.firewall}`;
    case 'wire-resize': return 'press Publish below, which also sets the resize step';
    case 'unpin-output': return 'remove output_name; with one display it is only a liability';
    case 'reboot-to-clear-connectors': return 'reboot: the kernel is holding a mode on a port with nothing on it';
    case 'modprobe-conf': return `write "${fix.line}" to ${fix.path}`;
    case 'target-real-monitor': return 'aim capture at a monitor that is actually being driven';
    default: return fix.kind;
  }
}

function drawOutputs(s) {
  const list = $('outputs');
  list.replaceChildren();
  if (!s.outputs.length) {
    list.append(el('li', 'muted pad', 'No display is connected to a GPU.'));
    return;
  }
  for (const o of s.outputs) {
    const li = el('li');
    li.append(el('span', 'idx', String(o.index)));

    const main = el('div', 'out-main');
    main.append(el('div', 'out-name', o.connector));
    const sub = o.present && o.width
      ? `${o.width}x${o.height} · connector id ${o.connectorId}`
      : `connector id ${o.connectorId} · not currently driven`;
    main.append(el('div', 'out-sub', sub));
    li.append(main);

    if (!o.present) li.append(el('span', 'tag absent', 'down'));
    if (o.streamed) li.append(el('span', 'tag streamed', 'streaming'));
    list.append(li);
  }
}

function drawApps(s) {
  const list = $('apps');
  list.replaceChildren();
  $('appsPath').textContent = s.sunshine.confPath ? s.sunshine.confPath.replace(/sunshine\.conf$/, 'apps.json') : '';

  if (!s.apps.length) {
    list.append(el('li', 'muted', 'No app list yet.'));
  }
  for (const a of s.apps) {
    const li = el('li');
    li.append(el('span', 'app-name', a.name));
    if (a.cmd) li.append(el('span', 'app-cmd', a.cmd));
    if (a.managed) li.append(el('span', 'tag ours', 'ours'));
    else if (a.stock) li.append(el('span', 'tag', 'stock'));
    list.append(li);
  }

  if (!s.clarity.found) {
    list.append(el('li', 'muted', 'Clarity.AppImage was not found, so no Couch Mode tile.'));
  }
}

function drawNotes(s) {
  const notes = [];
  for (const d of s.staleDesktopEntries ?? []) {
    notes.push({
      title: `${d.file.split('/').pop()} points at a file that is gone`,
      body: `${d.file} runs ${d.target}, which does not exist. Not ours to fix, but it will not start.`
    });
  }
  if (s.sunshine.installed && s.sunshine.cudaLinked === false) {
    notes.push({
      title: 'Encoding copies every frame through system memory',
      body: 'This Sunshine build links no CUDA, so frames go GPU to RAM to GPU. It streams; it costs latency. Only a CUDA-enabled build changes it.'
    });
  }
  const card = $('notes');
  const list = $('noteList');
  list.replaceChildren();
  if (!notes.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  for (const n of notes) {
    const li = el('li');
    const head = el('div', 'finding-head');
    head.append(el('span', 'dot info'));
    head.append(el('span', 'finding-title', n.title));
    li.append(head);
    const body = el('div', 'finding-body');
    body.append(el('p', 'muted', n.body));
    li.append(body);
    list.append(li);
  }
}

function draw(s) {
  state = s;
  drawHeader(s);
  drawVerdict(s);
  drawFindings(s);
  drawOutputs(s);
  drawApps(s);
  drawNotes(s);
  // Asks Sunshine over the network, so it is not blocked on by the rest of
  // the window drawing.
  drawPairing().catch(() => { /* its own panel reports its own trouble */ });
  drawSession().catch(() => { /* likewise */ });
}

// A session can start or end without anybody touching this window, and a
// stuck one is exactly what somebody comes here to find.
setInterval(() => { drawSession().catch(() => {}); }, 5000);

/* --------------------------------------------------------------- actions */

async function refresh() {
  const s = await window.cs.status({ fresh: true });
  draw(s);
  return s;
}

function showCommand(title, why, command) {
  $('cmdTitle').textContent = title;
  $('cmdWhy').textContent = why;
  $('cmdText').textContent = command;
  $('cmdDialog').showModal();
}

$('cmdCopy').addEventListener('click', async () => {
  await window.cs.copy($('cmdText').textContent);
  toast('Copied. Paste it into a terminal.');
});
$('cmdClose').addEventListener('click', () => $('cmdDialog').close());

$('refresh').addEventListener('click', () => withBusy(refresh, 'Refresh'));

$('applyFixes').addEventListener('click', () => withBusy(async () => {
  const out = await window.cs.applyFixes({});
  const changed = out.done
    .flatMap((d) => d.applied ?? [])
    .filter((a) => a.action !== 'unchanged');
  const services = out.done.filter((d) => d.kind === 'user-service' && d.ok);
  const bits = [];
  if (changed.length) bits.push(`${changed.length} setting${changed.length === 1 ? '' : 's'}`);
  if (services.length) bits.push('service started');
  toast(bits.length ? `Applied: ${bits.join(', ')}` : 'Nothing needed changing');
  await refresh();
}, 'Applying fixes'));

$('runVerify').addEventListener('click', () => withBusy(async () => {
  $('verifyState').textContent = 'capturing two frames…';
  $('verifyResult').replaceChildren();
  const r = await window.cs.verify({});
  $('verifyState').textContent = '';

  const box = el('div', `measure ${r.comparison.verdict ?? ''}`);
  box.append(el('div', null,
    `${r.output ?? 'display'}: ${r.comparison.verdict ?? 'could not tell'}`));
  box.append(el('p', 'muted', r.comparison.text ?? r.first.reason ?? ''));
  if (r.first.ok) {
    box.append(el('div', 'nums',
      `mean ${r.first.mean} · peak ${r.first.max} · stddev ${r.first.stddev}`));
  }
  $('verifyResult').append(box);

  const note = el('p', 'muted narrow');
  note.textContent =
    'That is the compositor reading back, which proves the desktop is drawing and nothing more. ' +
    'The reading that settles it comes from the DRM scanout buffer, the same path Sunshine uses, ' +
    'and that needs root.';
  $('verifyResult').append(note);

  if (r.kmsCommand) {
    const b = el('button', 'ghost', 'Show the root command');
    b.addEventListener('click', () => showCommand(
      'Measure the real capture path',
      'This reads the scanout buffer exactly as Sunshine does, then measure the frame it saves.',
      `${r.kmsCommand}\n\nnode bin/clarity-stream measure /tmp/clarity-stream-kms-check.png`));
    $('verifyResult').append(b);
  }
}, 'Measuring'));

$('publishApps').addEventListener('click', () => withBusy(async () => {
  const r = await window.cs.applyApps({ pruneStock: $('pruneStock').checked });
  if (!r.ok) { toast(r.reason, true); return; }
  const added = r.changes.filter((c) => c.action !== 'unchanged').length;
  toast(added ? `Published ${added} entr${added === 1 ? 'y' : 'ies'}` : 'App list already up to date');
  await refresh();
}, 'Publishing'));

refresh().catch((err) => toast(`Could not read the machine: ${err.message}`, true));
