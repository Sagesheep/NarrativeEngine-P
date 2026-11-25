import type { InjectionTarget, PromptInjection } from '../../types';
import { injectionTargetOf } from '../../services/payload/promptInjections';

export const targetLabels: Record<InjectionTarget, string> = {
    story: 'Story AI',
    director: 'Director Brief',
    recommender: 'Context Recommender',
};

export const targetHelp: Record<InjectionTarget, string> = {
    story: 'Placed in the story request as a message or prefill, by role and depth.',
    director: 'Added to the Continuity Director\'s prompt, after the scene evidence and before its answer format. Sent every time the Director runs (Pro and Max tiers). It steers what the Director checks; the Writer Brief keeps its usual format.',
    recommender: 'Added to the Context Recommender\'s prompt, after the NPC/lore/item lists and the recent conversation, before its answer format. Sent every time it picks context for a turn. It steers which NPCs, lore and items get loaded.',
};

/** One-line card summary for lists: where and how the card is sent. */
export function injectionSummary(item: PromptInjection): string {
    const target = injectionTargetOf(item);
    if (target !== 'story') return targetLabels[target];
    if (item.mode === 'message') return `${item.role} · depth ${item.depth}`;
    return item.mode === 'reasoning' ? 'Reasoning prefill' : 'Assistant prefill';
}
