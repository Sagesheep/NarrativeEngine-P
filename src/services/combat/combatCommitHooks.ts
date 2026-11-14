import { useAppStore } from '../../store/useAppStore';
import type {
    CombatTelemetry, GameContext, ParleyRatingSource, ParleyRecord, SceneStakes, StuntDifficulty, StuntResultKind,
} from '../../types';

function bump<K extends string>(map: Partial<Record<K, number>> | undefined, key: K): Partial<Record<K, number>> {
    const base: Partial<Record<K, number>> = { ...(map ?? {}) };
    base[key] = (base[key] ?? 0) + 1;
    return base;
}

export function countParleyTelemetry(record: Pick<ParleyRecord, 'rating' | 'intent' | 'effect' | 'success'>, source: ParleyRatingSource): void {
    const store = useAppStore.getState();
    const prev: CombatTelemetry = store.context.combatTelemetry ?? { dangerousCommits: 0, dangerousWithoutProposal: 0 };
    store.updateContext({
        combatTelemetry: {
            ...prev,
            parleyRatings: bump(prev.parleyRatings, record.rating),
            parleyIntents: bump(prev.parleyIntents, record.intent),
            parleyOutcomes: bump(prev.parleyOutcomes, record.success ? 'success' : record.effect),
            parleySources: bump(prev.parleySources, source),
        },
    });
}

export function countStuntTelemetry(result: StuntResultKind, difficulties: readonly StuntDifficulty[] = []): void {
    const store = useAppStore.getState();
    const prev: CombatTelemetry = store.context.combatTelemetry ?? { dangerousCommits: 0, dangerousWithoutProposal: 0 };
    let words = prev.stuntDifficulties;
    for (const d of difficulties) words = bump(words, d);
    store.updateContext({
        combatTelemetry: {
            ...prev,
            ...(words ? { stuntDifficulties: words } : {}),
            stuntResults: bump(prev.stuntResults, result),
        },
    });
}

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
    if (context.combatSuccession && context.combatSuccession.createdAt < input.messageTimestamp) patch.combatSuccession = undefined;
    if (context.combatModeActive === true && input.sceneStakes === 'dangerous') {
        const prev: CombatTelemetry = context.combatTelemetry ?? { dangerousCommits: 0, dangerousWithoutProposal: 0 };
        const proposed = proposedMessageIds.has(input.messageId) || store.combatProposal?.messageId === input.messageId;
        patch.combatTelemetry = {
            ...prev,
            dangerousCommits: prev.dangerousCommits + 1,
            dangerousWithoutProposal: prev.dangerousWithoutProposal + (proposed ? 0 : 1),
        };
        if (!proposed) console.info('[combat] committed a dangerous turn with no combat proposal');
    }
    if (Object.keys(patch).length > 0) store.updateContext(patch);
}
