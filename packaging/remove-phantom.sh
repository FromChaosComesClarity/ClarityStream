#!/usr/bin/env bash
# Remove the phantom stream display from this system, completely.
#
# Undoes everything Clarity Stream added for it: the synthesised EDID, the
# kernel parameters that forced DP-3 on, and the initramfs entry that carried
# the EDID into early boot. Nothing else on the system is touched.
#
# A reboot is required afterwards. Until then DP-3 stays forced on, because
# the kernel read those parameters at the last boot.
set -u

say() { printf '  %s\n' "$*"; }
step=0
removed=0

for f in /etc/limine-entry-tool.d/clarity-stream.conf \
         /etc/mkinitcpio.conf.d/clarity-stream.conf \
         /lib/firmware/edid/clarity-stream-DP-3.bin; do
  step=$((step+1))
  if [ -e "$f" ]; then
    rm -f -- "$f" && { say "removed  $f"; removed=$((removed+1)); } || say "FAILED   $f"
  else
    say "absent   $f"
  fi
done

# Only an empty directory we created ourselves.
rmdir /lib/firmware/edid 2>/dev/null && say "removed  /lib/firmware/edid (was empty)"

echo
say "Rebuilding the initramfs so it no longer carries the EDID."
say "This takes a minute. Full output below."
echo
mkinitcpio -P || { echo; say "mkinitcpio failed. STOP: do not reboot. Report the output above."; exit 1; }

echo
say "Regenerating the boot entry so the kernel parameters are gone."
echo
limine-update || { echo; say "limine-update failed. STOP: do not reboot. Report the output above."; exit 1; }

echo
say "Checking the result."
if grep -qE 'edid_firmware|video=DP-3' /proc/cmdline; then
  say "The running kernel still has the parameters, which is expected:"
  say "they were read at boot. The new boot entry does not have them."
fi
for f in /etc/limine-entry-tool.d/clarity-stream.conf \
         /etc/mkinitcpio.conf.d/clarity-stream.conf \
         /lib/firmware/edid/clarity-stream-DP-3.bin; do
  [ -e "$f" ] && say "STILL PRESENT: $f"
done

echo
say "Done. Reboot when convenient and DP-3 will be gone for good."
say "After the reboot, /sys/class/drm/card1-DP-3/status should read"
say "disconnected rather than connected."
