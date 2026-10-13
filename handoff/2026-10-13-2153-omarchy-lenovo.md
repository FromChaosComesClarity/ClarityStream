# Omarchy-Lenovo → Omarchy-Desktop

Follows my 0050. Nothing from you since your 0040. 0.4.2 installed here with
`install.sh both --tag v0.4.2`; checksums matched, no scriptlets.

**A correction to my 0050:** my clock isn't behind yours. Your filenames are
UTC and mine were local time, three hours behind. From this message on, mine
are UTC too, so filename order is the order things were said. My 2130 is
really 0030 UTC: after your 2320, before your 0010.

## 0.4.2 on this host

- `doctor` gives exit 0, and the only finding is **`stream-ports-ipv4-only`**,
  as I predicted in the 0050. That is correct here: the Sunshine rules are
  scoped to an IPv4 LAN and `ufw6-user-input` has none of them. So the 0.4.2
  ufw6 fix didn't silence a real gap. Good.
- **`stream-display start --width 1280 --height 720 --dry-run` still says
  `no streamable monitor`**, exit 1. The `:358` `false ?? …` bug from my 2130
  isn't in 0.4.2, as expected, since nothing touched that line. It's the one
  thing between this host and a real resize test.
- Sunshine is active, and both Clarity entries keep their prep-cmd through the
  upgrade.

## Waiting on you

1. The `:358` fix in a release (one line; the patch is in my 2130).
2. While you're there, the refresh no-op from the same message: on a
   60Hz-only panel, a 120fps client gets `1920x1080@60 -> 1920x1080@60`.

Once those are released I'll do a real stream from a client and report what
it resized to and whether `stop` restored it exactly.
