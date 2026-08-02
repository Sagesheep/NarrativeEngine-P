/**
 * WO-P5-17 / WO-P5-18 screen fault taxonomy and observable fault store.
 *
 * Screens have their own fault union. Compute faults describe a worker run;
 * screen faults describe loading, rendering, and the message boundary.
 */
import type { ModFault } from './modTypes';

export type ScreenFaultKind = 'load' | 'threw' | 'crashed' | 'denied' | 'flood' | 'malformed';

export interface ScreenFaultRecord {
    readonly modId: string;
    readonly screenId: string;
    readonly file: string;
    readonly kind: ScreenFaultKind;
    readonly reason: string;
}

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

export const screenFaultStore = createScreenFaultStore();

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
        case 'denied':
            return `${where}: denied (${input.message})`;
        case 'flood':
            return `${where}: message flood — torn down (${input.message})`;
        case 'malformed':
            return `${where}: malformed message (${input.message})`;
    }
}
