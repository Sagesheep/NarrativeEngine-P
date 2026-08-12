import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreChunk } from '../../types';

export function LoreTab() {
    const loreChunks = useAppStore((s) => s.loreChunks);
    const updateLoreChunk = useAppStore((s) => s.updateLoreChunk);
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
    // WO-12.3b — per-chunk content preview (desktop-native nicety).
    // Mirror of the inline-expand pattern used in ChapterCard/FactsView.
    const [expandedContent, setExpandedContent] = useState<Record<string, boolean>>({});

    const bulkModeIsOn = (mode: 'vector' | 'keyword' | 'always' | 'auto') => {
        if (loreChunks.length === 0) return false;
        if (mode === 'auto') {
            return loreChunks.filter(c => c.ragMode === undefined && !c.disabled).length >= loreChunks.length / 2;
        }
        return loreChunks.filter(c => c.ragMode === mode && !c.disabled).length >= loreChunks.length / 2;
    };

    const bulkToggleMode = (mode: 'vector' | 'keyword' | 'always' | 'auto') => {
        if (loreChunks.length === 0) return;
        if (mode === 'auto') {
            loreChunks.forEach(chunk => {
                updateLoreChunk(chunk.id, { ragMode: undefined, disabled: false });
            });
            return;
        }

        const withMode = loreChunks.filter(c => c.ragMode === mode && !c.disabled).length;
        const turnOn = withMode < loreChunks.length / 2;
        loreChunks.forEach(chunk => {
            if (turnOn) {
                updateLoreChunk(chunk.id, { ragMode: mode, disabled: false });
            } else {
                updateLoreChunk(chunk.id, { ragMode: undefined, disabled: false });
            }
        });
    };

    const bulkDisableAll = () => {
        if (loreChunks.length === 0) return;
        loreChunks.forEach(chunk => {
            updateLoreChunk(chunk.id, { disabled: true });
        });
    };

    const addKeyword = (chunkId: string) => {
        const kw = (newKeyword[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        if (chunk.triggerKeywords.includes(kw)) return;
        updateLoreChunk(chunkId, { triggerKeywords: [...chunk.triggerKeywords, kw] });
        setNewKeyword(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeKeyword = (chunkId: string, kw: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        updateLoreChunk(chunkId, { triggerKeywords: chunk.triggerKeywords.filter(k => k !== kw) });
    };

    const renderChunk = (chunk: LoreChunk) => (
        <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${chunk.disabled ? 'opacity-50 border-border' : chunk.alwaysInclude ? 'border-terminal/40 shadow-[0_0_10px_rgba(74,222,128,0.05)]' : 'border-border'}`}>
            {/* Header row */}
            <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                    {chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim()}
                </span>
                <span className="text-[11px] text-text-dim shrink-0">
                    {chunk.tokens}tk
                </span>
            </div>

            {/* Meta badges row */}
            <div className="flex flex-wrap items-center gap-1 mb-2">
                <span className="px-1.5 py-0.5 rounded bg-terminal/10 text-terminal text-[8px] uppercase tracking-wider font-bold">
                    {chunk.category || 'misc'}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-void text-text-dim text-[8px] uppercase tracking-wider border border-border" title="Priority level">
                    P{chunk.priority || 5}
                </span>
                {(chunk.linkedEntities || []).slice(0, 2).map((link, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-void text-text-dim text-[8px] border border-border truncate max-w-[80px]" title={`Links to: ${link}`}>
                        🔗 {link}
                    </span>
                ))}
                {(chunk.linkedEntities?.length || 0) > 2 && (
                    <span className="px-1.5 py-0.5 rounded bg-void text-text-dim text-[8px] border border-border" title={`${chunk.linkedEntities!.length - 2} more links`}>
                        +{(chunk.linkedEntities?.length || 0) - 2}
                    </span>
                )}
                {/* WO-12.3b — Inline content preview toggle. Desktop-native nicety;
                    mirrors the inline-expand pattern in ChapterCard/FactsView. */}
                <button
                    onClick={() => setExpandedContent(prev => ({ ...prev, [chunk.id]: !prev[chunk.id] }))}
                    className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-void text-text-dim text-[8px] uppercase tracking-wider border border-border hover:text-terminal hover:border-terminal/40 transition-colors"
                    title={expandedContent[chunk.id] ? 'Hide full chunk content' : 'Preview full chunk content'}
                >
                    {expandedContent[chunk.id] ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
                    {expandedContent[chunk.id] ? 'Hide' : 'Preview'}
                </button>
            </div>

            {/* WO-12.3b — Inline content preview body. Shown when toggled open.
                Renders the raw chunk.content verbatim in a scrollable monospace
                block to match the terminal aesthetic and avoid layout blow-up
                on very long chunks. */}
            {expandedContent[chunk.id] && (
                <div className="mb-2 border border-border/60 rounded bg-surface/50 overflow-hidden">
                    <div className="px-2 py-1 border-b border-border/40 bg-void/40">
                        <span className="text-[8px] text-text-dim uppercase tracking-wider font-bold">
                            Content · {chunk.tokens}tk
                        </span>
                    </div>
                    <pre className="px-2 py-2 text-[12px] text-text-primary/90 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto leading-relaxed">
{chunk.content}
                    </pre>
                </div>
            )}

            {/* Controls row */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <label className="flex items-center gap-1 text-[11px] text-text-dim cursor-pointer">
                    <input
                        type="checkbox"
                        checked={chunk.alwaysInclude}
                        onChange={() => updateLoreChunk(chunk.id, { alwaysInclude: !chunk.alwaysInclude })}
                        className="w-3 h-3 accent-terminal"
                    />
                    Always
                </label>
                <label className="flex items-center gap-1 text-[11px] text-text-dim">
                    Depth:
                    <select
                        value={chunk.scanDepth || 3}
                        onChange={(e) => updateLoreChunk(chunk.id, { scanDepth: parseInt(e.target.value) })}
                        className="bg-surface border border-border rounded px-1 py-0.5 text-[11px] text-text-primary"
                    >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                    </select>
                </label>
                {/* WO-11.8 — Per-chunk RAG activation mode. Authoritative over
                    heuristics; 'always' is the explicit equivalent of the
                    alwaysInclude checkbox for the hybrid retrieval path. */}
                <label className="flex items-center gap-1 text-[11px] text-text-dim">
                    Match:
                    <select
                        value={chunk.disabled ? 'disabled' : (chunk.ragMode ?? '')}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (val === 'disabled') {
                                updateLoreChunk(chunk.id, { disabled: true });
                            } else {
                                updateLoreChunk(chunk.id, { disabled: false, ragMode: (val || undefined) as LoreChunk['ragMode'] });
                            }
                        }}
                        className="bg-surface border border-border rounded px-1 py-0.5 text-[11px] text-text-primary"
                        title="How this chunk is matched during hybrid retrieval. Blank = auto (heuristics decide)."
                    >
                        <option value="">auto</option>
                        <option value="vector">vector</option>
                        <option value="keyword">keyword</option>
                        <option value="always">always</option>
                        <option value="disabled">disabled</option>
                    </select>
                </label>
            </div>

            {/* Keywords */}
            <div className="flex flex-wrap gap-1 mb-1.5">
                {(chunk.triggerKeywords || []).map((kw) => (
                    <span
                        key={kw}
                        className="inline-flex items-center gap-0.5 bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-dim hover:border-danger group cursor-pointer"
                        onClick={() => removeKeyword(chunk.id, kw)}
                        title="Click to remove"
                    >
                        {kw}
                        <span className="text-danger opacity-0 group-hover:opacity-100 text-[8px]">×</span>
                    </span>
                ))}
            </div>

            {/* Add keyword input */}
            <div className="flex gap-1">
                <input
                    type="text"
                    value={newKeyword[chunk.id] || ''}
                    onChange={(e) => setNewKeyword(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(chunk.id); } }}
                    placeholder="+ keyword"
                    className="flex-1 bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-primary placeholder:text-text-dim/40"
                />
                <button
                    onClick={() => addKeyword(chunk.id)}
                    className="text-[11px] text-terminal hover:text-text-primary px-1"
                >
                    +
                </button>
            </div>
        </div>
    );

    return (
        <div className="px-4 py-4 space-y-4">
            <div className="space-y-1">
                <p className="text-[11px] text-text-dim/50">
                    Chunks trigger when keywords appear in recent messages
                </p>
                {loreChunks.length > 0 && (
                    <div className="flex items-center gap-1.5 pt-2 flex-wrap">
                        <span className="text-[8px] text-text-dim/60 uppercase tracking-wider shrink-0">Bulk:</span>
                        {(['auto', 'vector', 'keyword', 'always'] as const).map(mode => {
                            const on = bulkModeIsOn(mode);
                            return (
                                <button
                                    key={mode}
                                    onClick={() => bulkToggleMode(mode)}
                                    title={`${on ? 'Turn off' : 'Turn on'} ${mode} for all chunks`}
                                    className={`flex-1 py-1.5 md:py-1 text-[11px] uppercase tracking-wider rounded border transition-colors min-w-[55px] ${
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
                            title="Disable all chunks (never retrieve)"
                            className="flex-1 py-1.5 md:py-1 text-[11px] uppercase tracking-wider rounded bg-surface text-text-dim hover:text-danger hover:bg-danger/10 transition-colors min-w-[70px]"
                        >
                            Disable All
                        </button>
                    </div>
                )}
            </div>
            {loreChunks.length === 0 ? (
                <p className="text-text-dim/50 text-xs text-center mt-8">
                    No lore uploaded for this campaign.
                </p>
            ) : (
                <div className="space-y-3">
                    {(() => {
                        const alwaysOn = loreChunks.filter(c => c.alwaysInclude);
                        const conditional = loreChunks.filter(c => !c.alwaysInclude);

                        return (
                            <>
                                {alwaysOn.length > 0 && (
                                    <div className="space-y-2 mb-4">
                                        <div className="text-[12px] text-terminal uppercase tracking-wider font-bold mb-1 border-b border-terminal/20 pb-1 flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                                            Always On
                                        </div>
                                        {alwaysOn.map(renderChunk)}
                                    </div>
                                )}
                                {conditional.length > 0 && (
                                    <div className="space-y-2">
                                        <div className="text-[12px] text-text-dim uppercase tracking-wider font-bold mb-1 border-b border-border/50 pb-1 flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-text-dim/50" />
                                            Conditional Triggers
                                        </div>
                                        {conditional.map(renderChunk)}
                                    </div>
                                )}
                            </>
                        );
                    })()}
                </div>
            )}
        </div>
    );
}
