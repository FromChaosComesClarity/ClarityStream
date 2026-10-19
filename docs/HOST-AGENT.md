# Scope: a host agent, and ending a session from the client

Two requests, one missing piece.

1. The client cannot tell you what resolution the host is set to, which became
   a problem the moment the automatic resize was removed in 0.8.0.
2. The client's **Stop the session** button does not reliably end a session.

Both need the same thing: a small service on the host that the client can ask.
Neither can be solved from the client alone, and the reasons are different.

## What is true today

**The host app listens on nothing.** It is a window over `packages/core`, and
every privileged or authenticated action happens inside it.

**Sunshine's unauthenticated API has no display information.** The client
already reads `/serverinfo` on port 47989 through `host-link.serverInfo`, and
the complete tag list is:

```
appversion currentgame ExternalPort GfeVersion hostname HttpsPort LocalIP
mac MaxLumaPixelsHEVC PairStatus ServerCodecModeSupport state uniqueid
```

No resolution, no mode, no mode list. So the client cannot learn the host's
display state from Sunshine at all, at any level of authentication.

**Ending a session needs credentials the client does not have.** The host ends
a session with `POST /api/apps/close` on port 47990 with HTTP Basic auth,
using Sunshine's web credentials, which the host app keeps in the OS keyring
through Electron's `safeStorage`. That works and is what the host window's
Stop button calls.

**The client instead shells out to `moonlight quit`.** Moonlight documents
that verb as *"Quit the currently running app"*, which is not the same as
ending the session, and matches the reported behaviour: the app stops, the
session stays held, and the display or the host stays occupied. It is also
startlingly heavyweight. Running it loads SDL, creates a QML window and reads
476 gamepad mappings to send what should be one request.

## A bug worth fixing before any of this

`apps/client/main.js`:

```js
ipcMain.handle('quit', (_e, { address }) => {
  const [cmd, ...args] = hostLink.quitCommand(address);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, command: [cmd, ...args].join(' ') };   // always
});
```

It spawns detached, ignores the output, never waits, and returns `ok: true`
unconditionally. The renderer then says *"Asked the host to stop the
session."* whether Moonlight is installed, whether the address is right, and
whether anything happened.

**This is the same mistake this project has now made eight times: reporting a
proxy as the thing.** The spawn succeeding is not the session ending.

It can be fixed immediately and independently, because `/serverinfo` is
unauthenticated and the client already reads it. The button should:

- await the command and check its exit status
- poll `/serverinfo` until `state` leaves `SUNSHINE_SERVER_BUSY`, with a
  deadline
- report what actually happened: ended, still busy after N seconds, or could
  not ask

That alone turns a button that lies into a button that tells you it did not
work, which is most of the value. Do this first, whatever happens to the rest.

## The agent

A small HTTP service inside the Clarity Stream **host** app.

### What it serves

```
GET  /display    the streamed connector, its current mode, and its mode list
GET  /state      busy, current app, and the host's own version
POST /session/stop   ends the session, by calling Sunshine as the host already does
```

`/display` is what closes the gap the resize removal opened. The client can
then show the host's current resolution beside the picker, mark the chosen
resolution when it does not match, and offer the host's **real** modes rather
than a hardcoded list that currently offers `3840x2160` to hosts that cannot
produce it.

`/session/stop` is the honest version of the Stop button. The host holds the
credentials and makes the call; the client never sees them.

### Authentication

The client must prove it is allowed, and the host must never hand Sunshine's
credentials over.

Reusing Moonlight's pairing is not available: that is Sunshine's certificate
store, and nothing in this project can mint one.

So: its own pairing, mirroring the Sunshine PIN flow this project already
implements. The host window shows a code, the client enters it once, and they
exchange a token the client stores. Same shape as the existing Devices panel,
which is already understood by anyone using this.

Bearer token on every request, over plain HTTP on the LAN. Not TLS: a
self-signed certificate on a LAN service produces a warning that teaches
people to click through warnings, and the data here is a mode list and a stop
command. Worth revisiting only if the agent ever carries anything private.

### The port, and the firewall

A new listening port means `firewall.js` has to know about it, or the first
symptom is a client that cannot see a host which is plainly there, which is a
failure mode this project has already shipped once and diagnosed at length.

Needs: a port chosen and documented, the firewall recipe extended to include
it, and the helper's allowlist extended, since opening it needs root the same
way Sunshine's ports did.

### What it must not become

- It must not run as root. It needs none.
- It must not proxy arbitrary requests to Sunshine. Three endpoints, each
  doing one named thing.
- It must not start unless the host window is running. A background service
  that outlives the app is a thing to forget about and a thing to be
  surprised by.
- It must refuse every request without a valid token, including `/display`,
  which otherwise tells the network what hardware is on this desk.

## Order of work

1. **Stop the client's Stop button from lying.** Independent, small, and
   valuable whatever follows. Verify through `/serverinfo`.
2. **The agent, with `/state` and `/session/stop`.** This makes the button
   work rather than merely honest.
3. **Pairing and the token.** Required before either endpoint is reachable;
   listed after them only because the shape of the endpoints decides what the
   token has to protect.
4. **`/display`, and the client's resolution picker.** The host's real modes,
   its current mode shown beside the choice, and a warning when they differ.
5. **Firewall and helper changes**, with the port documented in the README
   next to Sunshine's.

## What this does not solve

The host still does not change its own resolution, and this does not propose
that it should. The agent tells the client what the host is set to; setting it
remains a thing the person does through whatever owns display configuration on
that desktop. That is the conclusion of parts eight to eleven of
`DIAGNOSIS.md` and nothing here revisits it.

A reasonable middle ground, if the manual step proves annoying: `/display`
could also return *whether the host's current mode matches what the client is
about to ask for*, so the client can say "your host is at 3440x1440 and you
are asking for 1920x1080" before the stream starts rather than after. That is
information, not control, and it stays on the right side of the rule.
