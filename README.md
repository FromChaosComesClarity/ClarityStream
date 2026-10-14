# Clarity Stream

Game streaming from a Linux box, including the NVIDIA ones where it has never
worked.

Sunshine and Moonlight are good software. Getting them working on a Linux host
is not a software problem, it is a configuration problem with a nasty property:
when you get it wrong, nothing fails. The host starts, the client connects, the
session negotiates, the bitrate climbs, and you watch a perfectly healthy
stream of solid black. There is no error message, because from Sunshine's point
of view nothing went wrong. It captured some pixels and they happened to all be
zero.

That is the problem this solves. Not "improved compatibility", not a wiki page
of things to try. Clarity Stream reads the actual machine, names the actual
fault, applies the actual fix, and then measures real pixels to prove the fix
worked.

## Why NVIDIA hosts show a black screen

On a wlroots compositor such as Hyprland, Sunshine's default capture path is
wlr-screencopy over dmabuf. The NVIDIA driver hands out buffers in a tiled,
compressed layout that this path cannot read, so it encodes black. The fix is
`capture = kms`, which reads the scanout buffer from the kernel instead.

But `capture = kms` on its own is not enough, and this is where most guides
stop:

- KMS capture is privileged. Without `cap_sys_admin` on the Sunshine binary it
  fails at init, and you are back to black.
- On a machine with more than one GPU, capture has to be pinned to the card
  that actually drives a display. An idle second GPU enumerates just as
  readily, and capturing it gives you a flawless stream of nothing.
- With more than one monitor, which one gets streamed is otherwise a coin toss.

All three are detected and fixed by name. See [docs/RECIPES.md](docs/RECIPES.md).

## Getting the client's resolution

Streaming your actual 3440x1440 desktop to a 1280x800 handheld wastes most of
your bitrate on black bars. So the host has to scan out at the resolution the
client asked for, for as long as the session lasts.

Clarity Stream sets the streamed monitor to that resolution when a stream
starts and puts it back exactly as it was when the stream ends. It records the
previous mode, position and scale before changing anything, and keeps that on
disk rather than in memory, so a crash mid-session does not lose the way back.
If the host has no mode of the shape the client asked for, it leaves the
display alone and lets the client scale, which is worse-looking and not broken.

Yes, the desktop visibly reflows, twice. That is the whole cost, and on a
machine you are streaming away from you are not looking at it.

**What this used to be, and why it is not any more.** The first answer was a
phantom display: take an unused physical connector, force it on with a
synthetic EDID generated for the client's resolution, and let the client have
a screen of its own while the real desktop stays untouched. It worked. The
measurements are in [docs/DIAGNOSIS.md](docs/DIAGNOSIS.md).

It was still the wrong trade. It needed a kernel parameter, an EDID in the
initramfs, and a reboot, because NVIDIA reads a firmware EDID only at boot. It
needed `video=<CONNECTOR>:e` alongside `drm.edid_firmware=`, which is silently
ignored on its own. And the compositor would not leave it alone: it took a
workspace, it sat adjacent to the desktop so the pointer slid onto it, and a
bar panel rewriting the monitor config put it back where it had been. Each of
those got a fix, and the fixes needed fixes. Removed in 0.7.0, along with
every kernel parameter it added.

## Upgrading from 0.6.x, if you armed a phantom display

If you ran a version before 0.7.0 and armed a phantom display, this version no
longer knows about it, and the kernel parameters are still on your machine.
Remove them:

```sh
sudo bash packaging/remove-phantom.sh
```

It deletes the generated EDID, the bootloader drop-in and the initramfs
drop-in, rebuilds the initramfs and regenerates the boot entry, and tells you
if any step fails before you reboot. Nothing else is touched. Reboot when
convenient; until then the forced connector stays on, because the kernel read
those parameters at the last boot.

If you never armed one, there is nothing to do. `clarity-stream doctor` will
tell you either way.

## Verifying, instead of hoping

Every other tool in this space ends at "now restart the service". Clarity
Stream captures a frame through the same DRM path Sunshine uses and measures
it, then tells you what the measurement means:

| compositor readback | DRM readback | conclusion |
| --- | --- | --- |
| live | live | the stream will work |
| live | black | capture is aimed at the wrong GPU or a dead connector |
| black | black | nothing is being drawn; the output is asleep or blanked |

It reads two frames, not one, and requires them to differ. That is not
fussiness: a single-frame check on this machine confidently reported a stream
as live when what it had actually captured was the client's own
`Starting Desktop...` placeholder.

