import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { MAX_SWIPES, SWIPE_BASE_TEMP_OFFSET } from '../../services/turn/swipeGeneration';
import { hasSwipeSet } from '../../services/turn/pendingCommit';
import type { ChatMessage } from '../../types';

/**
 * RegenerateSheet — Swipe Generation v1 modal.
 *
 * Opens when the user taps 🔄 on the latest GM bubble. Shows the temperature
 * slider (opens at base + 0.1), the current variant, the swipe indicator
 * (2/5), and prev/next chevrons. Generating a new variant is lazy (one at a
 * time, max MAX_SWIPES). The temperature offset is remembered for the rest
 * of this browse session, reset on commit.
 *
 * IMPORTANT: this component does NOT create its own useSwipeVariants hook.
 * All swipe state + actions are owned by the single ChatArea-owned hook
 * instance and passed in as props. Two hook instances fighting over the same
 * message was the root cause of the v1 bugs (lost variants, no sheet).
 */
export interface RegenerateSheetProps {
    messageId: string | null;
    onClose: () => void;
    // ── Swipe state + actions from the ChatArea-owned useSwipeVariants hook ──
    swipeGenLoading: boolean;
    generateSwipe: (guidance?: string) => Promise<void>;
    nextSwipe: () => void;
    prevSwipe: () => void;
    getSessionOffset: () => number;
    setSessionOffset: (offset: number) => void;
    getSwipeTemperature: () => number;
    /** Scene Continue v1: Continue must disable swipe Generate (mutual exclusion — wire both directions). */
    continueLoading?: boolean;
}

