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
disconnected, and nothing on this machine uses it. Sunshine does not know
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

> **Abandoned in 0.7.0.** Everything from here to the end of part three is a
> record of a path that worked and was removed. Clarity Stream no longer
> builds a phantom display; it resizes the real one for the duration of a
> session. The readings are kept because they are what was measured and
> because the three traps below are still true of anyone trying it. Nothing
> in this section describes what the current version does.

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

---

# Part three: the phantom display exists, and streams

> Still the abandoned path. See the note in part one.

Added 2026-10-11, after the reboot that armed it.

## It worked

```
/proc/cmdline   drm.edid_firmware=DP-3:edid/clarity-stream-DP-3.bin video=DP-3:e
DP-3            status connected, EDID 128 bytes, byte-for-byte ours
modes offered   1920x1080, 2560x1440, 1600x900, 1280x800, 1280x720, 1024x768
Hyprland        DP-3 1920x1080@59.93, described as "CSTI Inc Clarity Strm"
Sunshine        Screencasting with KMS, Found connector ID [834]
Moonlight       launch 200, a real picture at stddev 21.34
```

NVIDIA honours `drm.edid_firmware` when, and only when, `video=<CONNECTOR>:e`
is passed alongside it. A monitor that does not exist, at a resolution we
chose, captured by KMS, with both real monitors untouched.

The EDID comparison is what makes this conclusive rather than suggestive.
"Connected" alone proves nothing; a connector can report connected for its own
reasons. The bytes the kernel hands out are identical to the bytes we wrote,
and nothing else explains that.

## Three things the phantom broke, and what fixed them

**It stole a workspace.** Hyprland gives a new output the first free
workspace, so arming the phantom quietly moved workspace 2 onto a monitor
nobody can see. Switching to it would send windows nowhere. Fixed with a
persistent default workspace rule reserving workspace 11 for it. The rule
alone is not enough on a monitor that is already up: it keeps whatever it
grabbed, so the output is cycled off and on to pick the rule up.

**It caught the pointer.** Hyprland moves the cursor between monitors by
adjacency, and the phantom landed at 3652x0, flush against the ultrawide's
right edge. Fixed by parking it 6000px clear of every real monitor, so no
edge touches it.

**It will not stay parked.** Parking is runtime state and Hyprland re-reads
its config on every start. Worse, on this machine `~/.config/hypr/monitors.lua`
is rewritten by a bar panel (`im0001gt.screens`), which had already saved the
phantom into the managed block at its original adjacent position. So Clarity
Stream does not write to that file at all. It installs its own user unit,
`clarity-stream-phantom.service`, which parks the phantom at login.

## The design that did not work, and why

The obvious idea is to keep the phantom switched off and bring it up only for
the duration of a stream, through Sunshine's `prep-cmd`. It was built, and it
fails:

```
Error: Couldn't find monitor [2]      (x10, during encoder probing)
Error: Couldn't find any working encoder matching [nvenc]
Launch response: status_code="503" Failed to initialize video capture/encoding.
```

**Sunshine resolves `output_name` and probes encoders when its service
starts, not when a session begins.** With the phantom down at that moment,
index 2 does not exist, every encoder fails against a missing monitor, and the
launch is refused before `prep-cmd` ever runs. The phantom has to be up
whenever Sunshine is.

That also makes the `prep-cmd` actively dangerous rather than merely useless:
its `undo` would take the phantom down after each stream and break the next
launch. The entries carry no prep-cmd.

## Where the client opens

Hyprland has no primary monitor. A client lands on the monitor at the origin,
which here is a rotated 1440x900 panel at 0x0 while the 3440x1440 ultrawide
starts at 900x0, so Moonlight kept opening sideways on the small screen.

Fixed with `hl.window_rule({ match = "com.moonlight_stream.Moonlight", monitor = "DP-2" })`,
applied at login by the same unit that parks the phantom. Note the spelling:
`hl.windowrule` does not exist and answers
`attempt to call a nil value (field 'windowrule')`, while `hl.window_rule` and
Omarchy's own `o.window` wrapper both work.

## Two more places a name was assumed

The pattern from part two repeated twice more, which is why discovery is now
the rule rather than the exception:

- **Clarity moved.** `~/Clarity/Clarity.AppImage` became
  `~/Applications/Clarity.AppImage` between sessions. A hardcoded path did not
  error; it produced an app list with the Couch Mode tile silently missing.
  The AppImage is searched for now. Both `clarity.desktop` and
  `clarity-couch.desktop` still point at the old path and are therefore
  broken, which Clarity Stream reports rather than fixes, since they are not
  its files.
- **Node is not on root's PATH.** `sudo` resets `PATH` to `secure_path`, and
  this machine has no system Node, only mise's. The helper died with
  `node: command not found`. The CLI prints `process.execPath` now.

# Part four: why the phantom was removed

It worked, and it was removed anyway, on 2026-10-13.

The phantom was correct about the problem. A client wants its own resolution,
and changing the real monitor's mode rearranges a desktop somebody may be
using. A screen that does not physically exist solves that cleanly.

What it cost:

- A kernel parameter, which means editing the boot path on a machine whose
  owner did not ask for that.
- An EDID inside the initramfs, so a kernel update has to carry it forward.
- A reboot to arm, because NVIDIA reads a firmware EDID only at boot.
- Four separate faults, every one of them found on real hardware rather than
  predicted: the compositor took a workspace for it; the pointer slid onto it
  because Hyprland moves between monitors by adjacency; a bar panel rewriting
  `monitors.lua` restored it to where it had been; and it could not be cycled
  around a stream because Sunshine resolves `output_name` at service start,
  so a phantom that was down made every launch fail with `Couldn't find
  monitor` and a 503 before `prep-cmd` ran.

