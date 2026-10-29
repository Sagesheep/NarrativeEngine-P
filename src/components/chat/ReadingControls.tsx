import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ALargeSmall, Minus, Plus } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import {
    READING_ALIGNS, READING_DEFAULTS, READING_FONTS, READING_LEADINGS, READING_WIDTHS,
    READING_SIZE_MAX, READING_SIZE_MIN, clampReadingSize,
    normalizeReadingAlign, normalizeReadingFont, normalizeReadingLeading, normalizeReadingWidth,
} from './readingPrefs';

/**
 * The "Aa" button beside the story: a quick popover over the same persisted
 * reading settings as Settings → Display. It lives outside the scroll
 * container so it never scrolls away with the first message (the 2.0.1
 * toolbar did, and players never found it).
 */
export function ReadingControls() {
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointer = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const font = normalizeReadingFont(settings.readingFont);
    const size = clampReadingSize(settings.readingSize);
    const leading = normalizeReadingLeading(settings.readingLeading);
    const width = normalizeReadingWidth(settings.readingWidth);
    const align = normalizeReadingAlign(settings.readingAlign);

    const segment = (active: boolean) =>
        `flex-1 px-2 py-1 text-[11px] border-l first:border-l-0 border-border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-terminal ${active ? 'bg-terminal text-void font-bold' : 'bg-void text-text-dim hover:text-text-primary'}`;

    return (
        <div ref={rootRef} className="reading-controls">
            <button
                onClick={() => setOpen(o => !o)}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Reading settings"
                aria-label="Reading settings"
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <ALargeSmall size={18} />
            </button>
            {open && (
                <div role="dialog" aria-label="Reading settings" className="reading-controls-panel bg-void-lighter border border-border rounded shadow-lg p-3 space-y-3">
                    <Row label="Font">
                        <div className="flex border border-border rounded overflow-hidden">
                            {READING_FONTS.map(o => (
                                <button key={o.value} className={segment(font === o.value)} aria-pressed={font === o.value}
                                    style={{ fontFamily: o.value === 'serif' ? "'Palatino Linotype', Georgia, serif" : "'Segoe UI', system-ui, sans-serif" }}
                                    onClick={() => updateSettings({ readingFont: o.value })}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </Row>
                    <Row label="Size">
                        <div className="flex items-center gap-2">
                            <button className="reading-step" aria-label="Smaller text" disabled={size <= READING_SIZE_MIN}
                                onClick={() => updateSettings({ readingSize: clampReadingSize(size - 1) })}>
                                <Minus size={12} />
                            </button>
                            <span className="flex-1 text-center font-mono text-[11px] text-text-primary" aria-live="polite">{size}px</span>
                            <button className="reading-step" aria-label="Larger text" disabled={size >= READING_SIZE_MAX}
                                onClick={() => updateSettings({ readingSize: clampReadingSize(size + 1) })}>
                                <Plus size={12} />
                            </button>
                        </div>
                    </Row>
                    <Row label="Line spacing">
                        <div className="flex border border-border rounded overflow-hidden">
                            {READING_LEADINGS.map(o => (
                                <button key={o.value} className={segment(leading === o.value)} aria-pressed={leading === o.value}
                                    onClick={() => updateSettings({ readingLeading: o.value })}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </Row>
                    <Row label="Width">
                        <div className="flex border border-border rounded overflow-hidden">
                            {READING_WIDTHS.map(o => (
                                <button key={o.value} className={segment(width === o.value)} aria-pressed={width === o.value}
                                    onClick={() => updateSettings({ readingWidth: o.value })}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </Row>
                    <Row label="Align">
                        <div className="flex border border-border rounded overflow-hidden">
                            {READING_ALIGNS.map(o => (
                                <button key={o.value} className={segment(align === o.value)} aria-pressed={align === o.value}
                                    onClick={() => updateSettings({ readingAlign: o.value })}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </Row>
                    <button
                        className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal focus:outline-none focus-visible:underline"
                        onClick={() => updateSettings({ ...READING_DEFAULTS })}
                    >
                        Reset to defaults
                    </button>
                </div>
            )}
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
            {children}
        </div>
    );
}
