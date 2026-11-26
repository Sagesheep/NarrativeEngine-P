/**
 * Phase 5.1 — the sixth fault store, in the shape the repo already uses:
 * `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions, `eventFaults.ts` for bus listeners,
 * `mountFaults.ts` for mounts. **Not a second error vocabulary** — same
 * `{ modId, file, kind, reason }` record, same `subscribe`, same
 * `getFaults()` projection into the Extensions list.
 *
 * Phase 5.1 §3: a throwing or slow resolver must not break prompt assembly.
 * The registry contains it (empty string plus a surfaced fault naming the
 * mod), the same posture mounts take with a `state()` that throws.
 */
import type { ModFault } from '../modTypes';
import type { MacroFaultKind } from './macroTypes';

/**
 * A macro fault record. Keyed by mod (one row per mod in the Extensions
 * list, latest fault wins — matches `mountFaultStore` and
 * `eventFaultStore`: a mod whose resolver throws on every turn must not
 * grow the list).
 */
export interface MacroFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: MacroFaultKind;
    /** The macro name, qualified or bare. Absent for `revoked`. */
    readonly name?: string;
}

export interface MacroFaultStore {
    add(record: MacroFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly MacroFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createMacroFaultStore(): MacroFaultStore {
    // Keyed by mod id: one row per mod, latest fault wins.
    const records = new Map<string, MacroFaultRecord>();
    const listeners = new Set<() => void>();
    const notify = (): void => {
        for (const listener of [...listeners]) {
            try { listener(); } catch { /* diagnostics must not break a turn */ }
        }
    };
    return {
        add(record) {
            records.set(record.modId, { ...record });
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
        clearMod(modId) {
            if (records.delete(modId)) notify();
        },
        clear() {
            records.clear();
            notify();
        },
    };
}

export const macroFaultStore = createMacroFaultStore();

/**
 * Phase 5.1 §3 — the natural reason strings, matching the shapes the
 * other fault stores already use (`<modName>: <what happened>`).
 */
export function formatMacroFaultReason(input: {
    readonly modName: string;
    readonly kind: MacroFaultKind;
    readonly name?: string;
    readonly message?: string;
}): string {
    const where = `${input.modName}: macro`;
    const named = input.name ? ` "${input.name}"` : '';
    switch (input.kind) {
        case 'shadow':
            return `${where}${named} shadows a built-in slot`;
        case 'duplicate':
            return `${where}${named} registered the same name twice`;
        case 'threw':
            return `${where}${named} resolver threw (${input.message ?? 'error'})`;
        case 'revoked':
            return `${input.modName}: macro registration attempted after disable${named}`;
        case 'unresolved':
            // Phase 9.2 / 6.9.2 awkward moment #3. The slot text still ships
            // verbatim — an author who reads the prompt sees their typo, which
            // is the pre-9.2 behaviour and is deliberate. What changes is that
            // an author who does NOT read the prompt now finds out too.
            return `${where} slot${named} matched no registered macro — the literal text was sent to the model`;
    }
}