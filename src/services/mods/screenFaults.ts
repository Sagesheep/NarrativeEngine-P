/**
 * WO-P5-17 — screen fault taxonomy (R5) and fault store (Step 3).
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
 * reads. The `ScreenFaultStore` below is the observable collector the
 * Extensions tab subscribes to, mirroring `sandboxFaultStore`.
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
import type { ModFault } from './modTypes';

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

/**
 * The observable fault store for screen faults. Mirrors `sandboxFaultStore`
 * (`sandboxFaults.ts`) so the Extensions fault list can subscribe to both
 * with the same shape. The store keys on `${modId}/${screenId}` — a screen
 * that faults repeatedly overwrites its own record rather than stacking,
 * so a runaway screen produces one entry, not a flood. `getFaults()`
 * returns the `{ file, reason }` projection the existing Extensions list
 * consumes (`ExtensionsTab.tsx`); `getRecords()` returns the full records
 * for diagnostics.
 */
export interface ScreenFaultStore {
    add(record: ScreenFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly ScreenFaultRecord[];
    subscribe(listener: () => void): () => void;
    clear(): void;
}

export function createScreenFaultStore(): ScreenFaultStore {
    const records = new Map<string, ScreenFaultRecord>();
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of listeners) listener();
    };

    return {
        add(record) {
            records.set(`${record.modId}/${record.screenId}`, { ...record });
            notify();
        },
        getFaults() {
            return [...records.values()].map(({ file, reason }) => ({ file, reason }));
        },
        getRecords() {
            return [...records.values()].map((record) => ({ ...record }));
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        clear() {
            records.clear();
            notify();
        },
    };
}

/** The singleton store the Extensions tab subscribes to. */
export const screenFaultStore = createScreenFaultStore();

/**
 * Format the single user-facing reason shape the Extensions fault list
 * expects. Mirrors `formatSandboxFaultReason` (`sandboxFaults.ts`): a
 * one-line string naming the mod and screen and what happened. The
 * `kind->prose` mapping is the only place the taxonomy reaches the UI.
 */
export function formatScreenFaultReason(input: {
    modName: string;
    screenId: string;
    kind: ScreenFaultKind;
    message: string;
}): string {
    const where = `${input.modName}: screen "${input.screenId}"`;
    switch (input.kind) {
        case 'load':
            return `${where}: failed to load (${input.message})`;
        case 'threw':
            return `${where}: threw (${input.message})`;
        case 'crashed':
            return `${where}: frame process crashed (${input.message})`;
    }
}