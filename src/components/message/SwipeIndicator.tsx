import { ChevronLeft, ChevronRight, Loader2, FastForward } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { MAX_SWIPES } from '../../services/turn/swipeGeneration';

/**
 * SwipeIndicator — shows "2/5" position and prev/next chevrons for the
 * latest GM message's swipe set. Touch-swipe left/right on the bubble
 * navigates; the chevrons are tap targets for desktop / accessibility.
 */
export function SwipeIndicator({
    msg,
    onPrev,
    onNext,
}: {
    msg: ChatMessage;
    onPrev: () => void;
    onNext: () => void;
}) {
    const swipeSet = msg.swipeSet;
    if (!swipeSet) return null;
    const current = (msg.swipeActiveIndex ?? 0) + 1;
    const total = Math.max(swipeSet.length, MAX_SWIPES);
    const atFirst = (msg.swipeActiveIndex ?? 0) === 0;
    const atLast = (msg.swipeActiveIndex ?? 0) >= swipeSet.length - 1 && swipeSet.length >= MAX_SWIPES;
    const isStreaming = swipeSet[msg.swipeActiveIndex ?? 0]?.streaming === true;

    return (
        <div className="flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-text-dim select-none">
            <button
                onClick={onPrev}
                disabled={atFirst}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Previous variant"
            >
                <ChevronLeft size={12} />
            </button>
            <span className="font-mono text-text-dim/80">
                {isStreaming ? '…' : current}/{total}
            </span>
            <button
                onClick={onNext}
                disabled={atLast}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Next variant"
            >
                <ChevronRight size={12} />
            </button>
        </div>
    );
}

/**
 * ContinueButton — extends the latest GM reply in place (a swipe that appends
 * instead of replaces). Mounted beside the swipe controls; same visibility
 * condition as the swipe indicator (latest GM message + pending commit).
 * Disabled while a continue, swipe, or real turn is streaming (mutual exclusion).
 */
export function ContinueButton({
    loading,
    disabled,
    onClick,
}: {
    loading: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title="Continue — extend this reply"
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest text-text-dim hover:text-ice border border-border/50 hover:border-ice/50 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <FastForward size={12} />}
            <span>Continue</span>
        </button>
    );
}
