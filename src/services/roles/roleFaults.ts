import type { ModFault } from '../mods/modTypes';
import type { RoleFaultKind } from './roleTypes';

export interface RoleFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: RoleFaultKind;
    readonly roleId?: string;
    readonly winner?: string;
    readonly loser?: string;
    readonly strikes?: number;
    readonly latched?: boolean;
}

export interface RoleFaultStore {
    add(record: RoleFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly RoleFaultRecord[];
    subscribe(listener: () => void): () => void;
    clearMod(modId: string): void;
    clear(): void;
}

export function createRoleFaultStore(): RoleFaultStore {
    const records = new Map<string, RoleFaultRecord>();
    const listeners = new Set<() => void>();
    const notify = (): void => {
        for (const listener of [...listeners]) {
            try { listener(); } catch { /* diagnostics must never break a turn */ }
        }
    };
    const keyFor = (record: Pick<RoleFaultRecord, 'modId' | 'roleId'>): string =>
        `${record.modId}:${record.roleId ?? ''}`;

    return {
        add(record) {
            records.set(keyFor(record), { ...record });
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
            let changed = false;
            for (const [key, record] of records) {
                if (record.modId === modId) {
                    records.delete(key);
                    changed = true;
                }
            }
            if (changed) notify();
        },
        clear() {
            records.clear();
            notify();
        },
    };
}

export const roleFaultStore = createRoleFaultStore();

export function formatRoleFaultReason(input: {
    readonly modName: string;
    readonly kind: RoleFaultKind;
    readonly roleId?: string;
    readonly message?: string;
    readonly knownRoles?: readonly string[];
    readonly winner?: string;
    readonly loser?: string;
    readonly strikes?: number;
    readonly latched?: boolean;
}): string {
    const role = input.roleId ? ` role "${input.roleId}"` : ' role';
    const where = `${input.modName}:${role}`;
    switch (input.kind) {
        case 'unknown-role':
            return `${where} is unknown; known roles: ${(input.knownRoles ?? []).join(', ') || '(none)'}`;
        case 'undeclared':
            return `${where} was not declared in the mod manifest`;
        case 'unprovided':
            return `${where} was declared but never provided by activate`;
        case 'conflict':
            return `${where} lost a conflict with ${input.winner ?? 'another provider'} (resolved by loading_order)`;
        case 'duplicate':
            return `${where} was provided more than once; the later provider replaced the earlier one`;
        case 'revoked':
            return `${where} was provided after the mod was disabled`;
        case 'sandbox':
            return `${where} is native-tier only`;
        case 'threw':
            return `${where} threw (${input.message ?? 'error'}); no answer was used this turn`;
        case 'timeout':
            return `${where} exceeded its deadline; no answer was used this turn`;
        case 'invalid':
            return `${where} returned an invalid answer (${input.message ?? 'shape rejected'}); no answer was used this turn`;
        case 'partial':
            return `${where} returned unresolved scene ids (${input.message ?? 'unknown ids were dropped'})`;
    }
}

