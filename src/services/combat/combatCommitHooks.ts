import { useAppStore } from '../../store/useAppStore';
import type { CombatTelemetry, GameContext, SceneStakes } from '../../types';

const proposedMessageIds = new Set<string>();

export function markProposedMessage(messageId: string): void {
    if (messageId) proposedMessageIds.add(messageId);
}

export function wasMessageProposed(messageId: string): boolean {
    return proposedMessageIds.has(messageId);
}

export function resetProposedMessages(): void {
    proposedMessageIds.clear();
}

export function settleCombatNotesOnCommit(input: { messageId: string; messageTimestamp: number; sceneStakes: SceneStakes }): void {
    const store = useAppStore.getState();
    const context = store.context;
    const patch: Partial<GameContext> = {};
    if (context.combatDeclined && context.combatDeclined.createdAt < input.messageTimestamp) patch.combatDeclined = undefined;
    if (context.combatAftermath && context.combatAftermath.createdAt < input.messageTimestamp) patch.combatAftermath = undefined;
    if (context.combatModeActive === true && input.sceneStakes === 'dangerous') {
        const prev: CombatTelemetry = context.combatTelemetry ?? { dangerousCommits: 0, dangerousWithoutProposal: 0 };
        const proposed = proposedMessageIds.has(input.messageId) || store.combatProposal?.messageId === input.messageId;
        patch.combatTelemetry = {
            dangerousCommits: prev.dangerousCommits + 1,
            dangerousWithoutProposal: prev.dangerousWithoutProposal + (proposed ? 0 : 1),
        };
        if (!proposed) console.info('[combat] committed a dangerous turn with no combat proposal');
    }
    if (Object.keys(patch).length > 0) store.updateContext(patch);
}
