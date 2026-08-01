import type { ArchiveChapter } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { deepArchiveScan } from '../archive-memory/deepArchiveSearch';
import { queryFacts, formatFactsForContext } from '../retrieval/semanticMemory';
import { tierAllows } from '../turn/aiTier';
import { hasHostModelRole, type HostFacade } from '../turn/hostFacade';

export type DeepSearchDeps = {
    deepSearchThisTurn: boolean;
    chapters: ArchiveChapter[];
    setLoadingStatus?: (status: string | null) => void;
};

export async function gatherDeepSearch(
    state: TurnState,
    deps: DeepSearchDeps,
    finalInput: string,
    signal?: AbortSignal,
    facade?: HostFacade
): Promise<string | undefined> {
    const data = facade?.data;
    const config = facade?.config;
    const activeCampaignId = data?.activeCampaignId ?? state.activeCampaignId;
    if (!deps.deepSearchThisTurn || !activeCampaignId) {
        return undefined;
    }

    if (!tierAllows(config?.aiTier ?? state.settings.aiTier, 'deepScan')) {
        return undefined;
    }

    const utilityEndpoint = facade ? undefined : state.getUtilityEndpoint?.();
    const utilityAvailable = facade ? hasHostModelRole(facade, 'utility') : Boolean(utilityEndpoint?.endpoint);
    if (!utilityAvailable) {
        return undefined;
    }

    try {
        const sealedChapters = deps.chapters.filter(c => c.sealedAt !== undefined);
        if (sealedChapters.length > 0) {
            const deepBudget = Math.floor(((config?.contextLimit ?? state.settings.contextLimit) || 8192) * 0.45);
            const deepContextSummary = await deepArchiveScan(
                utilityEndpoint,
                data?.archiveIndex ?? state.archiveIndex,
                sealedChapters,
                activeCampaignId,
                data?.messages ?? state.messages,
                finalInput,
                deepBudget,
                (msg) => deps.setLoadingStatus?.(msg),
                signal,
                facade ? (request: import('../turn/hostFacade').ModelRequest) => facade.model.call('utility', request) : undefined
            );
            console.log(`[DeepArchiveSearch] Brief generated: ~${Math.ceil((deepContextSummary || '').length / 4)} tokens`);
            return deepContextSummary;
        }
    } catch (err) {
        console.warn('[DeepArchiveSearch] Failed, standard recall used:', err);
    }

    return undefined;
}

export function gatherSemanticFacts(
    state: TurnState,
    finalInput: string
): string | undefined {
    const semanticFacts = state.semanticFacts ?? [];
    if (semanticFacts.length === 0) {
        return undefined;
    }
    const relevantFacts = queryFacts(semanticFacts, finalInput, state.messages, state.npcLedger, 500);
    return formatFactsForContext(relevantFacts) || undefined;
}
