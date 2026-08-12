import { useState, useEffect, useCallback } from 'react';
import { X, Plus, RotateCcw, Search, Sliders } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreChunk, RuleChunkMeta } from '../../types';
import { chunkLoreFile } from '../../services/lore/loreChunker';
import { indexRules, deriveDefaultMeta, type IndexingProgress } from '../../services/rules/rulesIndexer';
import { ScreenSection } from '../primitives/ScreenSection';

type ChunkWithMeta = {
    chunk: LoreChunk;
    meta: RuleChunkMeta;
};

export function RulesManagerTab({ onBack }: { onBack?: () => void }) {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const settings = useAppStore((s) => s.settings);
    const getUtilityEndpoint = useAppStore((s) => s.getActiveUtilityEndpoint);

    const [chunksWithMeta, setChunksWithMeta] = useState<ChunkWithMeta[]>([]);
    const [indexing, setIndexing] = useState(false);
    const [progress, setProgress] = useState<IndexingProgress | null>(null);
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
    const [newSecondary, setNewSecondary] = useState<Record<string, string>>({});
    const [confirmRegenId, setConfirmRegenId] = useState<string | null>(null);
    // WO-screen-modernization §1 — sticky-header search. A live ruleset
    // produces dozens of chunks; this filter mirrors the pattern in Lore.
    const [query, setQuery] = useState('');

    const parseChunks = useCallback(() => {
        if (!context.rulesRaw) {
            setChunksWithMeta([]);
            return;
        }
        const chunks = chunkLoreFile(context.rulesRaw);
        const meta = context.rulesChunkMeta ?? {};
        const combined: ChunkWithMeta[] = chunks.map(chunk => ({
            chunk,
            meta: meta[chunk.id] ?? deriveDefaultMeta(chunk),
        }));
        setChunksWithMeta(combined);
    }, [context.rulesRaw, context.rulesChunkMeta]);

    useEffect(() => {
        parseChunks();
    }, [parseChunks]);

    const runIndex = async () => {
        if (!activeCampaignId || !context.rulesRaw) return;
        setIndexing(true);
        try {
            const utilityEndpoint = getUtilityEndpoint();
            const autoGen = settings.autoGenerateRuleKeywords ?? true;
            const result = await indexRules(
                activeCampaignId,
                context.rulesRaw,
                context.rulesChunkMeta,
                utilityEndpoint?.endpoint ? utilityEndpoint : undefined,
                autoGen,
                (p) => setProgress(p)
            );
            updateContext({ rulesChunkMeta: result.chunkMeta });
            const combined: ChunkWithMeta[] = result.chunks.map(chunk => ({
                chunk,
                meta: result.chunkMeta[chunk.id] ?? deriveDefaultMeta(chunk),
            }));
            setChunksWithMeta(combined);
        } catch (e) {
            console.warn('[RulesManager] Indexing failed:', e);
        } finally {
            setIndexing(false);
            setProgress(null);
        }
    };

    const updateMeta = (chunkId: string, patch: Partial<RuleChunkMeta>) => {
        const currentMeta = context.rulesChunkMeta ?? {};
        const existing = currentMeta[chunkId] ?? chunksWithMeta.find(c => c.chunk.id === chunkId)?.meta;
        if (!existing) return;

        const updated = { ...existing, ...patch };
        const newMeta = { ...currentMeta, [chunkId]: updated };
        updateContext({ rulesChunkMeta: newMeta });

        setChunksWithMeta(prev => prev.map(c =>
            c.chunk.id === chunkId ? { ...c, meta: updated } : c
        ));
    };

    const toggleMode = (chunkId: string, mode: 'vector' | 'keyword' | 'always') => {
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        const modes = cwm.meta.activationModes.includes(mode)
            ? cwm.meta.activationModes.filter(m => m !== mode)
            : [...cwm.meta.activationModes, mode];
        if (modes.length === 0) return;
        updateMeta(chunkId, { activationModes: modes });
    };

    const persistBulk = (resolve: (meta: RuleChunkMeta) => ('vector' | 'keyword' | 'always')[]) => {
        const currentMeta = context.rulesChunkMeta ?? {};
        const newMeta = { ...currentMeta };
        for (const cwm of chunksWithMeta) {
            const existing = currentMeta[cwm.chunk.id] ?? cwm.meta;
            newMeta[cwm.chunk.id] = { ...existing, activationModes: resolve(existing) };
        }
        updateContext({ rulesChunkMeta: newMeta });
        setChunksWithMeta(prev => prev.map(c => ({ ...c, meta: { ...c.meta, activationModes: resolve(c.meta) } })));
    };

    const bulkToggleMode = (mode: 'vector' | 'keyword' | 'always') => {
        if (chunksWithMeta.length === 0) return;
        const withMode = chunksWithMeta.filter(c => c.meta.activationModes.includes(mode)).length;
        const turnOn = withMode < chunksWithMeta.length / 2;
        persistBulk(meta => {
            const has = meta.activationModes.includes(mode);
            return turnOn
                ? (has ? meta.activationModes : [...meta.activationModes, mode])
                : meta.activationModes.filter(m => m !== mode);
        });
    };

    const bulkDisableAll = () => {
        if (chunksWithMeta.length === 0) return;
        persistBulk(() => []);
    };

    const bulkModeIsOn = (mode: 'vector' | 'keyword' | 'always') =>
        chunksWithMeta.length > 0 &&
        chunksWithMeta.filter(c => c.meta.activationModes.includes(mode)).length >= chunksWithMeta.length / 2;

    const addKeyword = (chunkId: string) => {
        const kw = (newKeyword[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        if ((cwm.meta.triggerKeywords ?? []).includes(kw)) return;
        updateMeta(chunkId, {
            triggerKeywords: [...(cwm.meta.triggerKeywords ?? []), kw],
            keywordsUserEdited: true,
        });
        setNewKeyword(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeKeyword = (chunkId: string, kw: string) => {
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        updateMeta(chunkId, {
            triggerKeywords: (cwm.meta.triggerKeywords ?? []).filter(k => k !== kw),
            keywordsUserEdited: true,
        });
    };

    const addSecondaryKeyword = (chunkId: string) => {
        const kw = (newSecondary[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        if ((cwm.meta.secondaryKeywords ?? []).includes(kw)) return;
        updateMeta(chunkId, {
            secondaryKeywords: [...(cwm.meta.secondaryKeywords ?? []), kw],
            keywordsUserEdited: true,
        });
        setNewSecondary(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeSecondaryKeyword = (chunkId: string, kw: string) => {
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        updateMeta(chunkId, {
            secondaryKeywords: (cwm.meta.secondaryKeywords ?? []).filter(k => k !== kw),
            keywordsUserEdited: true,
        });
    };

    const regenerateKeywords = (chunkId: string) => {
        const cwm = chunksWithMeta.find(c => c.chunk.id === chunkId);
        if (!cwm) return;
        if (cwm.meta.keywordsUserEdited && confirmRegenId !== chunkId) {
            setConfirmRegenId(chunkId);
            return;
        }
        const fresh = deriveDefaultMeta(cwm.chunk);
        updateMeta(chunkId, {
            triggerKeywords: fresh.triggerKeywords,
            secondaryKeywords: fresh.secondaryKeywords,
            keywordsUserEdited: false,
        });
        setConfirmRegenId(null);
    };

    const renderChunk = (cwm: ChunkWithMeta) => {
        const { chunk, meta } = cwm;
        const isAlways = meta.activationModes.includes('always');
        const isKeyword = meta.activationModes.includes('keyword');
        const isVector = meta.activationModes.includes('vector');

        return (
            <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${isAlways ? 'border-terminal/40' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                        {chunk.header}
                    </span>
                    <span className="text-[11px] text-text-dim shrink-0">
                        {chunk.tokens}tk
                    </span>
                </div>

                <div className="flex items-center gap-3 mb-1.5">
                    <label className="flex items-center gap-1 text-[11px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isVector}
                            onChange={() => toggleMode(chunk.id, 'vector')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Vector
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isKeyword}
                            onChange={() => toggleMode(chunk.id, 'keyword')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Keyword
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isAlways}
                            onChange={() => toggleMode(chunk.id, 'always')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Always
                    </label>
                </div>

                {isKeyword && (
                    <div className="mb-1.5">
                        <div className="text-[11px] text-text-dim uppercase tracking-wider mb-0.5">Secondary (AND-gate)</div>
                        <div className="flex flex-wrap gap-1 mb-1">
                            {(meta.secondaryKeywords ?? []).map(kw => (
                                <span
                                    key={kw}
                                    className="inline-flex items-center gap-1 bg-surface border border-terminal/30 rounded px-1.5 py-0.5 text-[11px] text-terminal-dim hover:border-danger cursor-pointer"
                                    onClick={() => removeSecondaryKeyword(chunk.id, kw)}
                                    title="Click to remove"
                                >
                                    {kw}
                                    <X size={8} />
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-1">
                            <input
                                type="text"
                                value={newSecondary[chunk.id] || ''}
                                onChange={(e) => setNewSecondary(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSecondaryKeyword(chunk.id); } }}
                                placeholder="+ secondary kw"
                                className="flex-1 bg-surface border border-border rounded px-2 py-1 md:py-0.5 text-[16px] md:text-[11px] text-text-primary placeholder:text-text-dim/40 min-h-[36px] md:min-h-0"
                            />
                            <button
                                onClick={() => addSecondaryKeyword(chunk.id)}
                                className="text-[12px] md:text-[11px] text-terminal hover:text-text-primary px-2 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                            >
                                <Plus size={10} />
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap gap-1 mb-1.5">
                    {(meta.triggerKeywords ?? []).map(kw => (
                        <span
                            key={kw}
                            className="inline-flex items-center gap-1 bg-surface border border-border rounded px-2.5 md:px-1.5 py-1.5 md:py-0.5 text-xs md:text-[11px] text-text-dim hover:border-danger group cursor-pointer min-h-[32px] md:min-h-0"
                            onClick={() => removeKeyword(chunk.id, kw)}
                            title="Click to remove"
                        >
                            {kw}
                            <span className="text-danger opacity-100 md:opacity-0 md:group-hover:opacity-100 text-[12px] md:text-[11px]">×</span>
                        </span>
                    ))}
                </div>

                <div className="flex gap-1">
                    <input
                        type="text"
                        value={newKeyword[chunk.id] || ''}
                        onChange={(e) => setNewKeyword(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(chunk.id); } }}
                        placeholder="+ keyword"
                        className="flex-1 bg-surface border border-border rounded px-3 py-2 md:py-0.5 text-[16px] md:text-[11px] text-text-primary placeholder:text-text-dim/40 min-h-[44px] md:min-h-0"
                    />
                    <button
                        onClick={() => addKeyword(chunk.id)}
                        className="text-[14px] md:text-[11px] text-terminal hover:text-text-primary px-3 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                    >
                        <Plus size={10} />
                    </button>
                    <button
                        onClick={() => regenerateKeywords(chunk.id)}
                        onBlur={() => setConfirmRegenId(null)}
                        className={`text-[11px] transition-colors ${
                            confirmRegenId === chunk.id
                                ? 'text-danger font-bold'
                                : 'text-text-dim hover:text-terminal'
                        }`}
                        title={confirmRegenId === chunk.id ? 'Click again to confirm — this discards your keyword edits' : meta.keywordsUserEdited ? 'Regenerate keywords (discards edits)' : 'Regenerate keywords'}
                    >
                        {confirmRegenId === chunk.id ? 'Confirm?' : <RotateCcw size={10} />}
                    </button>
                </div>
            </div>
        );
    };

    // WO-screen-modernization §1 — search across the chunk header and
    // trigger keywords. Case-insensitive substring.
    const filtered = query.trim()
        ? chunksWithMeta.filter(c => {
            const q = query.toLowerCase();
            return c.chunk.header.toLowerCase().includes(q)
                || (c.meta.triggerKeywords ?? []).some(k => k.toLowerCase().includes(q))
                || (c.meta.secondaryKeywords ?? []).some(k => k.toLowerCase().includes(q));
        })
        : chunksWithMeta;
    const filteredAlways = filtered.filter(c => c.meta.activationModes.includes('always'));
    const filteredConditional = filtered.filter(c => !c.meta.activationModes.includes('always'));

    const totalTokens = chunksWithMeta.reduce((sum, c) => sum + c.chunk.tokens, 0);
    const rulesBudget = Math.floor((settings.contextLimit || 8192) * (settings.rulesBudgetPct ?? 0.10));

    return (
        // Shape B — Collection. Width comes from the lightbox (`wide`); the
        // layout here is a sticky-header search + a responsive card grid
        // that tiles 1 / 2 / 3 columns at md / xl / 2xl. Count badge matches
        // the nav drawer's badge.
        <div className="flex flex-col h-full space-y-4 font-mono">
            <div className="sticky top-0 z-10 bg-surface -mx-4 sm:-mx-6 px-4 sm:px-6 pt-1 pb-3 space-y-2">
                <ScreenSection
                    icon={Sliders}
                    label="Rules Chunk Manager"
                    count={chunksWithMeta.length}
                    rightSlot={
                        onBack ? (
                            <button onClick={onBack} className="text-[11px] text-text-dim hover:text-text-primary">
                                ← Back
                            </button>
                        ) : undefined
                    }
                />

                <div className="text-[11px] text-text-dim/70 space-y-1">
                    <div>Total rules: {totalTokens} tokens across {chunksWithMeta.length} chunks</div>
                    <div>RAG budget: {rulesBudget} tokens/turn (threshold: {Math.floor(rulesBudget * 1.2)} tokens)</div>
                </div>

                <button
                    onClick={runIndex}
                    disabled={indexing || !context.rulesRaw}
                    className={`w-full py-2 text-[12px] uppercase tracking-wider font-bold rounded transition-colors ${
                        indexing
                            ? 'bg-surface text-text-dim cursor-not-allowed'
                            : 'bg-terminal/10 text-terminal hover:bg-terminal/20'
                    }`}
                >
                    {indexing
                        ? `Indexing... ${progress ? `${progress.current}/${progress.total} (${progress.phase})` : ''}`
                        : 'Re-index Rules'}
                </button>

                {indexing && progress && (
                    <div className="h-1 bg-void-lighter rounded overflow-hidden">
                        <div
                            className="h-full bg-terminal transition-all duration-200"
                            style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                        />
                    </div>
                )}

                {chunksWithMeta.length > 0 && (
                    <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                        <span className="text-[11px] text-text-dim/60 uppercase tracking-wider shrink-0">Bulk:</span>
                        {(['vector', 'keyword', 'always'] as const).map(mode => {
                            const on = bulkModeIsOn(mode);
                            return (
                                <button
                                    key={mode}
                                    onClick={() => bulkToggleMode(mode)}
                                    title={`${on ? 'Turn off' : 'Turn on'} ${mode} for all chunks`}
                                    className={`flex-1 py-1.5 md:py-1 text-[11px] uppercase tracking-wider rounded border transition-colors ${
                                        on
                                            ? 'bg-terminal/15 text-terminal border-terminal/40'
                                            : 'bg-surface text-text-dim border-transparent hover:text-terminal hover:bg-terminal/10'
                                    }`}
                                >
                                    {mode}
                                </button>
                            );
                        })}
                        <button
                            onClick={bulkDisableAll}
                            title="Disable all chunks (clears every mode)"
                            className="flex-1 py-1.5 md:py-1 text-[11px] uppercase tracking-wider rounded bg-surface text-text-dim hover:text-danger hover:bg-danger/10 transition-colors"
                        >
                            Disable All
                        </button>
                    </div>
                )}

                {chunksWithMeta.length > 0 && (
                    <div className="relative">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Filter by header or keyword..."
                            className="w-full pl-8 pr-8 py-1.5 bg-void border border-border rounded text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors"
                        />
                        {query && (
                            <button
                                onClick={() => setQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary transition-colors"
                                aria-label="Clear filter"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {chunksWithMeta.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 opacity-40">
                    <Sliders size={48} strokeWidth={1} />
                    <p className="text-xs font-mono uppercase tracking-tighter">No rules to manage.</p>
                    <p className="text-[11px] text-text-dim/60 max-w-[300px] leading-relaxed normal-case tracking-normal">
                        Paste rules in the System tab first, then come back here to manage chunks.
                    </p>
                </div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center space-y-2 opacity-60">
                    <Search size={32} strokeWidth={1} />
                    <p className="text-xs font-mono uppercase tracking-tighter">No chunks match "{query}".</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                    {filteredAlways.length > 0 && (
                        <div className="space-y-2 md:col-span-2 2xl:col-span-3">
                            <ScreenSection label="Always On" tone="terminal" count={filteredAlways.length} marker />
                            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                                {filteredAlways.map(renderChunk)}
                            </div>
                        </div>
                    )}
                    {filteredConditional.length > 0 && (
                        <div className="space-y-2 md:col-span-2 2xl:col-span-3">
                            <ScreenSection label="Conditional" count={filteredConditional.length} marker />
                            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                                {filteredConditional.map(renderChunk)}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
