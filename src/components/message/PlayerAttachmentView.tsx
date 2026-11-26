import { useState } from 'react';
import { ImageIcon, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * The image a player attached to their own message.
 *
 * The thumbnail is for the human; the caption underneath is what the AI
 * actually received. Keeping the caption reachable — rather than hiding it or
 * blurting it inline — is the point: when the GM reacts to something that was
 * never in the picture, this is where you find out why.
 */
export function PlayerAttachmentView({
    url,
    caption,
}: {
    url?: string;
    caption?: string;
}) {
    const [open, setOpen] = useState(false);
    if (!url && !caption) return null;

    return (
        <div className="mb-2">
            {url && (
                <a href={url} target="_blank" rel="noreferrer" title="Open full size">
                    <img
                        src={url}
                        alt="Attached by the player"
                        className="max-h-48 max-w-full rounded border border-border object-contain"
                    />
                </a>
            )}
            {caption && (
                <div className="mt-1">
                    <button
                        type="button"
                        onClick={() => setOpen(v => !v)}
                        className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-text-dim/70 hover:text-terminal transition-colors"
                    >
                        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        <ImageIcon size={10} />
                        What the AI read
                    </button>
                    {open && (
                        <p className="mt-1 text-[11px] leading-4 text-text-dim italic border-l-2 border-border pl-2">
                            {caption}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
