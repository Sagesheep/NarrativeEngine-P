import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { countTokens } from '../../services/infrastructure/tokenizer';
import { normalizeInjections, injectionText } from '../../services/payload/promptInjections';
import type { AllocationRowId } from '../../services/payload/contextAllocation';
import { ROWS, buildAllocationView, resetAll, resetRow, setRowPct, type RowView } from './contextAllocationModel';

/**
 * Context Allocation — how much of the Max Context Limit each part of the story
 * prompt may use. Drag a slider or type a percentage; the total can never pass
 * 100%, and Current Scene gets whatever the others leave.
 *
 * Layout: each row reads left to right — what the part is (label, what the writer
 * receives, what is lost when lowered) on the left, its controls on the right.
 * Below ~640px the two halves stack.
 */

const SEGMENT_COLOR: Record<AllocationRowId | 'fixed' | 'pool', string> = {
    fixed: 'hsl(220 8% 55%)',
    currentScene: 'hsl(152 55% 42%)',
    npcs: 'hsl(28 85% 55%)',
    recall: 'hsl(205 75% 52%)',
    facts: 'hsl(265 55% 60%)',
    lore: 'hsl(45 85% 50%)',
    rules: 'hsl(350 65% 58%)',
    state: 'hsl(180 50% 42%)',
    olderHistory: 'hsl(120 25% 50%)',
    reply: 'hsl(0 0% 40%)',
    pool: 'hsl(235 35% 62%)',
};
const SEGMENT_LABEL: Record<string, string> = {
    fixed: 'Fixed',
    pool: 'Shared pool',
    ...Object.fromEntries(ROWS.map(r => [r.id, r.label])),
};

const fmtPct = (n: number) => `${Math.round(n * 10) / 10}%`;

