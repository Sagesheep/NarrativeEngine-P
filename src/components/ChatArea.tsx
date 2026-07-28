import { useState, useRef, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { findPendingCommitMessage } from '../services/turn/pendingCommit';
import { LootRollModal } from './chat/LootRollModal';
import { DiceRollModal } from './chat/DiceRollModal';
import { SceneImageModal } from './chat/SceneImageModal';
import { RegenerateSheet } from './chat/RegenerateSheet';
import { SelectionActionsMenu } from './chat/SelectionActionsMenu';
import { ChatActionStrip } from './chat/ChatActionStrip';
import { ChatComposer } from './chat/ChatComposer';
import { ChatNavFabs } from './chat/ChatNavFabs';
import { ChatMessageList } from './chat/ChatMessageList';
import { useSwipeVariants } from './hooks/useSwipeVariants';
import { useSceneContinue } from './hooks/useSceneContinue';
import { useRetryStoryAI } from './hooks/useRetryStoryAI';
import { rollbackArchiveFrom } from '../services/archive-memory/archiveManager';
import { useCondenser } from './hooks/useCondenser';
import { useChapterSealing } from './hooks/useChapterSealing';
import { useMessageEditor } from './hooks/useMessageEditor';
import { useChatOperations } from '../hooks/useChatOperations';
import { useChatPersistence } from '../hooks/useChatPersistence';
import { useAutoresizeInput } from '../hooks/useAutoresizeInput';
import { useChatKeyboard } from '../hooks/useChatKeyboard';
import { InventoryStagingBar } from './inventory/InventoryStagingBar';
import { IndexingBanner } from './IndexingBanner';
import { AskGmPanel } from './ooc/AskGmPanel';
import { ArmedAskGmNote } from './ooc/ArmedAskGmNote';

export function ChatArea() {
    const messages = useAppStore(s => s.messages);
    const condenser = useAppStore(s => s.condenser);
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const activeProvider = useAppStore(s => s.getActiveStoryEndpoint?.());
    const activeUtilityProvider = useAppStore(s => s.getActiveUtilityEndpoint?.());
    const semanticFacts = useAppStore(s => s.semanticFacts ?? []);

    const { settings, loreChunks, npcLedger, archiveIndex, chapters, locationLedger, enemyCompendium, enemyInstances, enemyEncounters } = useAppStore(
        useShallow(s => ({
            settings: s.settings,
            loreChunks: s.loreChunks,
            npcLedger: s.npcLedger,
            archiveIndex: s.archiveIndex,
            chapters: s.chapters,
            locationLedger: s.locationLedger,
            enemyCompendium: s.enemyCompendium,
            enemyInstances: s.enemyInstances,
            enemyEncounters: s.enemyEncounters,
        }))
    );

    const {
        setArchiveIndex, clearArchive, updateContext,
        setCondensed, deleteMessage, deleteMessagesFrom,
        setTimeline, setChapters, deleteDivergenceChapter,
        pipelinePhase, streamingStats,
    } = useAppStore(
        useShallow(s => ({
            setArchiveIndex: s.setArchiveIndex,
            clearArchive: s.clearArchive,
            updateContext: s.updateContext,
            setCondensed: s.setCondensed,
            deleteMessage: s.deleteMessage,
            deleteMessagesFrom: s.deleteMessagesFrom,
            setTimeline: s.setTimeline,
            setChapters: s.setChapters,
            deleteDivergenceChapter: s.deleteDivergenceChapter,
            pipelinePhase: s.pipelinePhase,
            streamingStats: s.streamingStats,
        }))
    );

    const [input, setInput] = useState('');
    // Session-local OOC state stays outside the campaign store and turn lifecycle.
    const [oocOpen, setOocOpen] = useState(false);
    const [oocBusy, setOocBusy] = useState(false);
    const [armedAskGmBrief, setArmedAskGmBrief] = useState<{ campaignId: string; text: string } | null>(null);

    // A brief belongs to this in-memory chat session and one campaign only.
    useEffect(() => {
        setArmedAskGmBrief(current => current?.campaignId === activeCampaignId ? current : null);
    }, [activeCampaignId]);

    // ── Swipe Generation v1 ──
    // The latest assistant message with pendingCommit=true, or null. Drives the
    // single useSwipeVariants hook instance owned by ChatArea. Scanning the tail
    // keeps this cheap and avoids re-subscribing on every keystroke.
    const pendingMessageId = useMemo(() => {
        const found = findPendingCommitMessage(messages);
        return found?.id ?? null;
    }, [messages]);

    const swipe = useSwipeVariants(pendingMessageId);
    const sceneContinue = useSceneContinue(pendingMessageId);
    const retry = useRetryStoryAI();
    const [swipeSheetMessageId, setSwipeSheetMessageId] = useState<string | null>(null);

    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);
    const composerInjection = useAppStore(s => s.composerInjection);
    const consumeComposerInjection = useAppStore(s => s.consumeComposerInjection);

    useEffect(() => {
        if (composerInjection != null) {
            setInput(composerInjection);
            consumeComposerInjection();
            inputRef.current?.focus();
        }
    }, [composerInjection, consumeComposerInjection]);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    const { resetTextareaHeight, resizeToContent } = useAutoresizeInput(inputRef);

    const { triggerCondense } = useCondenser({
        messages,
        condenser,
        setCondensed,
    });

    const { checkAndSealChapter } = useChapterSealing({
        activeCampaignId,
        chapters,
        context,
        setChapters,
        getActiveSummarizerEndpoint: () => useAppStore.getState().getActiveSummarizerEndpoint?.(),
        getActiveStoryEndpoint: () => useAppStore.getState().getActiveStoryEndpoint(),
    });

    const {
        isStreaming, loadingStatus, pendingProposal, setPendingProposal,
        pendingPcPrompt, resolvePcPrompt,
        handleSend, handleStop,
        directorBriefRunning, handleSkipDirectorBrief,
    } = useChatOperations({
        input,
        setInput,
        resetTextareaHeight,
        oocBusy,
        armedAskGmBrief,
        setArmedAskGmBrief,
        sceneContinue,
        checkAndSealChapter,
    });

    const { isSaving, handleForceSave, handleOpenArchive } = useChatPersistence();
    const { handleKeyDown } = useChatKeyboard(() => handleSend());

    const archiveDeps = {
        setArchiveIndex,
        setTimeline,
        setChapters,
        clearArchive,
        setCondenser: useAppStore.getState().setCondenser,
        getActiveCampaignId: () => useAppStore.getState().activeCampaignId,
        getArchiveIndex: () => useAppStore.getState().archiveIndex,
        getChapters: () => useAppStore.getState().chapters,
        getCondenser: () => useAppStore.getState().condenser,
        getMessages: () => useAppStore.getState().messages,
    };

    const editor = useMessageEditor({
        messages,
        rollbackArchive: (ts) => rollbackArchiveFrom(archiveDeps, ts),
        deleteMessagesFrom,
        updateMessageContent: (id, content) => useAppStore.getState().updateMessageContent(id, content),
        onAfterEdit: (text) => handleSend(text),
        onAfterRegenerate: (text) => handleSend(text),
        activeCampaignId,
        deleteMessage,
        archiveDeps,
        deleteDivergenceChapter,
    });

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (deepArmed) setDeepArmed(false);
        resizeToContent();
    };

    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
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

            <SelectionActionsMenu />

            <ChatMessageList
                scrollContainerRef={scrollContainerRef}
                bottomRef={bottomRef}
                messages={messages}
                isStreaming={isStreaming}
                settings={settings}
                editor={editor}
                pendingMessageId={pendingMessageId}
                swipe={swipe}
                sceneContinue={sceneContinue}
                onCreateCharacter={() => useAppStore.getState().togglePCPanel()}
                loadingStatus={loadingStatus}
                pipelinePhase={pipelinePhase}
                streamingStats={streamingStats}
                directorBriefRunning={directorBriefRunning}
                onSkipDirectorBrief={handleSkipDirectorBrief}
                onOpenSwipeSheet={setSwipeSheetMessageId}
                onRetry={retry.retryStoryAI}
            />

            <ChatActionStrip
                isStreaming={isStreaming}
                isSaving={isSaving}
                messagesCount={messages.length}
                onForceSave={handleForceSave}
                onTrim={triggerCondense}
                onOpenOoc={() => setOocOpen(true)}
                onOpenArchive={handleOpenArchive}
            />

            <div className="chat-composer-bar flex-shrink-0 bg-void border-t border-border">
                <IndexingBanner campaignId={activeCampaignId} />
                {armedAskGmBrief?.campaignId === activeCampaignId && (
                    <ArmedAskGmNote
                        brief={armedAskGmBrief.text}
                        onUpdate={text => setArmedAskGmBrief(current => current ? { ...current, text } : current)}
                        onRemove={() => setArmedAskGmBrief(null)}
                    />
                )}

                {pendingProposal && (
                    <InventoryStagingBar
                        proposal={pendingProposal}
                        onDone={() => setPendingProposal(null)}
                    />
                )}
                <ChatComposer
                    input={input}
                    inputRef={inputRef}
                    isStreaming={isStreaming}
                    oocBusy={oocBusy}
                    onInputChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onSend={() => handleSend()}
                    onStop={handleStop}
                />
            </div>

            {oocOpen && (
                <AskGmPanel
                    key={activeCampaignId ?? 'no-campaign'}
                    snapshot={{
                        campaignId: activeCampaignId,
                        provider: activeProvider,
                        context,
                        messages,
                        semanticFacts,
                        loreChunks,
                        archiveIndex,
                        npcLedger,
                        locationLedger,
                        enemyCompendium,
                        enemyInstances,
                        enemyEncounters,
                    }}
                    utilityProvider={activeUtilityProvider}
                    hasArmedBrief={armedAskGmBrief?.campaignId === activeCampaignId}
                    onArmBrief={text => {
                        if (!activeCampaignId) return;
                        setArmedAskGmBrief({ campaignId: activeCampaignId, text });
                    }}
                    storyBusy={isStreaming || pipelinePhase !== 'idle'}
                    onBusyChange={setOocBusy}
                    onClose={() => setOocOpen(false)}
                />
            )}

            <ChatNavFabs scrollContainerRef={scrollContainerRef} bottomRef={bottomRef} />

            <LootRollModal />
            <DiceRollModal />
            <SceneImageModal />

            {pendingPcPrompt && (
                <PcPromptModal
                    onCreate={() => resolvePcPrompt('create')}
                    onProceed={() => resolvePcPrompt('proceed')}
                    onCancel={() => resolvePcPrompt('cancel')}
                />
            )}

            <RegenerateSheet
                messageId={swipeSheetMessageId}
                onClose={() => setSwipeSheetMessageId(null)}
                swipeGenLoading={swipe.swipeGenLoading}
                generateSwipe={swipe.generateSwipe}
                nextSwipe={swipe.nextSwipe}
                prevSwipe={swipe.prevSwipe}
                getSessionOffset={swipe.getSessionOffset}
                setSessionOffset={swipe.setSessionOffset}
                getSwipeTemperature={swipe.getSwipeTemperature}
                continueLoading={sceneContinue.continueLoading}
            />
        </div>
    );
}

// WO-A2 §2.1 — first-send intercept modal. Shown when handleSend blocks on a
// missing PC. "Create Character" opens the Character Ledger; "Proceed anyway"
// sets `context.pcPromptDismissed` and never shows again for this campaign;
// "Cancel" aborts the send.
function PcPromptModal({ onCreate, onProceed, onCancel }: {
    onCreate: () => void;
    onProceed: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" onClick={onCancel}>
            <div className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
                <h3 className="text-sm font-bold text-text-primary uppercase tracking-widest mb-2">No Character Yet</h3>
                <p className="text-[12px] text-text-dim mb-4">
                    You haven't created your character. Sure you want to proceed?
                </p>
                <div className="flex flex-col gap-2">
                    <button
                        onClick={onCreate}
                        className="px-4 py-2 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 text-[11px] uppercase tracking-widest"
                    >
                        Create Character
                    </button>
                    <button
                        onClick={onProceed}
                        className="px-4 py-2 bg-void text-text-dim border border-border rounded hover:text-text-primary text-[11px] uppercase tracking-widest"
                    >
                        Proceed anyway
                    </button>
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 text-text-dim/60 hover:text-text-dim text-[10px] uppercase tracking-widest"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
