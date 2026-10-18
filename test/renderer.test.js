'use strict';
// A renderer is not covered by the engine's tests and is not type-checked, so
// a function deleted by accident is only found by opening the window and
// using it. That is exactly how `drawPairing is not defined` shipped: the
// phantom display's panel was cut by taking everything between its function
// and the next one, which swallowed drawSession and drawPairing too, and a
// smoke test that only checked the window opened did not notice, because the
// window does open. It fails on refresh.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERERS = [
  path.join(__dirname, '..', 'apps', 'host', 'renderer', 'app.js'),
  path.join(__dirname, '..', 'apps', 'client', 'renderer', 'app.js')
];

function topLevelFunctions(src) {
  return new Set([...src.matchAll(/^(?:async )?function ([a-zA-Z_$][\w$]*)/gm)].map((m) => m[1]));
}

// Only the draw/render family, because those are the ones a panel's removal
// orphans and the ones a crude scan can identify without a real parser.
function panelCalls(src) {
  return new Set(
    [...src.matchAll(/(?<![.\w$'"`])((?:draw|render)[A-Z][\w$]*)\s*\(/g)].map((m) => m[1])
  );
}

for (const file of RENDERERS) {
  const name = path.relative(path.join(__dirname, '..'), file);

  test(`${name}: every panel it draws is defined`, () => {
    const src = fs.readFileSync(file, 'utf8');
    const defined = topLevelFunctions(src);
    const called = panelCalls(src);
    assert.ok(called.size > 0, 'expected this renderer to draw something');
    const missing = [...called].filter((n) => !defined.has(n));
    assert.deepStrictEqual(missing, [], `called but not defined: ${missing.join(', ')}`);
  });

  test(`${name}: every panel it defines is drawn`, () => {
    // The other direction. A panel nobody calls is dead code, and after a
    // removal it is usually the half of the removal that was forgotten.
    const src = fs.readFileSync(file, 'utf8');
    const defined = [...topLevelFunctions(src)].filter((n) => /^(draw|render)[A-Z]/.test(n));
    const called = panelCalls(src);
    const orphans = defined.filter((n) => !called.has(n));
    assert.deepStrictEqual(orphans, [], `defined but never called: ${orphans.join(', ')}`);
  });

  test(`${name}: every bridge method it uses is exposed by the preload`, () => {
    // The renderer talks to the main process only through window.cs. Removing
    // a handler without removing its caller is the same bug one layer down,
    // and it also only shows up when somebody presses the button.
    const src = fs.readFileSync(file, 'utf8');
    const preloadPath = path.join(path.dirname(path.dirname(file)), 'preload.js');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    const exposed = new Set([...preload.matchAll(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm)].map((m) => m[1]));
    const used = new Set([...src.matchAll(/window\.cs\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
    assert.ok(used.size > 0, 'expected this renderer to call the bridge');
    const missing = [...used].filter((n) => !exposed.has(n));
    assert.deepStrictEqual(missing, [], `window.cs.${missing.join(', window.cs.')} is not in ${path.basename(preloadPath)}`);
  });
}
