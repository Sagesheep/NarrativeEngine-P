import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreCategory, LoreChunk } from '../../types';
import { buildLoreEntry } from '../../services/lore/loreChunker';
import { uid } from '../../utils/uid';

const button = 'px-3 py-2 text-xs border border-terminal/40 text-terminal rounded hover:bg-terminal/10 disabled:opacity-40';
const field = 'block w-full mt-1 bg-surface border border-border rounded p-2 text-xs text-text-primary placeholder:text-text-dim/40 focus:outline-none focus:border-terminal';

const CATEGORIES: LoreCategory[] = [
    'world_overview', 'faction', 'location', 'character', 'power_system',
    'economy', 'event', 'relationship', 'rules', 'culture', 'misc',
];

type MatchMode = '' | NonNullable<LoreChunk['ragMode']>;

/**
 * Add one lore entry to the running campaign by hand. The entry is appended to
 * the campaign's lore and saved like any other edit; the server indexes just
 * the new entry for semantic recall.
 */
export function NewLoreEntryForm({ campaignId }: { campaignId: string }) {
    const [open, setOpen] = useState(false);
    const [header, setHeader] = useState('');
    const [content, setContent] = useState('');
    const [category, setCategory] = useState<LoreCategory | ''>('');
    const [keywords, setKeywords] = useState('');
    const [mode, setMode] = useState<MatchMode>('');
    const [error, setError] = useState('');
    const [added, setAdded] = useState('');

    const reset = () => {
        setHeader(''); setContent(''); setCategory(''); setKeywords(''); setMode(''); setError('');
    };

    const save = () => {
        if (!header.trim() || !content.trim()) {
            setError('Give the entry a title and some text.');
            return;
        }
        const state = useAppStore.getState();
        if (state.activeCampaignId !== campaignId) {
            setError('The active campaign changed. Open the Lore tab again.');
            return;
        }
        const entry = buildLoreEntry({
            header,
            content,
            category: category || undefined,
            keywords: keywords.split(','),
            ragMode: mode || undefined,
        }, state.loreChunks, uid());
        state.setLoreChunks([...state.loreChunks, entry]);
        setAdded(entry.header);
        reset();
        setOpen(false);
    };

    if (!open) {
        return (
            <div className="flex flex-wrap items-center gap-2">
                <button className={button} onClick={() => { setAdded(''); setOpen(true); }}>+ New lore entry</button>
                {added && <span role="status" className="text-xs text-terminal">Added “{added}”.</span>}
            </div>
        );
    }

    return (
        <section className="border border-border rounded p-3 space-y-3 bg-void" aria-label="New lore entry">
            <span className="text-xs text-text-primary font-bold">New lore entry</span>
            <label className="block text-xs text-text-dim">Title
                <input className={field} value={header} onChange={e => setHeader(e.target.value)}
                    placeholder="e.g. The Ashen Pact" autoFocus />
            </label>
            <label className="block text-xs text-text-dim">Text
                <textarea className={`${field} min-h-[120px] resize-y font-mono`} value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="What the story should know about it." />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-xs text-text-dim">Category
                    <select className={field} value={category} onChange={e => setCategory(e.target.value as LoreCategory | '')}>
                        <option value="">auto (detect from text)</option>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
                    </select>
                </label>
                <label className="block text-xs text-text-dim">Match
                    <select className={field} value={mode} onChange={e => setMode(e.target.value as MatchMode)}>
                        <option value="">auto</option>
                        <option value="vector">vector</option>
                        <option value="keyword">keyword</option>
                        <option value="always">always</option>
                    </select>
                </label>
            </div>
            <label className="block text-xs text-text-dim">Keywords (comma separated, optional)
                <input className={field} value={keywords} onChange={e => setKeywords(e.target.value)}
                    placeholder="ashen pact, ember lords" />
            </label>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
                <button className={button} onClick={save}>Add entry</button>
                <button className="px-3 py-2 text-xs text-text-dim hover:text-text-primary"
                    onClick={() => { reset(); setOpen(false); }}>Cancel</button>
            </div>
        </section>
    );
}
