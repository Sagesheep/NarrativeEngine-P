import type { RefObject } from 'react';
import { ChevronUp, ChevronDown, ChevronsDown } from 'lucide-react';

/** Message-by-message navigation plus a shortcut back to the latest turn. */
export function ChatNavFabs({
    scrollContainerRef,
}: {
    scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
    const jumpMessage = (direction: 'previous' | 'next') => {
        const sc = scrollContainerRef.current;
        if (!sc) return;
        const rows = Array.from(sc.querySelectorAll<HTMLElement>('[data-ui="msg-row"]'));
        const viewportTop = sc.getBoundingClientRect().top + sc.clientTop;
        const padding = parseFloat(getComputedStyle(sc).scrollPaddingTop) || 0;
        const tops = rows.map(row => Math.max(0,
            row.getBoundingClientRect().top - viewportTop + sc.scrollTop - padding));
        const target = direction === 'previous'
            ? tops.filter(top => top < sc.scrollTop - 4).at(-1)
            : tops.find(top => top > sc.scrollTop + 4);
        const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        if (target !== undefined) sc.scrollTo({ top: target, behavior });
        else if (direction === 'previous') sc.scrollTo({ top: 0, behavior });
        else sc.scrollTo({ top: sc.scrollHeight, behavior });
    };

    const handleJumpToBottom = () => {
        const sc = scrollContainerRef.current;
        if (!sc) return;
        const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
        // Not scrollIntoView: that also scrolls overflow:hidden ancestors.
        sc.scrollTo({ top: sc.scrollHeight, behavior });
    };

    return (
        <div role="group" aria-label="Message navigation" className="chat-message-navigation">
            <button
                onClick={() => jumpMessage('previous')}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Jump up one message"
                aria-label="Previous message"
            >
                <ChevronUp size={16} />
            </button>
            <button
                onClick={() => jumpMessage('next')}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Jump down one message"
                aria-label="Next message"
            >
                <ChevronDown size={16} />
            </button>
            <button
                onClick={handleJumpToBottom}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Jump to latest message"
                aria-label="Latest message"
            >
                <ChevronsDown size={16} />
            </button>
        </div>
    );
}
