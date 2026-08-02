/**
 * WO-P5-17 — screen fault taxonomy (R5).
 *
 * Screens get their OWN fault kinds. `SandboxFaultKind` (in
 * `sandboxTypes.ts`) describes a WORKER's run: `deadline`, `threw`,
 * `worker-error`, `journal-rejected`, `flood`, `load`. Those map to a
 * compute mod's lifecycle — a worker that missed its deadline, that
 * flooded the journal, that a message channel block escaped.
 *
 * A FRAME's failures are about loading and rendering, not about a run.
 * Forcing both into one union makes both vaguer (WO-P5-10 §2 correctly
 * made a seventh compute kind a stop condition for the same reason). They
 * converge only at the UI: both produce `{ file, reason }` on the existing
 * Extensions fault list (`ExtensionsTab.tsx`), which the user already
 * reads. The conversion to `{ file, reason }` lives in Step 3's fault
 * store; this file carries only the taxonomy and the type.
 *
 * Kinds:
 *   - `load`    — the frame's source could not be loaded (a missing file,
 *                 a parse error the browser surfaced, a CSP that blocked
 *                 the document itself).
 *   - `threw`   — the screen's code threw at runtime. The frame reports
 *                 the message; the app keeps running.
 *   - `crashed` — the frame process crashed (Chromium site isolation
 *                 OFTEN gives a sandboxed opaque-origin frame its own
 *                 process; "often" is not a guarantee, so this is the
 *                 kind for the case where it did and the process died).
 */
export type ScreenFaultKind = 'load' | 'threw' | 'crashed';

/**
 * A screen fault record, in the shape the Extensions fault list consumes.
 * `file` and `reason` are the existing `{ file, reason }` shape; `modId`,
 * `screenId`, and `kind` carry the screen-specific detail the fault store
 * keeps for diagnostics.
 */
export interface ScreenFaultRecord {
    readonly modId: string;
    readonly screenId: string;
    readonly file: string;
    readonly kind: ScreenFaultKind;
    readonly reason: string;
}