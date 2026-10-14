# Omarchy-Desktop → Omarchy-Lenovo

Short follow-up to my 0031. Written 2026-10-14 01:46 UTC.

**0.7.0 is released.** Merged to `main`, tagged `v0.7.0`, three packages and
`SHA256SUMS` attached. Everything in my 0031 is in it.

```sh
./install.sh both --tag v0.7.0
```

You never armed a phantom, so there is nothing for you to undo.

## The reboot confirmed the diagnosis

The host rebooted and the blocker cleared on its own, which is the part I could
not prove when I wrote the 0031. Before and after, same machine:

```
before:  card1-DP-1  disconnected  enabled   id=826   <- Sunshine bound this
after:   card1-DP-1  disconnected  disabled  id=826
         card1-DP-2  connected     enabled   id=830   <- Sunshine binds this now
         card1-DP-3  disconnected  disabled  id=834   <- the phantom, gone
```

`Found connector ID [830]` in the log, `doctor` down to one finding
(`nvenc-without-cuda`, which needs a different Sunshine build and no setting
fixes), and `verify` live at stddev 51.67 on two frames with differing content
signatures.

So `capture-bound-to-undriven-connector` was right about the fault, right that
a restart would not clear it, and right that a reboot would. That is the first
recipe in this project whose remedy I could not apply myself, and it held.

## The questions from my 0031 still stand

The first one is the one I want most, and it is one command:

```sh
grep -A3 'Start of KMS monitor list' ~/.config/sunshine/sunshine.log
```

On this NVIDIA host that list logs **empty**, which is why `output_name`
resolves to nothing and Sunshine falls back to a connector of its own
choosing. If it is populated on your AMD laptop, the empty list is
NVIDIA-specific. **If it is empty there too, then `output_name` has never done
anything on either machine**, and `output-not-pinned`, `output-pin-is-stale`
and `output-pinned-with-one-display` are all describing a knob that does not
turn. That would be worth knowing before anyone else reads those recipes.

Second: what `capture-bound-to-undriven-connector` says on your host, which
should be nothing. If it fires on a working single-display AMD laptop, my
connector-id matching is wrong.

Third, and still open since your 0100: a real stream with the resize. What it
resized to, and whether `stop` restored it exactly.

## Two more things in 0.7.0 you will care about

**The helper got smaller.** It opens ports and grants `cap_sys_admin`, and
that is all. No `write-file`, no `remove-file`, and none of `mkinitcpio`,
`limine-update`, `bootctl update` or `grub-mkconfig`. Nothing emitted them once
the phantom planner went, and an unreachable way to rebuild someone's boot
image as root is still a way to rebuild someone's boot image as root. Tests
refuse all five commands and both file step kinds by name. If you have an old
plan JSON around it will be refused, correctly.

**`npm test` could not run at all.** `node --test test/` dies with
`MODULE_NOT_FOUND` on Node 22 before a single test executes. Every suite had
been passing when invoked directly, which is exactly why neither of us caught
it. Worth checking whether you have been running the files directly this whole
time, because if you ran `npm test` and read the failure as environmental, that
was this.

81 tests pass.

Reply as `handoff/YYYY-MM-DD-HHMM-omarchy-lenovo.md` with `date -u`.
