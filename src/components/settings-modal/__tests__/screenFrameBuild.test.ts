/**
 * WO-P5-18 §2.2 — `rewriteExportDefault` regression tests.
 *
 * The previous `source.replace(/export\s+default\s+/, …)` was unanchored
 * and matched the FIRST occurrence ANYWHERE — including inside comments
 * and string literals. The first mod author who documented their format in
 * a header comment containing the words `export default` got a SILENTLY
 * DEAD FRAME: the comment was rewritten, the real export was not, and the
 * frame shipped a syntax error. It passed only because no fixture comment
 * happened to contain the phrase.
 *
 * These tests pin the comment-aware scan. Each test asserts the SPECIFIC
 * thing that must happen, so removing the comment-awareness turns the
 * suite red:
 *   - a header comment containing `export default` is left intact,
 *   - the REAL `export default` is rewritten to `globalThis.__screenMod =`,
 *   - the rest of the source is byte-identical,
 *   - a string literal containing `export default` is left intact,
 *   - a source with no code `export default` is returned unchanged.
 *
 * Anchoring to `^` would fail the "comments before the export" case (the
 * original bug the unanchored version was solving). The comment-aware scan
 * handles both.
 */
import { describe, expect, it } from 'vitest';
import { rewriteExportDefault, buildScreenSrcDoc, SCREEN_FRAME_CSP } from '../screenFrameBuild';

describe('rewriteExportDefault — §2.2: comment-aware export-default rewrite', () => {
    it('rewrites the real `export default` when no comments are present (the original happy path)', () => {
        const src = 'export default function () { return 1; }';
        expect(rewriteExportDefault(src)).toBe('globalThis.__screenMod = function () { return 1; }');
    });

    it('rewrites `export default async function`', () => {
        const src = 'export default async function () { return 2; }';
        expect(rewriteExportDefault(src)).toBe('globalThis.__screenMod = async function () { return 2; }');
    });

    it('leaves a header comment containing "export default" INTACT and rewrites only the real export', () => {
        // The trap: a fixture documents its own format in a header comment.
        // The old unanchored regex matched the FIRST `export default` —
        // inside the comment — and silently killed the frame.
        const src = [
            '// This file uses `export default function` as its entry point.',
            '// An export default declaration is the mod screen contract.',
            'export default function () { return "real"; }',
        ].join('\n');
        const out = rewriteExportDefault(src);
        // The comment is byte-identical (the rewrite touched nothing in it).
        expect(out).toContain('// This file uses `export default function` as its entry point.');
        expect(out).toContain('// An export default declaration is the mod screen contract.');
        // The real export was rewritten.
        expect(out).toContain('globalThis.__screenMod = function () { return "real"; }');
        // And the original `export default` (the code one) is GONE.
        expect(out).not.toMatch(/^export\s+default\s/m);
    });

    it('leaves a block comment containing "export default" INTACT and rewrites only the real export', () => {
        const src = [
            '/*',
            ' * @example export default function () { return "doc"; }',
            ' */',
            'export default function () { return "real"; }',
        ].join('\n');
        const out = rewriteExportDefault(src);
        expect(out).toContain('@example export default function () { return "doc"; }');
        expect(out).toContain('globalThis.__screenMod = function () { return "real"; }');
        expect(out).not.toMatch(/^export\s+default\s/m);
    });

    it('leaves a string literal containing "export default" INTACT and rewrites only the real export', () => {
        const src = [
            'const doc = "use export default function to declare your entry point";',
            'export default function () { return "real"; }',
        ].join('\n');
        const out = rewriteExportDefault(src);
        // The string literal is untouched.
        expect(out).toContain('"use export default function to declare your entry point"');
        // The real export was rewritten.
        expect(out).toContain('globalThis.__screenMod = function () { return "real"; }');
        expect(out).not.toMatch(/^export\s+default\s/m);
    });

    it('returns the source UNCHANGED when no code `export default` is present', () => {
        // A source with `export default` only inside a comment. The rewrite
        // touches nothing; the caller's `typeof globalThis.__screenMod`
        // guard reports a fault (the screen shipped no entry point).
        const src = [
            '// export default function () { return "decoy"; }',
            'function run() { return "no entry point"; }',
        ].join('\n');
        expect(rewriteExportDefault(src)).toBe(src);
    });

    it('does not match `exportdefaultX` (an identifier, not the keyword pair)', () => {
        // The rewrite requires whitespace after `default` so it does not
        // match `export defaultX` (a single identifier). A source with
        // only that token is returned unchanged.
        const src = 'export defaultX = 1;';
        expect(rewriteExportDefault(src)).toBe(src);
    });

    it('handles a comment whose text is `export default` with no trailing whitespace (the decoy)', () => {
        // The line-comment scanner skips to the newline; a bare
        // `// export default` with no trailing code on the same line is
        // a comment, not a code match. The real export on a later line is
        // the one rewritten.
        const src = [
            '// export default',
            'export default function () { return "real"; }',
        ].join('\n');
        const out = rewriteExportDefault(src);
        expect(out).toContain('// export default');
        expect(out).toContain('globalThis.__screenMod = function () { return "real"; }');
    });

    it('rewrites only the FIRST code `export default` (the rest are a syntax error anyway)', () => {
        // A source with two `export default` statements is invalid ES
        // module syntax, but the rewrite should still touch only the
        // first (the regex's "first match wins" semantics preserved).
        const src = 'export default function () {}\nexport default function () {}';
        const out = rewriteExportDefault(src);
        expect(out).toBe('globalThis.__screenMod = function () {}\nexport default function () {}');
    });

    it('the srcdoc builder uses the comment-aware rewrite (integration with buildScreenSrcDoc)', () => {
        // The integration: buildScreenSrcDoc calls rewriteExportDefault,
        // so a fixture whose header comment contains `export default`
        // produces a srcdoc whose FIRST `globalThis.__screenMod =` is the
        // REAL one (in code), not a comment-rewrite.
        const src = [
            '// @example export default function () {}',
            'export default function () { return "real"; }',
        ].join('\n');
        const srcdoc = buildScreenSrcDoc(src, SCREEN_FRAME_CSP);
        // The comment is preserved verbatim.
        expect(srcdoc).toContain('// @example export default function () {}');
        // The real export was rewritten to the global assignment.
        expect(srcdoc).toContain('globalThis.__screenMod = function () { return "real"; }');
        // And no bare `export default` (in code) remains. The comment's
        // `export default` is still there, but no CODE-level one is.
        // We check by counting occurrences in the script body: the wrapper
        // inlines `moduleBody` after a `try {` line, so the only
        // `globalThis.__screenMod =` is the rewrite, and the only
        // `export default` left is the one inside the comment.
        const matches = srcdoc.match(/export\s+default/g) || [];
        expect(matches).toHaveLength(1); // the comment one
    });
});