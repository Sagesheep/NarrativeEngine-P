// ok.js — a well-behaved screen that renders into its own frame body.
//
// Asserts: the frame CAN compute and draw (R3's `default-src 'none'`
// leaves compute and inline styles available). The parent is unaffected.
// This is the baseline — if ok.js fails, the harness itself is broken.
export default function () {
    const el = document.createElement('div');
    el.id = 'ok-marker';
    el.textContent = 'screen rendered';
    document.body.appendChild(el);
    // Report back to the parent what we can see of ourselves. We send
    // ONLY our own document state — never the parent's.
    parent.postMessage({
        __screenFixture: 'ok.js',
        bodyHasMarker: !!document.getElementById('ok-marker'),
        textContent: document.getElementById('ok-marker')?.textContent ?? null,
        // The frame's own location is the opaque-origin sentinel "null"
        // when allow-same-origin is omitted (R1). If this is a real URL,
        // R1 has been violated.
        selfOrigin: location.origin,
        selfHref: location.href,
    }, '*');
}