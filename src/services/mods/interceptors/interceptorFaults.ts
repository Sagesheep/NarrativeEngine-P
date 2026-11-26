/**
 * Phase 5.2 — the seventh fault store, in the shape the repo already uses:
 * `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions, `eventFaults.ts` for bus listeners,
 * `mountFaults.ts` for mounts, `macroFaults.ts` for macros. **Not a second
 * error vocabulary** — same `{ modId, file, kind, reason }` record, same
 * `subscribe`, same `getFaults()` projection into the Extensions list.
 *
 * Phase 5.2 §3: "A failing interceptor must not fail the turn. Fault,
 * surface, continue with the un-intercepted payload." This store is the
 * *surface* half; the registry is the *continue* half.
 */
import type { ModFault } from '../modTypes';
import type { InterceptorFaultKind } from './interceptorTypes';

/**
 * An interceptor fault record. Keyed by mod (one row per mod in the
 * Extensions list, latest fault wins) — matching `mountFaultStore`,
 * `eventFaultStore` and `macroFaultStore`. An interceptor that throws on
 * every turn must not grow the list without bound; it is one broken mod, not
 * four hundred incidents.
 */
export interface InterceptorFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: InterceptorFaultKind;
    /**
     * The contribution or suppression id the fault concerns. Absent for
     * `threw` / `timeout` / `revoked`, which are about the call, not an id.
     */
    readonly id?: string;
}

export interface InterceptorFaultStore {
    add(record: InterceptorFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly InterceptorFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createInterceptorFaultStore(): InterceptorFaultStore {
    // Keyed by mod id: one row per mod, latest fault wins.
    const records = new Map<string, InterceptorFaultRecord>();
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

export const interceptorFaultStore = createInterceptorFaultStore();

/**
 * Phase 5.2 §3 — the reason strings, matching the shape the other fault
 * stores already use (`<modName>: <what happened>`).
 *
 * The `protected` message names the id AND says why it is refused, because
 * "rejected with a reason" is a literal done-when item for this phase: a mod
 * author who tries to delete the player's own words must be told that is what
 * they tried to do.
 */
export function formatInterceptorFaultReason(input: {
    readonly modName: string;
    readonly kind: InterceptorFaultKind;
    readonly id?: string;
    readonly message?: string;
    readonly deadlineMs?: number;
}): string {
    const where = `${input.modName}: prompt interceptor`;
    const named = input.id ? ` "${input.id}"` : '';
    switch (input.kind) {
        case 'threw':
            return `${where} threw (${input.message ?? 'error'}); the turn continued with the un-intercepted payload`;
        case 'timeout':
            return `${where} did not return within ${input.deadlineMs ?? 0} ms; the turn continued with the un-intercepted payload`;
        case 'protected':
            return `${where} may not suppress${named} — it is a structural block (the player's message, the world state, the confirmed ask-GM handoff, and the player's absolute command are never removable)`;
        case 'invalid':
            return `${where} returned an invalid contribution${named}${input.message ? ` (${input.message})` : ''}; it was dropped`;
        case 'revoked':
            return `${where} ran after the mod was disabled; its result was discarded`;
        case 'suppressed':
            return `${where} suppressed${named}; NPC stances were omitted for this turn and relationship numbers were not used as a replacement`;
    }
}