export function ContextAllocationSection() {
    const { settings, updateSettings, promptInjections, rulesIndexed } = useAppStore(useShallow(s => ({
        settings: s.settings,
        updateSettings: s.updateSettings,
        promptInjections: s.context?.promptInjections,
        rulesIndexed: (s.context?.rulesChunks?.length ?? 0) > 0,
    })));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [drafts, setDrafts] = useState<Partial<Record<AllocationRowId, string>>>({});

    const injectionTokens = useMemo(() => normalizeInjections(promptInjections)
        .filter(item => item.enabled && item.content.trim() && item.triggers.length > 0)
        .reduce((sum, item) => sum + countTokens(injectionText(item)) + 8, 0), [promptInjections]);
    const view = useMemo(() => buildAllocationView(settings, injectionTokens), [settings, injectionTokens]);
    const anyCustom = view.rows.some(r => r.custom);

    const apply = (id: AllocationRowId, pct: number) => updateSettings(setRowPct(settings, view, id, pct));
    // Reads the field's live value, so Enter and leaving the field both commit what was typed.
    const commitDraft = (id: AllocationRowId, raw: string) => {
        if (drafts[id] === undefined) return;
        setDrafts(d => ({ ...d, [id]: undefined }));
        if (raw.trim() === '') return;
        const n = Number(raw.replace('%', ''));
        if (Number.isFinite(n)) apply(id, n);
    };

    const renderRow = (row: RowView) => {
        const info = ROWS.find(r => r.id === row.id)!;
        const inert = row.id === 'rules' && !rulesIndexed;
        const modeLabel = row.custom ? (row.id === 'currentScene' ? 'Minimum' : 'Custom') : 'Automatic';
        const notes: { tone: 'dim' | 'warn'; text: string }[] = [];
        if (!row.custom && row.autoNote) notes.push({ tone: 'dim', text: `Automatic: ${row.autoNote}` });
        if (row.custom && row.pct === 0 && row.id !== 'currentScene') notes.push({ tone: 'warn', text: 'Off — the writer receives none of this.' });
        if (row.custom && row.maxPct < row.pct - 0.05) notes.push({ tone: 'warn', text: `Only ${fmtPct(row.maxPct)} is free now; this part gets less until others shrink.` });
        if (inert) notes.push({ tone: 'warn', text: "Your rules aren't indexed, so the whole rulebook is sent as standing instructions and this setting has no effect." });

        return (
            <div
                key={row.id}
                data-allocation-row={row.id}
                className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] gap-x-8 gap-y-3 py-4 border-t border-border/50 first:border-t-0"
            >
                {/* Left — what this part is */}
                <div className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SEGMENT_COLOR[row.id] }} aria-hidden />
                        <span className="text-[12px] text-text-primary font-bold tracking-wide">{info.label}</span>
                        <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${row.custom ? 'border-terminal text-terminal' : 'border-border text-text-dim'}`}>
                            {modeLabel}
                        </span>
                    </div>
                    <dl className="space-y-1.5 text-[10.5px] leading-relaxed">
                        <div>
                            <dt className="inline text-text-primary/85 font-semibold">Writer receives: </dt>
                            <dd className="inline text-text-dim">{info.receives}</dd>
                        </div>
                        <div>
                            <dt className="inline text-text-primary/85 font-semibold">If lower: </dt>
                            <dd className="inline text-text-dim">{info.lose}</dd>
                        </div>
                    </dl>
                    {notes.map(n => (
                        <div key={n.text} className={`text-[10px] leading-relaxed ${n.tone === 'warn' ? 'text-amber-400' : 'text-text-dim italic'}`}>{n.text}</div>
                    ))}
                </div>

                {/* Right — controls */}
                <div className="flex flex-col justify-center gap-2.5 sm:pl-6 sm:border-l sm:border-border/40">
                    <div className="flex items-center gap-2">
                        <div className="flex items-center h-8 bg-surface border border-border rounded focus-within:border-terminal">
                            <input
                                type="text"
                                inputMode="decimal"
                                aria-label={`${info.label} percent`}
                                value={drafts[row.id] ?? (row.pct > 0 || row.custom ? String(Math.round(row.pct * 10) / 10) : '0')}
                                onChange={e => setDrafts(d => ({ ...d, [row.id]: e.target.value }))}
                                onBlur={e => commitDraft(row.id, e.currentTarget.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { commitDraft(row.id, e.currentTarget.value); e.currentTarget.blur(); } }}
                                className="w-14 h-full bg-transparent px-2 text-[13px] text-right font-mono text-text-primary focus:outline-none"
                            />
                            <span className="pr-2 text-[11px] text-text-dim font-mono">%</span>
                        </div>
                        <span className="flex-1 text-right text-[11px] font-mono text-text-primary">{row.tokens.toLocaleString()} <span className="text-text-dim">tok</span></span>
                        <button
                            type="button"
                            onClick={() => { setDrafts(d => ({ ...d, [row.id]: undefined })); updateSettings(resetRow(settings, row.id)); }}
                            disabled={!row.custom}
                            title="Reset to default"
                            aria-label={`Reset ${info.label} to default`}
                            className="w-7 h-7 flex items-center justify-center rounded border border-border text-[13px] text-text-dim hover:text-terminal hover:border-terminal disabled:opacity-30 disabled:hover:text-text-dim disabled:hover:border-border"
                        >↺</button>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={0.5}
                        value={Math.min(100, row.pct)}
                        aria-label={`${info.label} share of the context limit`}
                        onChange={e => apply(row.id, Number(e.target.value))}
                        className={`w-full h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal ${row.custom ? '' : 'opacity-50'}`}
                    />
                    <div className="flex justify-between text-[9px] font-mono text-text-dim">
                        <span>0%</span>
                        <span>free up to {fmtPct(row.maxPct)}</span>
                        <span>100%</span>
                    </div>
                </div>
            </div>
        );
    };

    const main = view.rows.filter(r => !ROWS.find(i => i.id === r.id)!.advanced);
    const advanced = view.rows.filter(r => ROWS.find(i => i.id === r.id)!.advanced);
    const legend = view.segments.map(seg => ({ ...seg, pct: (seg.tokens / view.limit) * 100 }));

    return (
        <div data-ui="context-allocation" className="bg-void p-5 border border-border rounded space-y-5" style={{ gridColumn: '1 / -1' }}>
            {/* Header — explanation left, totals right */}
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(240px,300px)] gap-x-8 gap-y-3">
                <div className="space-y-1.5">
                    <label className="block text-[12px] text-text-primary uppercase tracking-wider font-bold">Context Allocation</label>
                    <div className="text-[10.5px] text-text-dim leading-relaxed">
                        How much of the Max Context Limit each part of the story prompt may use. Drag a slider or type a
                        percentage. Custom parts are trimmed to fit and never go over. Current Scene gets everything
                        left, including space a part doesn't use, so the total never passes 100%.
                    </div>
                    <div className="text-[10px] text-text-dim leading-relaxed italic">
                        Writer instructions and your message are measured each turn and come out of Current Scene.
                    </div>
                </div>
                <div className="flex flex-col justify-center gap-1 sm:pl-6 sm:border-l sm:border-border/40">
                    <span className="text-[10px] uppercase tracking-wider text-text-dim">Max context</span>
                    <span className="text-[18px] font-mono font-bold text-terminal">{view.limit.toLocaleString()} <span className="text-[11px] text-text-dim">tok</span></span>
                    <span className="text-[10px] text-text-dim">
                        Current Scene: <span className="text-text-primary font-mono">{view.currentSceneTokens.toLocaleString()}</span> ({fmtPct((view.currentSceneTokens / view.limit) * 100)})
                    </span>
                </div>
            </div>

            {/* Balance bar + legend */}
            <div className="space-y-2">
                <div className="flex h-3.5 w-full overflow-hidden rounded border border-border" role="img" aria-label="Context allocation balance">
                    {legend.map(seg => (
                        <div
                            key={seg.id}
                            title={`${SEGMENT_LABEL[seg.id]}: ${seg.tokens.toLocaleString()} tok (${fmtPct(seg.pct)})`}
                            style={{ width: `${seg.pct}%`, background: SEGMENT_COLOR[seg.id] }}
                        />
                    ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-text-dim">
                    {legend.map(seg => (
                        <span key={seg.id} className="inline-flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-sm" style={{ background: SEGMENT_COLOR[seg.id] }} aria-hidden />
                            {SEGMENT_LABEL[seg.id]} <span className="font-mono">{fmtPct(seg.pct)}</span>
                        </span>
                    ))}
                </div>
            </div>

            <div className="border-t border-border/50">{main.map(renderRow)}</div>

            <div className="border-t border-border/50 pt-3">
                <button type="button" onClick={() => setShowAdvanced(v => !v)} className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal">
                    {showAdvanced ? '▾' : '▸'} Advanced ({advanced.length})
                </button>
                {showAdvanced && <div className="mt-1">{advanced.map(renderRow)}</div>}
            </div>

            <div className="flex justify-end border-t border-border/50 pt-4">
                <button
                    type="button"
                    disabled={!anyCustom}
                    onClick={() => { setDrafts({}); updateSettings(resetAll()); }}
                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-mono border border-border rounded hover:border-terminal hover:text-terminal disabled:opacity-40 disabled:hover:border-border disabled:hover:text-inherit"
                >Reset all to defaults</button>
            </div>
        </div>
    );
}
