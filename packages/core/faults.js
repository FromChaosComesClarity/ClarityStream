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
      const outs = enumerateOutputs(f);
      if (outs.length < 2) return null;
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
        fix: { kind: 'use-phantom-instead' }
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
    id: 'phantom-not-armed',
    title: 'The phantom stream display is not armed',
    severity: SEVERITY.INFO,
    detect: (f) => {
      const forced = /drm\.edid_firmware=/.test(f.phantom.kernelCmdline ?? '');
      if (forced) return null;
      const card = displayCard(f);
      const spares = card?.spareConnectors ?? [];
      if (!spares.length) return {
        evidence: 'No spare connector on the card that drives the displays.',
        detail: 'A phantom display needs an unused physical connector to force on.',
        unknown: false,
        fix: { kind: 'none' }
      };
      return {
        evidence: `No drm.edid_firmware on the kernel command line. Spare connectors on ${card.card}: ${spares.join(', ')}.`,
        detail: 'Without it, streaming has to use a real monitor at its real resolution.',
        fix: { kind: 'arm-phantom', card: card.card, candidates: spares }
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
    // directly, so every frame is copied out to system memory and back. It
    // still streams; it costs latency and bandwidth that the hardware should
    // not have to spend.
    //
    // Measured here: `ldd /usr/bin/sunshine` links no CUDA library at all, so
    // this is a property of the package, not of the configuration. Nothing in
    // sunshine.conf can fix it, and saying so is more use than offering a
    // setting that will not help.
    detect: (f) => {
      if (!f.sunshine.installed || !f.nvidia.present) return null;
      if (f.sunshine.cudaLinked === null) return null;       // could not tell
      if (f.sunshine.cudaLinked) return null;
      return {
        evidence: 'The installed Sunshine binary is not linked against CUDA.',
        detail: 'Frames go GPU -> RAM -> GPU instead of staying in VRAM. ' +
                'Streaming works; it costs latency. Fixing it needs a CUDA-enabled build.',
        fix: { kind: 'none' }
      };
    }
  },

  {
    id: 'phantom-armed-but-absent',
    title: 'The phantom display is armed but the compositor does not have it up',
    severity: SEVERITY.BLOCKER,
    // Worth a blocker because of when Sunshine reads its configuration. It
    // resolves output_name as the service starts, not as a session begins,
    // so a phantom that is down at that moment makes every launch fail with
    // "Couldn't find monitor [N]" and a 503 to the client, before any
    // prep-cmd could raise it. Measured.
    detect: (f) => {
      const forced = /drm\.edid_firmware=/.test(f.phantom.kernelCmdline ?? '');
      if (!forced) return null;                      // phantom-not-armed covers it
      const outs = enumerateOutputs(f);
      const ph = outs.find((o) => o.isPhantom);
      if (!ph) return null;
      if (ph.monitor) return null;                   // compositor has it
      return {
        evidence: `${ph.connector} carries our EDID but the compositor is not driving it.`,
        detail: 'Sunshine binds its capture output at service start, so a phantom that is ' +
                'down then breaks every launch. Bring it up before Sunshine.',
        fix: { kind: 'park-phantom', connector: ph.connector }
      };
    }
  },

  {
    id: 'phantom-holds-a-user-workspace',
    title: 'The phantom display has taken one of your workspaces',
    severity: SEVERITY.DEGRADED,
    // Hyprland gives a new output the first free workspace. Arming a phantom
    // therefore moves one of the user's workspaces onto a monitor they
    // cannot see, and switching to it loses windows into the void. Observed:
    // it took workspace 2.
    detect: (f) => {
      const outs = enumerateOutputs(f);
      const ph = outs.find((o) => o.isPhantom);
      if (!ph || !ph.monitor) return null;
      const reserved = 11;
      const held = (f.compositor.workspaces ?? []).filter((w) => w.monitor === ph.connector);
      if (!held.length) return null;
      const stranded = held.filter((w) => w.id !== reserved);
      if (!stranded.length) return null;
      return {
        evidence: `${ph.connector} is holding ${stranded.map((w) => `workspace ${w.id}`).join(', ')}.`,
        detail: 'That workspace lives on a monitor you cannot see; switching to it sends windows nowhere.',
        fix: { kind: 'park-phantom', connector: ph.connector }
      };
    }
  },

  {
    id: 'phantom-touches-the-desktop',
    title: 'The phantom display is adjacent to a real monitor',
    severity: SEVERITY.DEGRADED,
    // Hyprland moves the pointer between monitors by adjacency, so a phantom
    // placed beside the desktop catches the cursor and it disappears onto an
    // invisible screen.
    detect: (f) => {
      const outs = enumerateOutputs(f);
      const ph = outs.find((o) => o.isPhantom);
      if (!ph || !ph.monitor) return null;
      const others = (f.compositor.monitors ?? []).filter((m) => m.name !== ph.connector);
      if (!others.length) return null;
      const phLeft = ph.monitor.x;
      const touching = others.filter((m) => {
        const right = m.x + Math.round(m.width / (m.scale || 1));
        return Math.abs(right - phLeft) < 2 || Math.abs(m.x - (phLeft + Math.round(ph.monitor.width / (ph.monitor.scale || 1)))) < 2;
      });
      if (!touching.length) return null;
      return {
        evidence: `${ph.connector} sits at x=${phLeft}, flush against ${touching.map((m) => m.name).join(', ')}.`,
        detail: 'The pointer will slide onto a monitor that is not there.',
        fix: { kind: 'park-phantom', connector: ph.connector }
      };
    }
  },

  {
    id: 'phantom-not-parked-at-login',
    title: 'The phantom will come back unparked after a reboot',
    severity: SEVERITY.DEGRADED,
    // Parking is runtime state. Hyprland re-reads its config on every start,
    // and on this machine that config is rewritten by a bar panel which
    // saves the phantom wherever it last sat. Without the login unit, every
    // reboot restores the adjacency and the stolen workspace.
    detect: (f) => {
      const forced = /drm\.edid_firmware=/.test(f.phantom.kernelCmdline ?? '');
      if (!forced) return null;
      const svc = f.phantom.parkService ?? {};
      if (svc.installed && svc.enabled === 'enabled') return null;
      return {
        evidence: svc.installed
          ? `The park service exists but is ${svc.enabled}.`
          : 'No login service parks the phantom.',
        detail: 'Hyprland re-applies its config at every start, so the phantom returns ' +
                'beside the desktop holding one of your workspaces.',
        fix: { kind: 'install-park-service' }
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
