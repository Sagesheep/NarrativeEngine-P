import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Braces, RotateCcw, Search, Undo2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { PromptOverride } from '../../types';
import {
    PROMPT_GROUPS, hashPromptText, isOverrideStale, listPrompts, missingPlaceholders,
    normalizePromptOverrides, unknownPlaceholders, withOverride, withoutOverride,
    type PromptDefinition,
} from '../../services/prompts/promptRegistry';

const inputClass = 'w-full rounded-xl border border-border bg-void px-3 py-2.5 text-sm text-text-primary outline-none focus:border-terminal focus:ring-1 focus:ring-terminal/30';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:border-terminal hover:text-terminal disabled:opacity-30 disabled:pointer-events-none';
const noteClass = 'flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-relaxed';

/**
 * Prompt Modification: every built-in AI prompt, editable for this campaign only.
 * An edit is stored in `context.promptOverrides`; "Return to default" removes it.
 */
export function PromptModificationTab() {
    const campaignId = useAppStore(s => s.activeCampaignId);
    const stored = useAppStore(s => s.context.promptOverrides);
    const updateContext = useAppStore(s => s.updateContext);
    const overrides = useMemo(() => normalizePromptOverrides(stored) ?? {}, [stored]);

    const prompts = listPrompts();
    const [selectedId, setSelectedId] = useState(prompts[0]?.id ?? '');
    const [query, setQuery] = useState('');
    const [modifiedOnly, setModifiedOnly] = useState(false);
    const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
    const [undo, setUndo] = useState<{ campaignId: string; overrides: Record<string, PromptOverride> } | null>(null);
    const [confirmResetAll, setConfirmResetAll] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    if (!campaignId) return <p className="p-6 text-text-dim">Open a campaign to edit its prompts.</p>;

    const save = (next: Record<string, PromptOverride> | undefined) => {
        if (useAppStore.getState().activeCampaignId === campaignId) updateContext({ promptOverrides: next });
    };
    const modifiedCount = Object.keys(overrides).length;
    const selected = prompts.find(def => def.id === selectedId) ?? prompts[0];
    const override = selected ? overrides[selected.id] : undefined;
    const text = draft?.id === selected?.id ? draft.text : (override?.text ?? selected?.text ?? '');

    const needle = query.trim().toLowerCase();
    const visible = prompts.filter(def =>
        (!modifiedOnly || overrides[def.id])
        && (!needle || `${def.label} ${def.description} ${def.id}`.toLowerCase().includes(needle)));

    const edit = (value: string) => {
        if (!selected) return;
        setDraft({ id: selected.id, text: value });
        save(withOverride(overrides, selected.id, value));
    };
    const resetOne = (def: PromptDefinition) => {
        setUndo({ campaignId, overrides });
        setDraft(null);
        save(withoutOverride(overrides, def.id));
    };
    const resetAll = () => {
        setUndo({ campaignId, overrides });
        setDraft(null);
        setConfirmResetAll(false);
        save(undefined);
    };
    const keepMine = (def: PromptDefinition) => {
        const current = overrides[def.id];
        if (current) save({ ...overrides, [def.id]: { ...current, baseHash: hashPromptText(def.text) } });
    };
    const insertPlaceholder = (name: string) => {
        const area = textareaRef.current;
        const token = `{{${name}}}`;
        const start = area?.selectionStart ?? text.length;
        const end = area?.selectionEnd ?? text.length;
        edit(text.slice(0, start) + token + text.slice(end));
        requestAnimationFrame(() => {
            area?.focus();
            area?.setSelectionRange(start + token.length, start + token.length);
        });
    };

    const missing = selected ? missingPlaceholders(selected.id, text) : [];
    const unknown = selected ? unknownPlaceholders(selected.id, text) : [];
    const stale = selected && override ? isOverrideStale(selected.id, override) : false;

    return (
        <section className="mx-auto grid w-full max-w-[100rem] grid-cols-1 gap-5 px-2 pb-10 text-text-primary lg:grid-cols-[22rem_minmax(0,1fr)]" aria-label="Prompt modification" data-ui="prompt-modification">
            <aside className="min-w-0 space-y-3">
                <p className="text-xs leading-relaxed text-text-dim">
                    Every built-in AI prompt, editable for <span className="text-text-primary">this campaign only</span>. Saved automatically. Other campaigns keep the default.
                </p>
                <label className="relative block">
                    <Search size={14} className="pointer-events-none absolute left-3 top-3 text-text-dim" />
                    <input aria-label="Search prompts" className={inputClass + ' pl-8'} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search prompts" />
                </label>
                <div className="flex items-center justify-between gap-2 px-1 text-xs">
                    <label className="flex cursor-pointer items-center gap-2 text-text-dim">
                        <input type="checkbox" className="accent-terminal" checked={modifiedOnly} onChange={event => setModifiedOnly(event.target.checked)} />
                        Modified only
                    </label>
                    <span className="text-terminal">{modifiedCount} modified</span>
                </div>
                <nav aria-label="Prompts" className="max-h-[65vh] space-y-4 overflow-y-auto rounded-2xl border border-border bg-surface/40 p-2">
                    {PROMPT_GROUPS.map(group => {
                        const items = visible.filter(def => def.group === group.id);
                        if (!items.length) return null;
                        return (
                            <div key={group.id}>
                                <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-text-dim">{group.label}</p>
                                {items.map(def => {
                                    const entry = overrides[def.id];
                                    const isSelected = def.id === selected?.id;
                                    return (
                                        <button key={def.id} type="button" onClick={() => { setSelectedId(def.id); setDraft(null); }}
                                            aria-current={isSelected ? 'true' : undefined}
                                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${isSelected ? 'bg-terminal/10 text-terminal' : 'text-text-secondary hover:bg-terminal/5 hover:text-terminal'}`}>
                                            <span className="min-w-0 flex-1 truncate">{def.label}</span>
                                            {entry && isOverrideStale(def.id, entry) && <AlertTriangle size={12} className="shrink-0 text-amber-500" aria-label="Default changed" />}
                                            {entry && <span className="shrink-0 rounded-full bg-terminal/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-terminal">Modified</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                    {!visible.length && <p className="px-2 py-6 text-center text-xs text-text-dim">No prompts match.</p>}
                </nav>
                <div className="space-y-2">
                    {confirmResetAll
                        ? <div className="flex gap-2">
                            <button type="button" className={buttonClass + ' flex-1 !border-amber-500/60 !text-amber-500'} onClick={resetAll}>Reset all {modifiedCount}</button>
                            <button type="button" className={buttonClass} onClick={() => setConfirmResetAll(false)}>Cancel</button>
                        </div>
                        : <button type="button" className={buttonClass + ' w-full'} disabled={!modifiedCount} onClick={() => setConfirmResetAll(true)}>
                            <RotateCcw size={14} /> Return all prompts to default
                        </button>}
                    {undo?.campaignId === campaignId && (
                        <button type="button" className="flex w-full items-center justify-center gap-2 py-1 text-xs text-terminal" onClick={() => { save(Object.keys(undo.overrides).length ? undo.overrides : undefined); setUndo(null); setDraft(null); }}>
                            <Undo2 size={13} /> Undo reset
                        </button>
                    )}
                </div>
            </aside>

            {selected && (
                <div className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface/30">
                    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
                        <div className="min-w-0">
                            <h3 className="text-sm font-semibold">{selected.label}</h3>
                            <p className="mt-1 text-xs leading-relaxed text-text-dim">{selected.description}</p>
                            <p className="mt-1 font-mono text-[10px] text-text-dim">{selected.id}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-wider ${override ? 'bg-terminal/15 text-terminal' : 'bg-border/40 text-text-dim'}`}>{override ? 'Modified' : 'Default'}</span>
                            <button type="button" className={buttonClass} disabled={!override && draft?.id !== selected.id} onClick={() => resetOne(selected)}>
                                <RotateCcw size={14} /> Return to default
                            </button>
                        </div>
                    </header>
                    <div className="space-y-4 p-5">
                        {stale && (
                            <div className={noteClass + ' flex-wrap bg-amber-500/10 text-amber-500'}>
                                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                <span className="min-w-0 flex-1">The built-in version of this prompt has changed since you edited it. Compare with the new default below, then return to default or keep yours.</span>
                                <button type="button" className="underline" onClick={() => keepMine(selected)}>Keep mine</button>
                            </div>
                        )}
                        {selected.readsReply && (
                            <div className={noteClass + ' bg-terminal/5 text-text-dim'}>
                                <Braces size={14} className="mt-0.5 shrink-0 text-terminal" />
                                <span>The app reads this prompt's reply. Keep the output format it asks for, or this feature may stop working.</span>
                            </div>
                        )}
                        <textarea ref={textareaRef} aria-label="Prompt text" spellCheck={false}
                            className={inputClass + ' min-h-[45vh] resize-y font-mono text-xs leading-relaxed'}
                            value={text} onChange={event => edit(event.target.value)} />
                        {!text.trim() && <p className="text-xs text-text-dim">Empty: the built-in text will be used.</p>}
                        {missing.length > 0 && text.trim() && (
                            <div className={noteClass + ' bg-amber-500/10 text-amber-500'}>
                                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                <span>Removed: {missing.map(name => `{{${name}}}`).join(', ')}. That data will no longer reach the AI.</span>
                            </div>
                        )}
                        {unknown.length > 0 && (
                            <div className={noteClass + ' bg-amber-500/10 text-amber-500'}>
                                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                <span>Not filled by the app: {unknown.map(name => `{{${name}}}`).join(', ')}. It is sent exactly as written.</span>
                            </div>
                        )}
                        {Object.keys(selected.placeholders).length > 0 && (
                            <div>
                                <p className="mb-2 text-xs text-text-dim">Placeholders the app fills in. Click one to insert it at the cursor.</p>
                                <ul className="grid gap-1.5 sm:grid-cols-2">
                                    {Object.entries(selected.placeholders).map(([name, description]) => (
                                        <li key={name}>
                                            <button type="button" onClick={() => insertPlaceholder(name)} className="flex w-full items-baseline gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs hover:border-terminal">
                                                <code className="shrink-0 text-terminal">{`{{${name}}}`}</code>
                                                <span className="min-w-0 truncate text-text-dim" title={description}>{description}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {override && (
                            <details className="rounded-xl border border-border p-3" open={stale}>
                                <summary className="cursor-pointer text-xs font-semibold">Built-in default</summary>
                                <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-dim">{selected.text}</pre>
                            </details>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}
