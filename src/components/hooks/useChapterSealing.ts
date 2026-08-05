import { api } from '../../services/llm/apiClient';
import { generateChapterSummary } from '../../services/saveFileEngine';
import { shouldAutoSeal } from '../../services/archive-memory/archiveChapterEngine';
import { pruneChapterEntries } from '../../services/campaign-state/divergenceRegister';
import { saveDivergenceRegister } from '../../store/campaignStore';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { emitCoreEvent } from '../../services/mods/events';
import type { ArchiveChapter, EndpointConfig, ProviderConfig, GameContext } from '../../types';

interface UseChapterSealingDeps {
    activeCampaignId: string | null;
    chapters: ArchiveChapter[];
    context: GameContext;
    setChapters: (chapters: ArchiveChapter[]) => void;
    getActiveSummarizerEndpoint: () => EndpointConfig | ProviderConfig | undefined;
    getActiveStoryEndpoint: () => EndpointConfig | ProviderConfig | undefined;
}

async function generateChapterSummaryAsync(
    campaignId: string,
    chapter: ArchiveChapter,
    headerIndex: string,
    provider: EndpointConfig | ProviderConfig | undefined,
    setChapters: (chapters: ArchiveChapter[]) => void
) {
    try {
        if (!provider) {
            console.warn('[ChapterSummary] No provider available');
            return;
        }

        const sceneIds: string[] = [];
        const startNum = parseInt(chapter.sceneRange[0], 10);
        const endNum = parseInt(chapter.sceneRange[1], 10);
        for (let i = startNum; i <= endNum; i++) {
            sceneIds.push(String(i).padStart(3, '0'));
        }

        const scenes = await api.archive.fetchScenes(campaignId, sceneIds);

        const summaryResult = await generateChapterSummary(
            provider as EndpointConfig | ProviderConfig,
            chapter,
            scenes,
            headerIndex
        );

        if (summaryResult) {
            await api.chapters.update(campaignId, chapter.chapterId, {
                title: summaryResult.title,
                summary: summaryResult.summary,
                keywords: summaryResult.keywords,
                npcs: summaryResult.npcs,
                majorEvents: summaryResult.majorEvents,
                unresolvedThreads: summaryResult.unresolvedThreads,
                tone: summaryResult.tone,
                themes: summaryResult.themes,
            });

            const freshChapters = await api.chapters.list(campaignId);
            setChapters(freshChapters);
            console.log(`[ChapterSummary] Generated for ${chapter.chapterId}`);
        } else {
            console.warn(`[ChapterSummary] Failed to generate for ${chapter.chapterId}`);
            toast.warning('Chapter summary generation failed. You can retry later.');
        }
    } catch (err) {
        console.error('[ChapterSummary] Generation failed:', err);
        toast.error('Chapter summary failed. Chapter remains sealed with empty summary.');
    }
}

async function pruneChapterEntriesAsync(
    campaignId: string,
    chapter: ArchiveChapter,
    provider: EndpointConfig | ProviderConfig | undefined
) {
    try {
        if (!provider) return;

        const liveRegister = useAppStore.getState().divergenceRegister;
        if (!liveRegister || liveRegister.entries.length === 0) return;

        const allChapters = await api.chapters.list(campaignId);
        const freshChapter = allChapters.find(c => c.chapterId === chapter.chapterId);
        const chapterForPrune = (freshChapter && (freshChapter.summary || freshChapter.unresolvedThreads?.length))
            ? freshChapter
            : chapter;

        const pruned = await pruneChapterEntries(
            provider as EndpointConfig | ProviderConfig,
            chapterForPrune,
            liveRegister,
            allChapters
        );

        useAppStore.getState().setDivergenceRegister(pruned);
        await saveDivergenceRegister(campaignId, pruned);
        console.log(`[ChapterPrune] Pruned entries for sealed chapter ${chapter.chapterId}`);
    } catch (err) {
        console.warn('[ChapterPrune] Failed:', err);
    }
}

export function useChapterSealing(deps: UseChapterSealingDeps) {
    const handleSealChapter = async (campaignId: string, title?: string, reason: string = 'manual') => {
        try {
            if (reason === 'manual') {
                const customTitle = window.prompt(
                    'Seal current chapter?\n\nThis will:\n- Finalize the current chapter\n- Create a new open chapter\n- Generate a summary automatically\n\nEnter an optional title (or leave blank for auto-generated):'
                );
                if (customTitle === null) return;
                title = customTitle || undefined;
            }

            const result = await api.chapters.seal(campaignId, title);
            if (!result) {
                toast.error('Failed to seal chapter');
                return;
            }

            console.log(`[SealChapter] Sealed ${result.sealedChapter.chapterId}, created ${result.newOpenChapter.chapterId}`);
            toast.success(`Chapter sealed: ${result.sealedChapter.chapterId}`);

            const freshChapters = await api.chapters.list(campaignId);
            deps.setChapters(freshChapters);

            // Phase 3.2 / `EVENTS.md` §6.5 — the second of the two places a seal
            // completes, after the seal landed and the new chapter list is in the
            // store. `trigger` distinguishes it from the auto-seal in
            // `postTurnPipeline.ts` so a mod can ignore the one it does not care
            // about.
            emitCoreEvent('archive.chapterSealed', {
                campaignId,
                chapterId: result.sealedChapter.chapterId,
                title: result.sealedChapter.title,
                trigger: reason === 'manual' ? 'manual' : 'auto',
            });

            const capturedHeaderIndex = deps.context.headerIndex;
            const capturedProvider = deps.getActiveSummarizerEndpoint?.()
                ?? deps.getActiveStoryEndpoint();
            await generateChapterSummaryAsync(campaignId, result.sealedChapter, capturedHeaderIndex, capturedProvider, deps.setChapters);
            const updatedChapters = await api.chapters.list(campaignId);
            const sealedWithSummary = updatedChapters.find(c => c.chapterId === result.sealedChapter.chapterId);
            if (sealedWithSummary) {
                await pruneChapterEntriesAsync(campaignId, sealedWithSummary, capturedProvider);
            }
        } catch (err) {
            console.error('[SealChapter] Failed:', err);
            toast.error('Failed to seal chapter');
        }
    };

    const checkAndSealChapter = async (campaignId: string) => {
        try {
            const autoSealResult = shouldAutoSeal(deps.chapters, deps.context.headerIndex);
            if (autoSealResult.shouldSeal) {
                console.log(`[AutoSeal] Triggering seal: ${autoSealResult.reason}`);
                await handleSealChapter(campaignId, undefined, autoSealResult.reason);
            }
        } catch (err) {
            console.warn('[AutoSeal] Check failed:', err);
        }
    };

    return { handleSealChapter, checkAndSealChapter };
}
