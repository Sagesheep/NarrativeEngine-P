// throws.js — a screen that throws at runtime.
//
// The frame MUST report a fault (the buildScreenSrcDoc wrapper catches
// the throw and posts a __screenFault message), and the APP MUST KEEP
// RUNNING. This is R5's "a throwing screen faults its own frame and the
// app keeps running" — the convergence point at the Extensions fault
// list.
//
// This fixture asserts the SPECIFIC thing: the throw is caught by the
// wrapper and reported as a fault, NOT as an unhandled error that
// crashes the frame process. The harness asserts the parent received a
// __screenFault message with `kind: 'threw'` and a message, AND that
// the parent is still responsive afterwards (it can run another
// fixture).
export default function () {
    throw new Error('screen threw on purpose');
}