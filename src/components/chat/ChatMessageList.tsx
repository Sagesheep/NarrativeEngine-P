import { useState, useMemo } from 'react';
import type { RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import type { ChatMessage, AppSettings, PipelinePhase, StreamingStats, RelationshipMemoryFault, RelationshipMemoryRecord } from '../../types';
import { MessageBubble } from '../MessageBubble';
import { ChatEmptyState } from './ChatEmptyState';
import { UtilityCallStrip } from '../UtilityCallStrip';
import { GenerationProgress } from '../GenerationProgress';
import type { useSwipeVariants } from '../hooks/useSwipeVariants';
import type { useSceneContinue } from '../hooks/useSceneContinue';
import type { useMessageEditor } from '../hooks/useMessageEditor';

/**
 * The scrollable message column: empty state, load-older paging, the
 * MessageBubble list, utility-call strip, generation progress, and the
 * loading status line. Owns the visible-count paging state.
 */
export function ChatMessageList({
    scrollContainerRef,
    bottomRef,
    messages,
    isStreaming,
    settings,
    editor,
    pendingMessageId,
    swipe,
    sceneContinue,
    onOpenSwipeSheet,
    onCreateCharacter,
    loadingStatus,
    pipelinePhase,
    streamingStats,
    directorBriefRunning,
    onSkipDirectorBrief,
    onRetry,
    relationshipMemoriesNpcToMc = [],
    relationshipMemoriesNpcToNpc = [],
    relationshipMemoryFaults = [],
}: {
    scrollContainerRef: RefObject<HTMLDivElement | null>;
    bottomRef: RefObject<HTMLDivElement | null>;
    messages: ChatMessage[];
    isStreaming: boolean;
    settings: AppSettings;
    editor: ReturnType<typeof useMessageEditor>;
    pendingMessageId: string | null;
    swipe: ReturnType<typeof useSwipeVariants>;
    sceneContinue: ReturnType<typeof useSceneContinue>;
    onOpenSwipeSheet: (messageId: string) => void;
    onCreateCharacter: () => void;
    loadingStatus: string | null;
    pipelinePhase: PipelinePhase;
    streamingStats: StreamingStats | null;
    /** WO-05: true while `runDirectorBrief` is in flight — surfaces the
     *  "Director drafting brief…" status + Skip affordance in GenerationProgress. */
    directorBriefRunning: boolean;
    /** WO-05: aborts the Director call only (never the whole turn). */
    onSkipDirectorBrief: () => void;
    /** Smart Retry v1: retries the failed/aborted GM bubble with the cached precontext. */
    onRetry?: (messageId: string) => void;
    relationshipMemoriesNpcToMc?: RelationshipMemoryRecord[];
    relationshipMemoriesNpcToNpc?: RelationshipMemoryRecord[];
    relationshipMemoryFaults?: RelationshipMemoryFault[];
}) {
    const [visibleCount, setVisibleCount] = useState(10);
    const [loadStep, setLoadStep] = useState(10);

    // WO-11.6 — Map tool_call_id -> result content, sourced from the (filtered-out)
    // `tool` role messages, so each assistant bubble can surface what its tool call
    // returned as a clean chip instead of raw system text.
    const toolResultById = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of messages) {
            if (m.role === 'tool' && m.tool_call_id) map.set(m.tool_call_id, m.content);
        }
        return map;
    }, [messages]);

    return (
        <div ref={scrollContainerRef} className="chat-panel flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3 relative">
            {messages.length === 0 && (
                <ChatEmptyState onCreateCharacter={onCreateCharacter} />
            )}

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

            {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg, idx, arr) => (
                <MessageBubble
                    key={msg.id}
                    message={msg}
                    isStreaming={isStreaming}
                    isLastMessage={idx === arr.length - 1}
                    showReasoning={!!settings.showReasoning}
                    relationshipMemories={msg.sceneId ? [...relationshipMemoriesNpcToMc, ...relationshipMemoriesNpcToNpc].filter(r => r.sceneId === msg.sceneId) : []}
                    relationshipMemoryFaults={msg.sceneId ? relationshipMemoryFaults.filter(f => f.sceneId === msg.sceneId) : []}
                    relationshipStances={msg.relationshipStances ?? []}
                    debugMode={!!settings.debugMode}
                    onStartEdit={editor.startEditing}
                    onRegenerate={editor.handleRegenerate}
                    onDelete={(id) => editor.handleDeleteOutput(id)}
                    toolResult={msg.tool_calls?.[0] ? toolResultById.get(msg.tool_calls[0].id) : undefined}
                    isEditing={editor.editingMessageId === msg.id}
                    inlineDraft={editor.editingMessageId === msg.id ? editor.inlineDraft : undefined}
                    onInlineDraftChange={editor.setInlineDraft}
                    onInlineSubmit={editor.handleEditSubmit}
                    onInlineCancel={editor.cancelEditing}
                    onOpenSwipeSheet={onOpenSwipeSheet}
                    onSwipeNavigate={(id, dir) => {
                        if (id !== pendingMessageId) return;
                        if (dir === 'prev') swipe.prevSwipe();
                        else swipe.nextSwipe();
                    }}
                    onSceneContinue={(id) => {
                        if (id !== pendingMessageId) return;
                        sceneContinue.runSceneContinue();
                    }}
                    sceneContinueLoading={sceneContinue.continueLoading}
                    swipeGenLoading={swipe.swipeGenLoading}
                    globalIsStreaming={isStreaming}
                    onRetry={onRetry}
                />
            ))}

            <UtilityCallStrip />
            <GenerationProgress
                phase={pipelinePhase}
                stats={streamingStats}
                directorBriefRunning={directorBriefRunning}
                onSkipDirectorBrief={onSkipDirectorBrief}
            />

            {loadingStatus && pipelinePhase === 'idle' && (
                <div className="flex items-center gap-2 text-terminal text-xs px-4">
                    <Loader2 size={12} className="animate-spin" />
                    <span className="animate-pulse-slow">{loadingStatus}</span>
                </div>
            )}

            <div ref={bottomRef} />
        </div>
    );
}
