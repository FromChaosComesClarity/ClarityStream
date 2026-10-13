#!/bin/sh
# Clarity Stream installer.
#
#   ./install.sh host      the machine whose games you want to stream
#   ./install.sh client    a machine you want to play from
#   ./install.sh both      a machine that is both
#
# Options:
#   --yes      do not ask before installing
#   --local    install from ./dist/pkg instead of the latest release
#   --tag vX   install a specific release instead of the latest
#
# It downloads the packages, checks them against the SHA256SUMS published with
# the release, and hands them to pacman. It does not enable anything, start
# anything, or change any configuration: that is the application's job and it
# asks first.

set -eu

REPO="FromChaosComesClarity/ClarityStream"
ROLE=""
ASSUME_YES=0
LOCAL=0
TAG=""

say()  { printf '%s\n' "$*"; }

# Piped from curl, stdin is the script itself, so a prompt has to read the
# terminal directly. Without this, `curl ... | sh` could never ask anything
# and every use of it would need --yes.
ask() {
  printf '%s' "$1"
  if [ -t 0 ]; then
    read -r REPLY
  elif [ -r /dev/tty ]; then
    read -r REPLY < /dev/tty
  else
    return 1
  fi
}
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m==>\033[0m %s\n' "$*" >&2; exit 1; }

# Parsed with shift so --tag takes its value properly, rather than leaving it
# to be picked up by a pattern that happens to match version strings.
while [ $# -gt 0 ]; do
  case "$1" in
    host|client|both) ROLE="$1" ;;
    --yes|-y) ASSUME_YES=1 ;;
    --local) LOCAL=1 ;;
    --tag)
      shift
      [ $# -gt 0 ] || die "--tag needs a release, like: --tag v0.3.0"
      TAG="$1"
      ;;
    --tag=*) TAG="${1#--tag=}" ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "I do not understand '$1'. Try: host, client or both." ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || die "This installs Arch packages, so it only runs on Linux."
command -v pacman >/dev/null 2>&1 || die "No pacman here. These are Arch packages; see the README for building from source."

if [ -z "$ROLE" ]; then
  say "What is this machine?"
  say "  1) a host, whose games you want to stream"
  say "  2) a client, that you want to play from"
  say "  3) both"
  ask 'Choose [1/2/3]: ' || die "Nothing to read an answer from. Tell me: host, client or both."
  case "$REPLY" in
    1) ROLE=host ;; 2) ROLE=client ;; 3) ROLE=both ;;
    *) die "Not one of the three." ;;
  esac
fi

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# --------------------------------------------------------------- gather

if [ "$LOCAL" -eq 1 ]; then
  DIR="$(cd "$(dirname "$0")" && pwd)/dist/pkg"
  [ -d "$DIR" ] || die "No dist/pkg here. Run: npm run pkg"
  step "Installing from $DIR"
else
  command -v curl >/dev/null 2>&1 || die "curl is needed to download the release."

  if [ -z "$TAG" ]; then
    step "Finding the latest release"
    # The /latest URL redirects to the tag, which saves parsing JSON and
    # therefore saves depending on jq.
    TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest" 2>/dev/null | sed 's#.*/tag/##')
    [ -n "$TAG" ] || die "Could not work out the latest release. Pass one with: --tag v0.3.0"
  fi
  say "    $TAG"

  WORK=$(mktemp -d)
  DIR="$WORK"
  BASE="https://github.com/$REPO/releases/download/$TAG"

  step "Fetching checksums"
  curl -fsSL -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS" \
    || die "That release has no SHA256SUMS, so nothing can be verified. Refusing to go on."
fi

# The filenames come out of SHA256SUMS rather than being guessed from the
# version, so a change in how packages are named cannot silently break this.
if [ -f "$DIR/SHA256SUMS" ]; then
  ALL=$(awk '{print $2}' "$DIR/SHA256SUMS")
else
  ALL=$(cd "$DIR" && ls ./*.pkg.tar.zst 2>/dev/null | sed 's#^\./##')
fi

pick() { printf '%s\n' "$ALL" | grep -E "$1" | head -1; }

COMMON=$(pick '^clarity-stream-common-')
HOSTPKG=$(pick '^clarity-stream-[0-9]')
CLIENTPKG=$(pick '^clarity-stream-client-')
[ -n "$COMMON" ] || die "The release is missing clarity-stream-common."

WANT="$COMMON"
case "$ROLE" in
  host)   WANT="$WANT $HOSTPKG" ;;
  client) WANT="$WANT $CLIENTPKG" ;;
  both)   WANT="$WANT $HOSTPKG $CLIENTPKG" ;;
esac

say ""
step "This will install, as $ROLE:"
for f in $WANT; do say "      $f"; done
case "$ROLE" in
  host)   say "    and make sure sunshine is installed" ;;
  client) say "    and make sure moonlight-qt is installed" ;;
  both)   say "    and make sure sunshine and moonlight-qt are installed" ;;
esac
say ""

if [ "$ASSUME_YES" -ne 1 ]; then
  ask 'Go ahead? [Y/n] ' || die "Nothing to read an answer from. Re-run with --yes if you meant it."
  case "$REPLY" in n|N|no|NO) die "Stopped." ;; esac
fi

# -------------------------------------------------------------- download

if [ "$LOCAL" -ne 1 ]; then
  for f in $WANT; do
    step "Downloading $f"
    curl -fL --progress-bar -o "$WORK/$f" "$BASE/$f" || die "Could not download $f."
  done

  step "Verifying"
  # Check only what was downloaded; the full file lists every package.
  : > "$WORK/to-check"
  for f in $WANT; do grep -E "  $f\$" "$WORK/SHA256SUMS" >> "$WORK/to-check"; done
  ( cd "$WORK" && sha256sum -c to-check >/dev/null ) \
    || die "A download does not match its checksum. Not installing it."
  say "    every file matches the checksums published with the release"
fi

# --------------------------------------------------------------- install

FILES=""
for f in $WANT; do FILES="$FILES $DIR/$f"; done

step "Installing"
# shellcheck disable=SC2086
sudo pacman -U --needed $FILES

NEED=""
case "$ROLE" in
  host)   NEED="sunshine" ;;
  client) NEED="moonlight-qt" ;;
  both)   NEED="sunshine moonlight-qt" ;;
esac
MISSING=""
for p in $NEED; do pacman -Qq "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  step "Installing what it streams with:$MISSING"
  # shellcheck disable=SC2086
  sudo pacman -S --needed $MISSING
fi

# ----------------------------------------------------------------- done

say ""
step "Done. Nothing has been enabled or configured yet."
case "$ROLE" in
  host|both)
    say "    Open 'Clarity Stream' from your launcher, or run: clarity-stream-host"
    say "    It will tell you what would stop a stream, and fix what it can."
    say "    Over SSH or in a terminal: clarity-stream doctor"
    ;;
esac
case "$ROLE" in
  client|both)
    say "    Open 'Clarity Stream Client', or run: clarity-stream-client"
    ;;
esac
say ""
