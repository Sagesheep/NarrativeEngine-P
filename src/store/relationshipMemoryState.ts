import { useAppStore } from './useAppStore';
import type { RelationshipMemoryFault, RelationshipMemoryRecord } from '../types';

export type RelationshipMemoryRuntimeState = {
    relationshipMemoriesNpcToMc: RelationshipMemoryRecord[];
    relationshipMemoriesNpcToNpc: RelationshipMemoryRecord[];
    relationshipMemoryFaults: RelationshipMemoryFault[];
};

export function readRelationshipMemoryState(): RelationshipMemoryRuntimeState {
    return useAppStore.getState() as unknown as RelationshipMemoryRuntimeState;
}

export function writeRelationshipMemoryState(
    patch: Partial<RelationshipMemoryRuntimeState>,
): void {
    useAppStore.setState(patch as unknown as Partial<ReturnType<typeof useAppStore.getState>>);
}
