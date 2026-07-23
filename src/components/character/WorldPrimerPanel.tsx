import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useState } from 'react';
import type { EndpointConfig } from '../../types';

export function WorldPrimerPanel({ onClose }: { onClose: () => void }) {
    const { loreChunks, getActiveAuxiliaryEndpoint } = useAppStore(useShallow(s => ({
        loreChunks: s.loreChunks,
        getActiveAuxiliaryEndpoint: s.getActiveAuxiliaryEndpoint,
    })));

    const [digest, setDigest] = useState<string | null>(null);
    const [isDigesting, setIsDigesting] = useState(false);
    const [selectedChunk, setSelectedChunk] = useState<string | null>(null);

    const auxProvider = getActiveAuxiliaryEndpoint();

    const handleDigest = async () => {
        if (!auxProvider) return;
        setIsDigesting(true);
        try {
            const { llmCall } = await import('../../utils/llmCall');
            const loreText = loreChunks.slice(0, 10).map(c => `## ${c.header}\n${c.content}`).join('\n\n');
            const prompt = `Summarize the following world lore for a new player in 2-3 paragraphs. Focus on the most important facts a newcomer would need to know.\n\n${loreText}`;
            const result = await llmCall(auxProvider as EndpointConfig, prompt, { priority: 'low' });
            setDigest(result || 'No digest generated.');
        } catch (e) {
            console.warn('[WorldPrimer] Digest failed:', e);
            setDigest('Failed to generate digest.');
        } finally {
            setIsDigesting(false);
        }
    };

    const activeChunk = selectedChunk ? loreChunks.find(c => c.id === selectedChunk) : null;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-void/80 backdrop-blur-sm p-4">
            <div className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-3xl max-h-[calc(75*var(--app-vh))] flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h3 className="text-[13px] font-medium text-terminal uppercase tracking-widest">World Primer</h3>
                    <button onClick={onClose} className="text-text-dim hover:text-text-bright transition-colors text-lg leading-none">&times;</button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {loreChunks.length === 0 ? (
                        <div className="p-6 text-center text-text-dim text-[13px]">
                            No world lore available yet. Add lore chunks in campaign settings.
                        </div>
                    ) : (
                        <div className="flex flex-col md:flex-row">
                            {/* Chunk list */}
                            <div className="md:w-1/3 border-r border-border/50 overflow-y-auto max-h-[calc(60*var(--app-vh))]">
                                {loreChunks.map(chunk => (
                                    <button
                                        key={chunk.id}
                                        onClick={() => setSelectedChunk(chunk.id)}
                                        className={`w-full text-left px-3 py-2 text-[11px] border-b border-border/30 transition-colors ${selectedChunk === chunk.id ? 'bg-terminal/10 text-terminal' : 'text-text-dim hover:text-text-bright'}`}
                                    >
                                        {chunk.header || 'Untitled'}
                                    </button>
                                ))}
                            </div>
                            {/* Content */}
                            <div className="md:w-2/3 p-4 overflow-y-auto max-h-[calc(60*var(--app-vh))]">
                                {activeChunk ? (
                                    <div>
                                        <h4 className="text-[12px] font-medium text-text-bright mb-2">{activeChunk.header}</h4>
                                        <p className="text-[12px] text-text-dim whitespace-pre-wrap">{activeChunk.content}</p>
                                    </div>
                                ) : digest ? (
                                    <div className="text-[12px] text-text-dim whitespace-pre-wrap">{digest}</div>
                                ) : (
                                    <div className="text-[12px] text-text-dim">Select a lore chunk to read, or generate a digest.</div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {auxProvider && loreChunks.length > 0 && (
                    <div className="px-4 py-3 border-t border-border">
                        <button
                            onClick={handleDigest}
                            disabled={isDigesting}
                            className="w-full py-2 rounded text-[11px] uppercase tracking-widest bg-terminal/20 text-terminal hover:bg-terminal/30 transition-colors disabled:opacity-50"
                        >
                            {isDigesting ? 'Generating digest...' : 'Summarize for newcomers'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}