import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { BookOpen, Plus, Loader2, Sparkles, Scale, Search, X, Library } from '../icons/narrativeIcons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/llm/apiClient';
import { ChapterCard } from './ChapterCard';
import { BookCard } from './BookCard';
import { bookOf, unbookedSealed, BOOK_AUTO_CLOSE_CHAPTERS } from '../../services/archive-memory/bookEngine';
import { closeBookThrough, proposeBooksForExisting, buildBooks, regenerateBook, updateBook, removeLastBook } from '../../services/archive-memory/bookService';
import { ResolvedStatePanel } from './ResolvedStatePanel';
import { runCombinedSeal } from '../../services/turn/postTurnPipeline';
import { backfillChapterSynopses, chaptersNeedingSynopsis } from '../../services/archive-memory/synopsisBackfill';
import { backfillSceneTags, scenesNeedingAnalysis } from '../../services/archive-memory/sceneTagBackfill';
import { toast } from '../Toast';
import { ScreenSection } from '../primitives/ScreenSection';
import type { ArchiveChapter } from '../../types';
import { CHAPTER_SCENE_SOFT_CAP } from '../../types';

export const ChapterTab: React.FC = () => {
    const {
        chapters,
        setChapters,
        books,
        setBooks,
        activeCampaignId,
        getActiveSummarizerEndpoint,
        timeline,
        setTimeline,
        removeTimelineEvent,
        pinnedChapterIds,
        pinChapter,
        messages,
        archiveIndex,
        loreChunks,
        npcLedger,
    } = useAppStore(useShallow(s => ({
        chapters: s.chapters,
        setChapters: s.setChapters,
        books: s.books,
        setBooks: s.setBooks,
        activeCampaignId: s.activeCampaignId,
        getActiveSummarizerEndpoint: s.getActiveSummarizerEndpoint,
        timeline: s.timeline,
        setTimeline: s.setTimeline,
        removeTimelineEvent: s.removeTimelineEvent,
        pinnedChapterIds: s.pinnedChapterIds,
        pinChapter: s.pinChapter,
        messages: s.messages,
        archiveIndex: s.archiveIndex,
        loreChunks: s.loreChunks,
        npcLedger: s.npcLedger,
    })));
    
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
    const [tagProgress, setTagProgress] = useState<{ done: number; total: number } | null>(null);
    const tagAbortRef = useRef<AbortController | null>(null);
    // WO-screen-modernization §1 — sticky-header search. A live campaign
    // carries 24 chapters; an unfiltered list of that size needs a filter.
    const [query, setQuery] = useState('');
    // Book being written / bound (book id, chapter id, or 'build').
    const [bookBusy, setBookBusy] = useState<string | null>(null);
    const [buildProgress, setBuildProgress] = useState<{ done: number; total: number } | null>(null);

    const refreshChapters = useCallback(async () => {
        if (!activeCampaignId) return;
        const [fresh, freshTimeline] = await Promise.all([
            api.chapters.list(activeCampaignId),
            api.timeline.get(activeCampaignId),
        ]);
        setChapters(fresh);
        setTimeline(freshTimeline);
        // Books are checked against the chapters on read (merge, split, rollback).
        setBooks(await api.books.list(activeCampaignId, fresh));
    }, [activeCampaignId, setChapters, setTimeline, setBooks]);

    useEffect(() => {
        refreshChapters();
    }, [refreshChapters]);

    // WO-07: abort the in-flight backfill when ChapterTab unmounts (e.g. drawer closed).
    useEffect(() => {
        return () => {
            backfillAbortRef.current?.abort();
            backfillAbortRef.current = null;
            tagAbortRef.current?.abort();
            tagAbortRef.current = null;
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
            } else {
                // The server refuses to seal a chapter with no scenes yet.
                toast.warning('Nothing to seal yet — the open chapter has no scenes.');
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
                    sealTimeoutSeconds: state.settings.sealTimeoutSeconds,
                    divergenceRegister: state.divergenceRegister ?? { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
                    getDivergenceRegister: () => useAppStore.getState().divergenceRegister,
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

    // One model call per scene missing tags or a definition, so it only ever runs from the
    // button. A second click while running stops it; finished scenes keep their results.
    const handleBackfillTags = useCallback(async () => {
        if (tagAbortRef.current) {
            tagAbortRef.current.abort();
            return;
        }
        if (!activeCampaignId) return;
        const provider = getActiveSummarizerEndpoint();
        if (!provider || !provider.endpoint) {
            toast.error('No summarizer AI configured');
            return;
        }

        const ac = new AbortController();
        tagAbortRef.current = ac;
        setTagProgress({ done: 0, total: scenesNeedingAnalysis(archiveIndex).length });
        const isActive = () => useAppStore.getState().activeCampaignId === activeCampaignId;

        try {
            const result = await backfillSceneTags({
                index: archiveIndex,
                provider,
                fetchScenes: (sceneIds) => api.archive.fetchScenes(activeCampaignId, sceneIds),
                patch: (patches) => api.archive.patchEvents(activeCampaignId, patches),
                isActive,
                signal: ac.signal,
                onProgress: (done, total) => setTagProgress({ done, total }),
            });
            if (!isActive()) return;
            useAppStore.getState().setArchiveIndex(await api.archive.getIndex(activeCampaignId));
            const failures = result.failed > 0 ? ` ${result.failed} failed, run it again to retry.` : '';
            if (result.stoppedOnErrors) toast.error(`Scene analysis stopped: the summarizer AI failed ${result.failed} times in a row. Check that it is running. ${result.tagged} analyzed.`);
            else if (result.aborted) toast.warning(`Scene analysis stopped: ${result.tagged} analyzed.${failures}`);
            else if (result.failed > 0) toast.warning(`Analyzed ${result.tagged} scenes.${failures}`);
            else toast.success(`Analyzed ${result.tagged} scenes.`);
        } catch (err) {
            console.error(err);
            if (isActive()) toast.error('Scene analysis failed');
        } finally {
            if (tagAbortRef.current === ac) {
                tagAbortRef.current = null;
                setTagProgress(null);
            }
        }
    }, [activeCampaignId, archiveIndex, getActiveSummarizerEndpoint]);

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

    // ─── Books ───
    // Book summaries are written from chapter summaries: the summarizer slot.
    const bookProvider = useCallback(() => {
        const provider = getActiveSummarizerEndpoint();
        return provider?.endpoint ? provider : undefined;
    }, [getActiveSummarizerEndpoint]);

    const isStillActive = useCallback(
        (campaignId: string) => useAppStore.getState().activeCampaignId === campaignId,
        [],
    );

    const handleEndBook = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId || bookBusy) return;
        const loose = unbookedSealed(chapters, books);
        const count = loose.findIndex(c => c.chapterId === chapter.chapterId) + 1;
        if (count <= 0) return;
        const provider = bookProvider();
        const ok = window.confirm(
            `Bind ${count} chapter${count === 1 ? '' : 's'} (${loose[0].chapterId} – ${chapter.chapterId}) into a book?\n\n` +
            (provider
                ? 'The summarizer AI writes the book\'s summary from the chapter summaries (one call). '
                : 'No summarizer AI is configured, so the book gets a stand-in summary until you use Rewrite Summary. ') +
            'The GM\'s Older History recap then shows the book instead of each chapter.\n\n' +
            'The chapters are untouched, and you can unbind the book later from its card.'
        );
        if (!ok) return;
        const campaignId = activeCampaignId;
        setBookBusy(chapter.chapterId);
        try {
            const next = await closeBookThrough(campaignId, chapter.chapterId, provider);
            if (!isStillActive(campaignId)) return;
            if (next) {
                setBooks(next);
                const book = next[next.length - 1];
                if (book.summaryPending) toast.warning('Book bound, but the summary was not written. Use Rewrite Summary on the book.');
                else toast.success(`Book bound: ${book.title}`);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to bind book');
        } finally {
            setBookBusy(null);
        }
    }, [activeCampaignId, bookBusy, chapters, books, bookProvider, isStillActive, setBooks]);

    const handleBuildBooks = useCallback(async () => {
        if (!activeCampaignId || bookBusy) return;
        const campaignId = activeCampaignId;
        const provider = bookProvider();
        setBookBusy('build');
        try {
            const { candidates, breaks } = await proposeBooksForExisting(campaignId, provider);
            if (!isStillActive(campaignId)) return;
            if (breaks.length === 0) {
                toast.info('No book to bind yet: the current arc is still running');
                return;
            }
            const groups: string[] = [];
            let from = 0;
            for (const end of breaks) {
                const to = candidates.findIndex(c => c.chapterId === end);
                groups.push(`• ${candidates[from].chapterId}–${end} (${to - from + 1}): "${candidates[from].title}" → "${candidates[to].title}"`);
                from = to + 1;
            }
            const left = candidates.length - from;
            const ok = window.confirm(
                `Build ${breaks.length} book${breaks.length === 1 ? '' : 's'}?\n\n` +
                `${provider ? 'Suggested by the AI at story breaks' : 'No summarizer AI is configured, so these are fixed groups'} (max ${BOOK_AUTO_CLOSE_CHAPTERS} chapters each):\n\n` +
                `${groups.join('\n')}` +
                (left > 0 ? `\n\n${left} newer chapter${left === 1 ? '' : 's'} stay loose until the current arc ends.` : '') +
                `\n\n${provider ? `Each book gets an AI-written summary (${breaks.length} call${breaks.length === 1 ? '' : 's'}). ` : ''}` +
                'You can unbind the newest book later and bind by hand with "End Book Here".'
            );
            if (!ok) return;
            setBuildProgress({ done: 0, total: breaks.length });
            const next = await buildBooks(campaignId, breaks, provider,
                (done, total) => setBuildProgress({ done, total }),
                () => isStillActive(campaignId));
            if (!isStillActive(campaignId)) return;
            setBooks(next);
            const pending = next.filter(b => b.summaryPending).length;
            toast.success(`${breaks.length} book${breaks.length === 1 ? '' : 's'} built${pending > 0 ? ` · ${pending} without a summary (Rewrite Summary)` : ''}`);
        } catch (err) {
            console.error(err);
            toast.error('Failed to build books');
        } finally {
            setBookBusy(null);
            setBuildProgress(null);
        }
    }, [activeCampaignId, bookBusy, bookProvider, isStillActive, setBooks]);

    const handleRegenerateBook = useCallback(async (bookId: string) => {
        if (!activeCampaignId || bookBusy) return;
        const provider = bookProvider();
        if (!provider) { toast.error('No summarizer AI configured'); return; }
        const campaignId = activeCampaignId;
        setBookBusy(bookId);
        try {
            const next = await regenerateBook(campaignId, bookId, provider);
            if (!isStillActive(campaignId)) return;
            if (next) { setBooks(next); toast.success('Book summary rewritten'); }
            else toast.error('Book summary failed. Check the summarizer AI and try again.');
        } catch (err) {
            console.error(err);
            toast.error('Book summary failed');
        } finally {
            setBookBusy(null);
        }
    }, [activeCampaignId, bookBusy, bookProvider, isStillActive, setBooks]);

    const handleSetEra = useCallback(async (bookId: string, era: string) => {
        if (!activeCampaignId) return;
        try {
            setBooks(await updateBook(activeCampaignId, bookId, { era: era || undefined }));
        } catch (err) {
            console.error(err);
            toast.error('Failed to save era');
        }
    }, [activeCampaignId, setBooks]);

    const handleUnbindBook = useCallback(async () => {
        if (!activeCampaignId) return;
        if (!window.confirm('Unbind this book?\n\nIts chapters become loose again and the book summary is discarded. The chapters themselves are untouched.')) return;
        try {
            setBooks(await removeLastBook(activeCampaignId));
            toast.success('Book unbound');
        } catch (err) {
            console.error(err);
            toast.error('Failed to unbind book');
        }
    }, [activeCampaignId, setBooks]);

    // Chapters grouped under their book; chapters after the last book stay loose.
    const { bookGroups, looseChapters, endBookIds } = useMemo(() => ({
        bookGroups: books.map(book => ({ book, chapters: chapters.filter(c => bookOf(c, [book])) })),
        looseChapters: chapters.filter(c => !bookOf(c, books)),
        endBookIds: new Set(unbookedSealed(chapters, books).map(c => c.chapterId)),
    }), [books, chapters]);

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
    const untaggedSceneCount = useMemo(() => scenesNeedingAnalysis(archiveIndex).length, [archiveIndex]);
    const missingSynopsisCount = useMemo(
        () => chaptersNeedingSynopsis(chapters).length,
        [chapters]
    );

    // WO-screen-modernization §1 — search across the chapter title and
    // synopsis. Case-insensitive substring.
    const filteredChapters = useMemo(() => {
        if (!query.trim()) return chapters;
        const q = query.toLowerCase();
        return chapters.filter(c =>
            c.title.toLowerCase().includes(q)
            || (c.synopsis ?? '').toLowerCase().includes(q)
        );
    }, [chapters, query]);

    // `nextChapter` comes from the same list (a book's chapters, or the loose ones),
    // so Merge is never offered across a book boundary.
    const renderChapter = (ch: ArchiveChapter, nextChapter: ArchiveChapter | undefined) => (
        <div key={ch.chapterId} className="relative">
            {(isRegenerating === ch.chapterId || bookBusy === ch.chapterId) && (
                <div className="absolute inset-0 bg-void/60 z-10 flex items-center justify-center rounded-lg backdrop-blur-[1px]">
                    <div className="flex items-center space-x-2 text-terminal font-mono text-[12px] uppercase font-bold">
                        <Loader2 size={14} className="animate-spin" />
                        <span>{bookBusy === ch.chapterId ? 'Binding book...' : 'Processing...'}</span>
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
                isNextAdjacent={nextChapter !== undefined}
                onMergeWithNext={() => nextChapter && handleMerge(ch.chapterId, nextChapter.chapterId)}
                timelineEvents={timeline}
                onDeleteTimelineEvent={handleDeleteTimelineEvent}
                isPinned={pinnedChapterIds.includes(ch.chapterId)}
                onTogglePin={() => pinChapter(ch.chapterId)}
                onDelete={() => handleDeleteChapter(ch)}
                onEndBook={endBookIds.has(ch.chapterId) && !bookBusy ? () => handleEndBook(ch) : undefined}
            />
        </div>
    );

    return (
        // Shape B — Collection. Width comes from the lightbox (`wide`); the
        // layout here is a sticky-header search + a responsive card grid that
        // tiles 1 / 2 / 3 columns at md / xl / 2xl. Count badge matches the
        // nav drawer's badge.
        //
        // WO-screen-modernization §0-B — root is a flex CHILD of the lightbox's
        // continuous flex chain, not a percentage-height element (`h-full`
        // against the wrapper's auto height was a no-op). `flex-1 min-h-0 flex
        // flex-col` is what gives the sticky header + grid a real height.
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
            <div className="sticky top-0 z-10 bg-surface -mx-4 sm:-mx-6 px-4 sm:px-6 pt-1 pb-3 space-y-2">
                <ScreenSection
                    icon={BookOpen}
                    label="Chapters"
                    count={chapters.length}
                    rightSlot={
                        <>
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
                        </>
                    }
                />
                {(pinnedChapterIds.length > 0 || books.length > 0) && (
                    <div className="flex items-center gap-2">
                        {books.length > 0 && (
                            <div className="text-[12px] font-bold uppercase text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded font-mono w-fit">
                                {books.length} BOOK{books.length === 1 ? '' : 'S'}
                            </div>
                        )}
                        {pinnedChapterIds.length > 0 && (
                            <div className="text-[12px] font-bold uppercase text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded font-mono w-fit">
                                {pinnedChapterIds.length} PINNED
                            </div>
                        )}
                    </div>
                )}
                {chapters.length > 0 && (
                    <div className="relative">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Filter by title or synopsis..."
                            className="w-full pl-8 pr-8 py-1.5 bg-void border border-border rounded text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors"
                        />
                        {query && (
                            <button
                                onClick={() => setQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary transition-colors"
                                aria-label="Clear filter"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {missingSynopsisCount > 0 && (
                <div className="-mx-4 sm:-mx-6 px-4 sm:mx-0 sm:px-0">
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

            {(tagProgress !== null || untaggedSceneCount > 0) && (
                <div className="-mx-4 sm:-mx-6 px-4 sm:mx-0 sm:px-0">
                    <button
                        onClick={handleBackfillTags}
                        title="Uses one AI call per scene"
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded bg-amber-400/10 border border-amber-400/30 text-amber-400 hover:bg-amber-400/20 transition-colors text-[12px] font-bold uppercase tracking-wider"
                    >
                        {tagProgress !== null ? (
                            <>
                                <Loader2 size={12} className="animate-spin" />
                                <span>Analyzing scenes… {tagProgress.done}/{tagProgress.total} (click to stop)</span>
                            </>
                        ) : (
                            <>
                                <Sparkles size={12} />
                                <span>Tag and define scenes ({untaggedSceneCount} AI calls)</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {driftCount > 0 && (
                <div className="-mx-4 sm:-mx-6 px-4 sm:mx-0 sm:px-0">
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

            {/* A backlog of loose sealed chapters: campaigns from before books, or ones
                that ran with auto-seal off. New play binds a book every
                BOOK_AUTO_CLOSE_CHAPTERS chapters by itself. */}
            {(buildProgress !== null || endBookIds.size >= BOOK_AUTO_CLOSE_CHAPTERS) && (
                <div className="-mx-4 sm:-mx-6 px-4 sm:mx-0 sm:px-0">
                    <button
                        onClick={handleBuildBooks}
                        disabled={bookBusy !== null}
                        title="Group loose sealed chapters into books at story breaks (the AI suggests, you confirm)"
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded bg-amber-400/10 border border-amber-400/30 text-amber-400 hover:bg-amber-400/20 transition-colors text-[12px] font-bold uppercase tracking-wider disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {bookBusy === 'build' ? (
                            <>
                                <Loader2 size={12} className="animate-spin" />
                                <span>{buildProgress ? `Writing book ${buildProgress.done + 1}/${buildProgress.total}…` : 'Finding story breaks…'}</span>
                            </>
                        ) : (
                            <>
                                <Library size={12} />
                                <span>Build books ({endBookIds.size} loose chapters)</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto pr-1">
                <ResolvedStatePanel />

                {chapters.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 opacity-40">
                        <BookOpen size={48} strokeWidth={1} />
                        <p className="text-xs font-mono uppercase tracking-tighter">No chapters defined</p>
                        <p className="text-[11px] text-text-dim/60 max-w-[300px] leading-relaxed normal-case tracking-normal">
                            Use the New button above to start the first chapter.
                        </p>
                    </div>
                ) : filteredChapters.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center space-y-2 opacity-60">
                        <Search size={32} strokeWidth={1} />
                        <p className="text-xs font-mono uppercase tracking-tighter">No chapters match "{query}".</p>
                    </div>
                ) : query.trim() ? (
                    // Filtering: one flat list, as before books.
                    <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                        {filteredChapters.map((ch, idx) => renderChapter(ch, filteredChapters[idx + 1]))}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {bookGroups.map(({ book, chapters: inBook }, i) => (
                            <BookCard
                                key={book.bookId}
                                book={book}
                                chapterCount={inBook.length}
                                isLast={i === bookGroups.length - 1}
                                busy={bookBusy === book.bookId}
                                onSetEra={(era) => handleSetEra(book.bookId, era)}
                                onRegenerate={() => handleRegenerateBook(book.bookId)}
                                onUnbind={handleUnbindBook}
                            >
                                {inBook.map((ch, idx) => renderChapter(ch, inBook[idx + 1]))}
                            </BookCard>
                        ))}
                        {looseChapters.length > 0 && (
                            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                                {looseChapters.map((ch, idx) => renderChapter(ch, looseChapters[idx + 1]))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
