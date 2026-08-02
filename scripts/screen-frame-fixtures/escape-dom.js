// escape-dom.js — the frame MUST NOT read or write the parent DOM.
//
// R1: omitting allow-same-origin puts the frame in a unique opaque
// origin. `parent.document` is null (or throws), `parent.document.body`
// is unreachable. A frame that COULD reach the parent DOM could delete
// the app, read the vault's decrypted state from the DOM, or remove its
// own sandbox attribute.
//
// This fixture asserts the SPECIFIC failure: it TRIES to reach the
// parent DOM and reports what it got back. The harness asserts that
// `parent.document` is inaccessible (null or a throw). If R1 were
// violated (allow-same-origin added), `parent.document` would be a real
// Document object and `parent.document.body` would be reachable — this
// fixture would report `reached: true` and the suite would go red.
export default function () {
    const probe = {
        __screenFixture: 'escape-dom.js',
        parentDocument: null,
        parentDocumentType: 'unknown',
        parentBody: null,
        parentTitle: null,
        reached: false,
        error: null,
    };
    try {
        const doc = parent.document;
        probe.parentDocument = doc ? 'object' : 'null';
        probe.parentDocumentType = typeof doc;
        if (doc) {
            probe.parentBody = doc.body ? 'present' : 'absent';
            probe.parentTitle = doc.title ?? null;
            probe.reached = true;
        }
    } catch (err) {
        probe.error = String(err);
    }
    parent.postMessage(probe, '*');
}