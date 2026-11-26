import { useRef, useEffect } from 'react';
import { Check, X } from 'lucide-react';

/**
 * WO-EDIT — inline message editor. Autofocuses and auto-grows on mount
 * (this component only mounts while its bubble is in edit mode).
 * Enter submits, Escape cancels; the sticky mini-toolbar mirrors both.
 */
export function InlineMessageEditor({
    draft,
    onDraftChange,
    onSubmit,
    onCancel,
}: {
    draft?: string;
    onDraftChange?: (v: string) => void;
    onSubmit?: () => void;
    onCancel?: () => void;
}) {
    const inlineRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        const ta = inlineRef.current;
        if (!ta) return;
        ta.focus();
        // Defer one frame so the textarea has its final width before we measure scrollHeight.
        const raf = requestAnimationFrame(() => {
            ta.style.height = 'auto';
            ta.style.height = `${Math.max(ta.scrollHeight, 160)}px`;
        });
        return () => cancelAnimationFrame(raf);
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel?.();
        }
    };

    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onDraftChange?.(e.target.value);
        const ta = e.currentTarget;
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(ta.scrollHeight, 160)}px`;
    };

    return (
        <div data-motion="reveal" className="w-full">
            <div className="sticky top-2 flex justify-end gap-1 z-20 mb-1">
                <button title="Save edit (Enter)" onClick={() => onSubmit?.()} className="text-terminal hover:text-terminal p-1.5 bg-void-darker rounded border border-border">
                    <Check size={14} />
                </button>
                <button title="Cancel (Esc)" onClick={() => onCancel?.()} className="text-text-dim hover:text-red-400 p-1.5 bg-void-darker rounded border border-border">
                    <X size={14} />
                </button>
            </div>
            <textarea
                ref={inlineRef}
                value={draft}
                onChange={onChange}
                onKeyDown={onKeyDown}
                className="w-full bg-void-darker border border-terminal/40 text-text-primary font-mono text-sm p-2 rounded resize-none outline-none focus:border-terminal min-h-[160px] leading-relaxed"
                placeholder="Edit message..."
            />
        </div>
    );
}
