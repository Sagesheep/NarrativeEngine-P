import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ScreenLightboxProps {
    /** `default` is the normal 90% lightbox; `full` is reserved for app-sized screens. */
    size?: 'default' | 'full';
    /**
     * Content width inside the scroll container.
     * - `form` (default) → `max-w-5xl mx-auto` — settings-style stacked forms
     * - `wide`           → full width — screens made of repeating units that tile
     *
     * Work order UI-polish §A1: the lightbox path had no width cap, so a
     * drawer tab promoted into a 90vw box stretched its `w-full` inputs to
     * ~1900px. A single global cap is the wrong fix (some screens want the
     * width), so the caller declares which shape it is.
     */
    width?: 'form' | 'wide';
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Shared shell for campaign screens that deserve the user's full attention.
 * The panel owns the backdrop, heading, close affordance, keyboard handling,
 * and focus lifecycle; its children only own the screen content.
 */
export function ScreenLightbox({ size = 'default', width = 'form', title, onClose, children }: ScreenLightboxProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        restoreFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const panel = panelRef.current;
        if (!panel) return undefined;

        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        (focusables[0] ?? panel).focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab') return;

            const currentFocusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            if (currentFocusables.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }

            const first = currentFocusables[0];
            const last = currentFocusables[currentFocusables.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            restoreFocusRef.current?.focus();
        };
    }, [onClose]);

    const panelSize = size === 'full' ? 'w-full h-full' : 'w-[90vw] h-[90vh]';
    const titleId = `screen-lightbox-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-void/80 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={onClose}
        >
            <div
                ref={panelRef}
                tabIndex={-1}
                className={`relative ${panelSize} bg-surface border border-border flex flex-col shadow-2xl overflow-hidden`}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 border-b border-border shrink-0 bg-void">
                    <h2 id={titleId} className="chrome-label text-terminal text-sm font-bold tracking-[0.2em] uppercase truncate">
                        {title}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-text-dim hover:text-danger transition-colors shrink-0"
                        aria-label={`Close ${title}`}
                    >
                        <X size={18} />
                    </button>
                </div>
                {/* WO-screen-modernization §0 + §0-B — the cap, padding AND the
                    height chain live on one inner wrapper. Three bugs in the
                    same family shipped green here:

                      §0  : `mx-auto` on a flex child of `flex flex-col` overrides
                             `align-items: stretch` and collapses it to
                             shrink-to-fit, so `max-w-5xl` never bound (panel
                             measured 442px at 1920vw). Fix: cap+padding move to
                             an inner wrapper.
                      §0-B: that inner wrapper had auto height, so callers'
                             `h-full` (height:100%) resolved against an
                             auto-height parent and was ignored — the textarea
                             stayed at 211px inside a 939px scroller with 297px
                             of dead space below. Fix: make the chain a
                             continuous flex column. The scroller is
                             `flex flex-col`, the inner wrapper is
                             `flex-1 min-h-0 flex flex-col`, and screen roots use
                             `flex-1 min-h-0 flex flex-col` (NOT `h-full`).
                      §0-C: making the inner wrapper a flex column re-introduced
                             §0 for `form` screens — `mx-auto` on a column flex
                             item with no explicit width collapses it to
                             shrink-to-fit again (Memory measured 608px instead
                             of the 1024px cap at 1280vw). Fix: pair `mx-auto`
                             with `w-full` so the width is explicit (100% of the
                             scroller) before `max-w-5xl` caps it and `mx-auto`
                             centers the capped box. `w-full` + `max-w-5xl` +
                             `mx-auto` on a column flex item: width resolves to
                             min(100%, 1024px), then auto margins center it.
                    No percentage heights anywhere in the chain. Verified in the
                    browser with getBoundingClientRect, not jsdom — jsdom has no
                    layout engine and returns 0 for every dimension. */}
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                    <div className={`p-4 sm:p-6 flex-1 min-h-0 flex flex-col ${
                        width === 'form' ? 'max-w-5xl w-full mx-auto' : 'w-full'}`}>
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}
