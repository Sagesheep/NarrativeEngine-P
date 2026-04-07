import { useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Send, Save, Loader2, Zap, Scroll, Edit2, RotateCcw, Trash2, Check, X, Square, FileText, ChevronDown, ChevronUp, RotateCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../store/useAppStore';
import type { ChatMessage, EndpointConfig, ProviderConfig, ArchiveChapter } from '../types';
import { condenseHistory } from '../services/condenser';
import { runSaveFilePipeline, generateChapterSummary } from '../services/saveFileEngine';
import { runTurn } from '../services/turnOrchestrator';
import { api } from '../services/apiClient';
import { set } from 'idb-keyval';
import { toast } from './Toast';
import { shouldAutoSeal } from '../services/archiveChapterEngine';


export function ChatArea() {
    // Split store subscriptions so streaming token updates only re-render the message list,
    // not the entire ChatArea. Stable/rarely-changing data is grouped with useShallow.
    const messages = useAppStore(s => s.messages);
    const condenser = useAppStore(s => s.condenser);
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);

    const { settings, loreChunks, npcLedger, archiveIndex, chapters } = useAppStore(
        useShallow(s => ({
            settings: s.settings,
            loreChunks: s.loreChunks,
            npcLedger: s.npcLedger,
            archiveIndex: s.archiveIndex,
            chapters: s.chapters,
        }))
    );

    const {
        setArchiveIndex, clearArchive, updateLastAssistant, updateContext,
        setCondensed, setCondensing, deleteMessage, deleteMessagesFrom,
        resetCondenser, setSemanticFacts, setChapters,
    } = useAppStore(
        useShallow(s => ({
            setArchiveIndex: s.setArchiveIndex,
            clearArchive: s.clearArchive,
            updateLastAssistant: s.updateLastAssistant,
            updateContext: s.updateContext,
            setCondensed: s.setCondensed,
            setCondensing: s.setCondensing,
            deleteMessage: s.deleteMessage,
            deleteMessagesFrom: s.deleteMessagesFrom,
            resetCondenser: s.resetCondenser,
            setSemanticFacts: s.setSemanticFacts,
            setChapters: s.setChapters,
        }))
    );

    const [input, setInput] = useState('');
    const [isStreaming, setStreaming] = useState(false); // Moved from store to local state
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    const [visibleCount, setVisibleCount] = useState(10);
    const [loadStep, setLoadStep] = useState(10);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [showCondensed, setShowCondensed] = useState(false);
    const [isEditingCondensed, setIsEditingCondensed] = useState(false);
    const [condensedDraft, setCondensedDraft] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const condenseAbortRef = useRef<AbortController | null>(null);

    // Auto-scroll only when a NEW message appears, not on every streaming token update.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // dropdownRef kept for future dropdown dismiss logic

    const triggerCondense = async () => {
        if (condenser.isCondensing) {
            if (condenseAbortRef.current) {
                condenseAbortRef.current.abort();
                condenseAbortRef.current = null;
            }
            setCondensing(false);
            toast.info('Condense cancelled');
            return;
        }
        condenseAbortRef.current = new AbortController();
        setCondensing(true);
        try {
            const provider = useAppStore.getState().getActiveStoryEndpoint();
            if (!provider) return;
            const currentCtx = useAppStore.getState().context;
            const uncondensed = messages.slice(condenser.condensedUpToIndex + 1);
            const saveResult = await runSaveFilePipeline(provider as EndpointConfig | ProviderConfig, uncondensed, currentCtx);

            if (saveResult.canonSuccess) {
                updateContext({ canonState: saveResult.canonState });
            } else {
                toast.warning('Canon state update failed — using previous state');
            }
            if (saveResult.indexSuccess) {
                updateContext({ headerIndex: saveResult.headerIndex });
            } else {
                toast.warning('Header index update failed — using previous index');
            }

            console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);

            const freshCtx = useAppStore.getState().context;
            const npcLedger = useAppStore.getState().npcLedger;
            const campaignId = useAppStore.getState().activeCampaignId || '';
            const result = await condenseHistory(
                provider,
                messages,
                freshCtx,
                condenser.condensedUpToIndex,
                condenser.condensedSummary,
                campaignId,
                npcLedger.map(n => n.name),
                settings.contextLimit,
                condenseAbortRef.current.signal
            );
            setCondensed(result.summary, result.upToIndex);

            if (campaignId) {
                const fresh = await api.archive.getIndex(campaignId);
                setArchiveIndex(fresh);
                console.log(`[Archive] Reloaded index: ${fresh.length} entries`);
                const freshFacts = await api.facts.get(campaignId);
                setSemanticFacts(freshFacts);
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
            setCondensing(false);
            condenseAbortRef.current = null;
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setStreaming(false);
        setIsCheckingNotes(false);
        setLoadingStatus(null);
    };

    const resetTextareaHeight = () => {
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
        }
    };

    const handleSend = async (overrideText?: string) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        abortControllerRef.current = new AbortController();

        // Capture a single getState() snapshot for all stable values needed at turn start.
        // Getters that need freshness mid-turn (messages, provider) remain as live accessors.
        const storeSnapshot = useAppStore.getState();

        await runTurn({
            input: textToUse,
            displayInput: textToUse,
            settings,
            context,
            messages: storeSnapshot.messages,
            condenser: storeSnapshot.condenser,
            loreChunks,
            npcLedger,
            archiveIndex,
            activeCampaignId,
            provider: storeSnapshot.getActiveStoryEndpoint(),
            getMessages: () => useAppStore.getState().messages,
            getFreshProvider: () => useAppStore.getState().getActiveStoryEndpoint(),
            getUtilityEndpoint: () => useAppStore.getState().getActiveUtilityEndpoint()
        }, {
            onCheckingNotes: setIsCheckingNotes,
            addMessage: storeSnapshot.addMessage,
            updateLastAssistant: updateLastAssistant,
            updateLastMessage: storeSnapshot.updateLastMessage,
            updateContext: updateContext,
            setArchiveIndex: setArchiveIndex,
            setSemanticFacts: setSemanticFacts,
            updateNPC: storeSnapshot.updateNPC,
            addNPC: storeSnapshot.addNPC,
            setCondensed: setCondensed,
            setCondensing: setCondensing,
            setStreaming: setStreaming,
            setLoadingStatus: setLoadingStatus,
            setLastPayloadTrace: storeSnapshot.setLastPayloadTrace
        }, abortControllerRef.current);

        // ─── PHASE 2: Auto-Seal Check (post-turn) ───
        if (activeCampaignId) {
            // Fire-and-forget auto-seal check
            checkAndSealChapter(activeCampaignId);
        }
    };

    /**
     * Generate chapter summary asynchronously and update the chapter.
     * Fire-and-forget: failures are logged but don't block.
     * IMPORTANT: All state must be captured at call site to prevent stale closure.
     */
    const generateChapterSummaryAsync = async (
        campaignId: string,
        chapter: ArchiveChapter,
        headerIndex: string,  // Captured at call site - prevents stale closure
        provider: EndpointConfig | ProviderConfig | undefined  // Captured at call site
    ) => {
        try {
            if (!provider) {
                console.warn('[ChapterSummary] No provider available');
                return;
            }

            // Get scenes in chapter range
            const sceneIds: string[] = [];
            const startNum = parseInt(chapter.sceneRange[0], 10);
            const endNum = parseInt(chapter.sceneRange[1], 10);
            for (let i = startNum; i <= endNum; i++) {
                sceneIds.push(String(i).padStart(3, '0'));
            }

            // Fetch scene content from server using apiClient
            const scenes = await api.archive.fetchScenes(campaignId, sceneIds);

            // Generate summary using captured headerIndex (not from closure)
            const summaryResult = await generateChapterSummary(
                provider as EndpointConfig | ProviderConfig,
                chapter,
                scenes,
                headerIndex
            );

            if (summaryResult) {
                // Update chapter with summary
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

                // Refresh chapters
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
    };

    /**
     * Check if chapter should be auto-sealed and trigger seal if needed.
     * Fire-and-forget: runs async without blocking the main flow.
     */
    const checkAndSealChapter = async (campaignId: string) => {
        try {
            const autoSealResult = shouldAutoSeal(chapters, context.headerIndex);
            if (autoSealResult.shouldSeal) {
                console.log(`[AutoSeal] Triggering seal: ${autoSealResult.reason}`);
                await handleSealChapter(campaignId, undefined, autoSealResult.reason);
            }
        } catch (err) {
            console.warn('[AutoSeal] Check failed:', err);
        }
    };

    /**
     * Seal the current open chapter and generate summary.
     * @param campaignId - The campaign ID
     * @param title - Optional custom title for the chapter
     * @param reason - Reason for sealing (auto-seal reason or 'manual')
     */
    const handleSealChapter = async (campaignId: string, title?: string, reason: string = 'manual') => {
        try {
            // Show confirmation for manual seals
            if (reason === 'manual') {
                const customTitle = window.prompt(
                    'Seal current chapter?\n\nThis will:\n- Finalize the current chapter\n- Create a new open chapter\n- Generate a summary automatically\n\nEnter an optional title (or leave blank for auto-generated):'
                );
                if (customTitle === null) return; // User cancelled
                title = customTitle || undefined;
            }

            // Call server to seal
            const result = await api.chapters.seal(campaignId, title);
            if (!result) {
                toast.error('Failed to seal chapter');
                return;
            }

            console.log(`[SealChapter] Sealed ${result.sealedChapter.chapterId}, created ${result.newOpenChapter.chapterId}`);
            toast.success(`Chapter sealed: ${result.sealedChapter.chapterId}`);

            // Refresh chapters from server
            const freshChapters = await api.chapters.list(campaignId);
            setChapters(freshChapters);

            // Fire-and-forget summary generation
            // Capture state before async gap to prevent stale closure
            const capturedHeaderIndex = context.headerIndex;
            const capturedProvider = useAppStore.getState().getActiveSummarizerEndpoint?.() 
                ?? useAppStore.getState().getActiveStoryEndpoint();
            generateChapterSummaryAsync(campaignId, result.sealedChapter, capturedHeaderIndex, capturedProvider);
        } catch (err) {
            console.error('[SealChapter] Failed:', err);
            toast.error('Failed to seal chapter');
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editingMessageId) {
                handleEditSubmit();
            } else {
                handleSend();
            }
        }
    };

    const [isSaving, setIsSaving] = useState(false);

    const handleForceSave = () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                set(`nn_settings`, { settings: state.settings, activeCampaignId: state.activeCampaignId });
                set(`nn_campaign_${state.activeCampaignId}_state`, { context: state.context, messages: state.messages, condenser: state.condenser });
                set(`nn_campaign_${state.activeCampaignId}_npcs`, state.npcLedger);
            } catch (e) {
                console.error("[Save] Failed to force save to IndexedDB:", e);
                toast.error('Force save failed');
            }
        }
        toast.success('Campaign saved');
        setTimeout(() => setIsSaving(false), 2000);
    };

    // ─── Archive helpers ───
    /**
     * Find the earliest archive scene that corresponds to messages at or after
     * `fromTimestamp`, then delete all scenes from that point forward.
     */
    const rollbackArchiveFrom = async (fromTimestamp: number) => {
        const campaignId = useAppStore.getState().activeCampaignId;
        if (!campaignId) return;
        const currentIndex = useAppStore.getState().archiveIndex;
        const currentChapters = useAppStore.getState().chapters;
        if (!currentIndex.length) return;

        // Find the first scene whose timestamp >= fromTimestamp
        const sorted = [...currentIndex].sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));
        const target = sorted.find(e => e.timestamp >= fromTimestamp);
        if (!target) return;

        fetch('/api/campaigns/' + campaignId + '/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'pre-rollback', isAuto: true }),
        }).catch(() => {});

        try {
            await api.archive.deleteFrom(campaignId, target.sceneId);
            
            // Refresh all dependent state
            const [freshIndex, freshFacts, freshChapters] = await Promise.all([
                api.archive.getIndex(campaignId),
                api.facts.get(campaignId),
                api.chapters.list(campaignId)
            ]);
            
            setArchiveIndex(freshIndex);
            setSemanticFacts(freshFacts);
            
            // Check if chapters were affected (count or scene ranges changed)
            const chaptersChanged = freshChapters.length !== currentChapters.length ||
                freshChapters.some((c, i) => c.sceneRange[0] !== currentChapters[i]?.sceneRange[0]);
            
            if (chaptersChanged) {
                setChapters(freshChapters);
                console.log('[Archive] Chapters repaired during rollback');
            }
            
            // Reset condenser (always safe after rollback)
            useAppStore.getState().setCondenser({
                condensedSummary: '',
                condensedUpToIndex: -1,
                isCondensing: false,
            });
            
            console.log(`[Archive] Rolled back from scene #${target.sceneId}`);
        } catch (err) {
            console.warn('[Archive] Rollback failed:', err);
            toast.warning('Archive rollback failed');
        }
    };

    const openArchive = async () => {
        if (!activeCampaignId) return;
        await api.archive.open(activeCampaignId);
    };

    const handleClearArchive = async () => {
        if (!activeCampaignId || !window.confirm('Are you sure you want to PERMANENTLY delete the entire archive? This cannot be undone.')) return;
        await fetch('/api/campaigns/' + activeCampaignId + '/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'pre-clear-archive', isAuto: true }),
        }).catch(() => {});
        try {
            await api.archive.clear(activeCampaignId);
            clearArchive();
            
            // Clear chapters and reset condenser
            setChapters([]);
            useAppStore.getState().setCondenser({
                condensedSummary: '',
                condensedUpToIndex: -1,
                isCondensing: false,
            });
            
            console.log('[Archive] Cleared successfully');
        } catch (err) {
            console.warn('[Archive] Failed to clear:', err);
            toast.error('Failed to clear archive');
        }
    };

    // ─── Edit & Regenerate logic ───
    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        setInput(msg.displayContent || msg.content);
        inputRef.current?.focus();
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            // Rollback archive to before this message's timestamp
            rollbackArchiveFrom(msg.timestamp);
            useAppStore.getState().deleteMessagesFrom(msg.id);
            const textToResend = input.trim();
            setInput('');
            resetTextareaHeight();
            setEditingMessageId(null);
            setTimeout(() => {
                handleSend(textToResend);
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, input.trim());
            setInput('');
            resetTextareaHeight();
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = useAppStore.getState().messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            // Rollback archive: the scene for lastUser's exchange gets removed
            rollbackArchiveFrom(lastUser.timestamp);
            deleteMessagesFrom(lastUser.id);
            setTimeout(() => {
                handleSend(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };


    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
            {/* Active Scene Note Banner */}
            {context.sceneNoteActive && (
                <div className="absolute top-0 left-0 right-0 z-20 px-4 py-1.5 bg-amber/90 backdrop-blur-sm border-b border-amber/40 flex items-center justify-between text-[10px] text-void-dark font-bold uppercase tracking-widest animate-in slide-in-from-top duration-300">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-void-dark animate-pulse" />
                        Active Scene Note: {context.sceneNote.slice(0, 50)}{context.sceneNote.length > 50 ? '...' : ''}
                    </div>
                    <button
                        onClick={() => updateContext({ sceneNoteActive: false })}
                        className="hover:opacity-60 transition-opacity"
                        title="Dismiss banner (note remains active in context settings)"
                    >
                        <X size={12} strokeWidth={3} />
                    </button>
                </div>
            )}

            {/* Transcript */}
            <div className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3">
                {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-3">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
                            <p className="text-text-dim/50 text-[11px]">
                                Paste your lore in the context drawer, configure your LLM, and begin.
                            </p>
                        </div>
                    </div>
                )}

                {/* Reverse Pagination: Load Older Messages Button */}
                {messages.length > visibleCount && (
                    <div className="flex justify-center py-2">
                        <button
                            onClick={() => setVisibleCount(prev => {
                                const next = prev + loadStep;
                                setLoadStep(s => s + 20);
                                return next;
                            })}
                            className="text-xs text-terminal/70 hover:text-terminal bg-terminal/10 hover:bg-terminal/20 px-4 py-2 rounded transition-colors"
                        >
                            ↑ Load older messages... ({messages.length - visibleCount} hidden)
                        </button>
                    </div>
                )}

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg) => {
                    let markdownContent: string = typeof msg.displayContent === 'string'
                        ? msg.displayContent
                        : (typeof msg.content === 'string' ? msg.content : '');

                    // Extract thinking block if present
                    let thinkingBlock = '';
                    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
                    if (thinkMatch) {
                        thinkingBlock = thinkMatch[1].trim();
                        // Strip reasoning from main content if hidden, or just to handle it separately
                        if (settings.showReasoning === false) {
                            markdownContent = markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                        } else {
                            // Even if shown, we might want to pull it out of the main markdown flow to style it
                            markdownContent = markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                        }
                    }

                    const parsedArgs = (msg as any).parsedArgs;
                    const hasSummary = msg.role === 'tool' && parsedArgs && Array.isArray(parsedArgs.summary);
                    const hasDebug = settings.debugMode === true && !!msg.debugPayload;

                    return (
                        <div
                            key={msg.id}
                            className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div
                                className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${msg.role === 'user'
                                    ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                                    : msg.role === 'system'
                                        ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                                        : 'bg-void-lighter border-l-2 border-border text-text-primary'
                                    }`}
                            >
                                {/* Action Bar */}
                                <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                                    {msg.role !== 'system' && (
                                        <button title="Edit" onClick={() => startEditing(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <Edit2 size={10} />
                                        </button>
                                    )}
                                    {msg.role === 'assistant' && (
                                        <button title="Regenerate" onClick={() => handleRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <RotateCcw size={10} />
                                        </button>
                                    )}
                                    <button title="Delete" onClick={() => deleteMessage(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
                                        <Trash2 size={10} />
                                    </button>
                                </div>

                                <div className="flex items-center gap-2 mb-1">
                                    <span
                                        className={`text-[10px] uppercase tracking-widest ${msg.role === 'user'
                                            ? 'text-terminal'
                                            : msg.role === 'system'
                                                ? 'text-ember'
                                                : 'text-ice'
                                            }`}
                                    >
                                        {msg.role === 'user' ? '► YOU' : msg.role === 'tool' ? '◈ TOOL' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                                    </span>
                                    {msg.role === 'tool' && msg.name && (
                                        <span className="text-[9px] text-terminal font-bold tracking-wider opacity-80">
                                            [{msg.name}]
                                        </span>
                                    )}
                                    <span className="text-[9px] text-text-dim">
                                        {new Date(msg.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>

                                <div className="gm-prose">
                                    {thinkingBlock && settings.showReasoning && (
                                        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
                                            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                                <Loader2 size={10} className={isStreaming && msg.id === messages[messages.length - 1].id ? "animate-spin" : ""} />
                                                Cognitive Process
                                            </summary>
                                            <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 max-h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                                                {thinkingBlock}
                                            </div>
                                        </details>
                                    )}
                                    <ReactMarkdown>{markdownContent}</ReactMarkdown>
                                    {hasSummary && (
                                        <div className="mt-2 pl-3 border-l-2 border-terminal/30 text-[10px] text-text-dim">
                                            <div className="uppercase tracking-widest text-terminal/60 mb-1">Generated Output:</div>
                                            <ul className="list-disc leading-tight space-y-1">
                                                {(parsedArgs.summary as any[]).map((s: any, i: number) => (
                                                    <li key={i}>{typeof s === 'string' ? s : String(s)}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>

                                {hasDebug && (
                                    <details className="mt-2 border-t border-border/50 pt-2 text-[10px]">
                                        <summary className="cursor-pointer text-terminal/60 hover:text-terminal transition-colors select-none">
                                            [View Raw Payload]
                                        </summary>
                                        <pre className="mt-2 bg-void p-2 overflow-x-auto text-text-dim text-[9px] font-mono leading-tight whitespace-pre-wrap break-all">
                                            {JSON.stringify(msg.debugPayload, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        </div>
                    );
                })}

                <div aria-live="polite" aria-atomic="true">
                    {loadingStatus ? (
                        <div className="flex items-center gap-2 text-terminal text-xs px-4">
                            <Loader2 size={12} className="animate-spin" />
                            <span className="animate-pulse-slow">{loadingStatus}</span>
                        </div>
                    ) : isCheckingNotes ? (
                        <div className="flex items-center gap-2 text-terminal/80 text-xs px-4">
                            <Loader2 size={12} className="animate-spin" />
                            <span className="animate-pulse-slow">The GM is checking their notes...</span>
                        </div>
                    ) : isStreaming ? (
                        <div className="flex items-center gap-2 text-terminal text-xs px-4">
                            <Loader2 size={12} className="animate-spin" />
                            <span className="animate-pulse-slow">Generating...</span>
                        </div>
                    ) : null}
                </div>

                <div ref={bottomRef} />
            </div>

            {/* Macro Bar */}
            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto">
                <button
                    onClick={handleForceSave}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={!condenser.isCondensing && messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    {condenser.isCondensing ? <Square size={13} /> : <Zap size={13} />}
                    {condenser.isCondensing ? 'Stop' : 'Condense'}
                </button>
                <button
                    onClick={openArchive}
                    disabled={!activeCampaignId}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
                >
                    <Scroll size={13} />
                    Archive
                </button>
                <button
                    onClick={() => activeCampaignId && handleSealChapter(activeCampaignId)}
                    disabled={!activeCampaignId || !chapters.find(c => !c.sealedAt)}
                    className="flex items-center gap-1.5 bg-void border border-amber-500/30 hover:border-amber-500 text-amber-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-amber-500/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Manually seal current chapter"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    Seal
                </button>
                <button
                    onClick={handleClearArchive}
                    disabled={!activeCampaignId || archiveIndex.length === 0}
                    className="flex items-center gap-1.5 bg-void border border-danger/30 hover:border-danger text-danger text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-danger/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <Trash2 size={13} />
                    Clear Archive
                </button>
                {condenser.condensedSummary && (
                    <button
                        onClick={() => setShowCondensed(prev => !prev)}
                        className="flex items-center gap-1.5 bg-void border border-amber-500/30 hover:border-amber-500 text-amber-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-amber-500/5"
                        title="View / Edit condensed summary"
                    >
                        <FileText size={13} />
                        Memory
                        {showCondensed ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </button>
                )}
            </div>

            {/* Condensed Summary Panel — Expandable & Editable */}
            {showCondensed && condenser.condensedSummary && (
                <div className="mx-2 md:mx-4 mb-1 border border-amber-500/30 bg-amber-500/5 rounded-sm overflow-hidden animate-[msg-in_0.15s_ease-out]">
                    <div className="flex items-center justify-between px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
                        <div className="flex items-center gap-2">
                            <FileText size={12} className="text-amber-500" />
                            <span className="text-[10px] text-amber-500 uppercase tracking-widest font-bold">Condensed Memory</span>
                            <span className="text-[9px] text-text-dim">(up to msg #{condenser.condensedUpToIndex})</span>
                        </div>
                        <div className="flex items-center gap-1">
                            {!isEditingCondensed ? (
                                <>
                                    <button
                                        onClick={() => {
                                            setCondensedDraft(condenser.condensedSummary);
                                            setIsEditingCondensed(true);
                                        }}
                                        className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                        title="Edit summary (retcon)"
                                    >
                                        <Edit2 size={11} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (window.confirm('Reset condensed memory? This will clear the summary and re-include all messages in context. Cannot be undone.')) {
                                                resetCondenser();
                                                setShowCondensed(false);
                                                toast.info('Condensed memory cleared — full history restored to context');
                                            }
                                        }}
                                        className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                        title="Reset condensed memory entirely"
                                    >
                                        <RotateCw size={11} />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        onClick={() => {
                                            setCondensed(condensedDraft, condenser.condensedUpToIndex);
                                            setIsEditingCondensed(false);
                                            toast.success('Condensed memory updated');
                                        }}
                                        className="text-text-dim hover:text-emerald-500 p-1 bg-void-lighter rounded transition-colors"
                                        title="Save edits (keep raw history)"
                                    >
                                        <Check size={11} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (window.confirm('RETCON: This will override ALL raw conversation history. Only your edited summary + your next message will be sent to the AI. Use this to rewrite scenes.')) {
                                                const currentMessages = useAppStore.getState().messages;
                                                setCondensed(condensedDraft, currentMessages.length - 1);
                                                setIsEditingCondensed(false);
                                                toast.success(`Retcon applied — all ${currentMessages.length} messages now behind summary boundary`);
                                            }
                                        }}
                                        className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                        title="RETCON: Save edits & override all raw history — AI will only see this summary"
                                    >
                                        <RotateCcw size={11} />
                                    </button>
                                    <button
                                        onClick={() => {
                                            setIsEditingCondensed(false);
                                            setCondensedDraft('');
                                        }}
                                        className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                        title="Cancel edits"
                                    >
                                        <X size={11} />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="p-3 max-h-[250px] overflow-y-auto">
                        {isEditingCondensed ? (
                            <textarea
                                value={condensedDraft}
                                onChange={(e) => setCondensedDraft(e.target.value)}
                                className="w-full bg-void border border-amber-500/30 focus:border-amber-500 text-text-primary text-[11px] font-mono leading-relaxed p-2 resize-y min-h-[120px] max-h-[400px] outline-none rounded-sm transition-colors"
                                placeholder="Edit condensed memory..."
                            />
                        ) : (
                            <div className="text-[11px] text-text-primary/80 font-mono leading-relaxed whitespace-pre-wrap">
                                {condenser.condensedSummary}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Input Area */}
            <div className="flex-shrink-0 bg-void border-t border-border">
                {editingMessageId && (
                    <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between">
                        <span className="text-terminal text-[11px] uppercase tracking-wider font-bold flex items-center gap-2">
                            <Edit2 size={12} /> Editing Message
                        </span>
                        <button
                            onClick={() => { setEditingMessageId(null); setInput(''); }}
                            className="text-text-dim hover:text-text-primary flex items-center gap-1 text-[10px] uppercase tracking-wider"
                        >
                            <X size={12} /> Cancel
                        </button>
                    </div>
                )}
                <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4">
                    <div className="flex gap-1 border border-border bg-void focus-within:border-terminal transition-colors items-end p-1 rounded-sm">
                        <div className="relative shrink-0 mb-[4px] ml-1">
                            <select
                                value={settings.activePresetId}
                                onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)}
                                className="h-[32px] bg-surface border border-border text-text-dim hover:text-terminal hover:border-terminal/50 pl-3 pr-7 text-[10px] uppercase tracking-widest focus:outline-none focus:border-terminal max-w-[120px] sm:max-w-[150px] truncate cursor-pointer appearance-none rounded transition-colors font-bold"
                                title="Active AI Preset"
                            >
                                {settings.presets.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                        </div>
                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            placeholder={editingMessageId ? "Edit message..." : "What do you do?"}
                            className="flex-1 bg-transparent px-2 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                        />
                        <button
                            onClick={isStreaming ? handleStop : (editingMessageId ? handleEditSubmit : () => handleSend())}
                            disabled={!isStreaming && !input.trim()}
                            className={`h-[32px] w-[44px] mb-[4px] rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 ${isStreaming ? 'text-amber-500 hover:bg-amber-500/10' : 'text-terminal hover:bg-terminal/10'}`}
                        >
                            {isStreaming ? <Square size={16} fill="currentColor" /> : (editingMessageId ? <Check size={16} /> : <Send size={16} />)}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}


