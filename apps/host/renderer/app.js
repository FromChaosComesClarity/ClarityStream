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
  const fixable = s.findings.some((f) => ['sunshine-conf', 'user-service', 'choose-output'].includes(f.fix?.kind));
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
    case 'arm-phantom': return `force a connector on ${fix.card}: ${fix.candidates.join(' or ')}`;
    case 'park-phantom': return 'park the phantom display';
    case 'install-park-service': return 'install the login service that parks it';
    case 'modprobe-conf': return `write "${fix.line}" to ${fix.path}`;
    case 'use-phantom-instead': return 'target a forced connector, not a headless output';
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

    if (o.isPhantom) li.append(el('span', 'tag phantom', 'phantom'));
    if (!o.present) li.append(el('span', 'tag absent', 'down'));
    if (o.streamed) li.append(el('span', 'tag streamed', 'streaming'));
    list.append(li);
  }
}

function drawPhantom(s) {
  const body = $('phantomBody');
  const stateLabel = $('phantomState');
  body.replaceChildren();

  if (!s.armed) {
    stateLabel.textContent = 'not armed';
    const p = el('p', 'muted narrow',
      'A phantom display is a connector with nothing plugged into it, forced on with an ' +
      'EDID we generate, so the client gets exactly the resolution it asks for and your ' +
      'real monitors are never touched. Arming it needs root and one reboot, because ' +
      'NVIDIA reads a firmware EDID only at boot.');
    body.append(p);

    const spare = s.phantomCandidates.spare ?? [];
    if (!spare.length) {
      body.append(el('p', 'muted', 'No spare connector on the GPU that drives your displays, so there is nothing to force on.'));
      return;
    }

    const row = el('div', 'row');
    const sel = document.createElement('select');
    for (const r of ['1920x1080', '2560x1440', '1920x1200', '1600x900', '1280x800', '1280x720']) {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      sel.append(opt);
    }
    const connSel = document.createElement('select');
    for (const c of spare) {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      connSel.append(opt);
    }
    const btn = el('button', 'primary', 'Prepare it');
    btn.addEventListener('click', () => withBusy(async () => {
      const [w, h] = sel.value.split('x').map(Number);
      const plan = await window.cs.planPhantom({ width: w, height: h, refresh: 60, connector: connSel.value });
      if (!plan.ok) { toast(plan.reason, true); return; }
      showCommand(
        'Arm the phantom display',
        `This writes an EDID for ${sel.value}, adds a kernel parameter, rebuilds the initramfs ` +
        `and the boot entry. Everything it touches is a file Clarity Stream owns, so deleting ` +
        `them undoes it. A reboot is needed afterwards.`,
        plan.command);
    }, 'Preparing the phantom'));

    row.append(el('span', 'muted', 'connector'), connSel,
                el('span', 'muted', 'resolution'), sel, btn);
    body.append(row);
    return;
  }

  const ph = s.phantom;
  if (!ph) {
    stateLabel.textContent = 'armed, but not found';
    body.append(el('p', 'muted narrow',
      'The kernel command line carries the override but no connector is reporting our EDID. ' +
      'A reboot may still be pending.'));
    return;
  }

  stateLabel.textContent = ph.present ? 'up' : 'armed but down';

  const kv = document.createElement('dl');
  kv.className = 'kv';
  const add = (k, v, mono) => {
    kv.append(el('dt', null, k));
    kv.append(el('dd', mono ? 'mono' : null, v));
  };
  add('Connector', ph.connector);
  add('Running at', ph.present ? ph.mode : 'not currently driven');
  add('Parked at', ph.position ?? 'not placed', true);
  add('Workspace', ph.workspaces.length ? ph.workspaces.join(', ') : 'none');
  add('Modes offered', ph.modes.length ? ph.modes.join(', ') : 'unknown', true);
  const watching = ph.service?.installed && ph.service.enabled === 'enabled';
  add('Kept parked', watching
    ? (ph.service.active === 'active' ? 'yes, watching for drift' : 'service installed but not running')
    : 'no');
  body.append(kv);

  body.append(el('p', 'muted narrow',
    'It stays up rather than being raised per stream. Sunshine binds its capture output when ' +
    'its service starts, so a phantom that is down at that moment makes every launch fail. ' +
    'Anything that makes Hyprland re-read its config drops the placement, so Clarity Stream ' +
    'watches for that and parks it again.'));

  const row = el('div', 'row');
  const park = el('button', 'secondary', ph.present ? 'Re-park it' : 'Bring it up');
  park.addEventListener('click', () => withBusy(async () => {
    const r = await window.cs.parkPhantom();
    if (!r.ok) { toast(r.reason ?? 'could not park it', true); return; }
    toast(r.strandedWorkspaces?.length
      ? `Parked, but still holding workspace ${r.strandedWorkspaces.join(', ')}`
      : `Parked at ${r.position}, on its own workspace`);
    await refresh();
  }, 'Parking'));
  row.append(park);

  if (!(ph.service?.installed && ph.service.enabled === 'enabled')) {
    const svc = el('button', 'primary', 'Keep it parked');
    svc.addEventListener('click', () => withBusy(async () => {
      const r = await window.cs.installPhantomService();
      toast(r.enabled ? 'Login service installed' : `Could not enable it: ${r.detail ?? ''}`, !r.enabled);
      await refresh();
    }, 'Installing the service'));
    row.append(svc);
  }

  if (ph.present) {
    const down = el('button', 'danger', 'Take it down');
    down.addEventListener('click', () => withBusy(async () => {
      await window.cs.unparkPhantom();
      toast('Phantom taken down. Sunshine will fail to launch until it is back.');
      await refresh();
    }, 'Taking it down'));
    row.append(down);
  }
  body.append(row);
}

