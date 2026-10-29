import { useState, useRef } from 'react';
import { Edit2, Check, Pin, PinOff, ChevronDown, ChevronUp, Trash2, Sparkles, Loader2, Users, X, Link2 } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import type { DivergenceCategory, DivergenceEntry, NPCEntry } from '../../../types';
import { EMPTY_REGISTER, CATEGORY_LABELS } from '../../../services/campaign-state/divergenceRegister';
import { runFactClustering, assignSubjectTokens, type ClusteringCancelled } from '../../../services/campaign-state/factClusterer';
import { runFactDedup, type DedupResult, type DedupCancelled } from '../../../services/campaign-state/factDeduper';
import { normalizeFaction, parseKnownByToken, groupDivergencesBySubject } from '../../../services/campaign-state/knowledgeScope';
import { DedupReviewModal } from '../../DedupReviewModal';

type FactsSubView = 'chapter' | 'topic' | 'subject';

const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    locations: 'text-blue-400',
    npc_events: 'text-terminal',
    promises_debts: 'text-amber-400',
    world_state: 'text-ice',
    party_facts: 'text-emerald-400',
    rules_lore: 'text-purple-400',
    misc: 'text-text-muted',
};

const CATEGORY_DOTS: Record<DivergenceCategory, string> = {
    locations: 'bg-blue-400',
    npc_events: 'bg-green-400',
    promises_debts: 'bg-amber-400',
    world_state: 'bg-cyan-400',
    party_facts: 'bg-emerald-400',
    rules_lore: 'bg-purple-400',
    misc: 'bg-gray-400',
};

// ── Known-By helpers (WO-11.1) ─────────────────────────────────────────

function knownByTokenLabel(tok: string, npcLedger: NPCEntry[]): string {
    const parsed = parseKnownByToken(tok);
    if (!parsed) {
        const npc = npcLedger.find(n => n.id === tok.trim());
        return npc ? npc.name : 'unknown';
    }
    if (parsed.kind === 'player') return 'the player';
    if (parsed.kind === 'faction') return `${parsed.name} members`;
    const npc = npcLedger.find(n => n.id === parsed.id);
    return npc ? npc.name : 'someone (removed)';
}

function knownBySummary(knownBy: string[] | undefined, npcLedger: NPCEntry[]): string {
    if (knownBy === undefined) return 'public';
    if (knownBy.length === 0) return 'secret (player only)';
    return knownBy.map(t => knownByTokenLabel(t, npcLedger)).join(', ');
}

function knownByChipClass(knownBy: string[] | undefined): string {
    if (knownBy === undefined) return 'text-emerald-400';
    if (knownBy.length === 0) return 'text-red-400';
    return 'text-amber-400';
}

/** Derive a readable group label from a subjectToken slug. e.g. "alex_chen.identity" -> "Alex Chen · identity". */
function subjectLabel(token: string): string {
    const parts = token.split(/[._]/).filter(Boolean);
    if (parts.length === 0) return token;
    const pretty = parts.map(p =>
        p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    );
    if (pretty.length >= 2) {
        const attr = pretty.pop();
        return `${pretty.join(' ')} · ${attr}`;
    }
    return pretty.join(' ');
}

