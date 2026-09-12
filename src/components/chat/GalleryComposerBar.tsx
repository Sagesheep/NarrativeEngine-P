import { Image as ImageIcon, X, Plus } from 'lucide-react';
import type { GalleryEntry, ArmedGalleryRecall } from '../../types';

/**
 * The gallery's presence in the composer: what is armed, what is being picked,
 * and what the app noticed you mention.
 *
 * The suggestion is an OFFER. It never arms anything on its own — same contract
 * the NPC detector follows with `NpcSuggestion` ("noticed but did NOT add — the
 * player decides"). That is what keeps this from being a sixth retrieval system
 * quietly spending your token budget.
 */

export function GalleryPicker({
    matches,
    activeIndex,
    onHover,
    onPick,
}: {
    matches: GalleryEntry[];
    activeIndex: number;
    onHover: (i: number) => void;
    onPick: (entry: GalleryEntry) => void;
}) {
    if (matches.length === 0) return null;
    return (
        <div className="mx-2 sm:mx-4 mb-1 border border-terminal/40 bg-void rounded-sm overflow-hidden shadow-lg">
            <div className="px-2 py-1 text-[8px] uppercase tracking-widest text-text-dim border-b border-border/50">
                Show the GM an image
            </div>
            {matches.map((entry, i) => (
                <button
                    key={entry.id}
                    type="button"
                    // onMouseDown, not onClick: the textarea must not lose focus
                    // before the pick runs, or the caret restore lands nowhere.
                    onMouseDown={e => { e.preventDefault(); onPick(entry); }}
                    onMouseEnter={() => onHover(i)}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 text-left transition-colors ${i === activeIndex ? 'bg-terminal/10' : 'hover:bg-terminal/5'}`}
                >
                    <img src={entry.imageUrl} alt="" className="w-8 h-8 object-cover rounded border border-border shrink-0" />
                    <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-text-primary truncate">{entry.title}</span>
                        <span className="block text-[9px] text-text-dim truncate">{entry.caption}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

export function GalleryArmedChips({
    armed,
    onRemove,
}: {
    armed: ArmedGalleryRecall[];
    onRemove: (id: string) => void;
}) {
    if (armed.length === 0) return null;
    return (
        <div className="mx-2 sm:mx-4 mb-1 flex flex-wrap gap-1">
            {armed.map(entry => (
                <span
                    key={entry.id}
                    title={entry.caption}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-terminal/10 text-terminal border border-terminal/40 rounded"
                >
                    <ImageIcon size={9} />
                    {entry.title}
                    <button
                        type="button"
                        onClick={() => onRemove(entry.id)}
                        title="Do not show this one"
                        className="hover:text-danger transition-colors"
                    >
                        <X size={9} />
                    </button>
                </span>
            ))}
        </div>
    );
}

export function GallerySuggestions({
    suggestions,
    onAdd,
    onDismiss,
}: {
    suggestions: GalleryEntry[];
    onAdd: (entry: GalleryEntry) => void;
    onDismiss: (id: string) => void;
}) {
    if (suggestions.length === 0) return null;
    return (
        <div className="mx-2 sm:mx-4 mb-1 flex flex-wrap gap-1">
            {suggestions.map(entry => (
                <span
                    key={entry.id}
                    className="flex items-center gap-1.5 px-1.5 py-0.5 text-[9px] bg-void-lighter border border-border rounded text-text-dim"
                >
                    <ImageIcon size={9} />
                    <span>Show the GM <span className="text-text-primary">{entry.title}</span>?</span>
                    <button
                        type="button"
                        onClick={() => onAdd(entry)}
                        title="Show this image with your next message"
                        className="flex items-center gap-0.5 text-terminal hover:underline uppercase tracking-wider"
                    >
                        <Plus size={9} /> Add
                    </button>
                    <button
                        type="button"
                        onClick={() => onDismiss(entry.id)}
                        title="Not this time"
                        className="hover:text-text-primary transition-colors"
                    >
                        <X size={9} />
                    </button>
                </span>
            ))}
        </div>
    );
}
