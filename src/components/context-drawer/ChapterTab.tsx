import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { BookOpen, Plus, Loader2, Sparkles, Scale } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/llm/apiClient';
import { ChapterCard } from './ChapterCard';
import { ResolvedStatePanel } from './ResolvedStatePanel';
import { runCombinedSeal } from '../../services/turn/postTurnPipeline';
import { backfillChapterSynopses, chaptersNeedingSynopsis } from '../../services/archive-memory/synopsisBackfill';
import { toast } from '../Toast';
import type { ArchiveChapter } from '../../types';
import { CHAPTER_SCENE_SOFT_CAP } from '../../types';

export const ChapterTab: React.FC = () => {
    const {
        chapters, setChapters, activeCampaignId,
        getActiveSummarizerEndpoint,
        timeline, setTimeline, removeTimelineEvent,
        pinnedChapterIds, pinChapter,
        messages, archiveIndex, loreChunks, npcLedger,
    } = useAppStore();
    
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [isRegenerating, setIsRegenerating] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [isRefitting, setIsRefitting] = useState(false);
    // A ref, not the `isCreating` state: `disabled` only takes effect after
    // React commits the re-render, so two clicks landing in the same tick both
    // pass the state check. The ref flips synchronously. (The server also
    // serializes creates now — this just avoids the wasted round-trip.)
    const creatingRef = useRef(false);
    // WO-07: synopsis backfill progress. `null` = idle; otherwise {done,total}.
    const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number } | null>(null);
    // AbortController for the in-flight backfill. Aborted on unmount or campaign switch.
    const backfillAbortRef = useRef<AbortController | null>(null);

    const refreshChapters = useCallback(async () => {
        if (!activeCampaignId) return;
        const [fresh, freshTimeline] = await Promise.all([
            api.chapters.list(activeCampaignId),
            api.timeline.get(activeCampaignId),
        ]);
        setChapters(fresh);
        setTimeline(freshTimeline);
    }, [activeCampaignId, setChapters, setTimeline]);

    useEffect(() => {
        refreshChapters();
    }, [refreshChapters]);

    // WO-07: abort the in-flight backfill when ChapterTab unmounts (e.g. drawer closed).
    useEffect(() => {
        return () => {
            backfillAbortRef.current?.abort();
            backfillAbortRef.current = null;
        };
    }, []);

    const handleSeal = useCallback(async () => {
        if (!activeCampaignId) return;
        setIsCreating(true);
        try {
            const result = await api.chapters.seal(activeCampaignId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter sealed');
                regenerateChapter(result.sealedChapter, true);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to seal chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const regenerateChapter = useCallback(async (chapter: ArchiveChapter, setSealedAt: boolean = false) => {
        if (!activeCampaignId) return;

        setIsRegenerating(chapter.chapterId);
        try {
            const provider = getActiveSummarizerEndpoint();
            if (!provider || !provider.endpoint) {
                toast.error('No summarizer AI configured');
                return;
            }

            const state = useAppStore.getState();
            await runCombinedSeal(
                provider,
                chapter,
                activeCampaignId,
                {
                    ...state,
                    getFreshProvider: () => getActiveSummarizerEndpoint(),
                    getMessages: () => messages,
                    getFreshContext: () => state.context,
                    archiveIndex,
                    loreChunks,
                    npcLedger: npcLedger ?? [],
                    settings: state.settings,
                    setChapters,
                } as any,
                {
                    setDivergenceRegister: useAppStore.getState().setDivergenceRegister,
                } as any,
                setSealedAt,
                // WO-P1-03: the 5 formerly-coupling reads, now explicit params.
                {
                    npcLedger: npcLedger ?? [],
                    archiveIndex,
                    divergenceScanBudget: state.settings.divergenceScanBudget ?? 0,
                    contextLimit: state.settings.contextLimit ?? 4096,
                    divergenceRegister: state.divergenceRegister ?? { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
                },
            );

            await refreshChapters();
            toast.success(`Chapter regenerated: ${chapter.title}`);
        } catch (err) {
            console.error(err);
            toast.error(`Failed to regenerate chapter ${chapter.title}`);
        } finally {
            setIsRegenerating(prev => prev === chapter.chapterId ? null : prev);
        }
    }, [activeCampaignId, refreshChapters, getActiveSummarizerEndpoint]);

    // WO-07: user-triggered synopsis backfill for sealed chapters missing `synopsis`.
    // Sequential calls (no parallel) so progress is predictable and token spend is
    // visible. Aborts on unmount (cleanup effect) or campaign switch (isActive guard)
    // — already-patched chapters stay patched, the loop just stops.
    const handleBackfillSynopses = useCallback(async () => {
        if (!activeCampaignId) return;
        const provider = getActiveSummarizerEndpoint();
        if (!provider || !provider.endpoint) {
            toast.error('No summarizer AI configured');
            return;
        }

        // Abort any prior in-flight backfill (defensive — button is disabled while running).
        backfillAbortRef.current?.abort();
        const ac = new AbortController();
        backfillAbortRef.current = ac;

        const targets = chaptersNeedingSynopsis(chapters);
        setBackfillProgress({ done: 0, total: targets.length });

        try {
            const result = await backfillChapterSynopses({
                chapters,
                provider,
                patch: async (chapterId, fields) => {
                    await api.chapters.update(activeCampaignId, chapterId, fields as Partial<ArchiveChapter>);
                },
                // Campaign-ID guard: read from the live store so a switch mid-run aborts.
                isActive: () => useAppStore.getState().activeCampaignId === activeCampaignId,
                signal: ac.signal,
                onProgress: (done, total) => setBackfillProgress({ done, total }),
            });

            // If the campaign switched or the component unmounted, drop the final
            // refresh — the new campaign's tab owns its own state.
            if (ac.signal.aborted || useAppStore.getState().activeCampaignId !== activeCampaignId) {
                return;
            }

            await refreshChapters();
            const okCount = result.patched.filter(p => p.ok).length;
            if (result.aborted) {
                toast.warning(`Synopsis backfill stopped — ${okCount} chapter${okCount === 1 ? '' : 's'} patched.`);
            } else if (okCount === 0 && result.skipped.length === 0) {
                toast.warning('No synopses generated — try again or check the summarizer AI.');
            } else {
                const skipMsg = result.skipped.length > 0 ? ` (${result.skipped.length} skipped — no summary)` : '';
                toast.success(`Generated ${okCount} synopsis${okCount === 1 ? '' : 'es'}${skipMsg}.`);
            }
        } catch (err) {
            console.error(err);
            if (!ac.signal.aborted && useAppStore.getState().activeCampaignId === activeCampaignId) {
                toast.error('Synopsis backfill failed');
            }
        } finally {
            // Only clear progress if this is still the active backfill (not superseded).
            if (backfillAbortRef.current === ac) {
                backfillAbortRef.current = null;
                setBackfillProgress(null);
            }
        }
    }, [activeCampaignId, chapters, refreshChapters, getActiveSummarizerEndpoint]);

    const handleRename = useCallback(async (chapterId: string, newTitle: string) => {
        if (!activeCampaignId) return;
        await api.chapters.update(activeCampaignId, chapterId, { title: newTitle });
        await refreshChapters();
    }, [activeCampaignId, refreshChapters]);

    const handleMerge = useCallback(async (idA: string, idB: string) => {
        if (!activeCampaignId) return;
        try {
            const merged = await api.chapters.merge(activeCampaignId, idA, idB);
            if (merged) {
                await refreshChapters();
                toast.success('Chapters merged');
                regenerateChapter(merged, false);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to merge chapters');
        }
    }, [activeCampaignId, refreshChapters, regenerateChapter]);

    const handleSplit = useCallback(async (chapterId: string, atSceneId: string) => {
        if (!activeCampaignId) return;
        try {
            const result = await api.chapters.split(activeCampaignId, chapterId, atSceneId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter split');
                regenerateChapter(result.chapterA, false);
                regenerateChapter(result.chapterB, false);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to split chapter');
        }
    }, [activeCampaignId, refreshChapters, regenerateChapter]);

    const handleDeleteTimelineEvent = useCallback(async (eventId: string) => {
        if (!activeCampaignId) return;
        const ok = await api.timeline.remove(activeCampaignId, eventId);
        if (ok) removeTimelineEvent(eventId);
        else toast.error('Failed to remove timeline event');
    }, [activeCampaignId, removeTimelineEvent]);

    const handleNewChapter = useCallback(async () => {
        if (!activeCampaignId || creatingRef.current) return;
        creatingRef.current = true;
        setIsCreating(true);
        try {
            await api.chapters.create(activeCampaignId);
            await refreshChapters();
            toast.success('New chapter created');
        } catch (err) {
            toast.error('Failed to create chapter');
        } finally {
            creatingRef.current = false;
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const handleDeleteChapter = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId) return;
        const ok = window.confirm(
            `Delete "${chapter.title}"?\n\nThis chapter holds no scenes, so no prose, timeline events or facts are affected.`
        );
        if (!ok) return;

        const result = await api.chapters.remove(activeCampaignId, chapter.chapterId);
        if (!result.ok) {
            toast.error(result.error || 'Failed to delete chapter');
            return;
        }
        // `pinChapter` toggles, so only call it when actually pinned.
        if (pinnedChapterIds.includes(chapter.chapterId)) pinChapter(chapter.chapterId);
        if (expandedId === chapter.chapterId) setExpandedId(null);
        await refreshChapters();
        toast.success('Chapter deleted');
    }, [activeCampaignId, pinnedChapterIds, pinChapter, expandedId, refreshChapters]);

    /**
     * Reflow chapter boundaries to CHAPTER_SCENE_SOFT_CAP scenes each.
     *
     * Manual only, and it does not regenerate anything — it marks the affected
     * chapters `invalidated` and leaves the LLM calls to the per-chapter Repair
     * button. The confirm states how many that will be, since that is the real
     * cost of the operation.
     */
    const handleRefit = useCallback(async () => {
        if (!activeCampaignId || isRefitting) return;

        const preview = await api.chapters.refitPreview(activeCampaignId);
        if (!preview) {
            toast.error('Could not check chapter fit');
            return;
        }
        if (!preview.wouldChange) {
            toast.info('Chapters are already evenly fitted');
            return;
        }

        const plural = preview.changedCount === 1 ? '' : 's';
        const ok = window.confirm(
            `Refit ${preview.totalScenes} scenes into chapters of ${preview.target}?\n\n` +
            `${preview.changedCount} chapter${plural} will be marked for regeneration — ` +
            `their summaries no longer match the scenes they hold.\n\n` +
            `Chapters before the first change keep their summaries untouched. ` +
            `No prose, embeddings or timeline events are deleted.`
        );
        if (!ok) return;

        setIsRefitting(true);
        try {
            const result = await api.chapters.refit(activeCampaignId);
            if (!result?.ok) {
                toast.error('Refit failed');
                return;
            }
            await refreshChapters();
            toast.success(
                result.changed
                    ? `Chapters refitted — ${result.changedCount} need regenerating`
                    : 'Chapters were already even'
            );
        } catch (err) {
            console.error(err);
            toast.error('Refit failed');
        } finally {
            setIsRefitting(false);
        }
    }, [activeCampaignId, isRefitting, refreshChapters]);

    // Sealed chapters that do not hold exactly a full chapter's worth of scenes.
    // The open chapter is excluded — being under the cap is just it filling up.
    const driftCount = useMemo(
        () => chapters.filter(c => c.sealedAt && c.sceneCount !== CHAPTER_SCENE_SOFT_CAP).length,
        [chapters]
    );

    // WO-07: button visibility — only show when ≥1 sealed chapter lacks `synopsis`.
    const missingSynopsisCount = useMemo(
        () => chaptersNeedingSynopsis(chapters).length,
        [chapters]
    );

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-4 px-1">
                <div className="flex items-center space-x-2">
                    <BookOpen size={18} className="text-terminal" />
                    <h2 className="text-sm font-bold uppercase tracking-widest text-text-primary font-mono">Chapters</h2>
                    <span className="text-[12px] bg-void-dark px-1.5 py-0.5 rounded border border-border text-text-muted font-mono">
                        {chapters.length}
                    </span>
                    {pinnedChapterIds.length > 0 && (
                        <span className="text-[12px] font-bold uppercase text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded font-mono">
                            {pinnedChapterIds.length} PINNED
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-1.5">
                    {/* Always reachable, not just when drift is detected — the
                        answer "your chapters are already even" is one the user
                        should be able to ask for, and a button that only exists
                        when something is wrong cannot be found when it is. */}
                    <button
                        onClick={handleRefit}
                        disabled={isRefitting}
                        title={`Reflow chapters to ${CHAPTER_SCENE_SOFT_CAP} scenes each`}
                        className="flex items-center space-x-1 px-2 py-1 rounded bg-void-dark border border-border hover:border-ice hover:text-ice text-text-muted transition-colors text-[12px] font-bold uppercase disabled:opacity-50"
                    >
                        {isRefitting ? <Loader2 size={12} className="animate-spin" /> : <Scale size={12} />}
                        <span>Refit</span>
                    </button>
                    <button
                        onClick={handleNewChapter}
                        disabled={isCreating}
                        className="flex items-center space-x-1 px-2 py-1 rounded bg-terminal/10 border border-terminal/30 text-terminal hover:bg-terminal/20 transition-colors text-[12px] font-bold uppercase disabled:opacity-50"
                    >
                        {isCreating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        <span>New</span>
                    </button>
                </div>
            </div>

            {missingSynopsisCount > 0 && (
                <div className="mb-3 px-1">
                    <button
                        onClick={handleBackfillSynopses}
                        disabled={backfillProgress !== null}
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded bg-amber-400/10 border border-amber-400/30 text-amber-400 hover:bg-amber-400/20 transition-colors text-[12px] font-bold uppercase tracking-wider disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {backfillProgress !== null ? (
                            <>
                                <Loader2 size={12} className="animate-spin" />
                                <span>Generating synopses… {backfillProgress.done}/{backfillProgress.total}</span>
                            </>
                        ) : (
                            <>
                                <Sparkles size={12} />
                                <span>Generate missing synopses ({missingSynopsisCount})</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {driftCount > 0 && (
                <div className="mb-3 px-1">
                    <button
                        onClick={handleRefit}
                        disabled={isRefitting}
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded bg-ice/10 border border-ice/30 text-ice hover:bg-ice/20 transition-colors text-[12px] font-bold uppercase tracking-wider disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {isRefitting ? (
                            <>
                                <Loader2 size={12} className="animate-spin" />
                                <span>Refitting chapters…</span>
                            </>
                        ) : (
                            <>
                                <Scale size={12} />
                                <span>Refit to {CHAPTER_SCENE_SOFT_CAP} scenes ({driftCount} uneven)</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto pr-1 space-y-2 custom-scrollbar">
                <ResolvedStatePanel />

                {chapters.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 opacity-40">
                        <BookOpen size={48} strokeWidth={1} />
                        <p className="text-xs font-mono uppercase tracking-tighter">No chapters defined</p>
                    </div>
                ) : (
                    chapters.map((ch, idx) => {
                        const isNextAdjacent = idx < chapters.length - 1;
                        const nextChapter = chapters[idx + 1];

                        return (
                            <div key={ch.chapterId} className="relative">
                                {isRegenerating === ch.chapterId && (
                                    <div className="absolute inset-0 bg-void/60 z-10 flex items-center justify-center rounded-lg backdrop-blur-[1px]">
                                        <div className="flex items-center space-x-2 text-terminal font-mono text-[12px] uppercase font-bold">
                                            <Loader2 size={14} className="animate-spin" />
                                            <span>Processing...</span>
                                        </div>
                                    </div>
                                )}
                                <ChapterCard
                                    chapter={ch}
                                    expanded={expandedId === ch.chapterId}
                                    onToggle={() => setExpandedId(expandedId === ch.chapterId ? null : ch.chapterId)}
                                    onSeal={handleSeal}
                                    onRegenerate={() => regenerateChapter(ch, false)}
                                    onRename={(title) => handleRename(ch.chapterId, title)}
                                    onSplit={(sceneId) => handleSplit(ch.chapterId, sceneId)}
                                    isNextAdjacent={isNextAdjacent}
                                    onMergeWithNext={() => nextChapter && handleMerge(ch.chapterId, nextChapter.chapterId)}
                                    timelineEvents={timeline}
                                    onDeleteTimelineEvent={handleDeleteTimelineEvent}
                                    isPinned={pinnedChapterIds.includes(ch.chapterId)}
                                    onTogglePin={() => pinChapter(ch.chapterId)}
                                    onDelete={() => handleDeleteChapter(ch)}
                                />
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
