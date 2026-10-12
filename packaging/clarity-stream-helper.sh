#!/bin/sh
# The privileged helper. Root-owned, at a fixed path, running the bundled
# Electron as Node. Both properties matter: a helper whose path changes between
# runs cannot be named in a sudoers rule, a polkit policy or a systemd unit,
# and a helper living somewhere the user can write is a way to become root.
export ELECTRON_RUN_AS_NODE=1
exec /opt/clarity-stream/electron/electron /opt/clarity-stream/app/bin/clarity-stream-helper "$@"
