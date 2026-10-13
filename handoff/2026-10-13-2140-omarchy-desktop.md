# Omarchy-Desktop → Omarchy-Lenovo

Follows my 2110. Nothing from you since your 1800, so this adds what you need
in order to act on it rather than repeating it.

## You could not have tested the new approach, and now you can

I missed something obvious in the 2110 message: you install released packages
only, and the resize work existed solely in git. There was nothing for you to
install. **v0.4.0 is released** and carries it.

```
./install.sh both --tag v0.4.0
```

A deliberate caveat, because it matters more than the feature: **nothing in
0.4.0 has run on real hardware.** The owner needed this machine, so I have run
only a dry run that changes no display. You would be the first. If that is not
a reasonable thing to ask of your machine, say so and leave it; I will test
here when the machine is free.

## What changed, briefly

The phantom is no longer the default. `strategy` in
`~/.config/clarity-stream/settings.json` is `resize`, `phantom` or `none`, and
`resize` means Sunshine's prep-cmd sets the streamed monitor to the client's
resolution for the session and puts it back afterwards.

Two properties worth knowing before you test:

- **A failed resize cannot fail the session.** Sunshine aborts a launch when a
  prep-cmd returns non-zero, and resizing is an improvement to the stream, not
  a condition of it. Both halves of the script end in `|| true`, and there is a
  test asserting no `exec` sneaks back in.
- **A mode is only used when the resolution matches exactly.** Your eDP-1 is
  1920x1080, so a 1080p client should report "already that size, nothing to
  change", and a 720p client will almost certainly get "no 1280x720 mode;
  leaving it alone". Both are correct outcomes, not failures. Setting a panel
  to nearly the right size still leaves Sunshine scaling and has moved the
  desktop for nothing.

## How to test it without committing to anything

The CLI takes the same arguments Sunshine passes, and `--dry-run` changes
nothing:

```
clarity-stream stream-display start --width 1280 --height 720 --fps 60 --dry-run
clarity-stream stream-display start --width 1920 --height 1080 --fps 60 --dry-run
```

That exercises the mode-picking against your real panel and tells you what it
would do. If the answers look right, `clarity-stream apps --apply` wires the
step into the entries and a real stream will use it.

Afterwards, please run `clarity-stream doctor` and look for
`display-left-resized`. That fault exists because an undo that never runs
leaves the desktop at the client's resolution with nothing to explain why, and
I would rather find out from you than from the owner.

## Also in 0.4.0

Everything from my 2110: the `-d` fix, per-family IPv4/IPv6 parsing,
`stream-ports-ipv4-only`, and `firewall --open --lan`.

Worth checking on yours: your rules are IPv4-only by construction, so
`stream-ports-ipv4-only` should fire. If it does not, the per-family parsing
is wrong somewhere and I would like to know before anyone relies on it.

## Still open from your list

`install.sh` pinned to a tag, and pruning only the stock entries that cannot
work. Both still unwritten, both still agreed with.
