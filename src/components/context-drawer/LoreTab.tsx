import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreChunk } from '../../types';

export function LoreTab() {
    const loreChunks = useAppStore((s) => s.loreChunks);
    const updateLoreChunk = useAppStore((s) => s.updateLoreChunk);
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});

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
        <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${chunk.alwaysInclude ? 'border-terminal/40 shadow-[0_0_10px_rgba(74,222,128,0.05)]' : 'border-border'}`}>
            {/* Header row */}
            <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                    {chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim()}
                </span>
                <span className="text-[9px] text-text-dim shrink-0">
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
            </div>

            {/* Controls row */}
            <div className="flex items-center gap-2 mb-1.5">
                <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                    <input
                        type="checkbox"
                        checked={chunk.alwaysInclude}
                        onChange={() => updateLoreChunk(chunk.id, { alwaysInclude: !chunk.alwaysInclude })}
                        className="w-3 h-3 accent-terminal"
                    />
                    Always
                </label>
                <label className="flex items-center gap-1 text-[9px] text-text-dim">
                    Depth:
                    <select
                        value={chunk.scanDepth || 3}
                        onChange={(e) => updateLoreChunk(chunk.id, { scanDepth: parseInt(e.target.value) })}
                        className="bg-surface border border-border rounded px-1 py-0.5 text-[9px] text-text-primary"
                    >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                    </select>
                </label>
            </div>

            {/* Keywords */}
            <div className="flex flex-wrap gap-1 mb-1.5">
                {(chunk.triggerKeywords || []).map((kw) => (
                    <span
                        key={kw}
                        className="inline-flex items-center gap-0.5 bg-surface border border-border rounded px-1.5 py-0.5 text-[9px] text-text-dim hover:border-danger group cursor-pointer"
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
                    className="flex-1 bg-surface border border-border rounded px-1.5 py-0.5 text-[9px] text-text-primary placeholder:text-text-dim/40"
                />
                <button
                    onClick={() => addKeyword(chunk.id)}
                    className="text-[9px] text-terminal hover:text-text-primary px-1"
                >
                    +
                </button>
            </div>
        </div>
    );

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Chunks trigger when keywords appear in recent messages
            </p>
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
                                        <div className="text-[10px] text-terminal uppercase tracking-wider font-bold mb-1 border-b border-terminal/20 pb-1 flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                                            Always On
                                        </div>
                                        {alwaysOn.map(renderChunk)}
                                    </div>
                                )}
                                {conditional.length > 0 && (
                                    <div className="space-y-2">
                                        <div className="text-[10px] text-text-dim uppercase tracking-wider font-bold mb-1 border-b border-border/50 pb-1 flex items-center gap-2">
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
