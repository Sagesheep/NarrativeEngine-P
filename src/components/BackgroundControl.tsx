import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Upload, Trash2 } from 'lucide-react';
import { toast } from './Toast';
import {
    setBackgroundImage,
    clearBackgroundImage,
    setBackgroundOpacity,
    fileToDataUrl,
    DEFAULT_BG_OPACITY,
} from '../services/background/backgroundManager';

/**
 * Global-settings control for the chat background image. Stores a single image (a new
 * pick replaces the old one) and exposes an opacity slider that controls how
 * translucent the chat panel is over the image.
 *
 * The popover is rendered through a portal at fixed coordinates: the header's
 * action bar uses `overflow-x-auto`, which forces `overflow-y` to clip, so an
 * absolutely-positioned dropdown would otherwise be cut off at the header edge.
 */
export function BackgroundControl() {
    const [open, setOpen] = useState(false);
    const [hasImage, setHasImage] = useState(() =>
        document.documentElement.hasAttribute('data-has-bg')
    );
    const [opacity, setOpacity] = useState(() => {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--chat-opacity')
            .trim();
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : DEFAULT_BG_OPACITY;
    });
    const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
    const btnRef = useRef<HTMLButtonElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Anchor the portal menu under the button whenever it opens.
    useLayoutEffect(() => {
        if (!open || !btnRef.current) return;
        const r = btnRef.current.getBoundingClientRect();
        const menuWidth = 240;
        // Keep the menu on-screen if the button sits near the right edge.
        const left = Math.min(r.left, window.innerWidth - menuWidth - 8);
        setPos({ top: r.bottom + 6, left: Math.max(8, left) });
    }, [open]);

    const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file later
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            toast.error('Please choose an image file');
            return;
        }
        try {
            const dataUrl = await fileToDataUrl(file);
            await setBackgroundImage(dataUrl);
            setHasImage(true);
            toast.success('Background updated');
        } catch (err) {
            console.warn('[background] failed to set image:', err);
            toast.error('Failed to load image');
        }
    };

    const handleRemove = async () => {
        await clearBackgroundImage();
        setHasImage(false);
        toast.info('Background removed');
    };

    const handleOpacity = (value: number) => {
        setOpacity(value);
        void setBackgroundOpacity(value);
    };

    return (
        <div className="shrink-0">
            <button
                ref={btnRef}
                onClick={() => setOpen((v) => !v)}
                className={`flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono ${open || hasImage ? 'border-terminal text-terminal bg-terminal/5' : 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal'}`}
                title="Background image"
                aria-label="Change background image"
            >
                <ImageIcon size={13} />
                <span className="hidden sm:inline">Background</span>
            </button>

            {/* Hidden picker lives outside the portal so its ref is always mounted. */}
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePick}
            />

            {open &&
                createPortal(
                    <>
                        {/* click-away catcher */}
                        <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
                        <div
                            className="fixed z-[61] w-60 bg-surface border border-border rounded-sm shadow-lg p-3 flex flex-col gap-3"
                            style={{ top: pos.top, left: pos.left }}
                        >
                            <button
                                onClick={() => fileRef.current?.click()}
                                className="flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-sm border border-terminal/40 hover:border-terminal bg-terminal/5 hover:bg-terminal/10 text-terminal transition-colors cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                            >
                                <Upload size={12} />
                                {hasImage ? 'Change image' : 'Choose image'}
                            </button>

                            <div className="flex flex-col gap-1.5">
                                <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-text-dim font-mono">
                                    <span>Chat opacity</span>
                                    <span className="text-terminal">{opacity}%</span>
                                </div>
                                <input
                                    type="range"
                                    min={10}
                                    max={100}
                                    step={5}
                                    value={opacity}
                                    disabled={!hasImage}
                                    onChange={(e) => handleOpacity(Number(e.target.value))}
                                    className="w-full accent-terminal disabled:opacity-40 cursor-pointer"
                                />
                                <p className="text-[9px] text-text-dim/70 leading-snug">
                                    Lower = more of the image shows through the chat.
                                </p>
                            </div>

                            {hasImage && (
                                <button
                                    onClick={handleRemove}
                                    className="flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-sm border border-border hover:border-danger text-text-dim hover:text-danger transition-colors cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                                >
                                    <Trash2 size={12} />
                                    Remove
                                </button>
                            )}
                        </div>
                    </>,
                    document.body
                )}
        </div>
    );
}
