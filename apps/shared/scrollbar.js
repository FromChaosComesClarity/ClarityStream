'use strict';
// Shared by the host and the client.
/* ------------------------------------------------------------ scrollbar */
// A drawn scrollbar, because the native one cannot be styled on this build:
// ::-webkit-scrollbar is ignored and the standard properties leave stepper
// arrows that no selector reaches. This paints a thumb and drives the real
// document; it does not reimplement scrolling, so the wheel, keys, trackpad
// and momentum all behave exactly as they did.

(function scrollbar() {
  const bar = document.getElementById('scrollbar');
  const thumb = document.getElementById('scrollthumb');
  const doc = document.documentElement;
  let hideTimer = null;
  let dragging = false;

  const metrics = () => {
    const track = bar.clientHeight;
    const ratio = doc.clientHeight / doc.scrollHeight;
    const height = Math.max(28, Math.round(track * ratio));
    const max = doc.scrollHeight - doc.clientHeight;
    const top = max <= 0 ? 0 : Math.round((track - height) * (doc.scrollTop / max));
    return { track, height, top, max, scrollable: max > 1 };
  };

  const paint = () => {
    const m = metrics();
    // Nothing to scroll means nothing to draw. A thumb filling the whole
    // track is just a decoration that says the page does not scroll.
    //
    // The strip is taken out of the layout entirely when there is nothing to
    // scroll. Setting pointer-events on the parent alone is not enough: the
    // thumb sets its own back to auto, so it kept intercepting clicks down
    // the right edge of a page that did not even scroll. elementFromPoint
    // found it there.
    bar.classList.toggle('inactive', !m.scrollable);
    if (!m.scrollable) { bar.classList.remove('visible'); return; }
    thumb.style.height = `${m.height}px`;
    thumb.style.top = `${m.top}px`;
  };

  const flash = () => {
    paint();
    if (!metrics().scrollable) return;
    bar.classList.add('visible');
    clearTimeout(hideTimer);
    if (!dragging) hideTimer = setTimeout(() => bar.classList.remove('visible'), 1100);
  };

  document.addEventListener('scroll', flash, { passive: true });
  window.addEventListener('resize', flash);
  bar.addEventListener('mouseenter', () => { bar.classList.add('visible'); clearTimeout(hideTimer); });
  bar.addEventListener('mouseleave', () => { if (!dragging) flash(); });

  // Dragging maps thumb travel back onto document scroll, so grabbing it
  // behaves like grabbing a real scrollbar rather than scrubbing by pixels.
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    bar.classList.add('dragging');
    thumb.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startScroll = doc.scrollTop;
    const m = metrics();
    const travel = m.track - m.height;

    const onMove = (ev) => {
      if (travel <= 0) return;
      const delta = ev.clientY - startY;
      doc.scrollTop = startScroll + (delta / travel) * m.max;
    };
    const onUp = () => {
      dragging = false;
      bar.classList.remove('dragging');
      thumb.removeEventListener('pointermove', onMove);
      thumb.removeEventListener('pointerup', onUp);
      flash();
    };
    thumb.addEventListener('pointermove', onMove);
    thumb.addEventListener('pointerup', onUp);
  });

  // Clicking the track pages toward the click, which is what a scrollbar does.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return;
    const m = metrics();
    const above = e.clientY < thumb.getBoundingClientRect().top;
    doc.scrollBy({ top: above ? -doc.clientHeight * 0.9 : doc.clientHeight * 0.9, behavior: 'smooth' });
    flash();
  });

  // The page grows and shrinks as findings render, so the thumb is resized
  // from the same observer rather than only on scroll.
  new ResizeObserver(paint).observe(document.body);
  paint();
})();

