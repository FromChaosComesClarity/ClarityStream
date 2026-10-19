'use strict';
// The fault catalogue. One entry per named, reproducible reason a Linux host
// fails to stream, with the evidence that identifies it and the change that
// fixes it. Clarity calls this kind of entry a Recipe: knowledge about one
// specific fault, applied only when that fault is actually present.
//
// Two rules, the same two Clarity uses:
//   1. A fault is knowledge about ONE problem. Anything general belongs in
//      the engine, not here.
//   2. Nothing fires on a guess. Every `detect` reads a measured fact, and
//      when the fact could not be read it returns 'unknown' rather than
//      assuming the good case.

const { enumerateOutputs, defaultOutput } = require('./outputs');
const firewall = require('./firewall');

const SEVERITY = { BLOCKER: 'blocker', DEGRADED: 'degraded', INFO: 'info' };

// A card that drives at least one lit connector. Capture has to be aimed
// here; any other card yields a technically successful, entirely black
// stream, which is the single most common NVIDIA complaint.
function displayCard(f) {
  return f.gpus.find((g) => g.connectedCount > 0) ?? null;
}

function sunshineCapture(f) {
  const raw = f.sunshine.confRaw;
  if (!raw) return null;
  const m = raw.match(/^\s*capture\s*=\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function sunshineKey(f, key) {
  const raw = f.sunshine.confRaw;
  if (!raw) return null;
  const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : null;
}

const FAULTS = [
  {
    id: 'sunshine-missing',
    title: 'Sunshine is not installed',
    severity: SEVERITY.BLOCKER,
    detect: (f) => f.sunshine.installed ? null : {
      evidence: 'No sunshine binary on PATH.',
      fix: { kind: 'install-package', packages: ['sunshine'] }
    }
  },

  {
    id: 'nvidia-wlr-capture-is-black',
    title: 'wlroots capture returns black frames on NVIDIA',
    severity: SEVERITY.BLOCKER,
    // The headline fault, and the reason this project exists. Sunshine's
    // default on a wlroots compositor is wlr-screencopy over dmabuf, and the
    // NVIDIA driver hands out buffers in a tiled, compressed layout that the
    // wlr path cannot read. Sunshine does not error: it encodes and sends a
    // perfectly valid, perfectly black video stream. KMS capture reads the
    // scanout buffer from the kernel instead and is unaffected.
    detect: (f) => {
      if (!f.sunshine.installed) return null;      // sunshine-missing covers it
      if (!f.nvidia.present) return null;
      if (!f.compositor.isWayland) return null;
      const capture = sunshineCapture(f);
      if (capture === 'kms') return null;
      return {
        evidence: capture
          ? `capture = ${capture}, on an NVIDIA Wayland session.`
          : 'capture is unset, so Sunshine will choose wlr on a wlroots compositor.',
        detail: 'The stream will connect, negotiate, and show solid black.',
        fix: { kind: 'sunshine-conf', changes: { capture: 'kms' } }
      };
    }
  },

  {
    id: 'kms-missing-capability',
    title: 'KMS capture needs CAP_SYS_ADMIN on the Sunshine binary',
    severity: SEVERITY.BLOCKER,
    // Reading the scanout buffer out of DRM is privileged. Without the
    // capability, KMS capture fails at init and Sunshine silently falls back
    // to something that does not work, so this must be fixed together with
    // the capture change, never after it.
    detect: (f) => {
      if (!f.sunshine.installed || !f.sunshine.realBin) return null;
      if (!f.sunshine.capabilitiesReadable) return {
        evidence: 'getcap could not read the binary, so the capability is unknown.',
        unknown: true,
        fix: { kind: 'setcap', path: f.sunshine.realBin, caps: 'cap_sys_admin,cap_sys_nice+p' }
      };
      const caps = f.sunshine.capabilities ?? '';
      if (/cap_sys_admin/.test(caps)) return null;
      return {
        evidence: caps
          ? `Binary has ${caps}, without cap_sys_admin.`
          : 'Binary has no capabilities set.',
        fix: { kind: 'setcap', path: f.sunshine.realBin, caps: 'cap_sys_admin,cap_sys_nice+p' }
      };
    }
  },

  {
    id: 'capture-aimed-at-idle-card',
    title: 'Capture is not pinned to the GPU that drives the displays',
    severity: SEVERITY.BLOCKER,
    // On a two-GPU machine, an idle card with no lit connector enumerates
    // first just as readily as the one doing the work. Capture it and you get
    // a valid stream of nothing. Pinning adapter_name removes the coin toss.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      if (f.gpus.length < 2) return null;
      const card = displayCard(f);
      if (!card || !card.renderNode) return null;
      const current = sunshineKey(f, 'adapter_name');
      if (current === card.renderNode) return null;
      const idle = f.gpus.filter((g) => g.connectedCount === 0).map((g) => `${g.card} (${g.driver})`);
      return {
        evidence: current
          ? `adapter_name = ${current}, but the displays are on ${card.card}.`
          : `adapter_name is unset and this machine has ${f.gpus.length} DRM cards.`,
        detail: `Idle with no connected display: ${idle.join(', ') || 'none'}. ` +
                `Lit: ${card.card} (${card.driver}), ${card.connectedCount} connector(s).`,
        fix: { kind: 'sunshine-conf', changes: { adapter_name: card.renderNode } }
      };
    }
  },

  {
    id: 'wireless-link-cannot-carry-a-stream',
    title: 'The network this host streams over cannot carry a stream',
    severity: SEVERITY.BLOCKER,
    // Judged on what the link is measured to deliver, not on a checklist of
    // unpromising attributes.
    //
    // The first version of this tripped on "is USB", "is 2.4GHz" and "one
    // spatial stream", and it was wrong within a day. The same radio moved to
    // 2.4GHz and measured 150 Mbit/s at -62 dBm with a standard deviation of
    // zero, and this still called it a blocker because it was USB and 2.4GHz.
    // Both were true and neither mattered. That is reasoning from a proxy,
    // which is the exact mistake this project exists to avoid.
    //
    // What was measured on the two bands of one radio, same room, same minute:
    //
    //   2.4GHz  142.4 Mbit/s mean, sd 10.1, -59 dBm   usable
    //   5GHz     76.8 Mbit/s mean, sd 26.9, -75 dBm   collapses to 27
    //
    // The mean alone would not separate those well. The spread does, because
    // a stream has no buffer to ride a dip out with.
    detect: (f) => {
      const net = f.network;
      if (!net || !net.streamsOverWireless) return null;
      const link = net.link;
      if (!link?.readable) return {
        title: 'Could not check the wireless link this host streams over',
        evidence: `Traffic leaves by ${net.routeVia}, which is wireless, but iw could not read it.`,
        unknown: true,
        fix: { kind: 'none' }
      };
      if (link.connected === false) return null;

      const tx = link.txStats ?? {};
      if (tx.mean === null || tx.mean === undefined) return {
        title: 'Could not read the rate of the wireless link this host streams over',
        evidence: `Connected to ${link.ssid ?? 'a wireless network'}, but no bitrate was reported.`,
        unknown: true,
        fix: { kind: 'none' }
      };

      // A 1080p60 stream wants roughly 20-30 Mbit/s sustained, and a wireless
      // link delivers about half its negotiated rate as real throughput. So
      // 60 Mbit/s negotiated is about the floor, and below that no bitrate
      // setting rescues it.
      const FLOOR = 60;
      // What decides it is the floor, not the spread: a stream has to survive
      // the link's worst moment, and its best moment buys nothing.
      //
      // A relative-spread rule lived here briefly and was too crude. A 2x2
      // adapter measured 273.8 mean ranging 162 to 300, a 13.2% spread that
      // very nearly tripped it, while every one of its samples was above
      // twice what a stream needs. Its worst sample beat the previous
      // adapter's best. Spread is worth reporting and is not worth judging.
      const tooThin = tx.mean < FLOOR;
      const dipsBelowFloor = tx.min !== null && tx.min < FLOOR;
      if (!tooThin && !dipsBelowFloor) return null;

      // Attributes explain the measurement; they never trigger it.
      const why = [];
      if (link.signalDbm !== null && link.signalDbm <= -70) why.push(`signal ${link.signalDbm} dBm`);
      if (link.spatialStreams === 1) why.push('one spatial stream');
      if (net.active?.usb) why.push('a USB adapter');
      if (link.band === '2.4GHz') why.push('2.4GHz, shared with everything else');

      const spread = tx.stddev === null ? '' :
        ` It moved between ${tx.min} and ${tx.max} over ${link.samples} samples (sd ${tx.stddev}).`;
      const wired = net.idleWiredPorts;
      return {
        evidence: `Streaming over ${net.routeVia} on ${link.ssid ?? 'a wireless network'}: ` +
                  `${tx.mean} Mbit/s negotiated on average, against roughly ${FLOOR} needed.` +
                  spread + (why.length ? ` Contributing: ${why.join(', ')}.` : ''),
        detail: wired.length
          ? `There is a wired port with nothing in it: ${wired.join(', ')}. A cable fixes this ` +
            'outright and no setting will. Everything else here is working.'
          : 'Lowering the bitrate on the client trades picture for stability, which is the ' +
            'only lever left without a cable.',
        fix: wired.length ? { kind: 'plug-in-ethernet', ports: wired } : { kind: 'lower-client-bitrate' }
      };
    }
  },
  {
    id: 'sunshine-cannot-raise-its-priority',
    title: 'Sunshine cannot raise its own scheduling priority',
    severity: SEVERITY.DEGRADED,
    // Sunshine asks for nice -10 and -15 for its capture and encode threads.
    // Denied, they compete with everything else on the box, which is felt as
    // jitter rather than as a lower frame rate.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const nice = f.sunshine.maxNicePriority;
      if (nice === null || nice === undefined) return null;
      if (nice > 0) return null;
      return {
        evidence: `The Sunshine process may not go below nice 0 (RLIMIT_NICE ceiling ${nice}).`,
        detail: 'Its capture and encode threads ask for -10 and -15 and are refused, so they ' +
                'queue behind ordinary work. It shows up as uneven frame pacing rather than ' +
                'as a slower stream.',
        fix: { kind: 'raise-nice-limit' }
      };
    }
  },

  {
    id: 'capture-bound-to-undriven-connector',
    title: 'Sunshine bound its capture to a port with nothing on it',
    severity: SEVERITY.BLOCKER,
    // Config says what we asked for. The log says what Sunshine did, and the
    // two are not the same thing: an index is resolved at service start
    // against whatever the kernel reported then.
    //
    // Measured on this machine. After a monitor was unplugged, Sunshine kept
    // binding the connector it had left behind. Capturing it gives a stream of
    // whatever is left in that scanout buffer, which is not the desktop.
    //
    // The comparison is against what the compositor drives, NOT against the
    // connector's sysfs state. "disconnected but enabled" is how an idle port
    // reads on amdgpu with nothing plugged in, so it is a description of the
    // symptom here and never the evidence.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      if (f.sunshine.logReadable !== true) return null;
      const bound = f.sunshine.boundConnectorId;
      if (bound === null) {
        // No connector line means one of two things, and they are not the
        // same. The AMD laptop running this found the distinction missing:
        // on the Wayland capture path Sunshine never logs a connector id at
        // all, and the detector was calling that "never started".
        if (f.sunshine.sunshineStarted === false) return null;   // genuinely never ran
        if (f.sunshine.capturedWith && f.sunshine.capturedWith !== 'kms') return null;
        if (f.sunshine.sunshineStarted) return {
          title: 'Could not tell which port Sunshine bound',
          evidence: 'Sunshine has started but logged no connector id, and no capture backend ' +
                    'could be read from its log either.',
          unknown: true,
          fix: { kind: 'none' }
        };
        return null;                                   // no log at all: nothing to say
      }

      const card = f.gpus.find((g) => g.connectedCount > 0);
      if (!card) return null;
      const all = card.connectors ?? [];
      // Without ids there is nothing to compare, and guessing would be worse
      // than saying the check could not be made.
      if (!all.some((c) => c.connectorId !== null)) return {
        title: 'Could not check which port Sunshine bound',
        evidence: `Sunshine bound connector ${bound}, but no connector id could be read from sysfs.`,
        unknown: true,
        fix: { kind: 'none' }
      };

      const driven = new Set(
        (f.compositor.monitors ?? [])
          .map((m) => all.find((c) => c.name === m.name)?.connectorId)
          .filter((id) => id !== null && id !== undefined)
      );
      if (f.compositor.monitors === null) return {
        title: 'Could not check which port Sunshine bound',
        evidence: 'The compositor did not answer, so no port could be matched to the capture.',
        unknown: true,
        fix: { kind: 'none' }
      };
      if (driven.has(bound)) return null;              // capturing a live display

      const who = all.find((c) => c.connectorId === bound);
      const drivenNames = (f.compositor.monitors ?? []).map((m) => m.name).join(', ') || 'none';
      return {
        evidence: who
          ? `Sunshine bound connector ${bound} (${who.name}), which is ${who.status}` +
            `${who.enabled === 'enabled' ? ' but still enabled' : ''}. ` +
            `The compositor is driving ${drivenNames}.`
          : `Sunshine bound connector ${bound}, which is not a connector on ${card.card}. ` +
            `The compositor is driving ${drivenNames}.`,
        detail: who && who.status === 'disconnected' && who.enabled === 'enabled'
          // On its own this state means nothing: an idle port reads exactly
          // this way on amdgpu, which the AMD laptop running this confirmed.
          // What makes it a fault here is that Sunshine bound it while the
          // compositor drives something else.
          ? 'This port reads disconnected but still enabled, which on its own is how an idle ' +
            'port looks on some drivers. What matters is that Sunshine bound it anyway. It ' +
            'resolves its capture target at service start and will keep choosing it. Rebooting ' +
            'clears it; restarting Sunshine does not, which was measured.'
          : 'Sunshine resolves its capture target when its service starts, against whatever ' +
            'the kernel reported at that moment.',
        fix: { kind: 'reboot-to-clear-connectors' }
      };
    }
  },

  {
    id: 'output-pin-is-stale',
    title: 'Sunshine is pinned to a display that is not there',
    severity: SEVERITY.BLOCKER,
    // output_name is a positional index, so unplugging a monitor renumbers
    // everything below it and the pin silently comes to mean a different
    // screen, or none. Observed: removing one of two monitors left the pin
    // aimed at a disabled output, and Sunshine captured a dead CRTC.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const current = sunshineKey(f, 'output_name');
      if (current === null || !/^\d+$/.test(current)) return null;
      // Run outside the graphical session and hyprctl answers nothing, so
      // every output looks undriven and a healthy pin would read as stale.
      // A confident wrong answer is the expensive failure here.
      if (f.compositor.monitors === null) return {
        title: 'Could not check which display Sunshine is pinned to',
        evidence: 'The compositor did not answer, so no output could be matched to the pin.',
        unknown: true,
        fix: { kind: 'none' }
      };
      const outs = enumerateOutputs(f);
      const present = outs.filter((o) => o.monitor);
      const pinned = outs.find((o) => String(o.index) === current);
      if (pinned && pinned.monitor) return null;               // pinned at a live display
      return {
        evidence: pinned
          ? `output_name = ${current} is ${pinned.connector}, which is not being driven.`
          : `output_name = ${current}, and there is no output with that index.`,
        detail: present.length <= 1
          ? 'With one display there is nothing to choose between, so the pin should simply go.'
          : `Present: ${present.map((o) => `${o.index} = ${o.connector}`).join('; ')}.`,
        fix: present.length <= 1
          ? { kind: 'unpin-output' }
          : { kind: 'sunshine-conf', changes: { output_name: String(present[0].index) } }
      };
    }
  },

  {
    id: 'output-pinned-with-one-display',
    title: 'Sunshine is pinned to an index it does not need',
    severity: SEVERITY.DEGRADED,
    // A pin on a single-display machine cannot help and can only go wrong
    // later, when a monitor is plugged in or taken away and the numbering
    // moves under it.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const current = sunshineKey(f, 'output_name');
      if (current === null) return null;
      const present = enumerateOutputs(f).filter((o) => o.monitor);
      if (present.length !== 1) return null;
      const pinned = enumerateOutputs(f).find((o) => String(o.index) === current);
      if (!pinned || !pinned.monitor) return null;             // the stale fault covers it
      return {
        evidence: `output_name = ${current}, and ${present[0].connector} is the only display.`,
        detail: 'The index moves whenever a display is added or removed, so a pin that is not ' +
                'needed is only a way for this to break later.',
        fix: { kind: 'unpin-output' }
      };
    }
  },

  {
    id: 'output-not-pinned',
    title: 'Sunshine is streaming a monitor you did not choose',
    severity: SEVERITY.DEGRADED,
    // Unpinned, Sunshine takes the first CRTC it enumerates, which is the
    // lowest connector id, which is very often the smallest or secondary
    // screen. Measured here: it picked the 1440x900 Dell over the 3440x1440
    // ultrawide. And `output_name` for KMS capture is an index, not a
    // connector name, so the obvious value does nothing at all.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      // One display is the normal case and needs no pin at all.
      const outs = enumerateOutputs(f);
      if (outs.filter((o) => o.monitor).length < 2) return null;
      const current = sunshineKey(f, 'output_name');
      const best = defaultOutput(f);
      if (current !== null && best && String(best.index) === current) return null;

      // A connector name in output_name matches nothing in the KMS backend,
      // which is worth calling out separately from simply being unset.
      const nameLike = current !== null && /[A-Za-z]/.test(current);
      return {
        evidence: current === null
          ? `output_name is unset, so Sunshine streams the lowest connector id: ${outs[0].label}.`
          : nameLike
            ? `output_name = ${current}, but the KMS backend takes an index, not a connector name. This matches nothing and is ignored.`
            : `output_name = ${current}, which is ${outs.find((o) => String(o.index) === current)?.label ?? 'not a valid index'}.`,
        detail: `Available: ${outs.map((o) => `${o.index} = ${o.label}`).join('; ')}.` +
                (best ? ` Suggested: ${best.index} (${best.label}).` : ''),
        unknown: outs.some((o) => !o.orderKnown),
        fix: best
          ? { kind: 'sunshine-conf', changes: { output_name: String(best.index) } }
          : { kind: 'none' }
      };
    }
  },

  {
    id: 'headless-output-cannot-be-captured',
    title: 'A headless output is configured as the stream target',
    severity: SEVERITY.BLOCKER,
    // Worth stating plainly because it is the obvious idea and it does not
    // work: a compositor-side headless output has no CRTC, so there is no
    // scanout buffer for KMS to read. This is why Clarity Stream forces a
    // real connector instead of asking Hyprland for a virtual one.
    detect: (f) => {
      const target = sunshineKey(f, 'output_name');
      if (!target || !/^HEADLESS-/i.test(target)) return null;
      return {
        evidence: `output_name = ${target}, which is a compositor-side virtual output.`,
        detail: 'KMS capture reads real scanout buffers and cannot see a headless output. ' +
                'Use a forced connector with a synthetic EDID instead.',
        fix: { kind: 'target-real-monitor' }
      };
    }
  },

  {
    id: 'encoder-not-pinned-nvenc',
    title: 'Hardware encoding is not pinned, so it may fall back to CPU',
    severity: SEVERITY.DEGRADED,
    detect: (f) => {
      if (!f.sunshine.installed || !f.nvidia.present) return null;
      if (!f.nvidia.nvencPresent) return {
        evidence: 'No libnvidia-encode on the system.',
        detail: 'Encoding would run on the CPU.',
        fix: { kind: 'install-package', packages: ['nvidia-utils'] }
      };
      if (sunshineKey(f, 'encoder') === 'nvenc') return null;
      return {
        evidence: 'encoder is unset, with NVENC available.',
        fix: { kind: 'sunshine-conf', changes: { encoder: 'nvenc' } }
      };
    }
  },

  {
    id: 'nvidia-modeset-disabled',
    title: 'nvidia_drm modesetting is not enabled',
    severity: SEVERITY.BLOCKER,
    detect: (f) => {
      if (!f.nvidia.present) return null;
      // The parameter file reads empty on drivers where it is no longer a
      // tunable, so the real test is whether nvidia is driving connectors.
      const nvidiaDrivesDisplay = f.gpus.some((g) => g.driver === 'nvidia' && g.connectedCount > 0);
      if (nvidiaDrivesDisplay || f.nvidia.modesetConfigured) return null;
      return {
        evidence: 'nvidia_drm.modeset is not set and no NVIDIA connector is lit.',
        detail: 'Without DRM modesetting there is no scanout buffer for KMS capture to read.',
        fix: { kind: 'modprobe-conf', path: '/etc/modprobe.d/nvidia.conf', line: 'options nvidia_drm modeset=1' }
      };
    }
  },

  {
    id: 'service-not-running-as-user',
    title: 'Sunshine is not running as a user service',
    severity: SEVERITY.BLOCKER,
    // A system-wide unit has no seat and no Wayland socket, so it cannot
    // capture a logged-in session no matter how the capture is configured.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      if (f.sunshine.unitActive === 'active') return null;
      if (!f.sunshine.unitFound) return {
        evidence: 'Sunshine is installed but ships no user unit this system can see.',
        detail: 'Without a user unit it has to be started by hand inside the graphical session.',
        unknown: true,
        fix: { kind: 'none' }
      };
      return {
        evidence: `${f.sunshine.unitName}: enabled=${f.sunshine.unitEnabled}, active=${f.sunshine.unitActive}.`,
        fix: { kind: 'user-service', unit: f.sunshine.unitName, enable: true }
      };
    }
  },

  {
    id: 'ports-blocked-by-firewall',
    title: 'Nothing on the network can reach this host',
    severity: SEVERITY.BLOCKER,
    // The cruellest fault in the set, because the host looks perfectly
    // healthy from the host. Sunshine binds 0.0.0.0 and says nothing more
    // about it, so with a default-deny firewall every local check passes, the
    // client just says "not answering", and the pairing PIN never arrives
    // because the pairing request never arrives. Nothing anywhere mentions a
    // firewall. Measured on this machine: ufw active, policy DROP, and not
    // one of Sunshine's ports allowed.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const fw = f.firewall;
      if (!fw || !fw.present) return null;
      if (fw.unknown) {
        return {
          title: `Could not tell whether ${fw.kind} is blocking the stream ports`,
          evidence: `${fw.kind} is running, and its rules could not be read from here.`,
          detail: 'Sunshine needs TCP 47984, 47989, 48010 and UDP 47998-48000, 48002, 48010 ' +
                  'reachable from your other machines.',
          unknown: true,
          fix: { kind: 'none' }
        };
      }
      if (!fw.blocking || !fw.missing?.length) return null;
      return {
        evidence: `${fw.kind} is active with a default ${fw.policy ?? 'deny'} policy and no rule for ` +
                  `${fw.missing.length} of Sunshine's ports.`,
        detail: 'Every check on this machine passes, because they all talk to it over loopback. ' +
                'From any other machine the host simply does not answer, and a client blames the ' +
                'pairing rather than the firewall. Missing: ' +
                fw.missing.map((m) => `${m.port}/${m.proto}`).join(', ') + '.',
        fix: { kind: 'open-ports', firewall: fw.kind, ports: fw.missing }
      };
    }
  },

  {
    id: 'stream-ports-ipv4-only',
    title: 'The stream ports are open over IPv4 but not IPv6',
    severity: SEVERITY.DEGRADED,
    // Raised by the session on the AMD laptop before it could happen to
    // anyone: ufw keeps IPv4 and IPv6 rules in separate files, and reading
    // them into one set reports a host as open when every rule is IPv4 and
    // the client arrives over IPv6. The host advertises itself over both.
    detect: (f) => {
      const fw = f.firewall;
      if (!fw?.present || fw.unknown || !fw.blocking) return null;
      if (fw.missing?.length) return null;              // the blocker covers it
      if (!fw.missingV6?.length) return null;
      return {
        evidence: `${fw.missingV6.length} of Sunshine's ports have no IPv6 rule.`,
        detail: 'A client that reaches this host over IPv6 is dropped, and nothing says so. ' +
                'Most clients use IPv4 and will not notice.',
        fix: { kind: 'none' }
      };
    }
  },

  {
    id: 'resize-prep-cmd-left-behind',
    title: 'Sunshine will run a prep command that no longer exists',
    severity: SEVERITY.BLOCKER,
    // Sunshine aborts any session whose prep command exits non-zero, before
    // the stream ever starts. A global_prep_cmd pointing at the resize script
    // an older Clarity Stream installed does not merely fail to resize: it
    // stops every launch, and the client sees a refusal with no explanation.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const state = require('./stream-prep').leftover(f);
      if (!state.present) return null;
      return {
        evidence: state.scriptPresent
          ? 'global_prep_cmd still runs the resize script from a version before 0.8.0.'
          : 'global_prep_cmd runs a resize script that is no longer installed.',
        detail: 'The display resize was removed because a desktop whose monitor config is ' +
                'owned by another tool captures the streaming resolution as though it were a ' +
                'choice. Sunshine refuses to start a session whose prep command fails, so this ' +
                'has to go rather than be left to fail quietly.',
        fix: { kind: 'remove-resize-prep' }
      };
    }
  },

  {
    id: 'nvenc-without-cuda',
    title: 'NVENC is round-tripping every frame through system memory',
    severity: SEVERITY.DEGRADED,
    // Sunshine says this itself, once, at startup:
    //   "Attempting to use NVENC without CUDA support.
    //    Reverting back to GPU -> RAM -> GPU"
    // The captured frame is already in VRAM and the encoder is on the same
    // card, but without CUDA support in the build it cannot be handed over
    // directly, so every frame is copied out to system memory and back.
    //
    // This was first written against `ldd`, and `ldd` was the wrong evidence:
    // Sunshine reaches CUDA through dlopen, so a CUDA-enabled build links no
    // CUDA library either, and the check reported the fault on the very build
    // that fixes it. Measured on both packages.
    //
    // Two better sources, in order. What the running build said at its last
    // start outranks everything, because a package can be swapped without the
    // service being restarted and then the file and the behaviour disagree.
    // Failing that, whether the give-up message is compiled into the binary at
    // all, which it only is when CUDA support is off.
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      if (!f.nvidia.present || !f.nvidia.nvencPresent) return null;

      const saidIt = f.sunshine.cudaWarningAtLastStart;
      const capable = f.sunshine.cudaCapable;

      // The running build is the authority when it has actually started.
      if (f.sunshine.sunshineStarted && saidIt === true) {
        return {
          evidence: 'Sunshine logged "Attempting to use NVENC without CUDA support" at its last start.',
          detail: 'Frames go GPU -> RAM -> GPU instead of staying in VRAM. Streaming works; it ' +
                  'costs latency. No setting changes it: it is how the package was built.',
          fix: { kind: 'install-cuda-build' }
        };
      }
      if (f.sunshine.sunshineStarted && saidIt === false) return null;

      // Not started, or no log. Fall back to the binary itself.
      if (capable === true) return null;
      if (capable === false) {
        return {
          evidence: 'The installed Sunshine binary carries the "without CUDA support" fallback, ' +
                    'which is only compiled in when CUDA support is off.',
          detail: 'Frames will go GPU -> RAM -> GPU instead of staying in VRAM. Streaming works; ' +
                  'it costs latency. No setting changes it: it is how the package was built.',
          fix: { kind: 'install-cuda-build' }
        };
      }
      return {
        title: 'Could not tell whether this Sunshine build uses CUDA',
        evidence: 'Neither the binary nor the log could be read.',
        unknown: true,
        fix: { kind: 'none' }
      };
    }
  },
  {
    id: 'moonlight-missing',
    title: 'Moonlight is not installed on this machine',
    severity: SEVERITY.INFO,
    detect: (f) => f.moonlight.installed ? null : {
      evidence: 'No moonlight binary on PATH.',
      detail: 'Only matters if this machine is also used as a client.',
      fix: { kind: 'install-package', packages: ['moonlight-qt'] }
    }
  }
];

module.exports = { FAULTS, SEVERITY, displayCard, sunshineCapture, sunshineKey };
