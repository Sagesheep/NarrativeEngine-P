/**
 * WO-P5-17 Step 2 — the frame host constants and srcdoc builder.
 *
 * Split out of `ScreenFrame.tsx` so the component file exports only the
 * component (the react-refresh rule requires this for hot reloads to
 * work). The constants and the srcdoc builder are the contract the R1/R3
 * tests read; the component is the thin React wrapper around them.
 */

/**
 * R1 — the one attribute that matters most. `allow-scripts` alone. The
 * frame is in a unique opaque origin: no parent DOM, no storage, no
 * same-origin fetch. The same-origin capability must NEVER appear alongside
 * it.
 *
 * This constant is the single source of truth — the component, the R1
 * attribute test, and the source scan all read it. A well-meaning future
 * edit that adds the same-origin capability here fails the test in
 * `ScreenFrame.r1.test.tsx` and the source scan in the same file.
 */
export const SCREEN_SANDBOX_ATTRIBUTE = 'allow-scripts';

/**
 * R3 — the Content-Security-Policy for the srcdoc document. `default-src
 * 'none'` leaves the frame no network of any kind; `script-src
 * 'unsafe-inline'` and `style-src 'unsafe-inline'` are deliberate (the
 * mod's code and styles are inlined into srcdoc); `img-src data:` is the
 * one exception a drawing screen needs (a canvas can still produce a
 * `data:` URL). The `<meta>` is injected into the srcdoc document head.
 */
export const SCREEN_FRAME_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

/**
 * Wrap a mod screen source into a complete srcdoc HTML document.
 *
 * The mod source is an ES module (`export default function/async function`).
 * srcdoc documents cannot use ES module `<script type="module">` without a
 * network URL to import from — and R3's `default-src 'none'` forbids that
 * anyway. So the transform rewrites `export default` into a
 * `globalThis.__screenMod` assignment (the same shape as `workerPrelude`
 * in scripts/verify-sandbox.mjs, one layer up), then invokes the default
 * export inside a try/catch that reports a fault via `postMessage` to the
 * parent. In 5.1 the parent listens for nothing (R6) — the message is for
 * the Step 4 browser harness, which asserts a thrown screen faults its
 * own frame and the app keeps running.
 *
 * The CSP `<meta>` is the FIRST element in `<head>`, before any script can
 * run, so the policy is in force when the mod code executes.
 */
export function buildScreenSrcDoc(source: string, csp: string): string {
    const moduleBody = source.replace(/^\s*export\s+default\s+/, 'globalThis.__screenMod = ');
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        '<meta charset="utf-8">',
        '</head>',
        '<body>',
        '<script>',
        '(function () {',
        '  try {',
        `    ${moduleBody}`,
        '    if (typeof globalThis.__screenMod === "function") {',
        '      var result = globalThis.__screenMod();',
        '      if (result && typeof result.then === "function") {',
        '        result.then(function () {',
        '          parent.postMessage({ __screenFault: false, screenId: null }, "*");',
        '        }, function (err) {',
        '          parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '        });',
        '      }',
        '    }',
        '  } catch (err) {',
        '    parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '  }',
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}