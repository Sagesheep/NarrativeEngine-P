// hang.js — a screen that spins forever.
//
// §2 of WORKORDER-P5-17: the guarantee from COMPUTE does not transfer.
// A Worker has its own thread; terminate() stops it. An iframe is NOT a
// worker — a same-process iframe SHARES THE PARENT'S EVENT LOOP. A
// screen running `while (true) {}` may freeze the entire app, and
// removing the element will NOT help, because the thread never returns
// to us to process the removal.
//
// Chromium's site isolation OFTEN gives a sandboxed opaque-origin frame
// its own process. "Often" is not a guarantee and you must not assume it.
//
// THIS FIXTURE MEASURES WHETHER THE PARENT STAYS RESPONSIVE.
//
// The harness:
//   1. Notes a parent-side timestamp.
//   2. Mounts the hang frame (which starts spinning immediately).
//   3. Schedules a parent-side `setTimeout(..., 200)` and records how
//      long it actually takes to fire.
//   4. If the setTimeout fires near 200ms, the parent stayed responsive
//      (the frame got its own process — site isolation did its job).
//   5. If the setTimeout fires MUCH later (or the harness times out
//      waiting), the parent FROZE. That is a STOP CONDITION (§7) — the
//      PM's call, not a mitigation to invent here.
//
// The fixture itself does nothing but spin. The measurement is
// parent-side. This is the most important result this sub-phase can
// produce.
export default function () {
    // Spin forever. The parent measures whether it stayed responsive
    // while this ran. There is no `postMessage` back — the frame never
    // yields to send one.
    while (true) {
        // A tight loop. Do not add a yield or a sleep — the point is to
        // pin whatever thread this frame runs on.
    }
}