export function RegenerateSheet({
    messageId,
    onClose,
    swipeGenLoading,
    generateSwipe,
    nextSwipe,
    prevSwipe,
    getSessionOffset,
    setSessionOffset,
    getSwipeTemperature,
    continueLoading = false,
}: RegenerateSheetProps) {
    // Subscribe to the message directly so the sheet re-renders when the
    // store's swipeSet / content / swipeActiveIndex change.
    const msg = useAppStore(s => s.messages.find(m => m.id === messageId)) as ChatMessage | undefined;

    const [tempOffset, setTempOffset] = useState<number>(getSessionOffset());
    const [guidance, setGuidance] = useState('');
    const openedAtRef = useRef(0);

    useEffect(() => {
        if (messageId) {
            openedAtRef.current = Date.now();
            setTempOffset(getSessionOffset());
            // Reset guidance when opening for a new message
            setGuidance('');
        }
    }, [messageId, getSessionOffset]);

    if (!messageId || !msg) return null;

    const swipeSet = msg.swipeSet;
    const currentIdx = msg.swipeActiveIndex ?? 0;
    const isLatest = hasSwipeSet(msg);
    const activePreset = useAppStore.getState().getActivePreset?.();
    const baseTemp = activePreset?.sampling?.temperature ?? 0.7;
    const currentTemp = getSwipeTemperature();
    const isStreaming = swipeSet?.[currentIdx]?.streaming === true;
    const generating = swipeGenLoading || isStreaming || continueLoading;

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const handleTempChange = (newOffset: number) => {
        setTempOffset(newOffset);
        setSessionOffset(newOffset);
    };

    const handlePrev = () => prevSwipe();
    const handleNext = () => {
        const atLastFilled = currentIdx >= (swipeSet?.length ?? 1) - 1;
        const canGenerate = (swipeSet?.length ?? 0) < MAX_SWIPES;
        if (atLastFilled && canGenerate && isLatest) {
            generateSwipe(guidance.trim() || undefined);
        } else {
            nextSwipe();
        }
    };

    const handleGuidanceKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Ctrl/Cmd+Enter triggers generation with the typed guidance
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const atLastFilled = currentIdx >= (swipeSet?.length ?? 1) - 1;
            const canGenerate = (swipeSet?.length ?? 0) < MAX_SWIPES;
            if (atLastFilled && canGenerate && isLatest && !generating) {
                generateSwipe(guidance.trim() || undefined);
            }
        }
    };

    const atLastSlot = (swipeSet?.length ?? 0) >= MAX_SWIPES;
    const nextDisabled = currentIdx >= (swipeSet?.length ?? 1) - 1 && atLastSlot;

    return (
        <div
            data-motion="overlay" className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={handleBackdropClick}
        >
            <div
                className="w-full md:max-w-2xl bg-void-darker border border-border rounded-t-lg md:rounded-lg shadow-2xl max-h-[85vh] overflow-y-auto animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <RefreshCw size={14} className={generating ? 'text-terminal animate-spin' : 'text-terminal'} />
                        <span className="text-[11px] uppercase tracking-widest text-text-dim">
                            Browse Variants
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-text-dim hover:text-text-primary p-1 rounded transition-colors"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Temperature slider */}
                <div className="px-4 py-3 border-b border-border/50">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase tracking-widest text-text-dim">
                            Temperature
                        </span>
                        <span className="text-[10px] font-mono text-terminal/80">
                            {currentTemp.toFixed(2)} <span className="text-text-dim/50">(base {baseTemp.toFixed(2)} + {tempOffset.toFixed(2)})</span>
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 font-mono">0.0</span>
                        <input
                            type="range"
                            min={0}
                            max={1.5}
                            step={0.05}
                            value={tempOffset}
                            onChange={e => handleTempChange(parseFloat(e.target.value))}
                            className="flex-1 accent-terminal"
                        />
                        <span className="text-[9px] text-text-dim/50 font-mono">+1.5</span>
                    </div>
                    <p className="text-[9px] text-text-dim/40 mt-1.5">
                        Opens at base + {SWIPE_BASE_TEMP_OFFSET.toFixed(1)}. Remembered for this browse session, reset on commit.
                    </p>
                </div>

                {/* Guidance text box — optional player instructions for the next variant */}
                <div className="px-4 py-3 border-b border-border/50">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase tracking-widest text-text-dim">
                            Guidance <span className="text-text-dim/40 normal-case tracking-normal">(optional)</span>
                        </span>
                        <span className="text-[9px] text-text-dim/40">
                            {generating ? 'Generating…' : 'Ctrl+Enter to generate'}
                        </span>
                    </div>
                    <textarea
                        value={guidance}
                        onChange={e => setGuidance(e.target.value)}
                        onKeyDown={handleGuidanceKeyDown}
                        disabled={generating}
                        placeholder="e.g. make it darker, add more dialogue, focus on the tension…"
                        className="w-full min-h-[60px] max-h-[120px] bg-void-lighter p-2.5 border border-border/50 rounded-sm text-[13px] font-mono leading-relaxed text-text-primary resize-none outline-none transition-all focus:border-terminal/30 focus:ring-1 focus:ring-terminal/20 disabled:opacity-50"
                        rows={2}
                    />
                    <div className="flex items-center justify-between mt-1.5">
                        <p className="text-[9px] text-text-dim/40">
                            Guides the next variant only. Leave empty for a plain re-roll.
                        </p>
                        <button
                            onClick={() => {
                                const atLastFilled = currentIdx >= (swipeSet?.length ?? 1) - 1;
                                const canGenerate = (swipeSet?.length ?? 0) < MAX_SWIPES;
                                if (atLastFilled && canGenerate && isLatest && !generating) {
                                    generateSwipe(guidance.trim() || undefined);
                                } else if (!atLastFilled) {
                                    nextSwipe();
                                }
                            }}
                            disabled={generating || (swipeSet?.length ?? 0) >= MAX_SWIPES}
                            className="px-3 py-1 bg-terminal/10 border border-terminal/30 text-terminal text-[9px] uppercase tracking-widest rounded hover:bg-terminal/20 disabled:opacity-40 disabled:pointer-events-none transition-colors shrink-0"
                            title="Generate next variant with this guidance"
                        >
                            {generating ? <Loader2 size={9} className="animate-spin inline mr-1" /> : null}
                            Generate
                        </button>
                    </div>
                </div>

                {/* Variant display */}
                <div className="px-4 py-3 min-h-[200px]">
                    <div className="flex items-center justify-between mb-2">
                        <button
                            onClick={handlePrev}
                            disabled={currentIdx === 0}
                            className="p-1.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            title="Previous variant"
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-text-dim">
                            {generating ? (
                                <Loader2 size={10} className="animate-spin text-terminal" />
                            ) : null}
                            <span className="font-mono">
                                {currentIdx + 1}/{MAX_SWIPES}
                            </span>
                        </div>
                        <button
                            onClick={handleNext}
                            disabled={nextDisabled}
                            className="p-1.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            title={currentIdx >= (swipeSet?.length ?? 1) - 1 && (swipeSet?.length ?? 0) < MAX_SWIPES ? 'Generate next variant' : 'Next variant'}
                        >
                            {swipeGenLoading ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                        </button>
                    </div>

                    {/* Status line — tells the user what's happening (lazy reuse, not re-gather) */}
                    <div className="text-[9px] uppercase tracking-widest text-text-dim/50 mb-2 flex items-center gap-1.5">
                        {generating ? (
                            <>
                                <span className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                                <span className="text-terminal/70">
                                    Generating variant {currentIdx + 1}/{MAX_SWIPES} — reusing turn context (no re-gather)
                                </span>
                            </>
                        ) : (
                            <>
                                <span className="w-1.5 h-1.5 rounded-full bg-ice/40" />
                                <span>Variant {currentIdx + 1} of {swipeSet?.length ?? 1} generated • swipe left/right on bubble to browse</span>
                            </>
                        )}
                    </div>

                    <div className="bg-void-lighter border border-border/50 rounded p-3 text-[13px] font-mono leading-relaxed text-text-primary max-h-[40vh] overflow-y-auto whitespace-pre-wrap">
                        {msg.content || (generating ? '…' : '(empty)')}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
                    <div className="text-[9px] text-text-dim/50 uppercase tracking-wider">
                        {swipeSet?.length ?? 0} of {MAX_SWIPES} generated
                    </div>
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 bg-terminal/10 border border-terminal/30 text-terminal text-[10px] uppercase tracking-widest rounded hover:bg-terminal/20 transition-colors"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}