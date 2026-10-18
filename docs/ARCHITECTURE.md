# Architecture

## Shape

```
packages/core/        the engine, no UI, no privilege, runnable over SSH
  probe.js            reads the machine. No opinions, no invented defaults
  faults.js           the Recipe catalogue
  diagnose.js         facts -> findings -> an ordered plan
  sunshine-conf.js    lossless read/modify/write of sunshine.conf
  stream-display.js   resizes the streamed display for a session, and back
  verify.js           measures real pixels and interprets the result
  hypr.js             drives Hyprland: set a mode, pin the client window
  outputs.js          which monitor Sunshine actually streams, by index
  firewall.js         whether another machine can reach this host at all
  network.js          the link this host streams over, and what it can carry
  sunshine-api.js     pairing and session control over Sunshine's own API
  sunshine-apps.js    the Moonlight app list, preserving what the user owns
  clarity-app.js      finds Clarity.AppImage instead of assuming where it is
  settings.js         host settings both the CLI and the window read
  apply.js            runs the fixes that need no root
bin/clarity-stream    headless CLI over all of the above
bin/clarity-stream-helper  the only part that runs as root
apps/host/            Electron host UI, a face over packages/core
apps/client/          Electron client app
```

## Three rules the engine follows

**The engine never escalates.** Anything needing root comes back as a
declarative plan: a list of `run` and `setcap` steps. The UI shows the plan in
full, the user approves it, and one privileged helper executes it. Nothing
shells out to `sudo` mid-diagnosis, and nothing is modified as a side effect
of looking.

The helper does two things: open Sunshine's ports, and grant the Sunshine
binary `cap_sys_admin`. It cannot write a file, delete a file, or touch the
boot path. The phantom display was the only thing that needed any of that, and
those step kinds went with it rather than staying behind as an allowlist with
nothing legal in it. Dead root capability is still root capability.

**Nothing the user owns gets clobbered.** `sunshine.conf` is patched line by
line, preserving comments, ordering and every key we do not recognise, with a
backup kept beside it. No distribution-owned file is edited, and nothing is
added to the kernel command line or the initramfs.

**A fact that could not be read is not a fact.** Probes return `null` and
detectors return `unknown` rather than assuming the good case. `getcap`
printing nothing means no capabilities; `getcap` failing means we do not know,
and those are reported differently.

## Decisions, and why

**Resize the real display, do not invent a second one.** The client needs the
host to scan out at the resolution the client asked for, or the picture is
scaled. The first answer was a phantom display: force an unused connector on
with a synthesised EDID, and the client gets a screen of its own while the
desktop is untouched. It worked and it was the wrong trade. It cost a kernel
parameter, a reboot per resolution, and a compositor that kept forming
opinions about the extra output. What ships instead sets the streamed
monitor's mode for the duration of the session and puts it back afterwards.
The desktop visibly reflows, twice, and that is the whole cost. Nothing is
installed and nothing needs undoing at boot.

**One display is the default assumption.** `output_name` is a positional
index, so pinning it on a machine with one monitor cannot help and breaks the
moment a monitor is plugged in or taken away. With one display Clarity Stream
leaves it unset and says why. The pin is for machines that genuinely have a
choice to make.

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

Plans carry the version that produced them. Without that, handing a plan to
an older helper fails with "refusing to run", the same words used when a plan
asks for something genuinely forbidden, and those are opposite problems: one
means upgrade, the other means something is wrong. It happened for real, with
a 0.3.1 checkout writing a firewall plan for an installed 0.2.0 helper that
had never heard of ufw. The version is only mentioned when a step actually
fails validation, so a plan from another version whose steps are all allowed
still runs.

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

## The host UI

A window over `packages/core`, not a second implementation. Every number it
shows comes from the same engine the CLI uses, so the two cannot disagree.
The renderer has no node integration; everything crosses through preload as a
named channel, and there is no generic invoke passthrough.

Two things about it that are not obvious:

**The scrollbar is drawn, not styled.** On this Electron build
`::-webkit-scrollbar` is ignored outright, measured by forcing `width: 40px`
and watching the scrollbar stay 10px. The standard `scrollbar-width` and
`scrollbar-color` do reach it, but that renderer draws stepper arrows at both
ends which no selector removes, and disabling Chromium's Fluent scrollbar
feature did not bring the pseudo-elements back. So the native one is hidden
and a thumb is painted instead. Scrolling itself is untouched: the wheel,
keys and trackpad still drive the real document.

**Long captions wrap.** A flex row without `flex-wrap` and a long caption
pushes a card wider than its container, which gives the whole page horizontal
overflow and clips every card at the window edge. It showed up the first time
the window was tiled to 688px, which is just a normal tile on a 3440 monitor.

## Still to build

- Pairing against Sunshine's local HTTPS API so a PIN is typed once, in
  Clarity Stream, instead of in a browser.
- The Couch Mode app entry, written into `apps.json` without disturbing
  entries the user added.
- Choosing the streamed monitor by name rather than by index, if Sunshine ever
  grows a way to say it. The index is what Sunshine accepts today, and it is
  positional, which is the whole reason `output-pin-is-stale` has to exist.
- Recovering a stranded resize faster than Sunshine's session timeout. A
  hard-killed client leaves the display small until Sunshine gives up on the
  session, which is over thirty seconds of an unusable desktop.
