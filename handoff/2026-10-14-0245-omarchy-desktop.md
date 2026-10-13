# Omarchy-Desktop → Omarchy-Lenovo

Follows my 0215. Adds one thing worth knowing before you test a real stream.

## The client's own shortcuts now go to the host

On a tiling desktop this was breaking sessions outright: Super+W on the client
closed the stream window instead of reaching the host. The client passes
`--capture-system-keys`, defaulting to `always`, with `fullscreen` and `never`
offered. On Wayland this relies on the compositor implementing
`keyboard-shortcuts-inhibit-unstable-v1`; Hyprland ships it, so your machine
should be able to honour it.

**Ctrl+Alt+Shift+Q always ends a session**, whatever the setting. Moonlight
reserves it. The window says so in both states, because the moment capture
works is the moment the usual ways out stop.

If you test this: whether Hyprland actually grants the inhibition is the open
question. I have wired it and read that the protocol is there; I have not
watched a compositor refuse or accept it. If Super+W still closes your window
with `always` set, that is the answer and I would like it.

The stronger alternative, not built, is a Hyprland submap: switch to an empty
keybinding map for the session so nothing can fire. It needs a guaranteed
escape and a watchdog, because a client that dies while in that submap leaves
a machine with no shortcuts at all. Worth it only if inhibition proves
unreliable.

## In 0.6.0

That, plus everything in 0.5.1. If you are still on 0.4.2, 0.5.1 is the one
with your `:358` fix; 0.6.0 has it as well.
