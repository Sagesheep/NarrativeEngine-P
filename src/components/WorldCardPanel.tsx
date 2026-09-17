import { useRef, useState } from 'react';
import type { WorldCard, WorldImport } from '../services/lore/worldCard';
import { readWorldFile } from '../services/lore/worldCard';
import { encodeWorldPayload } from '../services/lore/worldCardPng';
import { downloadWorldFile, worldCardBlob } from '../services/lore/worldCardBrowser';

type Props = {
    getExportCard: (() => WorldCard) | null;
    onImport: (result: WorldImport) => void;
    importLabel: string;
};
const button = 'px-3 py-2 text-xs border border-terminal/40 text-terminal rounded hover:bg-terminal/10 disabled:opacity-40';

/** Inline review keeps the parent screen's focus/escape handling intact. */
export function WorldCardPanel({ getExportCard, onImport, importLabel }: Props) {
    const [review, setReview] = useState<WorldImport | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [worldName, setWorldName] = useState('');
    const [author, setAuthor] = useState('');
    const [description, setDescription] = useState('');
    const [cover, setCover] = useState<File>();
    const input = useRef<HTMLInputElement>(null);
    const generation = useRef(0);

    const importFile = async (file?: File) => {
        if (!file) return;
        const current = ++generation.current;
        setBusy(true); setError(''); setReview(null); setExporting(false);
        try {
            const result = await readWorldFile(file);
            if (generation.current === current) setReview(result);
        } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : 'Import failed.'); }
        finally { if (generation.current === current) setBusy(false); }
    };
    const exportFile = async (extension: 'png' | 'json') => {
        if (!getExportCard) return;
        setBusy(true); setError('');
        try {
            const card = getExportCard();
            card.world.name = worldName.trim() || card.world.name;
            card.world.author = author;
            card.world.description = description;
            encodeWorldPayload(card); // Apply the same data limit to both download formats.
            const blob = extension === 'png' ? await worldCardBlob(card, cover)
                : new Blob([JSON.stringify(card)], { type: 'application/json' });
            downloadWorldFile(blob, card.world.name, extension);
        } catch (e) { setError(e instanceof Error ? e.message : 'Export failed.'); }
        finally { setBusy(false); }
    };
    return <section className="border border-border rounded p-3 space-y-3 bg-void" aria-label="World lore sharing"
        onDragOver={e => { e.preventDefault(); }}
        onDrop={e => { e.preventDefault(); if (!busy) void importFile(e.dataTransfer.files[0]); }}>
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-primary font-bold mr-auto">World lore cards</span>
            <button className={button} disabled={busy} onClick={() => input.current?.click()}>Import world PNG / JSON</button>
            <button className={button} disabled={busy || !getExportCard} onClick={() => {
                try {
                    if (getExportCard) {
                        const card = getExportCard(); setWorldName(card.world.name); setAuthor(card.world.author); setDescription(card.world.description);
                    }
                    setExporting(v => !v); setReview(null); setError('');
                } catch (e) { setError(e instanceof Error ? e.message : 'Cannot export this world.'); }
            }}>Export world PNG</button>
            <input ref={input} className="hidden" type="file" accept=".png,.json" aria-label="World lore file"
                onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <p className="text-xs text-text-dim">Share a whole world in one PNG. Accepts Narrative Engine worlds and SillyTavern lorebooks. Drop a file here to preview it.</p>
        {busy && <p role="status" className="text-xs text-terminal">Processing world file…</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {exporting && <div className="space-y-3">
            <label className="block text-xs text-text-dim">World title
                <input className="block w-full bg-surface border border-border p-2 text-text-primary" value={worldName} onChange={e => setWorldName(e.target.value)} />
            </label>
            <label className="block text-xs text-text-dim">Author (optional)
                <input className="block w-full bg-surface border border-border p-2 text-text-primary" value={author} onChange={e => setAuthor(e.target.value)} />
            </label>
            <label className="block text-xs text-text-dim">World description (optional)
                <textarea className="block w-full bg-surface border border-border p-2 text-text-primary" value={description} onChange={e => setDescription(e.target.value)} />
            </label>
            <label className="block text-xs text-text-dim">Cover image (optional; otherwise a title cover is created)
                <input className="block mt-1" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setCover(e.target.files?.[0])} />
            </label>
            <p className="text-xs text-text-dim">Exports are Narrative Engine world files. Send the original file so its lore stays attached.</p>
            <div className="flex gap-2">
                <button className={button} disabled={busy} onClick={() => void exportFile('png')}>Download PNG</button>
                <button className={button} disabled={busy} onClick={() => void exportFile('json')}>Download JSON</button>
                <button className={button} disabled={busy} onClick={() => setExporting(false)}>Cancel</button>
            </div>
        </div>}
        {review && <div className="space-y-3 border-t border-border pt-3">
            <h3 className="text-sm font-bold text-text-primary">{review.card.world.name}</h3>
            <p className="text-xs text-text-dim">{review.source === 'native' ? 'Narrative Engine world' : 'SillyTavern lore import'} · {review.card.world.chunks.length} entries · {review.card.world.chunks.filter(c => c.disabled).length} disabled</p>
            {review.card.world.author && <p className="text-xs text-text-dim">By {review.card.world.author}</p>}
            {review.card.world.description && <p className="text-sm text-text-primary whitespace-pre-wrap">{review.card.world.description}</p>}
            {review.warnings.map(w => <p key={w} className="text-xs text-amber-400">{w}</p>)}
            <details className="text-xs text-text-dim"><summary>Preview lore entries</summary>
                <div className="max-h-64 overflow-auto space-y-2 mt-2">{review.card.world.chunks.map(c => <div key={c.id}>
                    <strong>{c.header}{c.disabled ? ' (disabled)' : ''}</strong><p className="whitespace-pre-wrap">{c.content}</p>
                </div>)}</div>
            </details>
            <div className="flex gap-2">
                <button className={button} disabled={busy} onClick={() => {
                    try { onImport(review); setReview(null); setError(''); }
                    catch (e) { setError(e instanceof Error ? e.message : 'Could not save world.'); }
                }}>{importLabel}</button>
                <button className={button} onClick={() => setReview(null)}>Cancel</button>
            </div>
        </div>}
    </section>;
}