It also knows the trap that makes a working host look broken. Streaming the
display your client window is sitting on feeds the capture back into itself,
the loop locks onto the black it started with, and you get a perfect
impression of the NVIDIA bug. Measured here: streaming DP-2 with the client on
DP-2 gave peak 1; the same host streaming DP-1 gave a real picture.

A config file that says `capture = kms` is not evidence. A frame at stddev
32.7 showing your actual desktop is.

## Running it

The engine works headlessly, on purpose. A host doctor you cannot run over SSH
is no use on a machine that is showing you a black screen.

```
node bin/clarity-stream doctor              # what would stop a stream, with evidence
node bin/clarity-stream verify [output]     # measure real pixels
node bin/clarity-stream firewall            # can another machine reach this host
node bin/clarity-stream apps                # the Moonlight entries this publishes
node bin/clarity-stream stream-display stop # put a stranded display back
```

Nothing in the engine escalates privilege by itself. Anything requiring root is
returned as a declarative plan, shown to you in full, and run by one helper
call after you approve it.

## Status

**It works.** On the development machine, an RTX 4060 Ti on Hyprland that had
never streamed anything but black, Clarity Stream found the faults, applied
the fixes, and a Moonlight client decoded a real picture. Measured, not
assumed: 32.7 standard deviation on a real desktop against a peak of 1 on
black. Every reading is in [docs/DIAGNOSIS.md](docs/DIAGNOSIS.md).

A laptop client has paired through the host's own window, streamed, and the
ultrawide resized to 1920x1080 for the session and returned to 3440x1440
afterwards.

Working: the probe, the fault catalogue, the diagnosis, the applier for
everything that does not need root, lossless `sunshine.conf` editing, the
session resize and its restore, firewall diagnosis for ufw and firewalld on
both address families, in-app pairing, and pixel verification.

The privileged helper is built: `bin/clarity-stream-helper` validates every
step of a plan against an allowlist before running any of it, and its refusals
are tested. It cannot write a file at all.

Both apps are built.

**The host** (`npm start`) shows what would stop a stream and why, fixes what
it can without root, pairs clients, publishes the Moonlight entries, stops a
running session, and measures real pixels on demand.

**The client** (`npm run start:client`) finds hosts on the network, shows which
are reachable, busy or unpaired, and starts a session in one click with Couch
Mode featured above the rest. It drives moonlight-qt rather than
reimplementing it, and reads pairing state from Moonlight's own configuration
so the two never disagree.

Both are faces over the same engine the CLI uses.

## Installing it

One line, on each machine. Arch-based distributions only.

**On the machine whose games you want to stream:**

```sh
curl -fsSL https://raw.githubusercontent.com/FromChaosComesClarity/ClarityStream/main/install.sh | sh -s -- host
```

**On a machine you want to play from:**

```sh
curl -fsSL https://raw.githubusercontent.com/FromChaosComesClarity/ClarityStream/main/install.sh | sh -s -- client
```

**On a machine that is both:** `sh -s -- both`.

It finds the latest release, downloads only the packages that machine needs,
**checks them against the `SHA256SUMS` published with the release**, and hands
them to pacman. It will not install a file whose checksum does not match, and
it will not go on if a release has no checksums at all. It also installs
`sunshine` or `moonlight-qt` if they are missing.

It asks before doing anything. Add `--yes` to skip that, `--tag v0.3.1` to
pin a release, and `--local` to install from `dist/pkg` in a clone.

If you would rather read it before running it, which is the correct instinct
for anything piped into a shell, it is [install.sh](install.sh) in this
repository, and you can equally clone and run `./install.sh host`.

Nothing is enabled, started or configured by installing. That is the
application's job, and it asks first.

### What the three packages are

`clarity-stream-common` carries the engine and a bundled Electron, which is
why it is the big one and the other two are a few kilobytes. A machine that is
host and client holds one copy of the runtime, not two. Nothing else is
required: no system Node, no system Electron, no versions to keep in step.

### Doing it by hand