Each fix worked. The shape of the problem was that there was always another
one, because an output the compositor did not ask for is a thing every part of
the desktop has an opinion about.

Then it broke the machine's display configuration badly enough that the
owner's instruction was to disable it, which is the measurement that mattered.

The replacement is `stream-display.js`: record the streamed monitor's mode,
position and scale to disk, set the mode the client asked for, put it back
when the session ends. It needs no root, no reboot, nothing in the boot path,
and it has one failure mode rather than four. A hard-killed client leaves the
display small until Sunshine's session timeout, which `display-left-resized`
reports and `clarity-stream stream-display stop` fixes immediately.

## What the removal also exposed

Deleting the phantom took away the only fault that could return an `unknown`
verdict for an unreachable compositor, and the tests pinning the three-state
verdict were written against it. Repointing them at `output-pin-is-stale`
showed that fault had the bug the deleted one had been fixed for: with
`hyprctl` silent, every output looks undriven, so a healthy pin read as stale
and the doctor reported a blocker that was not there. Run outside the
graphical session it would have said the host could not stream.

It now reports unknown, and the test that would have caught it is the one
inherited from the phantom. Deleting code is a way to find out what the tests
were really holding up.

# Part five: a monitor was unplugged, and the stream followed it

2026-10-13, the same evening. One monitor from now on, by decision.

Unplugging the Dell from DP-1 moved every index below it, because
`output_name` is positional. `output_name = 1` had meant the ultrawide and now
meant the disabled phantom. That part was expected and is why
`output-pin-is-stale` exists.

What was not expected: with the pin corrected, and then with the pin removed
altogether, Sunshine kept binding **connector 826**.

```
[21:25:52.634]: Info: [wayland] Found monitor: VIE W340I165  (DP-2)
[21:25:52.634]: Info: -------- Start of KMS monitor list --------
[21:25:52.634]: Info: --------- End of KMS monitor list ---------
[21:25:52.775]: Info: Found connector ID [826]
```

Sunshine's Wayland enumeration is correct: it names DP-2, the ultrawide. Its
**KMS monitor list is empty**, so there is nothing for `output_name` to
resolve against, and it falls back to a connector of its own choosing. 826 is
DP-1, the port the Dell had been in.

sysfs says why that port was still a candidate:

```
card1-DP-1   disconnected  enabled   id=826
card1-DP-2   connected     enabled   id=830    <- the ultrawide, driven
card1-DP-3   connected     disabled  id=834    <- the phantom, kernel-forced
```

DP-1 reads **disconnected but still enabled**. The kernel had not torn down
the mode after the monitor was removed, so the connector still had a
programmed CRTC, and an earlier debug run had shown its geometry:

```
Debug: crtc(0, 0)
Debug: crtc(1440, 900)
```

1440x900, which is the Dell's resolution and not the ultrawide's 3440x1440.
Sunshine was capturing a scanout buffer for a monitor that was not there.

Three things were measured against this, and none of them fixed it:

1. Correcting `output_name` to the ultrawide's new index. Still 826.
2. Removing `output_name` entirely. Still 826.
3. Moving the ultrawide from its leftover `900x0` position to `0x0`, in case
   the gap at the origin was what the empty KMS list reflected. Still 826,
   and the KMS list stayed empty.

Each of those was followed by a service restart. **Restarting Sunshine does
not clear it**, which is the useful finding: this is kernel state, not
Sunshine state, and it needs a reboot.

## What was built from this

`capture-bound-to-undriven-connector`. Sunshine's config says what it was
asked for; its log says what it did, and after a monitor change those differ.
The probe now reads the last startup block of `sunshine.log` for
`Found connector ID [N]` and compares it against the connectors the
compositor is actually driving. When they disagree it is a blocker, and when
the port reads disconnected-but-enabled the finding says to reboot and says
that restarting will not do.

It reports unknown rather than guessing when the compositor cannot be
reached, when the log cannot be read, and when Sunshine has never started.

## A postscript on undoing it

`packaging/remove-phantom.sh` ran on this machine and its first version named
the wrong rebuild command.

```
==> ERROR: No presets found in /etc/mkinitcpio.d
==> WARNING: This does not update Limine boot entries.
    Use 'limine-mkinitcpio' or 'limine-update' instead.
```

`/etc/mkinitcpio.d` is empty here. `/etc/limine-entry-tool.d/omarchy-uki.conf`
sets `ENABLE_UKI=yes`, overriding the `ENABLE_UKI=no` in the shipped
`limine-entry-tool.conf`, so the boot image is a unified kernel image built by
`limine-mkinitcpio` from the `limine-mkinitcpio-hook` package. That one
command builds the image **and** updates the boot entries, so the separate
`limine-update` the old plan ran afterwards was redundant.

The inherited plan had carried `mkinitcpio -P` followed by `limine-update`
since the phantom was first armed. It had worked, because arming happened
through a path where something else had already generated the presets. Undoing
it was the first time the command ran on its own, and the assumption showed.

The script now tests for the UKI case and picks `limine-mkinitcpio`.

Which made the allowlist question concrete: the helper still permitted
`mkinitcpio -P`, `limine-update`, `bootctl update` and
`grub-mkconfig`, and nothing in the engine emitted any of them any more, nor
`remove-file`. Four ways to rebuild a stranger's boot image, reachable by no
caller. They are gone, with tests that refuse all five commands and both file
step kinds by name. The helper opens ports and sets a capability, and that is
the whole of what it can do.
