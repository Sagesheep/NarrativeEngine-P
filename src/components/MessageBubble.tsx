import { useRef } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import type { ChatMessage, DebugSection, RelationshipMemoryFault, RelationshipMemoryRecord, RelationshipStance } from '../types';
import { DebugPayloadView } from './DebugPayloadView';
import { ToolCallChips } from './chat/ToolCallChips';
import { proseForTTS } from '../services/tts/proseStripper';
import { hasSwipeSet } from '../services/turn/pendingCommit';
import { useTtsPlayback } from './hooks/useTtsPlayback';
import { TtsPlaybackPanel } from './tts/TtsPlaybackPanel';
import { MessageMarkdown } from './message/MessageMarkdown';
import { SwipeIndicator, ContinueButton } from './message/SwipeIndicator';
import { ReasoningViewer } from './message/ReasoningViewer';
import { InlineMessageEditor } from './message/InlineMessageEditor';
import { MessageActionRail } from './message/MessageActionRail';
import { MessageBelowSlots } from './message/MessageBelowSlots';
import { SceneImageAttachmentView } from './message/SceneImageAttachmentView';

interface MessageBubbleProps {
    message: ChatMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    showReasoning: boolean;
    debugMode: boolean;
    onStartEdit: (message: ChatMessage) => void;
    onRegenerate: (id: string) => void;
    onDelete: (id: string) => void;
    /** Raw result content for the first tool call on this message, if any. */
    toolResult?: string;
    /** WO-EDIT — inline edit wiring. When set, this bubble is the live editor. */
    isEditing?: boolean;
    inlineDraft?: string;
    onInlineDraftChange?: (v: string) => void;
    onInlineSubmit?: () => void;
    onInlineCancel?: () => void;
    /** Swipe Generation v1: called when the user taps 🔄 on the latest GM bubble. */
    onOpenSwipeSheet?: (messageId: string) => void;
    /** Swipe Generation v1: called when the user swipes left/right on the bubble. */
    onSwipeNavigate?: (messageId: string, direction: 'prev' | 'next') => void;
    /** Scene Continue v1: called when the user taps the Continue button on the latest GM bubble.
     *  Returns a promise the caller can await if it wants to block on completion. */
    onSceneContinue?: (messageId: string) => void | Promise<void>;
    /** Scene Continue v1: true while a continue is streaming into ANY pending GM bubble. */
    sceneContinueLoading?: boolean;
    /** Swipe Generation v1: true while a swipe is generating (mutual exclusion — Continue is disabled during swipes). */
    swipeGenLoading?: boolean;
    /** Global stream lock — true while a real turn is streaming (mutual exclusion — Continue is disabled during turns). */
    globalIsStreaming?: boolean;
    /** Smart Retry v1: called when the user taps Retry on a failed/aborted GM bubble. */
    onRetry?: (messageId: string) => void;
    relationshipMemories?: RelationshipMemoryRecord[];
    relationshipMemoryFaults?: RelationshipMemoryFault[];
    relationshipStances?: RelationshipStance[];
}

