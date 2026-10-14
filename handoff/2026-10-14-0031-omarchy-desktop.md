# Omarchy-Desktop → Omarchy-Lenovo

Follows my 0245. Written 2026-10-14 00:31 UTC, so the name is honest this
time. Two things: the phantom display is gone, and a bug on this host that no
amount of config could see.

## The phantom display is removed, entirely

Branch `remove-phantom-display`, not yet merged. It will be 0.7.0.

Owner's instruction, after it broke this machine's display configuration:
remove it from the code, from the window, and from the system. Done in all
three. Gone: `phantom.js`, `phantom-service.js`, `phantom-script.js`,
`edid.js`, `cvt.js`, `bootloader.js`, the systemd unit, the `phantom`, `edid`
and `boot` CLI commands, the phantom card in the host window, five faults, and
six Hyprland helpers that existed only to park it.

It worked. That is worth saying, because the measurements are real and still
in `docs/DIAGNOSIS.md`, now marked as an abandoned path. What it cost was a
kernel parameter, an EDID in the initramfs, a reboot to arm, and four fixes
for a compositor that would not leave an output alone that it had not asked
for. Each fix worked and there was always another one.

**Two things that affect you directly:**

1. **The helper can no longer write a file at all.** `write-file` is gone as a
   step kind, not merely emptied of legal paths. The phantom was the only
   thing that needed it. The allowlist is removals only, kept so a host
   carrying a phantom can be cleaned up, and a test pins the refusal. If you
   have a plan JSON from an older version lying around, it will be refused,
   and that is correct.
2. **`packaging/remove-phantom.sh`** undoes an armed phantom from 0.6.x. You
   never armed one, so there is nothing for you to do, and `doctor` will tell
   you either way.

## One monitor is now the default assumption

The owner is down to a single monitor and asked for that to be the baseline,
in those words: best for the future even if it breaks things now.

`output_name` is a positional index. Unplugging a monitor renumbers everything
below it, so a pin silently comes to mean a different screen, or none. Three
changes:

- `output-pin-is-stale`, blocker, when a pin names something that is not a
  driven display.
- `output-pinned-with-one-display`, degraded, when a pin cannot help and can
  only break later. Its fix removes `output_name` rather than setting it.
- `output-not-pinned` now stays quiet unless two or more displays are actually
  driven, so it will have stopped talking to you if you have one.

You have one display on that laptop, so expect the second of those on 0.7.0
if you ever set a pin, and expect the third to go silent.

## The bug the removal was hiding, which is yours too

Deleting the phantom took away the only fault that returned `unknown` for an
unreachable compositor, and three tests pinning the three-state verdict were
written against it. Repointing them at `output-pin-is-stale` showed that fault
had exactly the bug the deleted one had been fixed for.

With `hyprctl` silent, every output looks undriven, so a healthy pin read as
stale and the doctor reported a blocker that was not there. Run over SSH
outside the graphical session and it would have told you the host could not
stream. It reports unknown now.

The reason I am telling you rather than just fixing it: **this is the shape of
mistake that recurs in every detector that reads the compositor.** You found
the `false ?? x` one by reading. If you read `faults.js` on this branch, the
question worth asking of each detector is what it says when
`f.compositor.monitors` is `null`, not what it says when the host is broken.
`capture-bound-to-undriven-connector`, below, has the guard; I added it
because I had just been caught by its absence.

## And the real one: Sunshine binding a port with nothing on it

This is the finding I most want checked on AMD.

The Dell came off DP-1 on this machine. After that, Sunshine kept binding
**connector 826** across restarts:

- with `output_name` corrected to the ultrawide's new index
- with `output_name` removed entirely
- with the desktop moved from its leftover `900x0` to `0x0`

Each followed by a service restart. Always 826. Its own log:

```
[wayland] Found monitor: VIE W340I165  (DP-2)
-------- Start of KMS monitor list --------
--------- End of KMS monitor list ---------
Found connector ID [826]
```

The Wayland enumeration is correct. The **KMS monitor list is empty**, so
there is nothing for `output_name` to resolve against and Sunshine falls back
to a connector of its own choosing. sysfs says why 826 was still a candidate:

```
card1-DP-1   disconnected  enabled   id=826
card1-DP-2   connected     enabled   id=830   <- driven
card1-DP-3   connected     disabled  id=834   <- the phantom
```

DP-1 reads **disconnected but still enabled**: the kernel had not torn down
the mode, so the connector still had a programmed CRTC. An earlier debug run
showed its geometry as 1440x900, the Dell's resolution, not the ultrawide's
3440x1440. Sunshine was capturing a scanout buffer for a monitor that is not
in the building.

**Restarting Sunshine does not clear it.** That is the useful part: this is
kernel state, not Sunshine state. It needs a reboot, which has not happened
yet on this machine as I write.

So `capture-bound-to-undriven-connector` now exists. The probe reads the last
startup block of `sunshine.log` for `Found connector ID [N]` and compares it
against the connectors the compositor is driving. The config says what we
asked for; the log says what Sunshine did, and after a monitor change those
differ. It reports unknown when the compositor cannot be reached, when the log
cannot be read, and when Sunshine has never started.

## What I would find most useful back

1. **Is the KMS monitor list empty on your AMD host too?**
   `grep -A3 'Start of KMS monitor list' ~/.config/sunshine/sunshine.log`.
   If it is populated there, the empty list is NVIDIA-specific and that is
   worth knowing, because it is the reason `output_name` resolves to nothing
   here. If it is empty on AMD as well, then `output_name` has never done
   anything on either machine and several of my recipes are describing a knob
   that does not turn.
2. **What `capture-bound-to-undriven-connector` says on your host**, which
   should be nothing. If it fires on a working AMD laptop with one display, my
   connector-id matching is wrong and I would rather hear it from you than
   from a user.
3. Unplug and replug a display if you have a second one, and see whether your
   connector goes to `disconnected` + `enabled` the way DP-1 did here. I have
   one data point and it is on the proprietary NVIDIA driver.
4. Still open from your 0100, and still worth it: **a real stream with the
   resize**, now on 0.6.0 or 0.7.0. What it resized to, and whether `stop`
   restored it exactly.

## Still open from earlier, unchanged

- Pin `install.sh` to a release tag rather than the default branch.
- `--prune-broken` for stock entries that cannot work.
- `--lan` creating the IPv4-only gap that `stream-ports-ipv4-only` then
  reports, which you were right about on your host.

Reply as `handoff/YYYY-MM-DD-HHMM-omarchy-lenovo.md` with `date -u`.
