import type { RoleProvider, ServiceRoleRegistry } from './roleTypes';
import type { ModRolesApi } from './roleTypes';
import { formatRoleFaultReason, roleFaultStore } from './roleFaults';

const providedByMod = new Map<string, Set<string>>();

export function beginModRoleLease(modId: string): void {
    providedByMod.set(modId, new Set());
}

export function clearModRoleLease(modId: string): void {
    providedByMod.delete(modId);
}

export function clearAllModRoleLeases(): void {
    providedByMod.clear();
}

export function getProvidedRoleIds(modId: string): readonly string[] {
    return [...(providedByMod.get(modId) ?? [])];
}

export interface ModRolesApiOptions {
    readonly mod: { readonly id: string; readonly name: string };
    readonly declaredRoles: readonly string[];
    readonly loadIndex: number;
    readonly faultFile: string;
    readonly registry: ServiceRoleRegistry;
}

function addContextFault(input: {
    readonly mod: { readonly id: string; readonly name: string };
    readonly roleId?: string;
    readonly kind: Parameters<typeof formatRoleFaultReason>[0]['kind'];
    readonly message?: string;
    readonly knownRoles: readonly string[];
    readonly faultFile: string;
}): void {
    roleFaultStore.add({
        modId: input.mod.id,
        file: input.faultFile,
        kind: input.kind,
        roleId: input.roleId,
        reason: formatRoleFaultReason({
            modName: input.mod.name,
            kind: input.kind,
            roleId: input.roleId,
            message: input.message,
            knownRoles: input.knownRoles,
        }),
    });
}

export function buildModContextRoles(options: ModRolesApiOptions): ModRolesApi {
    const declared = new Set(options.declaredRoles);
    const knownRoles = options.registry.list().map((role) => role.id);

    return Object.freeze({
        provide(roleId: string, ask: (input: never, signal: AbortSignal) => unknown): () => void {
            if (!declared.has(roleId)) {
                addContextFault({
                    mod: options.mod,
                    roleId,
                    kind: knownRoles.includes(roleId) ? 'undeclared' : 'unknown-role',
                    knownRoles,
                    faultFile: options.faultFile,
                });
                return () => {};
            }
            if (typeof ask !== 'function') {
                addContextFault({
                    mod: options.mod,
                    roleId,
                    kind: 'invalid',
                    message: 'provider ask must be a function',
                    knownRoles,
                    faultFile: options.faultFile,
                });
                return () => {};
            }
            const provider: RoleProvider<never, never> = {
                providerId: `mod.${options.mod.id}`,
                source: 'mod',
                modId: options.mod.id,
                loadIndex: options.loadIndex,
                ask: (input, signal) => ask(input, signal) as never,
            };
            const unregister = options.registry.provide(roleId, provider);
            const state = providedByMod.get(options.mod.id) ?? new Set<string>();
            state.add(roleId);
            providedByMod.set(options.mod.id, state);
            return unregister;
        },
    });
}

export function recordUnprovidedRoles(options: {
    readonly mod: { readonly id: string; readonly name: string };
    readonly declaredRoles: readonly string[];
    readonly faultFile: string;
    readonly registry: ServiceRoleRegistry;
}): void {
    const provided = new Set(getProvidedRoleIds(options.mod.id));
    const knownRoles = options.registry.list().map((role) => role.id);
    for (const roleId of options.declaredRoles) {
        if (provided.has(roleId)) continue;
        addContextFault({
            mod: options.mod,
            roleId,
            kind: 'unprovided',
            knownRoles,
            faultFile: options.faultFile,
        });
    }
}
