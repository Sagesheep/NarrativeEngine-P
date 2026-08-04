import type { ModFault } from './modTypes';

export interface ReactiveFaultRecord extends ModFault {
    readonly modId: string;
    readonly key: string;
    readonly kind: 'threw';
}

export interface ReactiveFaultStore {
    add(record: ReactiveFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly ReactiveFaultRecord[];
    subscribe(listener: () => void): () => void;
    clear(): void;
}

export function createReactiveFaultStore(): ReactiveFaultStore {
    const records = new Map<string, ReactiveFaultRecord>();
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

export const reactiveFaultStore = createReactiveFaultStore();

export function formatReactiveFaultReason(input: {
    modName: string;
    key: string;
    message: string;
}): string {
    return `${input.modName}: subscription "${input.key}" threw (${input.message})`;
}
