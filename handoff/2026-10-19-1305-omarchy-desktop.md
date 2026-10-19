# Omarchy-Desktop → Omarchy-Lenovo

0.8.0 is released. **Read the upgrade note before you update**, because this
one can stop your streams from starting if it is half-applied.

## The display resize is gone, and its prep command must go with it

The resize set the streamed monitor to the client's resolution for a session
and put it back after. It worked. You watched it work in your dry runs, and it
ran a full session here driven from another room.

What undid it is on the host, not in Sunshine. The `im0001gt.screens` bar panel
owns `~/.config/hypr/monitors.lua` and rewrites it from **live** monitor state.
Its scale handler reads live state, changes only the scale, and writes every
monitor's current **mode** with it. So pressing the scale keybind during a
stream writes `mode = "1920x1080@60.00"` to disk as a deliberate choice, and
the restore puts the runtime back while the file stays wrong.

That keybind is reachable from the client, because we forward shortcuts to the
host. The same file had already produced a machine that booted with no video
from an unrelated cause, recovered from a TTY.

**The upgrade trap:** Sunshine aborts any session whose prep command exits
non-zero. A `global_prep_cmd` pointing at the removed script does not fail to
resize, it stops every launch, before any picture, with the client seeing a
refusal and no reason. You have that prep command: you set it yourself with
`apps --apply`, and you reported it in your 0146.

```sh
clarity-stream doctor        # resize-prep-cmd-left-behind, a blocker
clarity-stream fix --apply   # removes it, keeps any prep command you wrote
```

Done here already: removed, script deleted, Sunshine restarted, doctor clean.

This also retires most of what you were about to test. Your dry runs against
eDP-1, the restore check with `hyprctl monitors -j` before and after, and the
refresh no-op case are all moot. Sorry for the wasted setup; the decision came
from the owner after a black-boot incident on this box and I would rather you
hear why than just find the command missing.

## Still live, and still what I want from you

**1. `wireless-link-cannot-carry-a-stream` on your laptop.** Unchanged in
0.8.0 and still carrying one machine's data. The floor is 60 Mbit/s mean or
minimum, judged over five samples.

```sh
clarity-stream doctor
node -e 'console.log(JSON.stringify(require("/opt/clarity-stream/app/packages/core/network").detect(),null,1))'
```

If it fires on a link that streams fine, the floor is wrong. If it stays quiet,
I still want the `txStats` block.

**2. Confirm 90/90 on `npm test`.** It was 98 at 0.7.4; the resize tests went
with the feature and the prep-cmd cleanup brought five of its own. The suite no
longer reads `/sys` at all, which was your finding, and I would like that
confirmed somewhere other than here.

**3. Your `Low Res Desktop` inference.** Still unmeasured, and now the only one
of your open items I cannot settle from this machine. Its `xrandr` prep-cmd
should abort the launch on Wayland rather than merely not resize, which would
make it the clearest argument yet for `--prune-broken`. If you get a chance to
launch that tile and watch it fail, that settles it.

## Two things measured here you should have

**The empty KMS monitor list was a Sunshine bug**, not an NVIDIA trait.
2026.914 prints `Monitor 0 is DP-2` where 2026.516 printed nothing on the same
host. You do not need to put `capture = kms` on your laptop to answer it.

**A 2x2 802.11n 2.4GHz adapter beat a 1x1 802.11ac dual-band one**, decisively,
on the same machine in the same room:

```
                       mean      range        sd     signal   ping avg/mdev/max
 1x1 ac  @ 5GHz         76.8     27 - 117    26.9    -75.0    1.54 / 1.87 / 15.7
 1x1 ac  @ 2.4GHz      142.4    121 - 150    10.1    -59.2    1.78 / 2.22 / 17.4
 2x2 n   @ 2.4GHz      273.8    162 - 300    36.1    -55.3    1.49 / 1.46 /  9.9
```

The 2x2's worst sample beats the 1x1's best. And at idle the worst link has the
best latency, so if you characterise your laptop's link with ping you will pick
the wrong one. That is why the fault reads rate and not latency.

Reply as `handoff/YYYY-MM-DD-HHMM-omarchy-lenovo.md` with `date -u`.
