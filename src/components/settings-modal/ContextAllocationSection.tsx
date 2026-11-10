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
    fixed: 'Fixed (injections + margin)',
    pool: 'Shared automatic pool',
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
        return (
            <div key={row.id} data-allocation-row={row.id} className="py-2 border-t border-border/40 first:border-t-0">
                <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SEGMENT_COLOR[row.id] }} aria-hidden />
                    <span className="text-[11px] text-text-primary font-bold uppercase tracking-wider flex-1 min-w-0 truncate">{info.label}</span>
                    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${row.custom ? 'border-terminal text-terminal' : 'border-border text-text-dim'}`}>
                        {row.custom ? (row.id === 'currentScene' ? 'Minimum' : 'Custom') : 'Automatic'}
                    </span>
                    <button
                        type="button"
                        onClick={() => { setDrafts(d => ({ ...d, [row.id]: undefined })); updateSettings(resetRow(settings, row.id)); }}
                        disabled={!row.custom}
                        title="Reset to default"
                        aria-label={`Reset ${info.label} to default`}
                        className="text-[11px] px-1.5 text-text-dim hover:text-terminal disabled:opacity-30 disabled:hover:text-text-dim"
                    >↺</button>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={0.5}
                        value={Math.min(100, row.pct)}
                        aria-label={`${info.label} share of the context limit`}
                        onChange={e => apply(row.id, Number(e.target.value))}
                        className={`flex-1 h-1.5 bg-border rounded-lg appearance-none cursor-pointer accent-terminal ${row.custom ? '' : 'opacity-50'}`}
                    />
                    <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${info.label} percent`}
                        value={drafts[row.id] ?? (row.pct > 0 || row.custom ? String(Math.round(row.pct * 10) / 10) : '0')}
                        onChange={e => setDrafts(d => ({ ...d, [row.id]: e.target.value }))}
                        onBlur={e => commitDraft(row.id, e.currentTarget.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { commitDraft(row.id, e.currentTarget.value); e.currentTarget.blur(); } }}
                        className="w-14 h-6 bg-surface border border-border rounded px-1.5 text-[11px] text-right font-mono focus:outline-none focus:border-terminal"
                    />
                    <span className="text-[10px] text-text-dim font-mono">%</span>
                    <span className="w-24 text-right text-[10px] font-mono text-text-primary">= {row.tokens.toLocaleString()} tok</span>
                </div>
                <p className="text-[9px] text-text-dim leading-tight mt-1 max-w-none"><span className="text-text-primary/80">Writer receives:</span> {info.receives}</p>
                <p className="text-[9px] text-text-dim leading-tight mt-0.5 max-w-none"><span className="text-text-primary/80">If lower:</span> {info.lose}</p>
                {!row.custom && row.autoNote && <p className="text-[9px] text-text-dim leading-tight mt-0.5 italic">Automatic: {row.autoNote}</p>}
                {row.custom && row.pct === 0 && row.id !== 'currentScene' && (
                    <p className="text-[9px] text-amber-400 leading-tight mt-0.5">Off — the writer receives none of this.</p>
                )}
                {row.custom && row.maxPct < row.pct - 0.05 && (
                    <p className="text-[9px] text-amber-400 leading-tight mt-0.5">Only {fmtPct(row.maxPct)} is free now; this row gets less until others shrink.</p>
                )}
                {inert && <p className="text-[9px] text-amber-400 leading-tight mt-0.5">Your rules aren't indexed, so the whole rulebook is sent as standing instructions and this row has no effect.</p>}
            </div>
        );
    };

    const main = view.rows.filter(r => !ROWS.find(i => i.id === r.id)!.advanced);
    const advanced = view.rows.filter(r => ROWS.find(i => i.id === r.id)!.advanced);

    return (
        <div data-ui="context-allocation" className="bg-void p-3 border border-border rounded space-y-2" style={{ gridColumn: '1 / -1' }}>
            <div>
                <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold">Context Allocation</label>
                    <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-[10px]">
                        of {view.limit.toLocaleString()} tok
                    </span>
                </div>
                <p className="text-[9px] text-text-dim leading-tight">
                    How much of the Max Context Limit each part of the story prompt may use. Drag a slider or type a
                    percentage. Custom parts are trimmed to fit and never go over; Current Scene gets everything left,
                    including space a part doesn't use. The total can't pass 100%. Writer instructions and your
                    message are measured each turn and come out of Current Scene.
                </p>
            </div>

            <div className="flex h-3 w-full overflow-hidden rounded border border-border" role="img" aria-label="Context allocation balance">
                {view.segments.map(seg => (
                    <div
                        key={seg.id}
                        title={`${SEGMENT_LABEL[seg.id]}: ${seg.tokens.toLocaleString()} tok (${fmtPct((seg.tokens / view.limit) * 100)})`}
                        style={{ width: `${(seg.tokens / view.limit) * 100}%`, background: SEGMENT_COLOR[seg.id] }}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-text-dim">
                <span>Fixed {view.fixedTokens.toLocaleString()}</span>
                {view.poolTokens > 0 && <span>Shared pool {view.poolTokens.toLocaleString()}</span>}
                <span className="text-text-primary">Current Scene {view.currentSceneTokens.toLocaleString()} ({fmtPct((view.currentSceneTokens / view.limit) * 100)})</span>
            </div>

            <div>{main.map(renderRow)}</div>

            <button type="button" onClick={() => setShowAdvanced(v => !v)} className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal">
                {showAdvanced ? '▾' : '▸'} Advanced ({advanced.length})
            </button>
            {showAdvanced && <div>{advanced.map(renderRow)}</div>}

            <div className="flex justify-end pt-1">
                <button
                    type="button"
                    disabled={!anyCustom}
                    onClick={() => { setDrafts({}); updateSettings(resetAll()); }}
                    className="px-2 py-1 text-[10px] uppercase font-mono border border-border rounded hover:border-terminal disabled:opacity-40"
                >Reset all to defaults</button>
            </div>
        </div>
    );
}
