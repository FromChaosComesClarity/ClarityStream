'use strict';
// Client renderer. Same rules as the host: textContent everywhere, because
// host names and addresses come off the network and building markup out of
// those buys nothing.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let data = null;
let selected = null;

function toast(message, bad = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 4200);
}

/* ------------------------------------------------------------------ draw */

function drawHosts() {
  const list = $('hosts');
  list.replaceChildren();
  const hosts = data.hosts;
  $('hostCount').textContent = hosts.length
    ? `${hosts.length} found` : '';

  if (!data.moonlight) {
    list.append(el('li', 'pad muted',
      'Moonlight is not installed, so there is nothing to stream with. Install moonlight-qt.'));
    return;
  }
  if (!hosts.length) {
    list.append(el('li', 'pad muted',
      'No host found. Clarity Stream hosts announce themselves on the network; ' +
      'if yours is on another subnet, pair with it once from Moonlight by address.'));
    return;
  }

  for (const h of hosts) {
    const li = el('li');
    li.className = (h.reachable ? '' : 'unreachable ') + (selected === h.name ? 'selected' : '');

    const beacon = el('span', 'beacon');
    beacon.classList.add(!h.reachable ? 'off' : (h.busy ? 'busy' : 'on'));
    li.append(beacon);

    const main = el('div', 'host-main');
    main.append(el('div', 'host-name', h.name));
    const bits = [h.address];
    if (h.version) bits.push(`Sunshine ${h.version.split('.').slice(0, 3).join('.')}`);
    if (!h.reachable) bits.push('not answering, so it cannot be paired or played');
    else if (h.busy) bits.push('a session is already running');
    main.append(el('div', 'host-sub', bits.join(' · ')));
    li.append(main);

    if (!h.paired) li.append(el('span', 'tag absent', 'not paired'));
    if (h.discovered) li.append(el('span', 'tag', 'on the network'));

    const action = el('button', h.paired ? 'secondary' : 'primary', h.paired ? 'Choose' : 'Pair');
    // Pairing an unreachable host cannot work: the request never arrives, the
    // PIN never reaches it, and the failure reads as a pairing problem when
    // it is a reachability one. Usually a firewall on the host.
    if (!h.reachable) {
      action.disabled = true;
      action.title = 'This host is not answering, so pairing cannot reach it.';
    }
    action.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (h.paired) { select(h.name); return; }
      const r = await window.cs.startPairing({ address: h.address });
      $('pairHost').textContent = h.name;
      $('pairPin').textContent = r.pin;
      $('pairDialog').showModal();
      $('pairDialog').dataset.address = h.address;
    });
    li.append(action);

    li.addEventListener('click', () => { if (h.paired) select(h.name); });
    list.append(li);
  }
}

function select(name) {
  selected = name;
  drawHosts();
  drawApps();
}

function drawApps() {
  const card = $('playCard');
  const host = data.hosts.find((h) => h.name === selected);
  if (!host) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('playHost').textContent = `${host.name} · ${host.address}`;

  const list = $('apps');
  list.replaceChildren();

  if (!host.apps.length) {
    list.append(el('li', 'muted',
      'No apps known for this host yet. Open Moonlight once so it fetches the list.'));
    return;
  }

  // Couch Mode first: it is the one entry a Clarity Stream host publishes on
  // purpose, and the reason the rest of the grid can stay out of the way.
  const preferred = data.settings.preferredApp;
  const ordered = [...host.apps].sort((a, b) =>
    (b.name === preferred ? 1 : 0) - (a.name === preferred ? 1 : 0));

  for (const a of ordered) {
    const li = el('li', a.name === preferred ? 'featured' : '');
    const title = el('div', 'app-title', a.name);
    li.append(title);
    if (a.name === preferred) li.append(el('span', 'app-note', 'pick games here, on the TV'));

    const play = el('button', a.name === preferred ? 'primary' : 'secondary', 'Play');
    play.disabled = !host.reachable;
    play.addEventListener('click', async () => {
      if (host.busy) {
        toast('That host already has a session running. It will take over.', true);
      }
      const r = await window.cs.launch({ address: host.address, appName: a.name });
      toast(`Starting ${a.name}…`);
      console.info('launch:', r.command);
    });
    li.append(play);
    list.append(li);
  }
}

function drawSettings() {
  const s = data.settings;
  $('resolution').value = s.resolution;
  $('fps').value = String(s.fps);
  $('bitrate').value = String(s.bitrate);
  $('displayMode').value = s.displayMode;
  $('vsync').checked = Boolean(s.vsync);

  const pill = $('moonlightPill');
  pill.textContent = data.moonlight ? 'Moonlight ready' : 'Moonlight missing';
  pill.className = `pill ${data.moonlight ? 'on' : 'off'}`;

  // A resolution the host cannot produce gets scaled, which is the thing the
  // phantom display exists to avoid, so it is worth saying out loud.
  $('resHint').textContent =
    `The host streams at whatever its capture display is set to. A Clarity Stream host with a ` +
    `phantom display can offer ${s.resolution} exactly; anything else gets scaled or letterboxed.`;
}

/* --------------------------------------------------------------- actions */

async function refresh() {
  data = await window.cs.hosts();
  if (selected && !data.hosts.some((h) => h.name === selected)) selected = null;
  // Nothing chosen yet: land on the first paired, reachable host, which is
  // almost always the only one anybody wants.
  if (!selected) {
    const best = data.hosts.find((h) => h.paired && h.reachable);
    if (best) selected = best.name;
  }
  drawSettings();
  drawHosts();
  drawApps();
}

for (const [id, key, read] of [
  ['resolution', 'resolution', (e) => e.value],
  ['fps', 'fps', (e) => Number(e.value)],
  ['bitrate', 'bitrate', (e) => Number(e.value) || 20000],
  ['displayMode', 'displayMode', (e) => e.value],
  ['vsync', 'vsync', (e) => e.checked]
]) {
  $(id).addEventListener('change', async (e) => {
    data.settings = await window.cs.setSettings({ [key]: read(e.target) });
    drawSettings();
  });
}

$('refresh').addEventListener('click', () => refresh().catch((e) => toast(e.message, true)));
$('pairDone').addEventListener('click', async () => {
  $('pairDialog').close();
  // Pairing finishes on the host's side, so the list is re-read rather than
  // assumed to have changed.
  await refresh();
});
$('pairWeb').addEventListener('click', () => {
  const address = $('pairDialog').dataset.address;
  window.cs.openExternal(`https://${address}:47990`);
});

refresh().catch((err) => toast(`Could not look for hosts: ${err.message}`, true));
