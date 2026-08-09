import { ROLE_IDS, SERVICE_ROLE_IDS } from '@narrative/engine/roles/roleIds';
import type { MemoryRecallAnswer, MemoryRecallInput } from '../context-gatherer/archiveRecall';
import { askDefaultMemoryRecall } from '../context-gatherer/archiveRecall';
import { isBlockEnabled } from '../turn/blockEnablement';
import { createServiceRoleRegistry } from './roleRegistry';
import { getRoleModuleEnabled } from './roleEnablement';
import { beginModRoleLease, buildModContextRoles, clearModRoleLease, recordUnprovidedRoles } from './roleContext';
import type { ModRolesApi } from './roleTypes';
import type { ServiceRole, ServiceRoleRegistry } from './roleTypes';

export type { ModRolesApi } from './roleTypes';
export type { RoleFaultKind, RoleProvider, ServiceRole, ServiceRoleRegistry } from './roleTypes';
export { roleFaultStore, createRoleFaultStore, formatRoleFaultReason } from './roleFaults';
export { buildModContextRoles, beginModRoleLease, clearModRoleLease, clearAllModRoleLeases, recordUnprovidedRoles } from './roleContext';
export { setRoleModuleEnabled, getRoleModuleEnabled } from './roleEnablement';
export { createServiceRoleRegistry } from './roleRegistry';

const memoryRecallRole: ServiceRole<MemoryRecallInput, MemoryRecallAnswer> = {
    id: 'memory.recall',
    name: 'Memory recall',
    description: 'Chooses which archived scenes are recalled into this turn\'s prompt.',
    deadlineMs: 8000,
    validate(answer): MemoryRecallAnswer | undefined {
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
        const sceneIds = (answer as { readonly sceneIds?: unknown }).sceneIds;
        if (!Array.isArray(sceneIds) || !sceneIds.every((id) => typeof id === 'string')) return undefined;
        return { sceneIds: [...sceneIds] };
    },
    defaultProvider: {
        providerId: 'role.memory.recall.core',
        source: 'builtin',
        loadIndex: Number.POSITIVE_INFINITY,
        ask: async (input, signal) => (await askDefaultMemoryRecall(input, signal)) ?? { sceneIds: [] },
    },
};

/** The only production role registry. This module is the role census. */
export const serviceRoles: ServiceRoleRegistry & {
    enable(modId: string): void;
    clear(): void;
} = createServiceRoleRegistry({
    // Keep the exact block enablement contract used by the track runner:
    // `isBlockEnabled(id, undefined, moduleEnabled)`.
    isEnabled: (providerId) => isBlockEnabled(providerId, undefined, getRoleModuleEnabled()),
});

for (const roleId of SERVICE_ROLE_IDS) {
    if (roleId === memoryRecallRole.id) serviceRoles.register(memoryRecallRole);
}

/** Shared package census used by code that needs the ids without descriptors. */
export { ROLE_IDS };

export function enableModRoles(modId: string): void {
    serviceRoles.enable(modId);
    beginModRoleLease(modId);
}

export function disableModRoles(modId: string): void {
    serviceRoles.revoke(modId);
    clearModRoleLease(modId);
}

export function configureModRoles(input: {
    readonly mod: { readonly id: string; readonly name: string };
    readonly declaredRoles: readonly string[];
    readonly loadIndex: number;
    readonly faultFile: string;
}): ModRolesApi {
    return buildModContextRoles({ ...input, registry: serviceRoles });
}

export function checkModRoles(input: {
    readonly mod: { readonly id: string; readonly name: string };
    readonly declaredRoles: readonly string[];
    readonly faultFile: string;
}): void {
    recordUnprovidedRoles({ ...input, registry: serviceRoles });
}
