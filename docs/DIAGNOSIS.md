# What was measured, on the machine that could never stream

Everything below was read off the development machine on 2026-10-11, not
inferred. Where something could not be measured it says so.

## The machine

| | |
| --- | --- |
| Host | omarchy, kernel 7.2.5-3-omarchy |
| Compositor | Hyprland 0.56.2, Wayland session |
| GPU 0 | `card0`, amdgpu, `1002:164e` (Raphael iGPU), render node `renderD129` |
| GPU 1 | `card1`, nvidia, `10de:2788` (RTX 4060 Ti), render node `renderD128` |
| Driver | nvidia-open-dkms 610.57.04, `nvidia_drm modeset=1` in modprobe.d |
| Displays | DP-1 1440x900 and DP-2 3440x1440, **both on `card1`** |
| Sunshine | not installed; available as `omarchy/sunshine 2026.516.143833-4.1` |
| Moonlight | moonlight-qt 6.1.0-7 |
| Bootloader | Limine 12.8.0 via limine-entry-tool, `ENABLE_UKI=yes` |

Two findings from this alone:

**The AMD iGPU drives nothing.** `card0` has four connectors and all four are
disconnected. Jose does not use it. But Sunshine does not know that: it
enumerates `card0` as readily as `card1`, and capturing it yields a stream that
is valid, healthy and entirely black. This is why `adapter_name` gets pinned to
`/dev/dri/renderD128` rather than left to chance.

**Hyprland renders on NVIDIA.** From its own log: `drm: Found 2 GPUs`, then
`gpu /dev/dri/card1 becomes primary drm`, then
`Renderer: NVIDIA GeForce RTX 4060 Ti/PCIe/SSE2`. It holds file descriptors on
both cards, so the open-fd list alone is not conclusive; the renderer string
is.

## Why the stream is black

