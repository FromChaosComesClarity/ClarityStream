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
    title: 'Which display gets streamed is left to chance',
    severity: SEVERITY.DEGRADED,
    detect: (f) => {
      if (!f.sunshine.installed) return null;
      const monitors = f.compositor.monitors ?? [];
      if (monitors.length < 2) return null;
      if (sunshineKey(f, 'output_name')) return null;
      return {
        evidence: `${monitors.length} outputs are active and output_name is unset.`,
        detail: `Sunshine will pick one: ${monitors.map((m) => `${m.name} ${m.width}x${m.height}`).join(', ')}.`,
        fix: { kind: 'choose-output', candidates: monitors.map((m) => m.name) }
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
      return {
        evidence: `sunshine.service (user): enabled=${f.sunshine.unitEnabled}, active=${f.sunshine.unitActive}.`,
        fix: { kind: 'user-service', unit: 'sunshine.service', enable: true }
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
