import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MentionEntry } from './mentionLookup';

/** A shared reading aid for NPCs, places, and glossary terms. Portal positioning
 * keeps the card inside the viewport and outside the chat scroller's clipping. */
export function MentionPreview({ entry, children }: { entry: MentionEntry; children: ReactNode }) {
    const trigger = useRef<HTMLSpanElement>(null);
    const card = useRef<HTMLSpanElement>(null);
    const pinned = useRef(false);
    const tooltipId = useId();
    const [position, setPosition] = useState<{ left: number; top: number; above: boolean; width: number; maxHeight: number } | null>(null);
    const close = () => { pinned.current = false; setPosition(null); };
    const reveal = () => {
        if (!trigger.current) return;
        const rect = trigger.current.getBoundingClientRect();
        const width = Math.min(288, window.innerWidth - 24);
        const above = rect.top > window.innerHeight - rect.bottom;
        setPosition({
            left: Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)),
            top: above ? rect.top - 8 : rect.bottom + 8,
            above, width, maxHeight: Math.max(60, (above ? rect.top : window.innerHeight - rect.bottom) - 20),
        });
    };
    const toggle = () => {
        pinned.current = !pinned.current;
        if (pinned.current) reveal(); else setPosition(null);
    };

    const open = position !== null;
    useEffect(() => {
        if (!open) return;
        const dismiss = () => { pinned.current = false; setPosition(null); };
        const scroll = (event: Event) => { if (!card.current?.contains(event.target as Node)) dismiss(); };
        const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) dismiss(); };
        window.addEventListener('resize', dismiss);
        window.addEventListener('scroll', scroll, true);
        document.addEventListener('pointerdown', outside);
        return () => {
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('scroll', scroll, true);
            document.removeEventListener('pointerdown', outside);
        };
    }, [open]);

    return (
        <>
            <span
                ref={trigger} role="button" tabIndex={0} aria-expanded={open}
                aria-describedby={open ? tooltipId : undefined}
                className="text-terminal font-bold cursor-help select-text outline-offset-2"
                onMouseEnter={reveal}
                onMouseLeave={() => { if (!pinned.current && document.activeElement !== trigger.current) setPosition(null); }}
                onFocus={reveal} onBlur={close} onClick={toggle}
                onKeyDown={event => {
                    if (event.key === 'Escape') { event.preventDefault(); close(); }
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
                }}
            >{children}</span>
            {position && createPortal(
                <span ref={card} id={tooltipId} role="tooltip" className="fixed z-[130] block overflow-y-auto rounded border border-terminal/40 bg-void-darker p-3 shadow-xl text-text-primary"
                    style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.above ? 'translateY(-100%)' : undefined }}>
                    {entry.image && <img src={entry.image} alt={entry.name} className={entry.portrait ? 'mx-auto mb-2 w-24 aspect-[3/4] object-cover object-top rounded' : 'mb-2 w-full max-h-40 object-contain rounded'} loading="lazy" draggable={false} />}
                    <span className="block text-xs text-terminal font-bold break-words">{entry.name}</span>
                    <span className="block text-[10px] text-text-dim mt-1">{entry.category}</span>
                    {entry.description && <span className="block text-xs font-normal leading-relaxed whitespace-pre-wrap break-words mt-2">{entry.description}</span>}
                </span>, document.body,
            )}
        </>
    );
}
