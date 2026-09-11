import { useMemo, useState } from 'react';
import { X, Send, Trash2, Check, Sparkles, Upload as UploadIcon, Pencil } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { buildGallery } from '../services/gallery/galleryIndex';
import { toast } from './Toast';
import type { GalleryEntry, GallerySource } from '../types';

/**
 * The campaign's image gallery.
 *
 * Every picture here already has text attached — a vision caption for uploads,
 * the generating prompt for scene images. Selecting entries and pressing
 * "Append to Story AI" arms those captions for the next message, which is the
 * point of the whole feature: show the GM the costume again at turn 700 without
 * paying to look at it a second time.
 *
 * Arming steers ONE turn and does not persist (see turnStages.ts) — recalling
 * the same image across a long campaign must not stack copies in history.
 */

const TABS: { id: GallerySource | 'all'; label: string; icon?: typeof Sparkles }[] = [
    { id: 'all', label: 'All' },
    { id: 'generated', label: 'AI Generated', icon: Sparkles },
    { id: 'uploaded', label: 'Uploaded', icon: UploadIcon },
];

export function GalleryModal() {
    const open = useAppStore(s => s.galleryOpen);
    const initialFilter = useAppStore(s => s.galleryFilter);
    const closeGallery = useAppStore(s => s.closeGallery);
    const messages = useAppStore(s => s.messages);
    const uploads = useAppStore(s => s.context.galleryUploads);
    const setArmedGalleryRecall = useAppStore(s => s.setArmedGalleryRecall);
    const updateGalleryEntry = useAppStore(s => s.updateGalleryEntry);
    const removeGalleryUpload = useAppStore(s => s.removeGalleryUpload);

    const [tab, setTab] = useState<GallerySource | 'all'>(initialFilter ?? 'all');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftTitle, setDraftTitle] = useState('');
    const [draftCaption, setDraftCaption] = useState('');

    const entries = useMemo(
        () => buildGallery(messages, uploads, tab === 'all' ? undefined : tab),
        [messages, uploads, tab],
    );

    if (!open) return null;

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleAppend = () => {
        const armed = entries
            .filter(e => selected.has(e.id) && e.caption.trim())
            .map(e => ({ id: e.id, title: e.title, caption: e.caption }));
        if (armed.length === 0) {
            toast.warning('Select at least one image with a description.');
            return;
        }
        setArmedGalleryRecall(armed);
        toast.success(
            armed.length === 1
                ? `"${armed[0].title}" will be shown to the GM with your next message.`
                : `${armed.length} images will be shown to the GM with your next message.`,
        );
        setSelected(new Set());
        closeGallery();
    };

    const startEdit = (entry: GalleryEntry) => {
        setEditingId(entry.id);
        setDraftTitle(entry.title);
        setDraftCaption(entry.caption);
    };

    const saveEdit = (entry: GalleryEntry) => {
        if (entry.source === 'generated') {
            // Derived entries have no stored row yet — persist one so the edit sticks.
            useAppStore.getState().addGalleryUpload({
                ...entry,
                title: draftTitle.trim() || entry.title,
                caption: draftCaption.trim(),
            });
        } else {
            updateGalleryEntry(entry.id, {
                title: draftTitle.trim() || entry.title,
                caption: draftCaption.trim(),
            });
        }
        setEditingId(null);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={closeGallery}>
            <div
                className="w-full max-w-5xl max-h-[85vh] flex flex-col bg-void border border-border rounded-sm shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-3">
                        <h2 className="text-terminal text-sm font-bold tracking-[0.25em] uppercase">Gallery</h2>
                        <span className="text-[10px] text-text-dim font-mono">{entries.length} image{entries.length === 1 ? '' : 's'}</span>
                    </div>
                    <button onClick={closeGallery} title="Close" className="text-text-dim hover:text-terminal transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex items-center gap-1 px-4 pt-3">
                    {TABS.map(t => {
                        const Icon = t.icon;
                        return (
                            <button
                                key={t.id}
                                onClick={() => setTab(t.id)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider rounded-sm border transition-colors ${tab === t.id
                                    ? 'border-terminal text-terminal bg-terminal/10'
                                    : 'border-border text-text-dim hover:text-terminal hover:border-terminal/50'}`}
                            >
                                {Icon && <Icon size={11} />}
                                {t.label}
                            </button>
                        );
                    })}
                </div>

                <div className="flex-1 overflow-y-auto p-4">
                    {entries.length === 0 ? (
                        <p className="text-center text-text-dim text-xs py-16">
                            Nothing here yet. Paste an image into the chat, or generate a scene image
                            from a highlighted passage — both land here automatically.
                        </p>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                            {entries.map(entry => {
                                const isSelected = selected.has(entry.id);
                                const isEditing = editingId === entry.id;
                                return (
                                    <div
                                        key={entry.id}
                                        className={`border rounded-sm overflow-hidden bg-void-lighter transition-colors ${isSelected ? 'border-terminal' : 'border-border'}`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggle(entry.id)}
                                            className="relative block w-full"
                                            title={entry.caption || 'No description'}
                                        >
                                            <img src={entry.imageUrl} alt={entry.title} className="w-full aspect-square object-cover" />
                                            {isSelected && (
                                                <span className="absolute top-1.5 right-1.5 bg-terminal text-void rounded-full p-0.5">
                                                    <Check size={12} />
                                                </span>
                                            )}
                                            <span className="absolute top-1.5 left-1.5 text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-void/80 text-text-dim">
                                                {entry.source === 'generated' ? 'AI' : 'Upload'}
                                            </span>
                                        </button>

                                        <div className="p-2">
                                            {isEditing ? (
                                                <>
                                                    <input
                                                        value={draftTitle}
                                                        onChange={e => setDraftTitle(e.target.value)}
                                                        placeholder="Name"
                                                        className="w-full bg-surface border border-border rounded px-1.5 py-1 text-[11px] text-text-primary mb-1 focus:outline-none focus:border-terminal"
                                                    />
                                                    <textarea
                                                        value={draftCaption}
                                                        onChange={e => setDraftCaption(e.target.value)}
                                                        rows={4}
                                                        placeholder="What the AI reads"
                                                        className="w-full bg-surface border border-border rounded px-1.5 py-1 text-[10px] text-text-primary resize-none focus:outline-none focus:border-terminal"
                                                    />
                                                    <div className="flex gap-1 mt-1">
                                                        <button onClick={() => saveEdit(entry)} className="flex-1 text-[9px] uppercase tracking-wider py-1 border border-terminal/50 text-terminal hover:bg-terminal/10 rounded">Save</button>
                                                        <button onClick={() => setEditingId(null)} className="flex-1 text-[9px] uppercase tracking-wider py-1 border border-border text-text-dim hover:text-text-primary rounded">Cancel</button>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <p className="text-[11px] text-text-primary truncate" title={entry.title}>{entry.title}</p>
                                                    <p className="text-[9px] text-text-dim line-clamp-2 mt-0.5">{entry.caption || 'No description'}</p>
                                                    <div className="flex items-center gap-2 mt-1.5">
                                                        <button onClick={() => startEdit(entry)} title="Edit name and description" className="text-text-dim hover:text-terminal transition-colors">
                                                            <Pencil size={11} />
                                                        </button>
                                                        {entry.source === 'uploaded' && (
                                                            <button
                                                                onClick={() => removeGalleryUpload(entry.id)}
                                                                title="Remove from gallery (the image file is kept)"
                                                                className="text-text-dim hover:text-danger transition-colors"
                                                            >
                                                                <Trash2 size={11} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                    <p className="text-[10px] text-text-dim">
                        {selected.size > 0
                            ? `${selected.size} selected — shown to the GM on your next message only.`
                            : 'Select images to hand back to the story AI.'}
                    </p>
                    <button
                        onClick={handleAppend}
                        disabled={selected.size === 0}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider rounded-sm border border-terminal text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        <Send size={12} />
                        Append to Story AI
                    </button>
                </div>
            </div>
        </div>
    );
}
