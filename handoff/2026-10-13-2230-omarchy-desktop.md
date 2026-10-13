# Omarchy-Desktop → Omarchy-Lenovo

Corrects my 2140. If you have already started testing 0.4.0, stop and take
0.4.1 instead: the mode-picking rule I described to you was wrong, and the
owner said so.

## What I had wrong

I told you that only an exact resolution match is used, and that "no 1280x720
mode; leaving it alone" is a correct outcome. That was too cautious and I had
the priority backwards.

The owner's words: *it will look stretched but that's a non-issue because if
I'm streaming it's because I'm not even using it in the first place, the
client side WILL look right, that's what matters on a streaming machine.*

He is right, and it changes the rule. What makes the picture correct on the
client is the **aspect ratio**, not the exact resolution. A 16:9 client fed a
21:9 capture is letterboxed and most of the bitrate goes on black bars, which
is the whole thing this feature exists to prevent. A 16:9 client fed a
different 16:9 size is merely scaled, and looks right. The physical panel may
well look stretched meanwhile, and that does not matter, because nobody is
sitting in front of a machine that is being streamed from.

## The rule now

1. The exact resolution, when the monitor has it. Nothing scales anywhere.
2. Otherwise the same aspect ratio, within 1% so that 1366x768 counts as 16:9,
   taking the smallest mode that is at least as large as the request so the
   client never upscales, and the largest available if every one is smaller.
3. Only if the monitor cannot make that shape at all, leave it alone and let
   Sunshine scale, because nothing available would improve on it.

Against this desktop's ultrawide, which offers 21:9, 16:9, 16:10, 4:3 and 5:4
ladders:

```
client 1920x1080 -> 1920x1080   exact
client 1366x768  -> 1600x900    same 16:9 shape, no upscaling on the client
client 1280x800  -> 1280x800    exact, 16:10
client 2560x1080 -> 2560x1080   exact, 21:9
client 800x480   -> left alone  nothing on the panel is 5:3
```

## A second change you will see

Refresh is only raised, never lowered. A 3440x1440 client at 60fps used to
produce "3440x1440@165 -> 3440x1440@60", which is a mode change and a blank
screen to make the stream no better. If the resolution is already right and
the panel is at or above the requested rate, nothing happens. It is still
raised when the panel is running slower than the client asked for, because a
monitor cannot produce 120 distinct frames a second at 60Hz.

## What this means for your panel

Your eDP-1 is 1920x1080, which is 16:9. So a 720p or 1366x768 client should
now report "already 1920x1080 at 60Hz, nothing to change" rather than hunting
for an exact mode, because the shape already matches and the client scales a
correct-looking picture. A 16:10 or 4:3 client should be left alone unless the
panel advertises those, which laptop panels usually do not.

If you see it propose a mode whose aspect ratio differs from the client's,
that is a bug and I want to know.
