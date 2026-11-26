/**
 * Phase 5.4 — the eighth fault store, in the shape the repo already uses:
 * `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions, `eventFaults.ts` for bus listeners,
 * `mountFaults.ts` for mounts, `macroFaults.ts` for macros,
 * `interceptorFaults.ts` for interceptors. **Not a second error vocabulary**
 * — same `{ modId, file, kind, reason }` record, same `subscribe`, same
 * `getFaults()` projection into the Extensions list.
 *
 * Phase 5.4 §3: a throwing publisher yields no fact (no match) plus a
 * surfaced fault. The registry contains it; the turn never breaks.
 */
import type { ModFault } from '../modTypes';
import type { FactFaultKind } from './factTypes';

/**
 * A fact fault record. Keyed by mod (one row per mod in the Extensions
 * list, latest fault wins) — matching the other fault stores. A mod
 * whose publisher throws on every turn must not grow the list.
 */
export interface FactFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: FactFaultKind;
    /** The fact name the fault concerns. Absent for `revoked`. */
    readonly name?: string;
}

export interface FactFaultStore {
    add(record: FactFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly FactFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createFactFaultStore(): FactFaultStore {
    const records = new Map<string, FactFaultRecord>();
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

export const factFaultStore = createFactFaultStore();

/**
 * Phase 5.4 §3 — the natural reason strings, matching the shapes the
 * other fault stores already use (`<modName>: <what happened>`).
 */
export function formatFactFaultReason(input: {
    readonly modName: string;
    readonly kind: FactFaultKind;
    readonly name?: string;
    readonly message?: string;
    readonly winner?: string;
}): string {
    const where = `${input.modName}: fact publisher`;
    const named = input.name ? ` "${input.name}"` : '';
    switch (input.kind) {
        case 'shadow':
            return `${where}${named} tried to publish a core fact without a claim, or claimed a name the host has not opened for claims`;
        case 'conflict':
            return `${where}${named} lost a conflict with ${input.winner ?? 'another mod'} (resolved by loading_order)`;
        case 'threw':
            return `${where}${named} threw (${input.message ?? 'error'}); the fact yielded no value this turn`;
        case 'revoked':
            return `${input.modName}: fact publication attempted after disable${named}`;
        case 'duplicate':
            return `${where}${named} registered the same name twice`;
    }
}