/** KnownBy editor popover — inline, matches existing inline-edit pattern. */
function KnownByEditor({ entry, npcLedger, onApply, onClose }: {
    entry: DivergenceEntry;
    npcLedger: NPCEntry[];
    onApply: (knownBy: string[] | undefined) => void;
    onClose: () => void;
}) {
    const [tokens, setTokens] = useState<string[]>(entry.knownBy === undefined ? [] : [...entry.knownBy]);
    const isPublic = entry.knownBy === undefined;
    const [factionInput, setFactionInput] = useState('');

    const addToken = (tok: string) => {
        if (tokens.includes(tok)) return;
        setTokens([...tokens, tok]);
    };
    const removeToken = (tok: string) => {
        setTokens(tokens.filter(t => t !== tok));
    };

    return (
        <div className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1.5 text-[10px]">
            <div className="flex items-center gap-1 flex-wrap">
                <span className="text-text-dim uppercase tracking-wider text-[8px]">Knows:</span>
                {isPublic && (
                    <span className="text-emerald-400 px-1 py-0.5 bg-emerald-500/10 rounded">public</span>
                )}
                {!isPublic && tokens.length === 0 && (
                    <span className="text-red-400 px-1 py-0.5 bg-red-500/10 rounded">secret (player only)</span>
                )}
                {!isPublic && tokens.map(t => (
                    <span key={t} className={`px-1 py-0.5 rounded flex items-center gap-0.5 ${t === 'player' ? 'text-ice bg-ice/10' : t.startsWith('faction:') ? 'text-purple-400 bg-purple-500/10' : 'text-amber-400 bg-amber-500/10'}`}>
                        {knownByTokenLabel(t, npcLedger)}
                        <button onClick={() => removeToken(t)} className="hover:text-red-400"><X size={8} /></button>
                    </span>
                ))}
            </div>

            <div className="space-y-1">
                <div className="text-text-dim text-[9px] uppercase tracking-wider">Add knower:</div>
                <div className="flex items-center gap-1 flex-wrap">
                    <button
                        onClick={() => addToken('player')}
                        className={`px-1 py-0.5 rounded text-ice bg-ice/10 hover:bg-ice/20 ${tokens.includes('player') ? 'opacity-40 cursor-not-allowed' : ''}`}
                        disabled={tokens.includes('player')}
                    >
                        + player
                    </button>
                    <button
                        onClick={() => onApply(undefined)}
                        className="px-1 py-0.5 rounded text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                        title="Set to public/broadcast (knownBy = undefined)"
                    >
                        make public
                    </button>
                </div>

                <div className="flex items-center gap-0.5 flex-wrap">
                    <span className="text-text-dim text-[9px] flex items-center gap-0.5"><Users size={9} /> NPC:</span>
                    {npcLedger.length === 0 && <span className="text-text-dim/50 italic">no NPCs in ledger</span>}
                    {npcLedger.slice(0, 12).map(n => {
                        const tok = `npc:${n.id}`;
                        return (
                            <button
                                key={n.id}
                                onClick={() => addToken(tok)}
                                disabled={tokens.includes(tok)}
                                className={`px-1 py-0.5 rounded text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 ${tokens.includes(tok) ? 'opacity-40 cursor-not-allowed' : ''}`}
                            >
                                + {n.name}
                            </button>
                        );
                    })}
                </div>

                <div className="flex items-center gap-0.5">
                    <span className="text-text-dim text-[9px]">faction:</span>
                    <input
                        type="text"
                        value={factionInput}
                        onChange={ev => setFactionInput(ev.target.value)}
                        placeholder="e.g. Ironspire Knights"
                        className="flex-1 bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none min-w-0"
                        onKeyDown={ev => {
                            if (ev.key === 'Enter' && factionInput.trim()) {
                                const f = normalizeFaction(factionInput);
                                if (f) { addToken(`faction:${f}`); setFactionInput(''); }
                            }
                        }}
                    />
                    <button
                        onClick={() => {
                            const f = normalizeFaction(factionInput);
                            if (f) { addToken(`faction:${f}`); setFactionInput(''); }
                        }}
                        disabled={!factionInput.trim()}
                        className="px-1 py-0.5 rounded text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-40"
                    >
                        + add
                    </button>
                </div>
            </div>

            <div className="flex gap-1.5 justify-end">
                <button
                    onClick={() => onApply(tokens)}
                    className="flex items-center gap-0.5 text-emerald-400 hover:text-emerald-300 px-1"
                >
                    <Check size={8} /> Save
                </button>
                <button onClick={onClose} className="text-text-dim hover:text-red-400 px-1">Cancel</button>
            </div>
        </div>
    );
}

