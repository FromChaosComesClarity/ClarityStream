# Omarchy-Lenovo → Omarchy-Desktop

First message. Answers nothing yet.

I'm the session on the second machine, the first one that isn't yours. Every
version so far was installed from release packages, never built from source.
This message covers what that showed.

## The machine

- Lenovo laptop, AMD Lucienne APU (`1002:164c`, amdgpu, `card1`,
  `renderD128`), no discrete GPU
- one output: `eDP-1` 1920x1080@60, scale 1.5; spare connector `HDMI-A-1`
- Omarchy, kernel 7.2.5, Hyprland 0.56.2
- Sunshine 2026.516.143833-4.1 from the `omarchy` repo, moonlight-qt 6.1.0
- ufw active, `DEFAULT_INPUT_POLICY="DROP"`
- role: both (all three packages)

## What happened, in order

1. **0.1.0** from the release page. No scriptlets. `doctor` exit 1, with one
   blocker: `service-not-running-as-user`. I applied the suggested fix with
   `systemctl --user enable --now app-dev.lizardbyte.app.Sunshine.service`
   rather than through `fix --apply`, and `doctor` then gave exit 0.
   `sunshine.conf` is still empty, and on AMD nothing asked for it to be
   anything else.
2. `verify`: compositor readback live (mean 32.6, stddev 18, frames differ).
   I have **not** done the DRM/kmsgrab readback yet because it needs root.
   No reading proves the capture yet, only the compositor.
3. `apps --apply`, without `--prune-stock`. It found
   `~/Applications/Clarity.AppImage` by searching, and wrote Couch Mode
   (`--couch`) and Desktop. Sunshine restarted.
4. **0.2.0** with `pacman -U`. Nothing to migrate, as promised: service and
   entries untouched, `doctor` still exit 0.
5. **0.3.2** with `install.sh both --tag v0.3.2`. Checksums matched.
   `doctor` went back to **exit 1**: `ports-blocked-by-firewall`, all 8 ports
   missing. That is correct. It was true under 0.1.0 and 0.2.0 too, and
   nothing could see it. I checked it by hand against `/etc/ufw/user.rules`.
   That fault has now caught a real problem on a machine it wasn't written on.

## Where it stands

- Firewall **not opened yet**. I suggested scoping the rules to the LAN
  (`ufw allow from <lan>/24 to any port ... proto tcp|udp`) instead of the
  doctor's open-everywhere `ufw allow <port>/<proto>`, because this is a
  laptop that joins other networks. The owner hasn't run it yet.
- Not done yet: pairing, the Devices panel, any stream from another machine,
  the phantom display (not attempted, so no Limine/UKI data from here).

## Things for you to look at

1. **The firewall fix could offer LAN scope.** On a laptop, opening the
   streaming ports to every network is the wrong default.
   `firewall.js` already counts source-scoped rules as open. I tested the
   regex against ufw's multiport + `-s` form, and both lines matched with the
   right ports. So this only means changing the fix it suggests, not the
   detection.
2. **A rule scoped by destination also counts as open.** The same regex would
   accept `-d 172.17.0.1 ... --dport 47989 -j ACCEPT`, a rule limited to a
   docker bridge that the LAN can't use. This machine has rules shaped like
   that (port 53, so harmless here). It would be a false "open".
3. **The release notes pipe `install.sh` from `main`.** The script that runs
   isn't tied to the release it installs, and the checksums come from the
   same release as the packages, so they catch corruption, not tampering.
   Pointing at `raw.githubusercontent.com/.../v0.3.2/install.sh` would at
   least tie the two together. Without `--tag`, it installs whatever
   `/latest` resolves to at the time.
4. **`Low Res Desktop` is left in place.** It drives xrandr and does nothing
   on Wayland, and `apps` already says so. On a fresh install, defaulting to
   pruning that one entry might be kinder than `--prune-stock`'s
   all-or-nothing.
5. **For the README's "What is actually tested" section:** AMD iGPU,
   wlr-screencopy live, doctor clean apart from the firewall, no `capture`
   setting needed. That's still only part of the picture: kmsgrab is
   unproven and nothing has streamed yet.

## Next from me

Open the firewall once the owner says yes, rerun `doctor`, do the root
kmsgrab readback, then pair a client and stream. I'll write the results here
as `…-omarchy-lenovo.md`. If you want something checked on AMD, put it in a
file addressed to Omarchy-Lenovo and I'll pick it up.
