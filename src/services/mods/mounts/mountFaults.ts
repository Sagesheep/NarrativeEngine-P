/**
 * Phase 4.2 — the fifth fault store, in the shape the repo already uses:
 * `sandboxFaults.ts` for compute, `lifecycleFaults.ts` for hooks,
 * `reactiveFaults.ts` for subscriptions, `eventFaults.ts` for bus listeners.
 * **Not a second error vocabulary** — same `{ modId, file, kind, reason }`
 * record, same `subscribe`, same `getFaults()` projection into the Extensions
 * list.
 *
 * `MOUNTS.md` §8.6 / §5: faults are surfaced, never silently dropped. The
 * over-budget call **records a fault and returns a no-op handle** — it does
 * not throw. Throwing inside `activate` would count a strike against the mod
 * and, after three, latch its hooks off for the session (`lifecycleHost.ts`),
 * killing registrations that were fine. Contained failure, same posture the
 * event bus takes with a listener that throws.
 */
import type { ModFault } from '../modTypes';
import type { MountFaultKind, MountRegionId } from './mountTypes';

/**
 * A mount fault record. Keyed by mod (one row per mod in the Extensions list,
 * latest fault wins — matches `reactiveFaultStore` and `eventFaultStore`: a
 * mod whose `state()` throws on every render must not grow the list).
 */
export interface MountFaultRecord extends ModFault {
    readonly modId: string;
    /** The region the fault occurred in. */
    readonly region: MountRegionId;
    readonly kind: MountFaultKind;
    /** The entry id, qualified or bare. Absent for `revoked`. */
    readonly entryId?: string;
}

export interface MountFaultStore {
    add(record: MountFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly MountFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createMountFaultStore(): MountFaultStore {
    // Keyed by mod id: one row per mod, latest fault wins.
    const records = new Map<string, MountFaultRecord>();
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

export const mountFaultStore = createMountFaultStore();

/**
 * `MOUNTS.md` §8.6 — the natural reason strings, matching the shapes the
 * other fault stores already use (`<modName>: <what happened>`).
 */
export function formatMountFaultReason(input: {
    readonly modName: string;
    readonly region: MountRegionId;
    readonly kind: MountFaultKind;
    readonly entryId?: string;
    readonly message?: string;
}): string {
    const where = `${input.modName}: mount in "${input.region}"`;
    const entry = input.entryId ? ` "${input.entryId}"` : '';
    switch (input.kind) {
        case 'budget':
            return `${where}${entry} exceeded the per-mod budget`;
        case 'duplicate':
            return `${where}${entry} registered the same entry id twice`;
        case 'icon':
            return `${where}${entry} declared an unknown icon (${input.message ?? 'unknown name'})`;
        case 'threw':
            return `${where}${entry} threw (${input.message ?? 'error'})`;
        case 'revoked':
            return `${input.modName}: registration attempted after disable${entry}`;
    }
}