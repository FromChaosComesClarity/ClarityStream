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

// Signal and negotiated rate for a wireless interface.
//
// Sampled, not read once. The rate a wireless link reports is the rate of the
// last frame, and on a marginal link it moves between reads while a healthy
// one holds. Measured on two bands of the same radio, same room, same minute:
//
//   2.4GHz  142.4 Mbit/s mean, stddev 10.1, signal -59   stable
//   5GHz     76.8 Mbit/s mean, stddev 26.9, signal -75   collapsing to 27
//
// A single read would have called either of those anything. The spread is the
// measurement that matters, because a stream cannot buffer through a dip.
function wirelessLink(name, { samples = 5, gapMs = 150 } = {}) {
  const reads = [];
  let ssid = null, band = null, freqMhz = null, streams = null, connected = null;

  for (let i = 0; i < samples; i += 1) {
    const r = tryExec('iw', ['dev', name, 'link']);
    if (!r.ok) return { readable: false };
    if (/Not connected/i.test(r.stdout)) return { readable: true, connected: false };
    connected = true;

    const num = (re) => { const m = r.stdout.match(re); return m ? Number(m[1]) : null; };
    ssid = (r.stdout.match(/SSID:\s*(.+)/) || [])[1]?.trim() ?? ssid;
    freqMhz = num(/freq:\s*([\d.]+)/) ?? freqMhz;
    // NSS appears only in VHT output. On an HT link the stream count is
    // implied by the MCS index: 0-7 is one stream, 8-15 two, 16-23 three.
    // Parsing only NSS reported null on 2.4GHz, which is the band this
    // machine moved to.
    const nss = num(/NSS\s+(\d+)/);
    const htMcs = /VHT/.test(r.stdout) ? null : num(/\bMCS\s+(\d+)/);
    streams = nss ?? (htMcs === null ? streams : Math.floor(htMcs / 8) + 1);
    reads.push({
      signalDbm: num(/signal:\s*(-?\d+)\s*dBm/),
      txBitrateMbit: num(/tx bitrate:\s*([\d.]+)\s*MBit\/s/),
      rxBitrateMbit: num(/rx bitrate:\s*([\d.]+)\s*MBit\/s/)
    });

    // Busy-wait rather than pull in async: the probe is synchronous
    // throughout and one second of it is cheaper than making it not be.
    if (i < samples - 1) {
      const until = Date.now() + gapMs;
      while (Date.now() < until) { /* spin */ }
    }
  }

  const stats = (key) => {
    const vals = reads.map((r) => r[key]).filter((v) => v !== null && !Number.isNaN(v));
    if (!vals.length) return { mean: null, min: null, max: null, stddev: null };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return {
      mean: Number(mean.toFixed(1)),
      min: Math.min(...vals),
      max: Math.max(...vals),
      stddev: Number(Math.sqrt(variance).toFixed(1))
    };
  };

  const tx = stats('txBitrateMbit');
  const sig = stats('signalDbm');
  if (freqMhz !== null) band = freqMhz >= 5000 ? '5GHz' : '2.4GHz';

  return {
    readable: true,
    connected,
    ssid,
    freqMhz,
    band,
    spatialStreams: streams,
    samples: reads.length,
    // Point values kept for anything that wants one number, taken as the mean
    // rather than as whichever read happened to be last.
    signalDbm: sig.mean === null ? null : Math.round(sig.mean),
    txBitrateMbit: tx.mean,
    rxBitrateMbit: stats('rxBitrateMbit').mean,
    txStats: tx,
    signalStats: sig
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
