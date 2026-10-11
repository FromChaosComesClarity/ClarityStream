# Recipes, the streaming edition

Clarity uses the word **Recipe** for knowledge about one named game's fault and
its fix: the exact fault, the exact fix, applied when the game launches, with
nothing to configure.

Clarity Stream uses the same idea for hosts. A Recipe here is one named,
reproducible reason a Linux machine fails to stream, the evidence that
identifies it, and the change that fixes it. They live in
[`packages/core/faults.js`](../packages/core/faults.js).

The two rules are Clarity's two rules:

1. **A Recipe is knowledge about one problem.** Anything general belongs in the
   engine, not the catalogue.
2. **Nothing fires on a guess.** Every detector reads a measured fact, and when
   a fact cannot be read it reports `unknown` rather than assuming the machine
   is fine.

## The catalogue

| id | severity | what it catches |
| --- | --- | --- |
| `sunshine-missing` | blocker | No Sunshine binary on PATH. |
| `nvidia-wlr-capture-is-black` | blocker | NVIDIA plus Wayland plus a capture mode that is not `kms`. The stream will connect and show solid black. |
| `kms-missing-capability` | blocker | `capture = kms` without `cap_sys_admin` on the resolved binary. Fails at init. |
| `capture-aimed-at-idle-card` | blocker | Two or more DRM cards and `adapter_name` not pinned to the one driving a display. |
| `headless-output-cannot-be-captured` | blocker | `output_name` points at a `HEADLESS-*` output, which has no CRTC for KMS to read. |
| `nvidia-modeset-disabled` | blocker | No DRM modesetting, so there is no scanout buffer at all. |
| `service-not-running-as-user` | blocker | Sunshine not active as a user unit. A system unit has no seat and no Wayland socket. |
| `output-not-pinned` | degraded | Sunshine is streaming a display you did not choose. `output_name` is an index for KMS capture, not a connector name, so the obvious value does nothing. |
| `encoder-not-pinned-nvenc` | degraded | NVENC present but `encoder` unset, so encoding may land on the CPU. |
| `phantom-not-armed` | info | No phantom display, so streaming has to use a real monitor at its real resolution. |
| `nvenc-without-cuda` | degraded | The Sunshine build links no CUDA, so frames go GPU to RAM to GPU instead of staying in VRAM. No setting fixes it. |
| `moonlight-missing` | info | Only matters if this machine is also a client. |

## Order is part of the fix

Severity does not determine the order fixes are applied in, dependency does.
Setting `capture = kms` before granting the capability leaves the host worse
off than it started: the old path at least produced a picture on AMD, and the
new one cannot initialise. The sequence lives in `ORDER` in
[`diagnose.js`](../packages/core/diagnose.js) and the capability always precedes
the capture change.

## Adding one

A new Recipe needs four things, and the fourth is the one people skip:

1. An `id`, a `title` a person can read, and a severity.
2. A `detect(facts)` that reads measured facts and returns `null` when the
   fault is absent.
3. `evidence`: the specific reading that identifies it, quoted, so the report
   shows why rather than just what.
4. A position in `ORDER`, and a measurement proving the fix works on a real
   machine. Both directions: broken before, working after.