/* --------------------------------------------------------------- devices */

// Pairing, from this side. The client picks a PIN and shows it; this is where
// it gets typed. Sunshine wants its web credentials to accept one, so the
// panel has two faces: get those sorted, then pair.
async function drawPairing() {
  const body = $('pairingBody');
  const label = $('pairingState');
  body.replaceChildren();

  let p;
  try { p = await window.cs.pairingState(); }
  catch (err) { body.append(el('p', 'muted', `Could not read pairing state: ${err.message}`)); return; }

  if (!p.sunshineRunning) {
    label.textContent = 'Sunshine is not running';
    body.append(el('p', 'muted narrow',
      'Pairing goes through Sunshine, so it has to be running first. Fix that above and come back.'));
    return;
  }

  if (!p.stored || p.credentialsWork === false) {
    label.textContent = p.stored ? 'credentials rejected' : 'not set up';

    body.append(el('p', 'muted narrow',
      'To accept a pairing PIN, Clarity Stream needs the username and password for Sunshine\u2019s ' +
      'own web interface. They are checked before they are saved, and kept ' +
      (p.encryptionAvailable
        ? 'in your system keyring.'
        : 'in a file only you can read. There is no keyring on this machine, so they are not encrypted at rest.')));

    if (!p.sunshineHasCredentials) {
      body.append(el('p', 'muted narrow',
        'Sunshine has no credentials yet either. Set them once with: sunshine --creds <username> <password>'));
    }
    if (p.stored && p.reason) body.append(el('p', 'muted', p.reason));

    const row = el('div', 'pinrow');
    const userField = el('label', 'field', 'Username');
    const user = document.createElement('input');
    user.type = 'text'; user.autocomplete = 'off'; user.value = p.username ?? '';
    userField.append(user);

    const passField = el('label', 'field', 'Password');
    const pass = document.createElement('input');
    pass.type = 'password'; pass.autocomplete = 'off';
    passField.append(pass);

    const save = el('button', 'primary', 'Save');
    save.addEventListener('click', () => withBusy(async () => {
      const r = await window.cs.saveCredentials({ username: user.value.trim(), password: pass.value });
      if (!r.ok) { toast(r.reason, true); return; }
      toast(r.encrypted ? 'Saved to your keyring' : 'Saved (not encrypted: no keyring here)');
      await drawPairing();
    }, 'Saving credentials'));

    const open = el('button', 'ghost', 'Open the web interface');
    open.addEventListener('click', () => window.cs.openExternal(p.webUrl));

    row.append(userField, passField, save, open);
    body.append(row);
    return;
  }

  label.textContent = p.clients.length
    ? `${p.clients.length} paired` : 'none paired yet';

  body.append(el('p', 'muted narrow',
    'On the device you want to play from, press Pair. It shows four digits. Type them here.'));

  const row = el('div', 'pinrow');
  const pinField = el('label', 'field', 'PIN');
  const pin = document.createElement('input');
  pin.type = 'text'; pin.id = 'pinInput'; pin.inputMode = 'numeric';
  pin.maxLength = 4; pin.autocomplete = 'off'; pin.placeholder = '····';
  pinField.append(pin);

  const nameField = el('label', 'field', 'Call it');
  const name = document.createElement('input');
  name.type = 'text'; name.placeholder = 'Laptop'; name.autocomplete = 'off';
  nameField.append(name);

  const accept = el('button', 'primary', 'Pair it');
  const send = () => withBusy(async () => {
    const r = await window.cs.submitPin({ pin: pin.value.trim(), deviceName: name.value.trim() });
    if (!r.ok) { toast(r.reason, true); return; }
    toast('Paired.');
    pin.value = ''; name.value = '';
    await drawPairing();
  }, 'Pairing');

  accept.addEventListener('click', send);
  // Four digits typed from another screen: pressing Enter is the natural end
  // of that, and so is simply finishing the fourth digit.
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  pin.addEventListener('input', () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
    if (pin.value.length === 4) accept.focus();
  });

  row.append(pinField, nameField, accept);
  body.append(row);

  if (p.clients.length) {
    const list = el('ul', 'devices');
    for (const c of p.clients) {
      const li = el('li');
      li.append(el('span', 'device-name', c.name));
      li.append(el('span', 'device-id', c.uuid.slice(0, 8)));
      const drop = el('button', 'ghost', 'Remove');
      drop.addEventListener('click', () => withBusy(async () => {
        const r = await window.cs.unpair({ uuid: c.uuid });
        toast(r.ok ? `Removed ${c.name}` : (r.reason ?? 'Could not remove it'), !r.ok);
        await drawPairing();
      }, 'Removing'));
      li.append(drop);
      list.append(li);
    }
    body.append(list);
  }

  const forget = el('button', 'ghost', 'Forget the saved credentials');
  forget.addEventListener('click', () => withBusy(async () => {
    await window.cs.forgetCredentials();
    toast('Credentials forgotten');
    await drawPairing();
  }, 'Forgetting'));
  const footer = el('div', 'row');
  footer.style.marginTop = '14px';
  footer.append(forget);
  body.append(footer);
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
    if (a.managed) li.append(el('span', 'tag phantom', 'ours'));
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
  drawPhantom(s);
  drawApps(s);
  drawNotes(s);
  // Asks Sunshine over the network, so it is not blocked on by the rest of
  // the window drawing.
  drawPairing().catch(() => { /* its own panel reports its own trouble */ });
}

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
