import type { ModFault } from '../modTypes';

/**
 * Phase 3.2 / `EVENTS.md` §5.3 — the fourth fault store, in the shape the repo
 * already uses: `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions. **Not a second error vocabulary** —
 * same `{ modId, file, kind, reason }` record, same `subscribe`, same
 * `getFaults()` projection into the Extensions list.
 *
 * **Strikes and latching are declined for v1.** The sandbox latches a mod off
 * after three consecutive faults because a faulting compute hook burns a worker
 * and a deadline every turn. A throwing listener costs one `try`/`catch`.
 * Surfacing it in Extensions is the whole remedy; disabling a mod's event
 * handling out from under it, silently, is worse than a noisy fault.
 */
export interface EventFaultRecord extends ModFault {
    readonly modId: string;
    /** The fully-qualified event name whose listener threw. */
    readonly event: string;
    readonly kind: 'threw';
}

export interface EventFaultStore {
    add(record: EventFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly EventFaultRecord[];
    subscribe(listener: () => void): () => void;
    clear(): void;
}

export function createEventFaultStore(): EventFaultStore {
    // Keyed by mod: one row per mod in the Extensions list, latest fault wins.
    // Matches `reactiveFaultStore` — a mod whose listener throws on every turn
    // must not grow the list without bound.
    const records = new Map<string, EventFaultRecord>();
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
        clear() {
            records.clear();
            notify();
        },
    };
}

export const eventFaultStore = createEventFaultStore();

/**
 * `EVENTS.md` §5.3 — the natural reason string, matching
 * `formatReactiveFaultReason`'s shape exactly:
 *
 * ```
 * <modName>: listener for "<event>" threw (<message>)
 * ```
 */
export function formatEventFaultReason(input: {
    modName: string;
    event: string;
    message: string;
}): string {
    return `${input.modName}: listener for "${input.event}" threw (${input.message})`;
}
