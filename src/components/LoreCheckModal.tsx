import { useState, useEffect, useRef } from 'react';
import { X, Check, Edit3, AlertTriangle, ShieldCheck, HelpCircle, Loader2, Search, Zap } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { runLoreCheck } from '../services/loreCheck';
import type { LoreCheckCategory } from '../types';

const CATEGORY_CHIPS: { value: LoreCheckCategory; label: string }[] = [
    { value: 'wrong-fact', label: 'Wrong fact' },
    { value: 'contradicts-lore', label: 'Contradicts lore' },
    { value: 'wrong-entity', label: 'Wrong NPC/place' },
    { value: 'tone-voice', label: 'Tone/voice' },
    { value: 'out-of-character', label: 'Out of character' },
];

type Stage = 'hint' | 'running' | 'done';

export function LoreCheckModal() {
    const open = useAppStore(s => s.loreCheckOpen);
    const status = useAppStore(s => s.loreCheckStatus);
    const error = useAppStore(s => s.loreCheckError);
    const result = useAppStore(s => s.loreCheckResult);
    const selection = useAppStore(s => s.loreCheckSelection);
    const setStatus = useAppStore(s => s.setLoreCheckStatus);
    const setResult = useAppStore(s => s.setLoreCheckResult);
    const setError = useAppStore(s => s.setLoreCheckError);
    const close = useAppStore(s => s.closeLoreCheck);
    const updateMessageContent = useAppStore(s => s.updateMessageContent);

    const [stage, setStage] = useState<Stage>('hint');
    const [hint, setHint] = useState('');
    const [categories, setCategories] = useState<LoreCheckCategory[]>([]);
    const [editMode, setEditMode] = useState(false);
    const [draft, setDraft] = useState('');
    const abortRef = useRef<AbortController | null>(null);

    const openedAtRef = useRef(0);
    useEffect(() => {
        if (open) {
            openedAtRef.current = Date.now();
            setStage('hint');
            setHint('');
            setCategories([]);
        }
    }, [open]);

    const toggleCategory = (cat: LoreCheckCategory) => {
        setCategories(prev =>
            prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
        );
    };

    const runCheck = (checkHint?: string, checkCategories?: LoreCheckCategory[]) => {
        if (!selection) return;
        const ac = new AbortController();
        abortRef.current = ac;
        setStage('running');

        (async () => {
            try {
                const state = useAppStore.getState();
                const utility = state.getActiveUtilityEndpoint();
                if (!utility) {
                    setError('No Utility AI configured. Set one in Settings \u2192 AI Providers.');
                    setStage('done');
                    return;
                }
                const messages = state.messages;
                const campaignId = state.activeCampaignId ?? '';
                const loreChunks = state.loreChunks ?? [];
                const archiveIndex = state.archiveIndex ?? [];
                const sealedChapters = (state.chapters ?? []).filter((c: { sealedAt?: number; invalidated?: boolean }) => c.sealedAt != null && !c.invalidated);

                if (loreChunks.length === 0 && sealedChapters.length === 0) {
                    setError('No lore or archived chapters available to check against.');
                    setStage('done');
                    return;
                }

                const res = await runLoreCheck({
                    utilityEndpoint: utility,
                    selectedText: selection.selectedText,
                    surroundingContext: selection.surroundingContext,
                    messages,
                    targetMessageId: selection.messageId,
                    loreChunks,
                    archiveIndex,
                    sealedChapters,
                    campaignId,
                    onStatus: setStatus,
                    signal: ac.signal,
                    hint: checkHint,
                    categories: checkCategories,
                });
                setResult(res);
                setStage('done');
            } catch (err) {
                if (ac.signal.aborted) return;
                setError(err instanceof Error ? err.message : 'Lore check failed.');
                setStage('done');
            }
        })();
    };

    const handleGuidedCheck = () => {
        const effectiveHint = hint.trim() || undefined;
        const effectiveCategories = categories.length > 0 ? categories : undefined;
        runCheck(effectiveHint, effectiveCategories);
    };

    const handleJustCheck = () => {
        runCheck(undefined, undefined);
    };

    if (!open) return null;

    const loading = stage === 'running';

    const verdictMeta = result && {
        consistent:    { color: 'text-emerald-400 border-emerald-500/40', icon: <ShieldCheck size={14} />, label: 'Consistent' },
        unsupported:   { color: 'text-amber-400 border-amber-500/40',     icon: <HelpCircle size={14} />,  label: 'Unsupported' },
        contradicts:   { color: 'text-red-400 border-red-500/40',         icon: <AlertTriangle size={14} />, label: 'Contradicts' },
    }[result.verdict];

    const accept = (text: string) => {
        if (!selection) return;
        const state = useAppStore.getState();
        const msg = state.messages.find(m => m.id === selection.messageId);
        if (!msg || typeof msg.content !== 'string') {
            close();
            return;
        }
        const newContent = msg.content.replace(selection.selectedText, text);
        updateMessageContent(selection.messageId, newContent);
        close();
    };

    const handleClose = () => {
        abortRef.current?.abort();
        abortRef.current = null;
        setEditMode(false);
        setDraft('');
        setStage('hint');
        setHint('');
        setCategories([]);
        close();
    };

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        handleClose();
    };

    const showHintStage = stage === 'hint';
    const showResult = stage === 'done' && result && verdictMeta;

    return (
        <div
            className="fixed inset-0 z-[150] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={handleBackdropClick}
        >
            <div
                className="bg-void-darker border border-border max-w-2xl w-full max-h-[85vh] overflow-y-auto rounded font-mono text-sm"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-3 border-b border-border">
                    <span className="text-[10px] uppercase tracking-widest text-terminal">◆ Lore Check</span>
                    <button onClick={handleClose} className="text-text-dim hover:text-text-primary">
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {showHintStage && selection && (
                        <>
                            <div className="text-[10px] uppercase tracking-widest text-text-dim">Selected text</div>
                            <div className="bg-void border border-border p-2 text-xs text-text-dim whitespace-pre-wrap max-h-24 overflow-y-auto rounded">
                                {selection.selectedText}
                            </div>

                            <div>
                                <div className="text-[10px] uppercase tracking-widest text-text-dim mb-2">What seems wrong?</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {CATEGORY_CHIPS.map(chip => {
                                        const active = categories.includes(chip.value);
                                        return (
                                            <button
                                                key={chip.value}
                                                onClick={() => toggleCategory(chip.value)}
                                                className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded border transition-colors ${
                                                    active
                                                        ? 'bg-terminal/15 border-terminal/50 text-terminal'
                                                        : 'border-border text-text-dim hover:text-text-primary hover:border-terminal/30'
                                                }`}
                                            >
                                                {chip.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div>
                                <textarea
                                    value={hint}
                                    onChange={(e) => setHint(e.target.value)}
                                    placeholder="Optional — what looks wrong? e.g. This NPC was already dead at scene 12"
                                    className="w-full bg-void border border-border p-2 text-xs font-mono placeholder:text-text-dim/50 focus:outline-none focus:border-terminal/40 rounded"
                                    rows={2}
                                />
                            </div>

                            <div className="flex gap-2">
                                <button
                                    onClick={handleGuidedCheck}
                                    className="text-[10px] uppercase tracking-widest bg-emerald-500/10 border border-emerald-500 text-emerald-400 px-3 py-1.5 rounded hover:bg-emerald-500/20 flex items-center gap-1.5"
                                >
                                    <Search size={10} /> Run guided check
                                </button>
                                <button
                                    onClick={handleJustCheck}
                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1.5 rounded hover:text-text-primary flex items-center gap-1.5"
                                >
                                    <Zap size={10} /> Just check it
                                </button>
                            </div>
                        </>
                    )}

                    {loading && (
                        <div className="flex items-center gap-3 py-4">
                            <Loader2 size={18} className="animate-spin text-terminal" />
                            <div className="text-text-primary text-sm">{status || 'Working...'}</div>
                        </div>
                    )}

                    {stage === 'done' && error && (
                        <div className="text-red-400 text-xs">{error}</div>
                    )}

                    {showResult && (
                        <>
                            <div className={`inline-flex items-center gap-2 px-2 py-1 border rounded text-[10px] uppercase tracking-widest ${verdictMeta.color}`}>
                                {verdictMeta.icon}{verdictMeta.label}
                            </div>

                            {result.issues.length > 0 && (
                                <ul className="space-y-1">
                                    {result.issues.map((iss, i) => (
                                        <li key={i} className="text-text-dim text-xs flex gap-2">
                                            <span className="text-terminal">{'▸'}</span>{iss}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {result.citations.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {result.citations.map((c, i) => (
                                        <span key={i} className="text-[10px] px-2 py-0.5 bg-terminal/10 border border-terminal/30 text-terminal/90 rounded">
                                            {c.label}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {result.rawResponse && (
                                <details className="bg-void border border-amber-500/30 rounded">
                                    <summary className="cursor-pointer p-2 text-[10px] uppercase tracking-widest text-amber-400/80">
                                        Raw verifier output (debug)
                                    </summary>
                                    <pre className="p-2 text-[10px] text-text-dim whitespace-pre-wrap break-words border-t border-amber-500/20 max-h-64 overflow-y-auto">
                                        {result.rawResponse}
                                    </pre>
                                </details>
                            )}

                            {result.suggestedRewrite != null && (
                                <div className="space-y-2">
                                    <div className="text-[10px] uppercase tracking-widest text-text-dim">Original</div>
                                    <div className="bg-red-500/5 border-l-2 border-red-500 p-2 text-xs whitespace-pre-wrap">
                                        {result.originalText}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-widest text-text-dim">Suggested rewrite</div>
                                    {!editMode ? (
                                        <div className="bg-emerald-500/5 border-l-2 border-emerald-500 p-2 text-xs whitespace-pre-wrap">
                                            {result.suggestedRewrite}
                                        </div>
                                    ) : (
                                        <textarea
                                            value={draft}
                                            onChange={(e) => setDraft(e.target.value)}
                                            className="w-full bg-void border border-border p-2 text-xs font-mono"
                                            rows={5}
                                        />
                                    )}

                                    <div className="flex gap-2 flex-wrap">
                                        {!editMode && (
                                            <>
                                                <button
                                                    onClick={() => accept(result.suggestedRewrite!)}
                                                    className="text-[10px] uppercase tracking-widest bg-emerald-500/10 border border-emerald-500 text-emerald-400 px-3 py-1 rounded hover:bg-emerald-500/20 flex items-center gap-1"
                                                >
                                                    <Check size={10} /> Accept rewrite
                                                </button>
                                                <button
                                                    onClick={() => { setDraft(result.suggestedRewrite!); setEditMode(true); }}
                                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary flex items-center gap-1"
                                                >
                                                    <Edit3 size={10} /> Edit then accept
                                                </button>
                                            </>
                                        )}
                                        {editMode && (
                                            <button
                                                onClick={() => accept(draft)}
                                                className="text-[10px] uppercase tracking-widest bg-emerald-500/10 border border-emerald-500 text-emerald-400 px-3 py-1 rounded hover:bg-emerald-500/20 flex items-center gap-1"
                                            >
                                                <Check size={10} /> Save &amp; apply
                                            </button>
                                        )}
                                        <button
                                            onClick={handleClose}
                                            className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary"
                                        >
                                            Reject
                                        </button>
                                    </div>
                                </div>
                            )}

                            {result.suggestedRewrite == null && result.verdict === 'consistent' && (
                                <button
                                    onClick={handleClose}
                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary"
                                >
                                    Close
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}