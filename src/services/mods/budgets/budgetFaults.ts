/**
 * Phase 7.4 — the budget fault store, in the shape the repo already uses:
 * `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions, `eventFaults.ts` for bus listeners,
 * `mountFaults.ts` for mounts, `macroFaults.ts` for macros,
 * `interceptorFaults.ts` for interceptors, `factFaults.ts` for facts.
 * **Not a second error vocabulary** — same `{ modId, file, kind, reason }`
 * record, same `subscribe`, same `getFaults()` projection into the
 * Extensions list.
 *
 * Phase 7.4 §3 (per Phase 7.5 §3): a misbehaving claim yields no allocation
 * (zero) plus a surfaced fault. The registry contains it; the turn never
 * breaks.
 */
import type { ModFault } from '../modTypes';
import type { BudgetFaultKind } from './budgetTypes';

/**
 * A budget fault record. Keyed by mod (one row per mod in the Extensions
 * list, latest fault wins) — matching the other fault stores.
 */
export interface BudgetFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: BudgetFaultKind;
    /** The claim id the fault concerns. Absent for `revoked`. */
    readonly name?: string;
}

export interface BudgetFaultStore {
    add(record: BudgetFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly BudgetFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createBudgetFaultStore(): BudgetFaultStore {
    const records = new Map<string, BudgetFaultRecord>();
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

export const budgetFaultStore = createBudgetFaultStore();

/**
 * Phase 7.4 — the natural reason strings, matching the shapes the other
 * fault stores already use (`<modName>: <what happened>`).
 */
export function formatBudgetFaultReason(input: {
    readonly modName: string;
    readonly kind: BudgetFaultKind;
    readonly name?: string;
    readonly message?: string;
}): string {
    const where = `${input.modName}: budget claim`;
    const named = input.name ? ` "${input.name}"` : '';
    switch (input.kind) {
        case 'shadow':
            return `${where}${named} tried to claim a built-in id; use a mod-namespaced id instead`;
        case 'duplicate':
            return `${where}${named} registered the same id twice`;
        case 'revoked':
            return `${input.modName}: budget claim attempted after disable${named}`;
        case 'bad-args':
            return `${where}${named} had invalid arguments (${input.message ?? 'error'})`;
    }
}