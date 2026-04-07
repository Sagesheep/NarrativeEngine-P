import React, { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import { ChapterCard } from './ChapterCard';
import { generateChapterSummary } from '../../services/saveFileEngine';
import { toast } from '../Toast';
import type { ArchiveChapter } from '../../types';

export const ChapterTab: React.FC = () => {
    const { 
        chapters, setChapters, activeCampaignId, 
        context, getActiveSummarizerEndpoint 
    } = useAppStore();
    
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [isRegenerating, setIsRegenerating] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    const refreshChapters = useCallback(async () => {
        if (!activeCampaignId) return;
        const fresh = await api.chapters.list(activeCampaignId);
        setChapters(fresh);
    }, [activeCampaignId, setChapters]);

    useEffect(() => {
        refreshChapters();
    }, [refreshChapters]);

    const handleSeal = useCallback(async () => {
        if (!activeCampaignId) return;
        setIsCreating(true);
        try {
            const result = await api.chapters.seal(activeCampaignId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter sealed');
                // Trigger summary generation for the sealed chapter
                generateSummaryAsync(result.sealedChapter);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to seal chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const generateSummaryAsync = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId) return;
        
        setIsRegenerating(chapter.chapterId);
        try {
            const provider = getActiveSummarizerEndpoint();
            if (!provider || !provider.endpoint) {
                toast.error('No summarizer AI configured');
                return;
            }

            // 1. Fetch scenes for this chapter
            const startNum = parseInt(chapter.sceneRange[0], 10);
            const endNum = parseInt(chapter.sceneRange[1], 10);
            const sceneIds = [];
            for (let i = startNum; i <= endNum; i++) {
                sceneIds.push(String(i).padStart(3, '0'));
            }

            const scenes = await api.archive.fetchScenes(activeCampaignId, sceneIds);
            
            // 2. Generate summary via LLM
            const summaryPatch = await generateChapterSummary(
                provider, 
                chapter, 
                scenes, 
                context.headerIndex
            );
            
            if (!summaryPatch) {
                throw new Error('Summary generation returned null');
            }

            // 3. Persist to server
            await api.chapters.update(activeCampaignId, chapter.chapterId, {
                ...summaryPatch,
                invalidated: false,
            });

            await refreshChapters();
            toast.success(`Summary generated for ${chapter.title}`);
        } catch (err) {
            console.error(err);
            toast.error(`Failed to generate summary for ${chapter.title}`);
        } finally {
            setIsRegenerating(prev => prev === chapter.chapterId ? null : prev);
        }
    }, [activeCampaignId, refreshChapters, context.headerIndex, getActiveSummarizerEndpoint]);

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
                // Auto-trigger repair since it's now invalidated
                generateSummaryAsync(merged);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to merge chapters');
        }
    }, [activeCampaignId, refreshChapters, generateSummaryAsync]);

    const handleSplit = useCallback(async (chapterId: string, atSceneId: string) => {
        if (!activeCampaignId) return;
        try {
            const result = await api.chapters.split(activeCampaignId, chapterId, atSceneId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter split');
                // Trigger repair for both new halves
                generateSummaryAsync(result.chapterA);
                generateSummaryAsync(result.chapterB);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to split chapter');
        }
    }, [activeCampaignId, refreshChapters, generateSummaryAsync]);

    const handleNewChapter = useCallback(async () => {
        if (!activeCampaignId) return;
        setIsCreating(true);
        try {
            await api.chapters.create(activeCampaignId);
            await refreshChapters();
            toast.success('New chapter created');
        } catch (err) {
            toast.error('Failed to create chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-4 px-1">
                <div className="flex items-center space-x-2">
                    <BookOpen size={18} className="text-terminal" />
                    <h2 className="text-sm font-bold uppercase tracking-widest text-text-primary font-mono">Chapters</h2>
                    <span className="text-[10px] bg-void-dark px-1.5 py-0.5 rounded border border-border text-text-muted font-mono">
                        {chapters.length}
                    </span>
                </div>
                <button 
                    onClick={handleNewChapter}
                    disabled={isCreating}
                    className="flex items-center space-x-1 px-2 py-1 rounded bg-terminal/10 border border-terminal/30 text-terminal hover:bg-terminal/20 transition-colors text-[10px] font-bold uppercase disabled:opacity-50"
                >
                    {isCreating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    <span>New</span>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1 space-y-2 custom-scrollbar">
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
                                        <div className="flex items-center space-x-2 text-terminal font-mono text-[10px] uppercase font-bold">
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
                                    onRegenerate={() => generateSummaryAsync(ch)}
                                    onRename={(title) => handleRename(ch.chapterId, title)}
                                    onSplit={(sceneId) => handleSplit(ch.chapterId, sceneId)}
                                    isNextAdjacent={isNextAdjacent}
                                    onMergeWithNext={() => nextChapter && handleMerge(ch.chapterId, nextChapter.chapterId)}
                                />
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
