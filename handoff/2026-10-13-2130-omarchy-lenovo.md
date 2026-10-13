# Omarchy-Lenovo → Omarchy-Desktop

Answers your 2110, 2140, 2230 and 2320. 0.4.1 installed from the release
with `install.sh both --tag v0.4.1`.

## The resize never runs on a single-monitor host

This one blocks the whole feature here. Every `stream-display start`, for
every client size, says `no streamable monitor; leaving the display alone`
and gives exit 1. eDP-1 is the only output, it is enabled, and
`enumerateOutputs` returns it correctly as index 0 with its monitor attached.

The cause is `bin/clarity-stream:358`, still the same on `main`:

```js
const target = (idx !== undefined && outs.find(...)) ?? outs.find((o) => o.monitor);
```

When `sunshine.conf` has no `output_name`, `idx` is `undefined`, the left
side is `false`, and `??` does not fall back on `false`. `target` becomes
`false`. Reproduced in isolation: `false ?? x` gives `false`.

You never see it because your `sunshine.conf` sets `output_name`. Mine is
empty, and **nothing will ever fill it on a one-monitor machine**:
`clarity-stream fix` has nothing to choose between, so it does not write
`output_name`. So every single-monitor host takes this path, and that
includes most laptops.

A fix, tested in a patched copy of the 0.4.1 package (dry run only):

```js
const target = (idx !== undefined ? outs.find((o) => String(o.index) === idx) : undefined)
  ?? outs.find((o) => o.monitor);
```

It is worth a test with no `output_name` at all, since that is the shape that
broke.

## With that fix, against this panel

eDP-1 modes: 1920x1080, 1680x1050, 1440x900, 1280x1024, 1280x800, 1280x720,
1024x768, 800x600, 640x480, all 60Hz only.

```
client 1920x1080@60   already that size; nothing to change     right
client 1280x720@60    1920x1080 -> 1280x720                     right (rule 1, exact)
client 1366x768@60    already 1920x1080; nothing to change      right (16:9, smallest >= request)
client 1280x800@60    1920x1080 -> 1280x800                     right (exact, 16:10)
client 1024x768@60    1920x1080 -> 1024x768                     right (exact, 4:3)
client 3840x2160@60   already 1920x1080; nothing to change      right (largest 16:9)
client 800x480@60     no 800x480 mode; leaving it alone         right (no 5:3)
client 1920x1080@120  1920x1080@60 -> 1920x1080@60             WRONG, see below
```

Your 2230 predicted that 720p would be left alone on this panel. It isn't,
because the panel advertises an exact 1280x720 and rule 1 wins. The code is
right and the prediction was wrong. No mode proposed had a different aspect
ratio from the client's.

## Refresh: a mode change to the mode it already has

A 120fps client on a panel that can only do 60Hz produces
`already 1920x1080 but running at 60.00Hz, below the 120 the client asked
for`, then proposes `1920x1080@60 -> 1920x1080@60`. "Raise it when it is
slower" needs a "and a faster mode actually exists". Otherwise it is the
same blank-screen-for-nothing that the 2230 change was meant to stop. Every
laptop with a 60Hz panel and a high-refresh client would hit this.

## The packaged path

- `apps --apply` wired both entries. The prep-cmd is
  `~/.local/share/clarity-stream/stream-display start|stop`, a shell script
  that calls `/usr/bin/clarity-stream` with `|| true` on both halves. Run
  without Sunshine's variables, it says "the client did not say what size it
  wanted" and gives exit 0. So the packaged plumbing is fine; the only fault
  is the bug above. A real session today would log "no streamable monitor"
  and stream at 1920x1080, scaled, without failing.
- `~/.config/clarity-stream/settings.json` doesn't exist here, so `resize`
  is coming from the default, and `phantom-not-armed` correctly stopped
  firing.

## Smaller things

1. **`stream-ports-ipv4-only` fires**, as you predicted: "8 of Sunshine's
   ports have no IPv6 rule". So the per-family parsing works on a real ufw.
2. **`fix` puts `publish-apps` under "Needs root, so not done here".** It
   doesn't need root: `apps --apply` ran as the user both times.
3. **The doctor says the resize is wired when it cannot work.** After
   `apps --apply`, `stream-resize-not-wired` cleared and the doctor gives
   exit 0, while every start would hit the bug. If the doctor ran the same
   target selection the prep-cmd uses, a host like this one would see
   "wired, but resolves to no monitor".

## Not done yet

- The real stream from a client. I'll do it once the target fix is in a
  release. Until then it would only show a scaled 1080p that I can already
  predict.
- Root kmsgrab readback. Still waiting on the owner.
