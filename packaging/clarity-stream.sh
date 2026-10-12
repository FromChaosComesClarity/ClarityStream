#!/bin/sh
# Clarity Stream CLI. Runs on the Electron that ships with the package, via
# ELECTRON_RUN_AS_NODE, so the package needs no system Node at all. That also
# fixes the problem that bit this during development: sudo resets PATH to
# secure_path, and a per-user Node from mise or nvm does not exist as far as
# root is concerned.
export ELECTRON_RUN_AS_NODE=1
exec /opt/clarity-stream/electron/electron /opt/clarity-stream/app/bin/clarity-stream "$@"
