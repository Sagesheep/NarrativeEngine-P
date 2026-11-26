import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreCategory, LoreChunk } from '../../types';
import { reviseLoreEntry } from '../../services/lore/loreChunker';
import { button, CATEGORIES, field } from './loreFormStyles';
import { cleanFolder, folderNames } from './loreFilters';

const CHUNK_TAG = /^\s*\[CHUNK:\s*[A-Z_]+[—\-\s]*\]\s*/i;

/**
 * Edit an existing lore entry's title, text and category in place. Imported
 * headers carry a "[CHUNK: TYPE —]" tag; it is hidden while editing and put
 * back on save. The server re-embeds the entry because its text changed.
 */
export function LoreEntryEditor({ chunk, campaignId, onDone }: {
    chunk: LoreChunk;
    campaignId: string;
    onDone: () => void;
}) {
    const tag = chunk.header.match(CHUNK_TAG)?.[0] ?? '';
    const [header, setHeader] = useState(chunk.header.slice(tag.length));
    const [content, setContent] = useState(chunk.content);
    const [category, setCategory] = useState<LoreCategory>(chunk.category || 'misc');
    const [folder, setFolder] = useState(chunk.folder ?? '');
    const allChunks = useAppStore(s => s.loreChunks);
    const [error, setError] = useState('');

    const save = () => {
        if (!header.trim() || !content.trim()) {
            setError('The entry needs a title and some text.');
            return;
        }
        const state = useAppStore.getState();
        if (state.activeCampaignId !== campaignId) {
            setError('The active campaign changed. Open the Lore tab again.');
            return;
        }
        const current = state.loreChunks.find(c => c.id === chunk.id);
        if (!current) {
            setError('This entry was deleted.');
            return;
        }
        const revised = reviseLoreEntry(current, {
            header: tag + header.trim(),
            content,
            category: category === current.category ? undefined : category,
        }, state.loreChunks);
        revised.folder = cleanFolder(folder);
        state.setLoreChunks(state.loreChunks.map(c => (c.id === chunk.id ? revised : c)));
        onDone();
    };

    return (
        <section className="mb-2 border border-terminal/40 rounded p-2 space-y-2 bg-surface/50" aria-label={`Edit ${header || 'lore entry'}`}>
            <label className="block text-[11px] text-text-dim">Title
                <input className={field} value={header} onChange={e => setHeader(e.target.value)} autoFocus />
            </label>
            <label className="block text-[11px] text-text-dim">Text
                <textarea className={`${field} min-h-[160px] resize-y font-mono`} value={content}
                    onChange={e => setContent(e.target.value)} />
            </label>
            <label className="block text-[11px] text-text-dim">Category
                <select className={field} value={category} onChange={e => setCategory(e.target.value as LoreCategory)}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
                </select>
            </label>
            <label className="block text-[11px] text-text-dim">Folder (your own sorting, e.g. Vehicles; optional)
                <input className={field} value={folder} onChange={e => setFolder(e.target.value)}
                    list={`lore-folders-${chunk.id}`} placeholder="none" />
                <datalist id={`lore-folders-${chunk.id}`}>
                    {folderNames(allChunks).map(name => <option key={name} value={name} />)}
                </datalist>
            </label>
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
                <button className={button} onClick={save}>Save</button>
                <button className="px-3 py-2 text-xs text-text-dim hover:text-text-primary" onClick={onDone}>Cancel</button>
            </div>
        </section>
    );
}