export function MessageBubble({
    message: msg,
    isStreaming,
    isLastMessage,
    showReasoning,
    debugMode,
    onStartEdit,
    onRegenerate,
    onDelete,
    toolResult,
    isEditing,
    inlineDraft,
    onInlineDraftChange,
    onInlineSubmit,
    onInlineCancel,
    onOpenSwipeSheet,
    onSwipeNavigate,
    onSceneContinue,
    sceneContinueLoading,
    swipeGenLoading,
    globalIsStreaming,
    onRetry,
    relationshipMemories = [],
    relationshipMemoryFaults = [],
    relationshipStances = [],
}: MessageBubbleProps) {
    let markdownContent: string = typeof msg.displayContent === 'string'
        ? msg.displayContent
        : (typeof msg.content === 'string' ? msg.content : '');

    // The scene number is rendered from `msg.sceneId` (the id the server actually
    // assigned) in the header below — never from the prose. Historical messages
    // have a `Scene #NNN | ` prefix baked into their text from when the number
    // was predicted at gather time and glued on; that prediction was frequently
    // wrong, so strip it rather than show a stale number next to the real one.
    markdownContent = markdownContent.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
        thinkingBlock = thinkMatch[1].trim();
        markdownContent = markdownContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    } else if (msg.reasoning_content) {
        thinkingBlock = msg.reasoning_content.trim();
    }

    const parsedArgs = (msg as any).parsedArgs;
    const hasSummary = msg.role === 'tool' && parsedArgs && Array.isArray(parsedArgs.summary);
    const hasDebug = debugMode === true && !!msg.debugPayload;

    // ── TTS playback (Kokoro, local) — chunked + highlight-synced + controllable ──
    const tts = useTtsPlayback(msg, markdownContent);
    const canSpeak = msg.role === 'assistant'
        && !isEditing
        && tts.ttsReady
        && !!markdownContent.trim();

    const isUser = msg.role === 'user';

    // ── Swipe Generation v1: touch-swipe gesture handling ──
    // Only the latest GM message (with a swipe set) responds to horizontal
    // swipes. A swipe left → next variant, right → previous. The threshold
    // is generous so a normal vertical scroll never triggers a swipe.
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);
    const SWIPE_THRESHOLD = 50;  // px horizontal travel before it counts as a swipe

    const handleTouchStart = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg)) return;
        const t = e.touches[0];
        touchStartX.current = t.clientX;
        touchStartY.current = t.clientY;
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg) || touchStartX.current === null || touchStartY.current === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX.current;
        const dy = t.clientY - touchStartY.current;
        touchStartX.current = null;
        touchStartY.current = null;
        // Only trigger on predominantly horizontal swipes
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
        if (dx < 0) {
            onSwipeNavigate?.(msg.id, 'next');
        } else {
            onSwipeNavigate?.(msg.id, 'prev');
        }
    };

    const actionRail = (
        <MessageActionRail
            msg={msg}
            isEditing={isEditing}
            canSpeak={canSpeak}
            ttsLoading={tts.ttsLoading}
            ttsPlaying={tts.ttsPlaying}
            ttsPaused={tts.ttsPaused}
            ttsFinished={tts.ttsFinished}
            onInlineSubmit={onInlineSubmit}
            onInlineCancel={onInlineCancel}
            onStartEdit={onStartEdit}
            onOpenSwipeSheet={onOpenSwipeSheet}
            onRegenerate={onRegenerate}
            onSpeak={tts.handleSpeak}
            onPauseResume={tts.handlePauseResume}
            onDelete={onDelete}
        />
    );

    return (
        <div
            key={msg.id}
            className={`group flex items-start gap-2 animate-[msg-in_0.2s_ease-out] ${isEditing ? 'w-full' : isUser ? 'justify-end' : 'justify-start'}`}
        >
            {isUser && !isEditing && actionRail}
            <div
                {...(msg.role === 'assistant' ? { 'data-lore-checkable': 'true', 'data-message-id': msg.id } : {})}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                className={`chat-bubble-base ${isEditing ? 'w-full max-w-full' : 'max-w-[95%] md:max-w-[75%]'} px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${isUser
                    ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                    : msg.role === 'system'
                        ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                        : 'chat-bubble bg-void-lighter border-l-2 border-border text-text-primary'
                    }`}
            >
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
                    {msg.role === 'assistant' && msg.sceneId && (
                        <span className="text-[9px] text-ice/60 tracking-wider" title="Archived scene">
                            SCENE {msg.sceneId}
                        </span>
                    )}
                    <span className="text-[9px] text-text-dim">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                </div>

                <div className="gm-prose">
                    {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                        <ToolCallChips toolCalls={msg.tool_calls} toolResult={toolResult} />
                    )}
                    {showReasoning && (thinkingBlock || relationshipMemories.length > 0 || relationshipMemoryFaults.length > 0 || relationshipStances.length > 0) && (
                        <ReasoningViewer thinkingBlock={thinkingBlock} spinning={isStreaming && isLastMessage} relationshipMemories={relationshipMemories} relationshipMemoryFaults={relationshipMemoryFaults} relationshipStances={relationshipStances} />
                    )}
                    {isEditing ? (
                        <InlineMessageEditor
                            draft={inlineDraft}
                            onDraftChange={onInlineDraftChange}
                            onSubmit={onInlineSubmit}
                            onCancel={onInlineCancel}
                        />
                    ) : (
                        <>
                            {(tts.ttsPlaying || tts.ttsLoading || tts.ttsFinished || tts.hasCache) && (
                                <TtsPlaybackPanel
                                    prose={proseForTTS(markdownContent)}
                                    ttsLoading={tts.ttsLoading}
                                    ttsPaused={tts.ttsPaused}
                                    ttsPlaying={tts.ttsPlaying}
                                    ttsFinished={tts.ttsFinished}
                                    activeSentenceIdx={tts.activeSentenceIdx}
                                    activeWordIdx={tts.activeWordIdx}
                                    playbackRate={tts.playbackRate}
                                    totalChunks={tts.totalChunks}
                                    generatedChunks={tts.generatedChunks}
                                    onPauseResume={tts.handlePauseResume}
                                    onSpeedChange={tts.handleSpeedChange}
                                    onSpeak={tts.handleSpeak}
                                    onWipe={tts.handleWipeTts}
                                    onSentenceClick={tts.jumpToSentence}
                                />
                            )}
                            <MessageMarkdown content={markdownContent} />
                        </>
                    )}
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

                {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 space-y-2">
                        {msg.attachments.map((att) => (
                            <SceneImageAttachmentView key={att.id} attachment={att} messageId={msg.id} />
                        ))}
                    </div>
                )}

                {/* Phase 4.4 — `message.below` mount region. Mod-claimed
                    content slots render here: below the prose block and the
                    attachment list, above the swipe/continue affordance and
                    the debug view (MOUNTS.md §2.6). Renders `null` when no
                    mod has claimed the region, so the bubble's DOM is
                    byte-identical to the pre-4.4 bubble with zero mods
                    installed (§2.8). The `MessageRef` carries the per-message
                    identity (id, role, sceneId) the mod needs to act on this
                    specific message (§8.4). */}
                <MessageBelowSlots message={{ id: msg.id, role: msg.role, sceneId: msg.sceneId ?? null }} />

                {msg.retryable && !isStreaming && onRetry && (
                    <div className="mt-2 mb-1 flex items-center gap-2 py-2 px-3 bg-void-darker border border-amber-500/30 rounded">
                        <AlertCircle size={12} className="text-amber-400 shrink-0" />
                        <span className="text-[11px] text-amber-400/80 truncate flex-1">Story AI halted — context preserved</span>
                        <button
                            onClick={() => onRetry(msg.id)}
                            className="text-[10px] uppercase tracking-wider text-text-dim hover:text-amber-300 shrink-0 flex items-center gap-1"
                        >
                            <RotateCw size={10} />
                            Retry
                        </button>
                    </div>
                )}

                {hasSwipeSet(msg) && (
                    <div className="mt-2 flex items-center justify-center gap-3 select-none">
                        <SwipeIndicator
                            msg={msg}
                            onPrev={() => onSwipeNavigate?.(msg.id, 'prev')}
                            onNext={() => onSwipeNavigate?.(msg.id, 'next')}
                        />
                        <ContinueButton
                            loading={!!sceneContinueLoading}
                            disabled={
                                !!sceneContinueLoading ||
                                !!swipeGenLoading ||
                                !!globalIsStreaming ||
                                msg.swipeSet?.[msg.swipeActiveIndex ?? 0]?.streaming === true
                            }
                            onClick={() => onSceneContinue?.(msg.id)}
                        />
                    </div>
                )}

                {hasDebug && (
                    <DebugPayloadView debugPayload={msg.debugPayload as { sections?: DebugSection[]; raw?: unknown }} />
                )}
            </div>
            {!isUser && !isEditing && actionRail}
        </div>
    );
}