export function FactsView() {
    const divergenceRegister = useAppStore(s => s.divergenceRegister);
    const chapters = useAppStore(s => s.chapters);
    const settings = useAppStore(s => s.settings);
    const deleteDivergenceFact = useAppStore(s => s.deleteDivergenceFact);
    const toggleDivergenceChapter = useAppStore(s => s.toggleDivergenceChapter);
    const toggleDivergenceCategory = useAppStore(s => s.toggleDivergenceCategory);
    const pinDivergenceFact = useAppStore(s => s.pinDivergenceFact);
    const editDivergenceFact = useAppStore(s => s.editDivergenceFact);
    const toggleDivergenceFact = useAppStore(s => s.toggleDivergenceFact);
    const setManyFactsEnabled = useAppStore(s => s.setManyFactsEnabled);
    const setTopicClusters = useAppStore(s => s.setTopicClusters);
    const getActiveUtilityEndpoint = useAppStore(s => s.getActiveUtilityEndpoint);
    const npcLedger = useAppStore(s => s.npcLedger);
    // WO-11.1 / WO-11.2 store setters
    const editDivergenceKnownBy = useAppStore(s => s.editDivergenceKnownBy);
    const applySubjectTokens = useAppStore(s => s.applySubjectTokens);

    const [factsView, setFactsView] = useState<FactsSubView>('chapter');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');
    const [knownByEditingId, setKnownByEditingId] = useState<string | null>(null);
    const [expandedChapter, setExpandedChapter] = useState<string | null>(null);
    const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
    const [clustering, setClustering] = useState(false);
    const [clusterError, setClusterError] = useState<string | null>(null);

    // WO-11.2 — Find Similarity state (distinct from Find Duplicates; never disables/deletes).
    const [simRunning, setSimRunning] = useState(false);
    const [simStatus, setSimStatus] = useState<string | null>(null);
    const [simSummary, setSimSummary] = useState<string | null>(null);
    const [simError, setSimError] = useState<string | null>(null);
    const simCancelRef = useRef<ClusteringCancelled>({ cancelled: false });

    const [dedupOpen, setDedupOpen] = useState(false);
    const [dedupRunning, setDedupRunning] = useState(false);
    const [dedupProgress, setDedupProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
    const [dedupResult, setDedupResult] = useState<DedupResult | null>(null);
    const [dedupSelections, setDedupSelections] = useState<Record<string, Set<string>>>({});
    const [dedupError, setDedupError] = useState<string | null>(null);
    const dedupCancelRef = useRef<DedupCancelled>({ cancelled: false });

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const entries = reg.entries;

    const pinnedEntries = entries.filter(e => e.pinned);
    const unpinnedEntries = entries.filter(e => !e.pinned);

    const byChapter = new Map<string, DivergenceEntry[]>();
    for (const e of unpinnedEntries) {
        if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, []);
        byChapter.get(e.chapterId)!.push(e);
    }

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const topicClusters = reg.topicClusters;
    const totalFacts = entries.length;
    const clusteredFacts = topicClusters
        ? topicClusters.groups.reduce((sum, g) => sum + g.factIds.length, 0)
        : 0;
    const isStale = topicClusters && topicClusters.generatedFromFactCount !== totalFacts;
    const minutesAgo = topicClusters
        ? Math.round((Date.now() - new Date(topicClusters.generatedAt).getTime()) / 60_000)
        : null;

    // By-subject grouping (WO-11.2) — computed from existing data, no AI needed.
    const subjectGroups = groupDivergencesBySubject(unpinnedEntries);

    // Find the open chapter for the placeholder
    const openChapter = chapters?.find(c => !c.sealedAt);

    const handleStartEdit = (e: DivergenceEntry) => {
        setEditingId(e.id);
        setEditText(e.text);
    };

    const handleSaveEdit = () => {
        if (!editingId) return;
        editDivergenceFact(editingId, editText);
        setEditingId(null);
        setEditText('');
    };

    const handleDelete = (id: string) => {
        if (window.confirm('Delete this fact permanently?')) {
            deleteDivergenceFact(id);
        }
    };

    const handleRecluster = async () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider?.endpoint) {
            setClusterError('No utility AI configured.');
            return;
        }
        setClustering(true);
        setClusterError(null);
        try {
            const clusters = await runFactClustering(reg, utilityProvider, settings.contextLimit || 8192);
            setTopicClusters(clusters);
        } catch (err) {
            setClusterError(err instanceof Error ? err.message : 'Clustering failed.');
        } finally {
            setClustering(false);
        }
    };

    // WO-11.2 — Find Similarity: group facts by subject via the existing clustering LLM
    // call, then assign/repair subjectToken. NEVER disables or deletes facts.
    const handleStartSimilarity = () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider?.endpoint) {
            setSimError('No utility AI configured.');
            return;
        }
        setSimRunning(true);
        setSimStatus('Starting…');
        setSimSummary(null);
        setSimError(null);
        simCancelRef.current = { cancelled: false };

        assignSubjectTokens(reg, utilityProvider, settings.contextLimit || 8192, simCancelRef.current, setSimStatus)
            .then(result => {
                if (result.updates.length > 0) {
                    applySubjectTokens(result.updates);
                }
                setSimSummary(`Grouped ${result.factCount} fact${result.factCount === 1 ? '' : 's'} into ${result.groupCount} subject${result.groupCount === 1 ? '' : 's'}.`);
                setSimRunning(false);
                setSimStatus(null);
            })
            .catch(err => {
                if (err.message === 'Find Similarity cancelled.') {
                    setSimRunning(false);
                    setSimStatus(null);
                } else {
                    setSimError(err.message || String(err));
                    setSimRunning(false);
                    setSimStatus(null);
                }
            });
    };

    const handleStopSimilarity = () => {
        simCancelRef.current.cancelled = true;
        setSimRunning(false);
        setSimStatus(null);
    };

    const handleToggleGroup = (factIds: string[], allEnabled: boolean) => {
        const updates = factIds.map(id => ({ id, enabled: !allEnabled }));
        setManyFactsEnabled(updates);
    };

    const handleStartDedup = () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider?.endpoint) {
            setDedupError('No utility AI endpoint configured.');
            setDedupOpen(true);
            return;
        }
        setDedupOpen(true);
        setDedupRunning(true);
        setDedupProgress(null);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
        dedupCancelRef.current = { cancelled: false };

        runFactDedup(reg, npcLedger ?? [], chapters ?? [], utilityProvider, dedupCancelRef.current, (msg, done, total) => {
            setDedupProgress({ msg, done, total });
        }).then(result => {
            setDedupResult(result);
            setDedupRunning(false);
            setDedupProgress(null);
            const sels: Record<string, Set<string>> = {};
            for (const g of result.groups) {
                sels[g.keepId] = new Set(g.disableIds);
            }
            setDedupSelections(sels);
        }).catch(err => {
            if (err.message === 'Dedup cancelled.') {
                setDedupOpen(false);
                setDedupRunning(false);
                setDedupProgress(null);
            } else {
                setDedupError(err.message || String(err));
                setDedupRunning(false);
                setDedupProgress(null);
            }
        });
    };

    const handleStopDedup = () => {
        dedupCancelRef.current.cancelled = true;
        setDedupOpen(false);
        setDedupRunning(false);
        setDedupProgress(null);
    };

    const handleToggleDisable = (keepId: string, disableId: string) => {
        setDedupSelections(prev => {
            const current = prev[keepId];
            if (!current) return prev;
            const next = new Set(current);
            if (next.has(disableId)) next.delete(disableId);
            else next.add(disableId);
            return { ...prev, [keepId]: next };
        });
    };

    const handleSkipGroup = (keepId: string) => {
        setDedupSelections(prev => ({
            ...prev,
            [keepId]: new Set<string>(),
        }));
    };

    const handleApplyDedup = () => {
        const updates: Array<{ id: string; enabled: boolean }> = [];
        for (const g of dedupResult?.groups ?? []) {
            const sel = dedupSelections[g.keepId];
            if (!sel) continue;
            for (const dId of sel) {
                updates.push({ id: dId, enabled: false });
            }
        }
        if (updates.length > 0) setManyFactsEnabled(updates);
        setDedupOpen(false);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
    };

    const handleCloseDedup = () => {
        if (dedupRunning) return;
        setDedupOpen(false);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
    };

    // Shared per-row action buttons (edit/pin/delete) so the three views stay in sync.
    const rowActions = (e: DivergenceEntry) => (
        <span className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => setKnownByEditingId(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit who knows">
                <Users size={9} />
            </button>
            <button onClick={() => pinDivergenceFact(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Pin">
                <Pin size={9} />
            </button>
            <button onClick={() => handleStartEdit(e)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit">
                <Edit2 size={9} />
            </button>
            <button onClick={() => handleDelete(e.id)} className="text-text-muted hover:text-red-400 p-0.5" title="Delete">
                <Trash2 size={9} className="inline" />
            </button>
        </span>
    );

    // Shared knownBy suffix chip rendered after a fact's text.
    const knownBySuffix = (e: DivergenceEntry) => (
        <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcLedger ?? [])})</span>
    );

    return (
        <>
            <div className="flex items-center gap-1 flex-wrap">
                <button
                    onClick={handleStartDedup}
                    disabled={dedupRunning}
                    className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Sparkles size={9} />
                    Find Duplicates
                </button>
                <button
                    onClick={handleStartSimilarity}
                    disabled={simRunning}
                    className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Group facts by subject and assign/repair subject tokens. Does NOT disable or delete any fact."
                >
                    <Link2 size={9} />
                    Find Similarity
                </button>
                {simRunning && (
                    <button
                        onClick={handleStopSimilarity}
                        className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 px-1"
                    >
                        <X size={9} /> Stop
                    </button>
                )}
            </div>

            {simStatus && (
                <div className="text-[9px] text-text-dim">{simStatus}</div>
            )}
            {simSummary && !simRunning && (
                <div className="text-[9px] text-purple-400">{simSummary}</div>
            )}
            {simError && !simRunning && (
                <div className="text-[9px] text-red-400">{simError}</div>
            )}

            <div className="flex items-center gap-1">
                <button
                    onClick={() => setFactsView('chapter')}
                    className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'chapter' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                >
                    By Chapter
                </button>
                <button
                    onClick={() => setFactsView('topic')}
                    className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'topic' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                >
                    By Topic
                </button>
                <button
                    onClick={() => setFactsView('subject')}
                    className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'subject' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                >
                    By Subject
                </button>
            </div>

            {factsView === 'topic' && (
                <div className="space-y-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                            onClick={handleRecluster}
                            disabled={clustering}
                            className={`flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-2 py-1 rounded ${isStale ? 'text-amber-400 bg-amber-500/15 border border-amber-500/30' : 'text-terminal bg-terminal/10'} disabled:opacity-50`}
                            title="Run AI to group facts by entity/theme"
                        >
                            {clustering ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                            {topicClusters ? 'Re-cluster' : 'AI Cluster'}
                        </button>
                        {topicClusters && (
                            <span className={`text-[8px] ${isStale ? 'text-amber-400' : 'text-text-dim'}`}>
                                {clusteredFacts}/{totalFacts} facts &middot; {minutesAgo}m ago{isStale ? ' &middot; stale' : ''}
                            </span>
                        )}
                        {clusterError && (
                            <span className="text-[8px] text-red-400">{clusterError}</span>
                        )}
                    </div>

                    {!topicClusters || topicClusters.groups.length === 0 ? (
                        <div className="text-center py-6 space-y-2">
                            <p className="text-[11px] text-text-dim/60">No topic groups yet.</p>
                            <p className="text-[10px] text-text-dim/40">Run AI clustering to organize your {totalFacts} facts by recurring entities and themes.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {topicClusters.groups.map(group => {
                                const groupEntries = group.factIds
                                    .map(id => entries.find(e => e.id === id))
                                    .filter((e): e is DivergenceEntry => e !== undefined);
                                const allEnabled = groupEntries.every(e => e.enabled !== false);
                                const someEnabled = groupEntries.some(e => e.enabled !== false);
                                const isExpanded = expandedGroup === group.id;

                                return (
                                    <div key={group.id} className="border border-border/30 rounded">
                                        <button
                                            className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                            onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                                        >
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    checked={someEnabled}
                                                    ref={el => { if (el) el.indeterminate = someEnabled && !allEnabled; }}
                                                    onChange={(ev) => { ev.stopPropagation(); handleToggleGroup(group.factIds, allEnabled); }}
                                                    className="w-3 h-3 accent-terminal"
                                                    onClick={(ev) => ev.stopPropagation()}
                                                />
                                                <span className="text-[11px] font-bold text-text-primary">{group.name}</span>
                                                <span className="text-[9px] text-text-dim">{groupEntries.length} facts</span>
                                            </div>
                                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                        </button>

                                        {isExpanded && (
                                            <div className="border-t border-border/20 px-3 pb-1.5 pt-1 space-y-0.5">
                                                {groupEntries.map(e => (
                                                    editingId === e.id ? (
                                                        <div key={e.id} className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1">
                                                            <textarea
                                                                value={editText}
                                                                onChange={ev => setEditText(ev.target.value)}
                                                                className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[24px] max-h-[48px]"
                                                                rows={2}
                                                            />
                                                            <div className="flex gap-1.5 justify-end">
                                                                <button onClick={handleSaveEdit} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1">
                                                                    <Check size={8} /> Save
                                                                </button>
                                                                <button onClick={() => setEditingId(null)} className="text-[9px] text-text-dim hover:text-red-400 px-1">
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : knownByEditingId === e.id ? (
                                                        <KnownByEditor
                                                            key={e.id}
                                                            entry={e}
                                                            npcLedger={npcLedger ?? []}
                                                            onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                            onClose={() => setKnownByEditingId(null)}
                                                        />
                                                    ) : (
                                                        <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                            <input
                                                                type="checkbox"
                                                                checked={e.enabled !== false}
                                                                onChange={() => toggleDivergenceFact(e.id)}
                                                                className="w-2.5 h-2.5 mt-0.5 accent-terminal shrink-0"
                                                            />
                                                            <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                            <span className="min-w-0 flex-1">
                                                                {e.text}
                                                                <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                                                {knownBySuffix(e)}
                                                            </span>
                                                            {rowActions(e)}
                                                        </div>
                                                    )
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {factsView === 'subject' && (
                <div className="space-y-2">
                    {pinnedEntries.length > 0 && (
                        <div className="space-y-1">
                            <div className="text-[9px] uppercase font-bold text-amber-400 tracking-wider flex items-center gap-1">
                                <Pin size={9} /> Pinned
                            </div>
                            {pinnedEntries.map(e => (
                                <div key={e.id} className="flex items-start gap-1 text-[11px] text-text-primary">
                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`${CATEGORY_COLORS[e.category]} text-[9px] uppercase`}>{CATEGORY_LABELS[e.category]}</span>
                                        {' '}{e.text}
                                        <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                        {knownBySuffix(e)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {subjectGroups.map(group => {
                        const isTokened = group.entries[0].subjectToken !== undefined;
                        const label = isTokened ? subjectLabel(group.token) : '(ungrouped)';
                        const isExpanded = expandedSubject === group.token;
                        const latestSceneRef = group.entries[group.entries.length - 1].sceneRef;

                        return (
                            <div key={group.token} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedSubject(isExpanded ? null : group.token)}
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-[11px] font-bold text-text-primary truncate">{label}</span>
                                        <span className="text-[9px] text-text-dim shrink-0">{group.entries.length} beat{group.entries.length === 1 ? '' : 's'}</span>
                                    </div>
                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border/20 px-3 pb-1.5 pt-1 space-y-0.5">
                                        {group.entries.map(e => {
                                            const isLatest = e.sceneRef === latestSceneRef;
                                            return knownByEditingId === e.id ? (
                                                <KnownByEditor
                                                    key={e.id}
                                                    entry={e}
                                                    npcLedger={npcLedger ?? []}
                                                    onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                    onClose={() => setKnownByEditingId(null)}
                                                />
                                            ) : (
                                                <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="text-text-dim/50 text-[9px]">[#{e.sceneRef}]</span>{' '}
                                                        {e.text}
                                                        {isLatest && group.entries.length > 1 && (
                                                            <span className="ml-1 text-[8px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-1 rounded">latest</span>
                                                        )}
                                                        {knownBySuffix(e)}
                                                    </span>
                                                    {rowActions(e)}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {entries.length === 0 && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No established facts yet. Facts are extracted when chapters seal.
                        </div>
                    )}
                    {entries.length > 0 && subjectGroups.length === 0 && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No subject groups yet. Run Find Similarity to group facts by subject.
                        </div>
                    )}
                </div>
            )}

            {factsView === 'chapter' && (
                <div className="space-y-3">
                    {pinnedEntries.length > 0 && (
                        <div className="space-y-1">
                            <div className="text-[9px] uppercase font-bold text-amber-400 tracking-wider flex items-center gap-1">
                                <Pin size={9} /> Pinned
                            </div>
                            {pinnedEntries.map(e => (
                                <div key={e.id} className="flex items-start gap-1 text-[11px] text-text-primary">
                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`${CATEGORY_COLORS[e.category]} text-[9px] uppercase`}>{CATEGORY_LABELS[e.category]}</span>
                                        {' '}{e.text}
                                        <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                        {knownBySuffix(e)}
                                    </span>
                                    <span className="flex items-center gap-0.5 shrink-0">
                                        <button onClick={() => pinDivergenceFact(e.id)} className="text-amber-400 p-0.5" title="Unpin">
                                            <PinOff size={9} />
                                        </button>
                                        <button onClick={() => handleStartEdit(e)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit">
                                            <Edit2 size={9} />
                                        </button>
                                        <button onClick={() => handleDelete(e.id)} className="text-text-muted hover:text-red-400 p-0.5" title="Delete">
                                            <Trash2 size={9} />
                                        </button>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {[...byChapter.entries()].map(([chapterId, chapterEntries]) => {
                        const chapterTitle = chapterTitleMap.get(chapterId) ?? chapterId;
                        const chapterOn = reg.chapterToggles[chapterId] !== false;
                        const isExpanded = expandedChapter === chapterId;

                        const catGroups = new Map<DivergenceCategory, DivergenceEntry[]>();
                        for (const e of chapterEntries) {
                            if (!catGroups.has(e.category)) catGroups.set(e.category, []);
                            catGroups.get(e.category)!.push(e);
                        }

                        return (
                            <div key={chapterId} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedChapter(isExpanded ? null : chapterId)}
                                >
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={chapterOn}
                                            onChange={(ev) => { ev.stopPropagation(); toggleDivergenceChapter(chapterId, !chapterOn); }}
                                            className="w-3 h-3 accent-terminal"
                                            onClick={(ev) => ev.stopPropagation()}
                                        />
                                        <span className="text-[11px] font-bold text-text-primary">{chapterTitle}</span>
                                        <span className="text-[9px] text-text-dim">{chapterEntries.length} facts</span>
                                    </div>
                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>

                                {isExpanded && [...catGroups.entries()].map(([cat, catEntries]) => {
                                    const catKey = `${chapterId}-${cat}`;
                                    const catExpanded = expandedCategory === catKey;

                                    return (
                                        <div key={cat} className="border-t border-border/20">
                                            <button
                                                className="w-full flex items-center justify-between px-3 py-1 text-left"
                                                onClick={() => setExpandedCategory(catExpanded ? null : catKey)}
                                            >
                                                <div className="flex items-center gap-1.5">
                                                    <input
                                                        type="checkbox"
                                                        checked={reg.categoryToggles[chapterId]?.[cat] !== false}
                                                        onChange={(ev) => { ev.stopPropagation(); toggleDivergenceCategory(chapterId, cat, reg.categoryToggles[chapterId]?.[cat] !== false); }}
                                                        className="w-2.5 h-2.5 accent-terminal"
                                                        onClick={(ev) => ev.stopPropagation()}
                                                    />
                                                    <span className={`text-[9px] uppercase font-bold ${CATEGORY_COLORS[cat]}`}>{CATEGORY_LABELS[cat]}</span>
                                                    <span className="text-[8px] text-text-dim">{catEntries.length}</span>
                                                </div>
                                                {catExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                                            </button>

                                            {catExpanded && (
                                                <div className="px-3 pb-1.5 space-y-0.5">
                                                    {catEntries.map(e => (
                                                        editingId === e.id ? (
                                                            <div key={e.id} className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1">
                                                                <textarea
                                                                    value={editText}
                                                                    onChange={ev => setEditText(ev.target.value)}
                                                                    className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[24px] max-h-[48px]"
                                                                    rows={2}
                                                                />
                                                                <div className="flex gap-1.5 justify-end">
                                                                    <button onClick={handleSaveEdit} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1">
                                                                        <Check size={8} /> Save
                                                                    </button>
                                                                    <button onClick={() => setEditingId(null)} className="text-[9px] text-text-dim hover:text-red-400 px-1">
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ) : knownByEditingId === e.id ? (
                                                            <KnownByEditor
                                                                key={e.id}
                                                                entry={e}
                                                                npcLedger={npcLedger ?? []}
                                                                onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                                onClose={() => setKnownByEditingId(null)}
                                                            />
                                                        ) : (
                                                            <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={e.enabled !== false}
                                                                    onChange={() => toggleDivergenceFact(e.id)}
                                                                    className="w-2.5 h-2.5 mt-0.5 accent-terminal shrink-0"
                                                                />
                                                                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                                <span className="min-w-0 flex-1">
                                                                    {e.text}
                                                                    <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                                                    {knownBySuffix(e)}
                                                                </span>
                                                                {rowActions(e)}
                                                            </div>
                                                        )
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}

                    {entries.length === 0 && openChapter && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No established facts yet. Facts will be extracted when Chapter {openChapter.chapterId} seals at scene {openChapter.sceneRange[1] || '?'}.
                        </div>
                    )}
                    {entries.length === 0 && !openChapter && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No established facts yet. Facts are extracted when chapters seal.
                        </div>
                    )}
                </div>
            )}

            <DedupReviewModal
                open={dedupOpen}
                running={dedupRunning}
                progress={dedupProgress}
                groups={dedupResult?.groups ?? null}
                failedBuckets={dedupResult?.failedBuckets ?? []}
                selections={dedupSelections}
                error={dedupError}
                entries={entries}
                onCancel={handleCloseDedup}
                onStop={handleStopDedup}
                onToggleDisable={handleToggleDisable}
                onSkipGroup={handleSkipGroup}
                onApply={handleApplyDedup}
            />
        </>
    );
}