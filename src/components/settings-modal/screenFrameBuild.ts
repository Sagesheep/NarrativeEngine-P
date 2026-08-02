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
 * Rewrite the first CODE `export default` in `source` to a global assignment.
 *
 * WO-P5-18 §2.2: the previous unanchored
 * `source.replace(/export\s+default\s+/, …)` matched the first occurrence
 * ANYWHERE — including inside comments and string literals. The first mod
 * author who documented their format in a header comment containing the
 * words `export default` got a SILENTLY DEAD FRAME: the comment was
 * rewritten, the real export was not, and the frame shipped a syntax error.
 * It passed only because no fixture comment happened to contain the phrase.
 *
 * Anchoring to `^` is NOT the fix — that was the original bug the
 * unanchored version was solving (a fixture may have comments or imports
 * before the `export default` line, and `^` would miss those). The fix is
 * a comment/string-aware scan: walk the source tracking lexer state —
 * inside a line comment, a block comment, a string/template literal — and
 * replace the first `export default` that appears in CODE, not in a
 * comment or string. This handles the realistic cases (header comments,
 * JSDoc, a JSDoc `@example` block) without a full JS parser dependency.
 *
 * Returns the source with ONLY that one occurrence rewritten. If no code
 * `export default` is present, the source is returned unchanged — the
 * caller's `typeof globalThis.__screenMod === "function"` guard then
 * reports a fault (the screen shipped no entry point).
 */
export function rewriteExportDefault(source: string): string {
    const target = 'export default';
    let i = 0;
    const len = source.length;
    while (i < len) {
        const ch = source[i];
        const next = source[i + 1];
        // Line comment: skip to end of line. The comment's contents are
        // irrelevant to code scanning, so we skip to the newline.
        if (ch === '/' && next === '/') {
            const nl = source.indexOf('\n', i + 2);
            if (nl === -1) return source;
            i = nl + 1;
            continue;
        }
        // Block comment: skip to the closing `*/`. An unclosed block
        // comment means the rest of the source is a comment; there is no
        // code `export default` to find, so return unchanged.
        if (ch === '/' && next === '*') {
            const close = source.indexOf('*/', i + 2);
            if (close === -1) return source;
            i = close + 2;
            continue;
        }
        // String literals: single, double, template. Skip their contents so
        // a string like "export default" is not mistaken for code. Template
        // literals can nest ${...} which may themselves contain strings, but
        // a bare `export default` inside a template expression is not valid
        // as a top-level statement anyway, so a flat scan of the template
        // body is sufficient for the defect this fixes.
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i += 1;
            while (i < len) {
                const c = source[i];
                if (c === '\\') { i += 2; continue; }
                if (c === quote) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        // Check for the target at the current code position.
        if (source.startsWith(target, i)) {
            // Require a whitespace char after "default" so we don't match
            // "export defaultX" (an identifier). The original regex used
            // `\s+` for the same reason.
            const after = source[i + target.length];
            if (after === ' ' || after === '\t' || after === '\n' || after === '\r') {
                return source.slice(0, i) + 'globalThis.__screenMod = ' + source.slice(i + target.length + 1);
            }
            i += 1;
            continue;
        }
        i += 1;
    }
    return source;
}

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
    const moduleBody = rewriteExportDefault(source);
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
        '        result.then(function () {}, function (err) {',
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