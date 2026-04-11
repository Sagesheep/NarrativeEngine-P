import { useRef, useEffect } from 'react';
import { condenseHistory, shouldCondense } from '../../services/condenser';
import { runSaveFilePipeline } from '../../services/saveFileEngine';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';
import type { ChatMessage, CondenserState, EndpointConfig, ProviderConfig, GameContext, NPCEntry, AppSettings, ArchiveIndexEntry } from '../../types';

interface UseCondenserDeps {
    activeCampaignId: string | null;
    isStreaming: boolean;
    messages: ChatMessage[];
    condenser: CondenserState;
    settings: AppSettings;
    setCondensing: (v: boolean) => void;
    setCondensed: (summary: string, upToIndex: number) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setTimeline: (events: any[]) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setLoadingStatus: (s: string | null) => void;
    getActiveStoryEndpoint: () => EndpointConfig | ProviderConfig | undefined;
    getFreshContext: () => GameContext;
    getNpcLedger: () => NPCEntry[];
}

export function useCondenser(deps: UseCondenserDeps) {
    const condenseAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (deps.isStreaming || deps.condenser.isCondensing || !deps.activeCampaignId) return;
        if (shouldCondense(deps.messages, deps.settings.contextLimit, deps.condenser.condensedUpToIndex)) {
            triggerCondense();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deps.isStreaming, deps.messages.length]);

    const triggerCondense = async () => {
        if (deps.condenser.isCondensing) {
            if (condenseAbortRef.current) {
                condenseAbortRef.current.abort();
                condenseAbortRef.current = null;
            }
            deps.setCondensing(false);
            deps.setLoadingStatus(null);
            toast.info('Condense cancelled');
            return;
        }
        condenseAbortRef.current = new AbortController();
        deps.setCondensing(true);
        try {
            const provider = deps.getActiveStoryEndpoint();
            if (!provider) return;
            const currentCtx = deps.getFreshContext();
            const uncondensed = deps.messages.slice(deps.condenser.condensedUpToIndex + 1);
            deps.setLoadingStatus('Archiving recent messages...');
            try {
                const saveResult = await runSaveFilePipeline(provider as EndpointConfig | ProviderConfig, uncondensed, currentCtx);
                if (saveResult.indexSuccess) {
                    deps.updateContext({ headerIndex: saveResult.headerIndex });
                }
                console.log(`[SavePipeline] Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);
            } catch (saveErr) {
                console.error('[SavePipeline] Failed (non-fatal, proceeding to condense):', saveErr);
            }

            const freshCtx = deps.getFreshContext();
            const npcLedger = deps.getNpcLedger();
            const campaignId = deps.activeCampaignId || '';

            let runningUpToIndex = deps.condenser.condensedUpToIndex;
            let runningSummary = deps.condenser.condensedSummary;
            let passes = 0;
            const MAX_PASSES = 10;
            do {
                passes++;
                deps.setLoadingStatus(`Condensing (Pass ${passes})...`);
                console.log(`[Condenser] Pass ${passes} — compressing from index ${runningUpToIndex + 1}`);
                const result = await condenseHistory(
                    provider,
                    deps.messages,
                    freshCtx,
                    runningUpToIndex,
                    runningSummary,
                    campaignId,
                    npcLedger.map(n => n.name),
                    deps.settings.contextLimit,
                    condenseAbortRef.current?.signal
                );
                if (result.upToIndex <= runningUpToIndex) break;
                runningUpToIndex = result.upToIndex;
                runningSummary = result.summary;
                deps.setCondensed(result.summary, result.upToIndex);
            } while (passes < MAX_PASSES && shouldCondense(deps.messages, deps.settings.contextLimit, runningUpToIndex));
            console.log(`[Condenser] Done — ${passes} pass(es), condensed up to index ${runningUpToIndex}`);

            if (campaignId) {
                deps.setLoadingStatus('Refreshing indices...');
                const [fresh, freshTimeline] = await Promise.all([
                    api.archive.getIndex(campaignId),
                    api.timeline.get(campaignId)
                ]);
                deps.setArchiveIndex(fresh);
                deps.setTimeline(freshTimeline);
                console.log(`[Archive] Reloaded index: ${fresh.length} entries`);
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.log('[Condenser] Condensation cancelled by user');
                toast.info('Condense cancelled');
                return;
            }
            console.error('[Condenser]', err);
            toast.error('Condenser failed — history was not compressed');
        } finally {
            deps.setCondensing(false);
            deps.setLoadingStatus(null);
            condenseAbortRef.current = null;
        }
    };

    return { triggerCondense, condenseAbortRef };
}