Sunshine's default capture on a wlroots compositor is wlr-screencopy over
dmabuf. The NVIDIA driver's buffers are tiled and compressed in a layout that
path cannot read, so it encodes black without erroring. Corroborated by
[LizardByte/Sunshine#5018](https://github.com/LizardByte/Sunshine/issues/5018),
[#5258](https://github.com/LizardByte/Sunshine/issues/5258) and
[omacom/omarchy#9011](https://github.com/omacom/omarchy/pull/9011), which
defaults NVIDIA users to `capture = kms` for exactly this reason.

NvFBC, NVIDIA's own capture API, does not support Wayland at all. The XDG
portal path was added upstream in April 2026
([#4417](https://github.com/LizardByte/Sunshine/pull/4417)) but
[does not work on Hyprland](https://github.com/LizardByte/Sunshine/issues/4662).

So on this machine KMS is the only capture path that can work, and that
constraint drives the whole design.

### Measured: the compositor is not the problem

`grim`, which uses wlr-screencopy into a shared-memory buffer, captures both
monitors successfully:

```
DP-2  verdict live   mean 33.89  peak 98   stddev 10.19
DP-1  verdict live   mean 30.12  peak 108  stddev 36.85
```

So screencopy itself is fine on NVIDIA here. What fails is specifically the
dmabuf consumer in Sunshine's wlr backend. That distinction matters: it means
the fix is a capture-path change, not a compositor or driver problem.

### Measured: KMS capture needs privilege, and says so in a recognisable way

Running the same DRM capture Sunshine's `kms` backend uses, unprivileged:

```
$ ffmpeg -f kmsgrab -device /dev/dri/card1 -i - ...
[in#0] No handle set on framebuffer: maybe you need some additional capabilities?
[in#0] Error opening input: Invalid argument
```

That exact string is now a recognised signature in the verifier, so a missing
capability is never misreported as a black screen. The required capability is
`cap_sys_admin,cap_sys_nice+p` on the resolved Sunshine binary.

## Why not a headless virtual output

Hyprland can make one, and it was tested here: `hyprctl output create headless`
produced `HEADLESS-1`, and `hyprctl output remove HEADLESS-1` cleaned it up.

But a headless output has no CRTC, so there is no scanout buffer, so KMS
capture cannot see it. Confirmed by
[Sunshine#2955](https://github.com/LizardByte/Sunshine/issues/2955) and noted
in the review on omarchy#9011. Since KMS is the only working capture path on
NVIDIA, headless outputs are unusable for streaming here, and the
`headless-output-cannot-be-captured` fault exists to say so plainly instead of
letting someone rediscover it.

### A side effect worth knowing about

Creating and removing that headless output triggered a full monitor
reconfigure, and Hyprland re-applied `~/.config/hypr/monitors.lua`. DP-2 had
been running at a runtime 3440x1440@165, scale 1.25, position 900x288, while
the config file says `3440x1440@60.00`, scale 1.0, position 900x0. It snapped
to the file's values and the runtime state was lost.

Arming the phantom display adds an output and will trigger the same
reconfigure, so `planArm` snapshots every monitor first and returns the
commands to restore them. On a Lua config `hyprctl keyword` is refused
outright; `hyprctl eval` with the `hl.*` API is the only form that applies.

## The phantom display path, and its three traps

Spare connectors on the card that drives the displays: **DP-3** and
**HDMI-A-1**. DisplayPort is preferred because DP accepts arbitrary CVT
timings most readily, where HDMI is constrained to CEA modes on some driver
versions.

1. `drm.edid_firmware=DP-3:edid/clarity-stream-DP-3.bin` **alone does nothing
   on the NVIDIA driver.** It needs `video=DP-3:e` alongside it to force the
   connector enabled.
2. The EDID is read during early boot, so the file must be in the initramfs.
   On this machine that is a `FILES+=(...)` drop-in in
   `/etc/mkinitcpio.conf.d/`, matching the house style of the drop-ins already
   there.
3. NVIDIA does not hot-reload a firmware EDID, so this costs one reboot.

Step order is not obvious and is easy to get backwards. Files first, then
`mkinitcpio -P`, then `limine-update`. This machine builds a UKI, which bakes
the kernel command line and the initramfs into one image, so regenerating the
boot entry before rebuilding the initramfs produces a UKI that carries the new
command line and the old initramfs: the kernel is told to load an EDID that is
not in there, and the connector stays dark.

Kernel parameters are added as a drop-in at
`/etc/limine-entry-tool.d/clarity-stream.conf` using
`KERNEL_CMDLINE[default]+=`, so undoing it is deleting one file. No
distribution-owned file is edited.

## Generated EDIDs are validated, not assumed

`edid-decode` is the oracle in the test suite, not our own parser. It reads
back the exact requested resolution with no warnings, and the computed pixel
clocks match the published VESA CVT reduced-blanking values: 1280x800 at
71.00 MHz, 1920x1080 at 138.50 MHz, 1680x1050 at 119.00 MHz.

Two bugs it caught that would otherwise have shipped:

- Colour depth was being written as `0b001`, which claims a 6-bit panel. The
  8-bit value is `0b010`.
- The range descriptor claimed default GTF support, which is untrue of a CVT
  reduced-blanking timing. It now says range-limits-only.

And one design decision it forced: CVT rounds the width down to a multiple of
8, which turns a client asking for 1366x768 into 1360x768 and a silently
scaled stream. EDID itself has no such constraint, so the generator keeps
CVT's blanking figures and holds the exact requested width.

---

# Part two: Sunshine installed, and a stream proved end to end

Added 2026-10-11, after installing `omarchy/sunshine 2026.516.143833-4.1` on
the same machine.

## What the doctor found on a live install

Three blockers, two degradations. The capability check correctly stayed
silent: the Omarchy package already ships
`cap_sys_admin,cap_sys_nice=p` on `/usr/bin/sunshine`, so that fault was
absent and was reported as absent.

## Corrections the live install forced

**The user unit is not called `sunshine.service`.** The LizardByte package
names it `app-dev.lizardbyte.app.Sunshine.service` and declares
`Alias=sunshine.service`, but a systemd alias only exists once the unit is
enabled. Asking about `sunshine.service` on a fresh install answers
`not-found`, and a fix that named it would have failed. The probe now
discovers the unit instead of assuming its name.

**`output_name` is an index, not a connector name.** Every guide says to put
something like `DP-2` there. For the KMS backend that matches nothing, raises
no error, and leaves Sunshine streaming whatever it enumerated first. Measured
by setting it and reading Sunshine's own debug log:

```
output_name = 0  ->  crtc_id(200), connector 826, crtc(1440, 900)   DP-1
output_name = 1  ->  crtc_id(392), connector 830, crtc(3440, 1440)  DP-2
```

Unpinned, it chose DP-1: the 1440x900 Dell, not the ultrawide. Sunshine's own
"KMS monitor list" prints empty on this host, which is why its web UI cannot
offer a display picker for KMS capture.

The order is derivable without parsing logs. sysfs exposes `connector_id` per
connector (DP-1 = 826, DP-2 = 830), and sorting connected connectors by it
reproduces Sunshine's index order exactly.

**Restarting Sunshine a few times trips its own start limit.** The packaged
unit sets `StartLimitBurst=5` over `StartLimitIntervalSec=500`. Tuning capture
settings means several restarts, after which systemd refuses to start it and
the unit sits `failed` for reasons unrelated to configuration. Clearing the
failure is now part of starting it.

**NVENC runs without CUDA in this package.** Sunshine says so at startup:
`Attempting to use NVENC without CUDA support. Reverting back to GPU -> RAM -> GPU`.
`ldd /usr/bin/sunshine` links no CUDA library, so every captured frame is
copied out to system memory and back rather than staying in VRAM. It streams;
it costs latency. No setting fixes it, and the catalogue says so rather than
offering one that will not help.

## The stream, measured

After `capture = kms`, `adapter_name = /dev/dri/renderD128`, `encoder = nvenc`
and `output_name = 1`, Sunshine logged `Screencasting with KMS` and
`Found connector ID [830]`.

Moonlight was paired locally and told to stream the Desktop app. Three
readings, and the first two are the interesting ones.

**Reading 1, a false positive.** Captured four seconds after the client window
appeared: mean 49.24, peak 104, stddev 3.32, reported **live**. Looking at the
frame showed Moonlight's own `Starting Desktop...` placeholder. No video had
arrived at all. A single non-black frame is not evidence of a stream, and the
verifier was changed: it now takes two frames, requires them to differ, and
treats a frame with stddev below 8 as low-detail rather than live.

**Reading 2, a real black stream, for a reason that is not a fault.** Streaming
DP-2 with the client full-screen on DP-2: mean 0.97, peak 1, and two
byte-identical frames. That is the capture feeding back into itself through
the client window. The loop locks onto what it started with, and it starts
before the first decoded frame, so it locks onto black. It looks exactly like
the NVIDIA bug this project exists to fix, and it is not one.

**Reading 3, the proof.** Streaming DP-1 with the client on DP-2, so there is
no loop: mean 20.48, peak 108, **stddev 32.7**, and the frame shows the Dell's
actual content, rotated, with the Omarchy bar along its edge. HEVC frames
decoding client-side (`Decoded frame with POC 0/0`).

**KMS capture works on this machine.** It is the first time it has streamed
anything but black.

What is not yet proved: DP-2 specifically, end to end, because every local test
of it is confounded by the loopback. That is a property of testing a host from
itself, and disappears the moment a real client connects from another machine.

## A bug in the verifier itself

The frame measurement read ffmpeg's raw output as UTF-8, which silently
replaces every byte above 127. A mid-grey test frame measured 253 instead of
128, and a detailed frame returned 3977 of its 4096 samples. Dark frames were
unaffected, which is why the conclusions above still stand, but anything bright
was being measured wrongly. Raw frames are now read as bytes, and a test
asserts that mid grey reads as mid grey.
