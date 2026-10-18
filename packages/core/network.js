'use strict';
// How the host reaches the network it streams over.
//
// This exists because the development machine streamed badly for reasons that
// had nothing to do with capture, encoding or Sunshine: it was on a USB
// wireless dongle at -74 dBm, negotiating a single spatial stream, with an
// ethernet port sitting unplugged beside it. Every capture-side check passed
// and the stream was still unusable.
//
// A game stream is the worst case for wireless. It is high bitrate, it is
// latency-sensitive, and it cannot buffer its way out of trouble the way
// video playback can, because a buffer is the thing it is trying not to have.

const fs = require('node:fs');
const { tryExec } = require('./run');

const SYS_NET = '/sys/class/net';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function interfaces() {
  let names = [];
  try { names = fs.readdirSync(SYS_NET).filter((n) => n !== 'lo'); } catch { return []; }
  return names.map((name) => {
    const speedRaw = readText(`${SYS_NET}/${name}/speed`);
    const speed = speedRaw === null ? null : Number(speedRaw);
    return {
      name,
      wireless: fs.existsSync(`${SYS_NET}/${name}/wireless`) || fs.existsSync(`${SYS_NET}/${name}/phy80211`),
      operstate: readText(`${SYS_NET}/${name}/operstate`),
      // 1 means a cable is in it. 0 on a wired port means the socket is there
      // and empty, which is worth saying out loud when the stream is on wifi.
      carrier: readText(`${SYS_NET}/${name}/carrier`) === '1',
      // Negative speeds are the kernel's way of saying it does not know.
      speedMbit: speed !== null && speed > 0 ? speed : null,
      // A USB NIC adds its own jitter on top of whatever the radio does.
      usb: (() => {
        try { return /\/usb\d+\//.test(fs.realpathSync(`${SYS_NET}/${name}`)); }
        catch { return false; }
      })()
    };
  });
}

// The interface packets to the LAN actually leave by, which is the only one
// that matters. Asking about a route to a public address answers it without
// needing to know the LAN's shape.
function routeInterface() {
  const r = tryExec('ip', ['route', 'get', '1.1.1.1']);
  if (!r.ok) return null;
  const m = r.stdout.match(/\bdev\s+(\S+)/);
  return m ? m[1] : null;
}

// Signal and negotiated rate for a wireless interface. Everything here is
// reported as measured or null; nothing is estimated.
function wirelessLink(name) {
  const r = tryExec('iw', ['dev', name, 'link']);
  if (!r.ok) return { readable: false };
  if (/Not connected/i.test(r.stdout)) return { readable: true, connected: false };

  const num = (re) => { const m = r.stdout.match(re); return m ? Number(m[1]) : null; };
  const str = (re) => { const m = r.stdout.match(re); return m ? m[1].trim() : null; };

  return {
    readable: true,
    connected: true,
    ssid: str(/SSID:\s*(.+)/),
    signalDbm: num(/signal:\s*(-?\d+)\s*dBm/),
    txBitrateMbit: num(/tx bitrate:\s*([\d.]+)\s*MBit\/s/),
    rxBitrateMbit: num(/rx bitrate:\s*([\d.]+)\s*MBit\/s/),
    // Spatial streams. One stream is half the ceiling of two, and on a cheap
    // dongle it is usually all you get.
    spatialStreams: num(/NSS\s+(\d+)/),
    freqMhz: num(/freq:\s*([\d.]+)/),
    band: (() => { const f = num(/freq:\s*([\d.]+)/); return f === null ? null : (f >= 5000 ? '5GHz' : '2.4GHz'); })()
  };
}

function detect() {
  const ifaces = interfaces();
  const routeVia = routeInterface();
  const active = ifaces.find((i) => i.name === routeVia) ?? null;
  const link = active?.wireless ? wirelessLink(active.name) : null;

  // A wired port with no cable in it is the whole fix, when there is one.
  const idleWired = ifaces.filter((i) => !i.wireless && !i.carrier);
  const liveWired = ifaces.filter((i) => !i.wireless && i.carrier);

  return {
    routeVia,
    active,
    link,
    streamsOverWireless: Boolean(active?.wireless),
    idleWiredPorts: idleWired.map((i) => i.name),
    liveWiredPorts: liveWired.map((i) => i.name),
    interfaces: ifaces
  };
}

module.exports = { detect, interfaces, routeInterface, wirelessLink };
