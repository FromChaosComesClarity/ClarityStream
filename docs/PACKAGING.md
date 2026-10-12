# Shipping it

Two applications, one build, everything vendored.

```
npm run pkg
```

That produces three packages in `dist/pkg/`:

| package | size | contents |
| --- | --- | --- |
| `clarity-stream-common` | ~107 MB | `/opt/clarity-stream/{app,electron}`: the engine, both UIs, and the Electron runtime |
| `clarity-stream` | tiny | the host: `clarity-stream` (CLI), `clarity-stream-host` (UI), the root helper, the phantom unit, a desktop entry |
| `clarity-stream-client` | tiny | the client: `clarity-stream-client`, a desktop entry |

```
sudo pacman -U dist/pkg/clarity-stream-common-*.zst dist/pkg/clarity-stream-0*.zst
sudo pacman -U dist/pkg/clarity-stream-common-*.zst dist/pkg/clarity-stream-client-*.zst
```

The host machine wants the first pair, a machine you play from wants the
second, and a machine that is both takes all three.

## Nothing outside the package is required

No system `nodejs`, no system `electron`, no matching Electron version to keep
up with. The runtime is vendored, and the CLI and the root helper run on it
through `ELECTRON_RUN_AS_NODE`. Verified by running `clarity-stream doctor`
from the staged tree with nothing else on PATH.

That is not only about convenience. During development the helper died with
`node: command not found` under `sudo`, because `sudo` resets `PATH` to
`secure_path` and the only Node on this machine is a per-user one from mise.
A bundled interpreter at a fixed path has no such problem.

The three packages exist so that Electron is carried once rather than twice.
A machine that is both host and client installs one copy of it.

## Why not an AppImage

Everything else here is an AppImage, and this is the one that cannot be,
for a reason that is specific rather than aesthetic.

Clarity Stream has two pieces that must live at **stable, root-owned paths**:

- The privileged helper, which writes an EDID into `/lib/firmware/edid`,
  rebuilds the initramfs and regenerates the boot entry.
- The systemd user unit that parks the phantom display at login, which names
  the CLI by absolute path.

An AppImage mounts itself at `/tmp/.mount_XXXXXX`, and that path is different
on every launch. A unit file or a sudoers rule naming it is invalid by the
next boot. The usual workaround is for the AppImage to copy its helper
somewhere fixed on first run, which puts a binary that will be executed as
root into a directory the user can write to. That is a way to become root, and
it is not worth the convenience.

A native package puts the helper at `/usr/lib/clarity-stream/helper`, owned by
root, mode 755, at a path that does not move.

## What the package does not do

It does not enable anything on its own. Installing it changes no
configuration, starts no service and touches no monitor. The host has to be
told to, from its window or from `clarity-stream fix --apply`.

The phantom unit is shipped but not enabled, because arming a phantom display
is a decision with a reboot attached. `clarity-stream phantom --install-service`
enables the packaged unit when it finds one, and removes any unit left in
`~/.config/systemd/user` by a development checkout, since a user unit shadows
the packaged one and would keep pointing at a directory that may be gone.

## Version

`pkgver` comes from `package.json` at build time rather than being kept in
step by hand.

## Running from the checkout

```
npm start           # the host
npm run start:client
node bin/clarity-stream doctor
```

The code works out which it is: `packages/core/paths.js` reports a packaged
install when `/usr/lib/clarity-stream/helper` and `/opt/clarity-stream` both
exist, and every command that prints a root command or writes a unit asks it
rather than assuming.
