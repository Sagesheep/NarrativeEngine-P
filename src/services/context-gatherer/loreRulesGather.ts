import type { LoreChunk } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { retrieveRelevantLore } from '../lore/loreRetriever';
import { retrieveRelevantRules } from '../rules/rulesRetriever';
import type { SemanticCandidates } from './semanticCandidates';

export type LoreRulesResult = {
    relevantLore: LoreChunk[] | undefined;
    relevantRules: LoreChunk[];
    rulesManifest: string;
};

export function gatherLoreAndRules(
    state: TurnState,
    semanticCandidates: SemanticCandidates,
    recommendedLoreIds?: string[],
): LoreRulesResult {
    const { input, messages, loreChunks, context } = state;
    const { semanticLoreIds, semanticRuleIds } = semanticCandidates;

    const candidateMessages = (state.condenser?.condensedUpToIndex !== undefined && state.condenser.condensedUpToIndex >= 0)
        ? messages.slice(state.condenser.condensedUpToIndex + 1)
        : messages;

    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages, semanticLoreIds, state.settings.retrievalAlgorithm ?? 'idf-rrf', recommendedLoreIds)
        : undefined;

    const rulesBudget = Math.floor(
        (state.settings.contextLimit ?? 8192) * (state.settings.rulesBudgetPct ?? 0.10)
    );
    const rulesResult = (context.rulesChunks?.length ?? 0) > 0
        ? retrieveRelevantRules(
            context.rulesChunks ?? [],
            context.rulesChunkMeta,
            input,
            rulesBudget,
            candidateMessages,
            semanticRuleIds,
            state.settings.retrievalAlgorithm ?? 'idf-rrf'
        )
        : { selected: [], manifest: '' };

    return {
        relevantLore,
        relevantRules: rulesResult.selected,
        rulesManifest: rulesResult.manifest,
    };
}
