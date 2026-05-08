import { useState, useEffect, useRef } from 'react';
import type { ChatMessage, ArchiveIndexEntry, DivergenceRegister, EndpointConfig, DivergenceEntry, DivergenceCategory } from '../types';
import { extractFromMessageBatch, buildSceneMap } from '../services/divergenceRegister';
import { toast } from './Toast';

type DivergenceReviewModalProps = {
    messages: ChatMessage[];
    archiveIndex: ArchiveIndexEntry[];
    currentRegister: DivergenceRegister;
    provider: EndpointConfig;
    onAccept: (entries: DivergenceEntry[]) => void;
    onClose: () => void;
};

type ReviewEntry = DivergenceEntry & {
    accepted: boolean;
};

const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    canon_override: 'bg-red-900/40 text-red-300 border-red-700/50',
    world_change: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
    entity_state: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
    player_state: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
    obligation: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
};

const CATEGORIES: DivergenceCategory[] = ['canon_override', 'world_change', 'entity_state', 'player_state', 'obligation'];

export function DivergenceReviewModal({
    messages,
    archiveIndex,
    currentRegister,
    provider,
    onAccept,
    onClose
}: DivergenceReviewModalProps) {
    const [status, setStatus] = useState<'loading' | 'editing'>('loading');
    const [entries, setEntries] = useState<ReviewEntry[]>([]);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        abortRef.current = new AbortController();
        const runExtraction = async () => {
            try {
                const { sceneIdsByMessageId } = buildSceneMap(archiveIndex, messages);
                const { newEntries, parseFailures } = await extractFromMessageBatch(
                    provider,
                    messages,
                    sceneIdsByMessageId,
                    currentRegister,
                    8000,
                    abortRef.current?.signal,
                    4000
                );
                
                // Ensure all entries have 'manual' source since we are guiding the review
                const reviewable: ReviewEntry[] = newEntries.map(e => ({
                    ...e,
                    source: 'manual',
                    accepted: true
                }));
                
                setEntries(reviewable);
                setStatus('editing');
                
                if (parseFailures > 0) {
                    toast.warning(`${parseFailures} entries failed to parse and may need editing`);
                }
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.error('[ReviewModal] Extraction failed:', err);
                toast.error('Failed to extract divergences');
                onClose();
            }
        };
        
        runExtraction();
        
        return () => {
            if (abortRef.current) {
                abortRef.current.abort();
            }
        };
    }, [archiveIndex, messages, provider, currentRegister, onClose]);

    const handleAccept = () => {
        const accepted = entries.filter(e => e.accepted).map(e => {
            const { accepted, ...rest } = e;
            return rest;
        });
        onAccept(accepted);
    };

    const updateEntry = (index: number, patch: Partial<ReviewEntry>) => {
        setEntries(prev => {
            const next = [...prev];
            next[index] = { ...next[index], ...patch };
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl flex flex-col w-full max-w-4xl max-h-[90vh]">
                <div className="flex-none p-4 border-b border-gray-800 flex justify-between items-center">
                    <div>
                        <h2 className="text-xl font-bold text-gray-100 flex items-center gap-2">
                            <span className="text-blue-400">⚡</span> Divergence Review
                        </h2>
                        <p className="text-xs text-gray-400 mt-1">
                            Scanning {messages.length} message{messages.length !== 1 && 's'}
                        </p>
                    </div>
                    {status === 'editing' && (
                        <div className="text-sm font-mono text-gray-400">
                            {entries.filter(e => e.accepted).length} / {entries.length} selected
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-4 min-h-[300px]">
                    {status === 'loading' ? (
                        <div className="flex flex-col items-center justify-center h-full space-y-4">
                            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                            <div className="text-gray-400 animate-pulse">Scanning for story divergences...</div>
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-500">
                            <p>No new divergences detected in this passage.</p>
                            <p className="text-xs mt-2">The model did not find any campaign-altering facts.</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {entries.map((entry, i) => (
                                <div 
                                    key={entry.id} 
                                    className={`p-3 rounded-md border transition-colors ${
                                        entry.accepted 
                                            ? 'bg-gray-800 border-gray-700' 
                                            : 'bg-gray-900/50 border-gray-800 opacity-60'
                                    } ${entry.parseError ? 'border-red-500 border-dashed' : ''}`}
                                >
                                    <div className="flex gap-3">
                                        <div className="pt-1">
                                            <input 
                                                type="checkbox"
                                                checked={entry.accepted}
                                                onChange={(e) => updateEntry(i, { accepted: e.target.checked })}
                                                className="w-5 h-5 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-800"
                                            />
                                        </div>
                                        <div className="flex-1 space-y-3">
                                            <div className="flex flex-wrap gap-2">
                                                <select
                                                    value={entry.category}
                                                    onChange={(e) => updateEntry(i, { category: e.target.value as DivergenceCategory })}
                                                    className={`text-xs px-2 py-1 rounded border outline-none ${CATEGORY_COLORS[entry.category]}`}
                                                    disabled={!entry.accepted}
                                                >
                                                    {CATEGORIES.map(c => (
                                                        <option key={c} value={c} className="bg-gray-900 text-gray-300">{c}</option>
                                                    ))}
                                                </select>
                                                
                                                <input
                                                    type="text"
                                                    value={entry.subject}
                                                    onChange={(e) => updateEntry(i, { subject: e.target.value })}
                                                    placeholder="Subject / Entity"
                                                    className="flex-1 bg-gray-950/50 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 outline-none focus:border-blue-500"
                                                    disabled={!entry.accepted}
                                                />
                                                
                                                <div className="text-xs font-mono text-gray-500 py-1 px-2 bg-gray-900 rounded">
                                                    Scene #{entry.sceneRef}
                                                </div>
                                            </div>
                                            
                                            <textarea
                                                value={entry.divergence}
                                                onChange={(e) => updateEntry(i, { divergence: e.target.value })}
                                                placeholder="Fact description..."
                                                className="w-full bg-gray-950/50 border border-gray-700 rounded p-2 text-sm text-gray-200 outline-none focus:border-blue-500 resize-y min-h-[60px]"
                                                disabled={!entry.accepted}
                                            />
                                            
                                            {entry.parseError && (
                                                <div className="text-xs text-red-400 font-semibold mt-1">
                                                    ⚠️ Model output parse error. Please verify the category and subject.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex-none p-4 border-t border-gray-800 flex justify-end gap-3 bg-gray-800/50">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors"
                    >
                        {status === 'loading' ? 'Cancel' : 'Discard All'}
                    </button>
                    {status === 'editing' && entries.length > 0 && (
                        <button
                            onClick={handleAccept}
                            disabled={entries.filter(e => e.accepted).length === 0}
                            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-lg shadow-blue-900/20"
                        >
                            Accept Selected
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
