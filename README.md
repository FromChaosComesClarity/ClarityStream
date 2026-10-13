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

## The phantom display

Streaming your actual 3440x1440 desktop to a 1280x800 handheld wastes most of
your bitrate on black bars, and the Steam Remote Play trick of changing your
monitor's resolution rearranges your desktop every time you play.

The obvious answer is a virtual display, and the obvious way to get one does
not work: a compositor-side headless output (`hyprctl output create headless`)
has no CRTC, so there is no scanout buffer, so KMS capture cannot see it. That
is the one capture path that works on NVIDIA, so headless outputs are a dead
end here.

Clarity Stream takes an unused physical connector instead and forces it on with
a synthetic EDID that it generates for exactly the resolution your client asked
for. The kernel believes there is a monitor on that port. The compositor gives
it a real output with a real CRTC and a real scanout buffer. KMS captures it
without complaint, and your desktop monitors are never touched.

Three things about this, learned the hard way and all encoded in the planner:

1. `drm.edid_firmware=` alone is silently ignored by the NVIDIA driver. It
   only takes effect alongside `video=<CONNECTOR>:e`.
2. The EDID is read during early boot, so the file has to be inside the
   initramfs, not merely present on disk.
3. NVIDIA does not hot-reload a firmware EDID, so arming the phantom costs one
   reboot. There is no way around that and Clarity Stream says so upfront
   rather than letting you discover it.

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
node bin/clarity-stream phantom 1920x1080   # plan the phantom display
node bin/clarity-stream edid 1280x800 f.bin # build an EDID on its own
node bin/clarity-stream boot                # how a kernel param gets added here
```

Nothing in the engine escalates privilege by itself. Anything requiring root is
returned as a declarative plan, shown to you in full, and run by one helper
call after you approve it.

## Status

**It works, phantom display and all.** On the development machine, an RTX 4060
Ti on Hyprland that had never streamed anything but black, Clarity Stream found
the faults, applied the fixes, armed a display that does not physically exist,
and a Moonlight client decoded a real picture of it. Both real monitors were
untouched throughout. Every reading is in
[docs/DIAGNOSIS.md](docs/DIAGNOSIS.md).

The phantom stays up rather than being cycled around each stream, which was
the first design and does not work: Sunshine resolves `output_name` when its
service starts, so a phantom that is down at that moment makes every launch
fail with `Couldn't find monitor` and a 503, before any `prep-cmd` can run.
Instead it is parked 6000px clear of every real monitor, holding a reserved
workspace of its own, by a login unit Clarity Stream installs. It never writes
to the user's Hyprland config, which on this machine is rewritten by a bar
panel anyway.

Working: the probe, the fault catalogue, the diagnosis, the applier for
everything that does not need root, lossless `sunshine.conf` editing, EDID
generation (validated against `edid-decode`), the phantom display planner,
bootloader and initramfs plumbing for Limine, GRUB and systemd-boot, and pixel
verification.

The privileged helper is built: `bin/clarity-stream-helper` validates every
step of a plan against an allowlist before running any of it, and its refusals
are tested.

The phantom EDID advertises several modes, not one. NVIDIA reads a firmware
EDID only at boot, so a single-mode phantom would mean a reboot every time you
wanted a different client resolution. One EDID carries 1920x1080 preferred,
2560x1440 as a second detailed timing, and 1600x900, 1280x800, 1280x720 and
1024x768 as standard timings. All are selectable at runtime.

Both apps are built.

**The host** (`npm start`) shows what would stop a stream and why, fixes what
it can without root, manages the phantom, publishes the Moonlight entries, and
measures real pixels on demand.

**The client** (`npm run start:client`) finds hosts on the network, shows which
are reachable, busy or unpaired, and starts a session in one click with Couch
Mode featured above the rest. It drives moonlight-qt rather than
reimplementing it, and reads pairing state from Moonlight's own configuration
so the two never disagree.

Both are faces over the same engine the CLI uses.

## Installing it

Grab the three packages from the
[latest release](https://github.com/FromChaosComesClarity/ClarityStream/releases/latest)
and install the ones that machine needs. Arch-based distributions only.

**On the machine whose games you want to stream:**

```sh
sudo pacman -U clarity-stream-common-*.pkg.tar.zst clarity-stream-0.*.pkg.tar.zst
sudo pacman -S sunshine          # the streaming host itself
```

**On a machine you want to play from:**

```sh
sudo pacman -U clarity-stream-common-*.pkg.tar.zst clarity-stream-client-*.pkg.tar.zst
sudo pacman -S moonlight-qt
```

A machine that is both takes all three. `clarity-stream-common` carries the
engine and a bundled Electron, which is why it is the big one and why the
other two are a few kilobytes; a machine that is host and client holds one
copy of the runtime, not two.

Nothing else is needed. No system Node, no system Electron, no matching
versions to keep up with. Installing changes no configuration, starts no
service and touches no display: everything happens when you ask for it.

### Setting up the host

Open **Clarity Stream** from your launcher, or run `clarity-stream-host`.

1. It reads the machine and tells you what would stop a stream, with the
   evidence for each thing. Press **Fix what I can** and it applies everything
   that does not need root: the capture method, which GPU to capture, which
   display, the encoder, and starting Sunshine as a user service.
2. Press **Publish Clarity entries** to put a Couch Mode tile in Moonlight.
3. Press **Measure now** whenever you want it to prove the capture is not
   black, rather than tell you it should be fine.

That is enough to stream. The phantom display is optional and worth it.

### The phantom display

Streaming your real monitor sends whatever resolution it happens to be, so a
1080p client gets your ultrawide letterboxed and most of the bitrate goes on
black bars. A phantom display is an unused port on your graphics card, forced
on with an EDID Clarity Stream generates, so the client gets its own screen at
its own resolution and your real monitors are never touched.

In the host window, under **Phantom display**, pick a spare connector and a
resolution and press **Prepare it**. It writes out a plan, you run one command
as root, and you reboot once. The reboot is not avoidable: NVIDIA reads a
firmware EDID only at boot.

Afterwards press **Keep it parked**, which installs a small user service. That
matters more than it sounds: parking is runtime state, and anything that makes
your compositor re-read its config throws it away.

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

- **The phantom display** is the deepest into the system. The bootloader
  plumbing understands Limine, GRUB and systemd-boot, but only Limine has been
  run for real. The parking and the workspace reservation are Hyprland-specific.
- **AMD and Intel hosts** should need less of this, not more: the black-screen
  fault this exists for is an NVIDIA one. The diagnosis still applies, and the
  faults that do not match simply do not fire.
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
