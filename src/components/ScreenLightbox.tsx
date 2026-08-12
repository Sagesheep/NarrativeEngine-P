import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ScreenLightboxProps {
    /** `default` is the normal 90% lightbox; `full` is reserved for app-sized screens. */
    size?: 'default' | 'full';
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
export function ScreenLightbox({ size = 'default', title, onClose, children }: ScreenLightboxProps) {
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
                    <h2 id={titleId} className="chrome-label text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green truncate">
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
                <div className="flex-1 min-h-0 overflow-y-auto">
                    {children}
                </div>
            </div>
        </div>
    );
}
