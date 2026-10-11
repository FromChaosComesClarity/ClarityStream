# Architecture

## Shape

```
packages/core/        the engine, no UI, no privilege, runnable over SSH
  probe.js            reads the machine. No opinions, no invented defaults
  faults.js           the Recipe catalogue
  diagnose.js         facts -> findings -> an ordered plan
  sunshine-conf.js    lossless read/modify/write of sunshine.conf
  edid.js             synthesises an EDID 1.4 base block
  cvt.js              VESA CVT reduced-blanking timings
  phantom.js          plans the phantom display, snapshots monitor state
  bootloader.js       Limine, GRUB and systemd-boot, as drop-ins
  verify.js           measures real pixels and interprets the result
bin/clarity-stream    headless CLI over all of the above
bin/clarity-stream-helper  the only part that runs as root
apps/host/            Electron host UI
apps/client/          Electron client app
```

## Three rules the engine follows

**The engine never escalates.** Anything needing root comes back as a
declarative plan: a list of `write-file`, `remove-file` and `run` steps. The UI
shows the plan in full, the user approves it, and one privileged helper
executes it. Nothing shells out to `sudo` mid-diagnosis, and nothing is
modified as a side effect of looking.

**Nothing the user owns gets clobbered.** `sunshine.conf` is patched line by
line, preserving comments, ordering and every key we do not recognise, with a
backup kept beside it. Kernel parameters and initramfs additions are drop-in
files that undo by deletion. No distribution-owned file is edited.

**A fact that could not be read is not a fact.** Probes return `null` and
detectors return `unknown` rather than assuming the good case. `getcap`
printing nothing means no capabilities; `getcap` failing means we do not know,
and those are reported differently.

## Decisions, and why

**Phantom display on a spare connector, not a headless output.** A
compositor-side headless output has no CRTC, so KMS capture cannot see it, and
KMS is the only capture path that is not black on NVIDIA. Forcing an unused
physical connector with a synthetic EDID gives a real CRTC at exactly the
client's resolution while leaving the desktop monitors untouched. Costs one
reboot to arm, which is stated upfront.

**Host and client are both full applications.** The host side carries the
weight: probe, diagnose, fix, verify, publish, pair. The client is its own app
rather than a thin wrapper, so discovery, pairing and launching happen without
the user ever opening Moonlight's settings.

**One published app entry: Couch Mode.** Moonlight's grid is a TV interface and
a few hundred tiles is not usable on one. Clarity Stream publishes a single
entry that launches Clarity's gamepad-driven Couch Mode, and game selection
happens there, over the stream, in a UI built for it. A Desktop entry comes
along for the cases where you want the machine itself.

## The privileged helper

`bin/clarity-stream-helper` is the only component that ever runs as root. It
takes a plan, validates every step against an allowlist, prints what it will
do, and does only that. There is no shell anywhere in it.

- Writable paths are a fixed set of regexes, every one of them a file Clarity
  Stream owns. Deleting those files undoes everything; none belongs to a
  package.
- Runnable commands are matched on the whole argv, not a prefix, so
  `mkinitcpio -P` is allowed and `mkinitcpio -P ; id` is not.
- `setcap` accepts only the two capability strings KMS capture needs.
- A path that does not resolve to itself is refused, which closes the symlink
  and `..` routes out of the allowlist.
- Validation runs over the entire plan before any step executes, so a plan
  that is partly illegal does not get to perform the legal half of itself.

The engine cannot ask it to do anything the allowlist does not already permit.
That is the point: the unprivileged side builds plans, and a bug there should
not become a root exploit here. The refusals are tested.

### Invoking it

`sudo` resets `PATH` to `secure_path`, so an interpreter installed per user
(mise, nvm, asdf) does not exist as far as root is concerned, and the helper
fails with `node: command not found` before it reads a single step. The CLI
therefore prints `process.execPath`, the absolute path of the interpreter
already running, rather than the bare name.

That works for development and it is not good enough to ship. A packaged
Clarity Stream cannot assume the user's Node is reachable by root, or that the
machine has a system Node at all: this one does not. The shipped helper needs
either a runtime bundled beside it or a rewrite into something root can always
run. Its allowlist logic is small enough for the second option to be
realistic.

## Still to build

- The Electron host UI over the engine: findings, the plan, an Apply button,
  and the verification result as a measured number.
- Pairing against Sunshine's local HTTPS API so a PIN is typed once, in
  Clarity Stream, instead of in a browser.
- The Couch Mode app entry, written into `apps.json` without disturbing
  entries the user added.
- Client-adaptive resolution: the client reports what it wants, the host
  regenerates the phantom EDID to match. The reboot requirement makes this
  an arm-once-per-resolution affair, so the client should pick from a small set
  of armed modes rather than anything arbitrary.
- The AMD fallback worth measuring: this machine's unused Raphael iGPU could
  host the phantom connector and do VAAPI encoding, since AMD KMS capture is
  not affected by the NVIDIA readback problem. It costs a cross-GPU copy per
  frame. Worth measuring before recommending, not before.
