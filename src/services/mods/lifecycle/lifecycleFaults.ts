/**
 * Phase 1.4 — lifecycle fault store and reason formatter.
 *
 * Modelled on `sandboxFaults.ts` and `screenFaults.ts`: a small observable
 * collector so the existing Extensions fault list can subscribe to lifecycle
 * faults the same way it already subscribes to sandbox and screen faults.
 *
 * Faults are deduped per mod id (one record per mod, latest wins), matching
 * `sandboxFaultStore`'s "one user-facing record per file" rule. The `add()`
 * upserts; the `strikes`/`latched` fields are kept on the record so the UI or
 * a later policy can decide how severe a repeat offender is.
 */
import type {
    LifecycleFaultKind,
    LifecycleFaultRecord,
    LifecycleFaultStore,
} from './lifecycleTypes';

export function createLifecycleFaultStore(): LifecycleFaultStore {
    const records = new Map<string, LifecycleFaultRecord>();
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of listeners) listener();
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

export const lifecycleFaultStore = createLifecycleFaultStore();

export interface LifecycleFaultReasonInput {
    readonly modName: string;
    readonly kind: LifecycleFaultKind;
    readonly hook: string;
    readonly message: string;
    readonly deadlineMs?: number;
    readonly latched?: boolean;
}

/**
 * Format the single user-facing reason shape required by the existing fault
 * list. The fault list renders `<file>\n<reason>`, so the reason carries the
 * mod name (the file path is the manifest label, set by the host).
 *
 * The shape mirrors `formatSandboxFaultReason`: `<modName>: <what happened>`.
 * The `; disabled until …` suffix is omitted here because lifecycle faults do
 * not latch a mod across turns the way compute faults do — a faulted
 * `install` does not stop a later `activate` from running. Phase 6.4 will
 * decide the data-on-fault policy; this phase only surfaces the fault.
 */
export function formatLifecycleFaultReason(input: LifecycleFaultReasonInput): string {
    const where = `${input.modName}: hook "${input.hook}"`;
    switch (input.kind) {
        case 'threw':
            return `${where} threw (${stripPrefix(input.message)})`;
        case 'deadline':
            return `${where} deadline exceeded (${input.deadlineMs ?? LIFECYCLE_DEADLINE_MS} ms)`;
        case 'missing-export':
            return `${where} named a missing export (${input.message})`;
        case 'load':
            return `${input.modName}: load (${stripPrefix(input.message)})`;
        case 'disabled-dep':
            return `${where} skipped — ${input.message}`;
    }
}

function stripPrefix(message: string): string {
    return message.replace(/^\[lifecycle\]\s*/, '');
}

/**
 * Phase 1.4 §3 — 5 seconds, matching SillyTavern's contract unless 0.2 says
 * otherwise. 0.2 did not, so 5s it is. A timeout is a fault with a reason,
 * shown in Extensions — not a crash.
 */
export const LIFECYCLE_DEADLINE_MS = 5000;

/**
 * Three consecutive faulted lifecycle runs latch the mod's hooks off for the
 * rest of this app session, mirroring `SANDBOX_FAULT_STRIKES`. The latch is
 * in-memory only; restarting the app gives the mod another chance, matching
 * the sandbox policy's behaviour.
 */
export const LIFECYCLE_FAULT_STRIKES = 3;