Grab the packages from the
[latest release](https://github.com/FromChaosComesClarity/ClarityStream/releases/latest):

```sh
sudo pacman -U clarity-stream-common-*.pkg.tar.zst clarity-stream-0.*.pkg.tar.zst      # host
sudo pacman -U clarity-stream-common-*.pkg.tar.zst clarity-stream-client-*.pkg.tar.zst # client
```

### Setting up the host

Open **Clarity Stream** from your launcher, or run `clarity-stream-host`.

1. It reads the machine and tells you what would stop a stream, with the
   evidence for each thing. Press **Fix what I can** and it applies everything
   that does not need root: the capture method, which GPU to capture, which
   display, the encoder, and starting Sunshine as a user service.
2. Press **Publish Clarity entries** to put a Couch Mode tile in Moonlight.
3. Press **Measure now** whenever you want it to prove the capture is not
   black, rather than tell you it should be fine.

That is enough to stream. Nothing else is required, and nothing needs a reboot.

### The resolution the client asked for

**Publish Clarity entries** also wires up the session resize, so there is
nothing separate to turn on. When a client starts streaming, the streamed
monitor changes to the resolution that client chose and changes back when the
stream ends.

If you quit the client cleanly the display comes back immediately. If you kill
it, the display stays small until Sunshine gives up on the session, which takes
over thirty seconds. `clarity-stream doctor` reports a display left that way,
and `clarity-stream stream-display stop` puts it back now.

### If a client says the host is not answering

Almost always a firewall. Sunshine binds every interface and says nothing more
about it, so a host behind a default-deny firewall passes every check run on
the host itself and is invisible from everywhere else. The client reports the
host as not answering, pairing never starts, and nothing mentions a firewall.

`clarity-stream firewall` says whether that is what is happening, and
`--open` writes a plan that opens exactly the ports Sunshine needs:
TCP 47984, 47989 and 48010, UDP 47998 to 48000, 48002 and 48010. Port 47990,
the web interface, is deliberately left closed: it is the administrative
surface and Moonlight never touches it.

The host window offers the same thing as a button on the finding.

### Your own keyboard shortcuts

While streaming, the client's shortcuts should reach the host rather than the
machine you are sitting at: on a tiling desktop, Super+W otherwise closes the
stream window instead of doing whatever it does over there.

The client sends `--capture-system-keys always` by default, and offers
`fullscreen` and `never`. On Wayland this needs the compositor to implement
`keyboard-shortcuts-inhibit-unstable-v1`, which Hyprland does.

**Ctrl+Alt+Shift+Q always ends a session**, whatever the setting. Moonlight
reserves it, which matters most when the capture is working and the usual ways
out have stopped.

### Pairing a client

Open **Clarity Stream Client**. It finds hosts on the network by itself. Press
**Pair** and it shows four digits.

Type those four digits into the host's **Devices** panel and press **Pair it**.
That is the whole thing; you never open Sunshine's web interface, which is
where everyone else has to go to do this.

The host needs Sunshine's web username and password once, because accepting a
PIN goes through Sunshine's own API. The Devices panel asks for them the first
time, checks them before saving anything, and keeps them in your system
keyring where there is one. If Sunshine has never had credentials set at all,
it says so and tells you the one command that sets them.

The same panel lists what is already paired and lets you remove any of it.

### What is actually tested

Honestly: one machine. Omarchy (Arch), Hyprland 0.56, an RTX 4060 Ti on the
proprietary driver, Limine with a unified kernel image. Everything in
[docs/DIAGNOSIS.md](docs/DIAGNOSIS.md) was measured there.

The parts most likely to need work elsewhere:

- **The session resize** is Hyprland-specific. It drives `hl.monitor` through
  `hyprctl eval`, because Hyprland under a Lua config refuses `hyprctl
  keyword` outright. Another compositor needs its own path.
- **AMD** has one data point now, from a Lenovo laptop with a Lucienne APU
  running the released packages: compositor readback live, no `capture`
  setting needed, and the diagnosis clean apart from the firewall. The
  black-screen fault this project exists for is an NVIDIA one, and on AMD it
  simply does not fire. The DRM capture path is still unproven there, and
  nothing has streamed from it yet.
- **Intel** has no data at all.
- **Capture on anything but a wlroots compositor** is untested. Sunshine has a
  KWin path that Clarity Stream does not drive yet.

If something is wrong, `clarity-stream doctor` prints what it measured and
what it concluded, which is the useful thing to paste into an issue. It exits
0 when a stream should work, 1 when something would stop it, and 2 when it
could not tell.

### Building it yourself

```sh
git clone https://github.com/FromChaosComesClarity/ClarityStream
cd ClarityStream && npm install && npm run pkg
```

The packages land in `dist/pkg/`. To run it without installing, `npm start`
for the host and `npm run start:client` for the client.

## Licence

MIT.
