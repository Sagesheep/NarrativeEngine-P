import type { ModFault } from '../modTypes';
import {
    SANDBOX_DEADLINE_MS,
    SANDBOX_FAULT_STRIKES,
    SandboxFaultError,
    type SandboxFaultKind,
} from './sandboxTypes';

export interface SandboxFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: SandboxFaultKind;
    readonly strikes: number;
    readonly latched: boolean;
}

export interface SandboxFaultStore {
    add(record: SandboxFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly SandboxFaultRecord[];
    subscribe(listener: () => void): () => void;
    clear(): void;
}

/** A small observable collector so the existing Extensions fault list can subscribe to runtime faults. */
export function createSandboxFaultStore(): SandboxFaultStore {
    const records = new Map<string, SandboxFaultRecord>();
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of listeners) listener();
    };

    return {
        add(record) {
            records.set(record.file, { ...record });
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

export const sandboxFaultStore = createSandboxFaultStore();

export interface SandboxFaultReasonInput {
    readonly modName: string;
    readonly kind: SandboxFaultKind;
    readonly message: string;
    readonly deadlineMs?: number;
    readonly latched?: boolean;
}

function stripSandboxPrefix(message: string): string {
    return message.replace(/^\[sandbox\]\s*/, '');
}

function journalReason(message: string): string {
    const clean = stripSandboxPrefix(message).replace(/^journal rejected:\s*/i, '');
    const quoted = /^(undeclared|unknown) write ["']([^"']+)["']$/i.exec(clean);
    if (quoted) return quoted[1].toLowerCase() + " write '" + quoted[2] + "'";
    return clean;
}

function floodReason(message: string): string {
    const clean = stripSandboxPrefix(message);
    const inbound = /inbound message cap exceeded \((\d+)\)/i.exec(clean);
    if (inbound) return 'flood (' + inbound[1] + ' inbound messages)';
    const journal = /(?:journal cap exceeded|max(?:imum)?\s+(\d+) entries exceeded)/i.exec(clean);
    if (journal) {
        const limit = journal[1] ?? /journal cap exceeded \((\d+) entries\)/i.exec(clean)?.[1];
        return limit ? 'flood (' + limit + ' journal entries)' : 'flood (journal entries)';
    }
    return 'flood (' + clean + ')';
}

/** Format the single user-facing reason shape required by the existing fault list. */
export function formatSandboxFaultReason(input: SandboxFaultReasonInput): string {
    const base = (() => {
        switch (input.kind) {
            case 'deadline':
                return input.modName + ': deadline exceeded (' + (input.deadlineMs ?? SANDBOX_DEADLINE_MS) + ' ms)';
            case 'journal-rejected':
                return input.modName + ': ' + journalReason(input.message) + '; no changes applied';
            case 'flood':
                return input.modName + ': ' + floodReason(input.message);
            case 'threw':
                return input.modName + ': threw (' + stripSandboxPrefix(input.message) + ')';
            case 'worker-error':
                return input.modName + ': worker-error (' + stripSandboxPrefix(input.message) + ')';
            case 'load':
                return input.modName + ': load (' + stripSandboxPrefix(input.message) + ')';
        }
    })();

    if (input.kind === 'load') return base;
    if (input.latched) return base + '; disabled until app reloads (' + SANDBOX_FAULT_STRIKES + ' consecutive faults)';
    return base + '; disabled for remainder of turn';
}

export function classifySandboxFault(error: unknown): SandboxFaultKind {
    if (error instanceof SandboxFaultError) return error.kind;
    const message = error instanceof Error ? error.message : String(error);
    if (/deadline exceeded/i.test(message)) return 'deadline';
    if (/journal (?:rejected|cap)|undeclared write|unknown write/i.test(message)) {
        return /cap exceeded|max(?:imum)?\s+\d+ entries exceeded/i.test(message) ? 'flood' : 'journal-rejected';
    }
    return 'threw';
}

export interface SandboxFaultPolicy {
    canRun(modId: string, turnKey: object): boolean;
    recordSuccess(modId: string, turnKey: object): void;
    recordFault(input: {
        modId: string;
        modName: string;
        file: string;
        kind: SandboxFaultKind;
        message: string;
        deadlineMs?: number;
        turnKey: object;
    }): SandboxFaultRecord;
    getStrikes(modId: string): number;
    isLatched(modId: string): boolean;
    reset(): void;
}

/** Per-turn disable plus consecutive-strike policy, independent of persisted module settings. */
export function createSandboxFaultPolicy(store: SandboxFaultStore = sandboxFaultStore): SandboxFaultPolicy {
    let currentTurnKey: object | undefined;
    const disabledThisTurn = new Set<string>();
    const strikes = new Map<string, number>();
    const latched = new Set<string>();

    const syncTurn = (turnKey: object): void => {
        if (currentTurnKey === turnKey) return;
        currentTurnKey = turnKey;
        disabledThisTurn.clear();
    };

    return {
        canRun(modId, turnKey) {
            syncTurn(turnKey);
            return !disabledThisTurn.has(modId) && !latched.has(modId);
        },
        recordSuccess(modId, turnKey) {
            syncTurn(turnKey);
            if (!latched.has(modId)) strikes.delete(modId);
        },
        recordFault(input) {
            syncTurn(input.turnKey);
            if (!disabledThisTurn.has(input.modId)) {
                disabledThisTurn.add(input.modId);
                strikes.set(input.modId, (strikes.get(input.modId) ?? 0) + 1);
            }
            const strikeCount = strikes.get(input.modId) ?? 0;
            const isLatched = strikeCount >= SANDBOX_FAULT_STRIKES;
            if (isLatched) latched.add(input.modId);
            const record: SandboxFaultRecord = {
                modId: input.modId,
                file: input.file,
                kind: input.kind,
                strikes: strikeCount,
                latched: isLatched,
                reason: formatSandboxFaultReason({
                    modName: input.modName,
                    kind: input.kind,
                    message: input.message,
                    deadlineMs: input.deadlineMs,
                    latched: isLatched,
                }),
            };
            store.add(record);
            return record;
        },
        getStrikes(modId) {
            return strikes.get(modId) ?? 0;
        },
        isLatched(modId) {
            return latched.has(modId);
        },
        reset() {
            currentTurnKey = undefined;
            disabledThisTurn.clear();
            strikes.clear();
            latched.clear();
            store.clear();
        },
    };
}

export const sandboxFaultPolicy = createSandboxFaultPolicy();
