// comment-export.js — WO-P5-18 §2.2 regression guard.
//
// The prior `source.replace(/export\s+default\s+/, …)` was unanchored and
// matched the FIRST occurrence ANYWHERE, including inside a header comment.
// The first mod author who documented their format in a comment like this
// one got a SILENTLY DEAD FRAME: the comment was rewritten, the real export
// was not, and the frame shipped a syntax error. It passed only because no
// fixture comment happened to contain the phrase.
//
// THIS FIXTURE'S HEADER COMMENT CONTAINS `export default` THREE TIMES:
//   - in the line above,
//   - in this sentence: "an export default function is the entry point",
//   - and in the JSDoc-style decoy below:
//       // export default function () { return 'decoy' }
// The harness builds this fixture's srcdoc with the SAME rewrite the
// ScreenFrame component uses. If the rewrite is unanchored (the old bug),
// it rewrites the FIRST `export default` in this comment (turning
// `// export default function` into `// globalThis.__screenMod = function`
// — still a comment, so the rewrite is harmless to the comment but the
// REAL `export default` below is left untouched), `globalThis.__screenMod`
// is never assigned, the wrapper's `typeof globalThis.__screenMod ===
// "function"` guard is false, the entry point never runs, and this fixture
// never posts its `__screenFixture` message. The harness would time out
// waiting for `comment-export.js` and the suite would go red.
//
// The harness asserts this fixture REPORTS A FIXTURE (rendered), NOT A
// FAULT and NOT A TIMEOUT. A fault or timeout here means the §2.2 defect
// has returned.
//
// Anchoring to `^` is NOT the fix (that was the original bug the unanchored
// form was solving — it missed `export default` after leading comments). A
// comment-aware scan is the fix: walk the source tracking lexer state and
// replace only the first CODE `export default`.
//
// This comment documents the format: use `export default function` to
// export your screen's entry point. Another mention: `export default async
// function` is also supported. A third: the `export default` keyword pair
// must appear exactly once outside comments.
export default function () {
    const el = document.createElement('div');
    el.id = 'comment-export-marker';
    el.textContent = 'comment-export rendered';
    document.body.appendChild(el);
    parent.postMessage({
        __screenFixture: 'comment-export.js',
        // The real export ran. If the comment was rewritten instead, this
        // message is never posted and the harness times out.
        ranDefaultExport: true,
        bodyHasMarker: !!document.getElementById('comment-export-marker'),
        textContent: document.getElementById('comment-export-marker')?.textContent ?? null,
    }, '*');
}