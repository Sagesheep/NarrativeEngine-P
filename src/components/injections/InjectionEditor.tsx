import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, MessageSquare, ArrowRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { InjectionTrigger, PromptInjection } from '../../types';
import type { OpenAIMessage } from '../../services/llm/llmService';
import { INJECTION_TRIGGERS, normalizeInjections, planInjections } from '../../services/payload/promptInjections';
import { uid } from '../../utils/uid';

const inputClass = 'w-full rounded-xl border border-border bg-void px-3 py-2.5 text-sm text-text-primary outline-none focus:border-terminal focus:ring-1 focus:ring-terminal/30';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:border-terminal hover:text-terminal disabled:opacity-30 disabled:pointer-events-none';
const roleColor = { system: 'text-amber-500', user: 'text-sky-500', assistant: 'text-violet-400' };
const triggerLabels: Record<InjectionTrigger, string> = { reply: 'Replies / retries', swipe: 'Swipes', continue: 'Continues' };
const example: OpenAIMessage[] = [
    { role: 'system', content: 'Rules, world context & memories' },
    { role: 'user', content: 'Earlier player message' },
    { role: 'assistant', content: 'Earlier narrator reply' },
    { role: 'user', content: 'Latest player message' },
];
const placementLabel = (item: PromptInjection) => item.mode !== 'message' ? 'Start of assistant response'
    : item.depth === 0 ? 'After latest message' : `Before message ${item.depth} from the end`;

export function InjectionEditor() {
    const settings = useAppStore(s => s.settings);
    const campaignId = useAppStore(s => s.activeCampaignId);
    const campaignInjections = useAppStore(s => s.context.promptInjections);
    const updateContext = useAppStore(s => s.updateContext);

    const [selectedId, setSelectedId] = useState('');
    const [previewTrigger, setPreviewTrigger] = useState<InjectionTrigger>('reply');
    const [removed, setRemoved] = useState<{ campaignId: string; item: PromptInjection; index: number } | null>(null);
    const preset = settings.presets.find(p => p.id === settings.activePresetId) ?? settings.presets[0];
    const items = normalizeInjections(campaignInjections);
    const selected = items.find(item => item.id === selectedId) ?? items[0];
    const provider = settings.providers.find(p => p.id === preset?.storyAIProviderId);
    const format = provider?.apiFormat ?? 'openai';
    const placements = planInjections(example, items, previewTrigger, format);
    const save = (next: PromptInjection[]) => {
        if (campaignId && useAppStore.getState().activeCampaignId === campaignId) updateContext({ promptInjections: next });
    };
    const patch = (id: string, changes: Partial<PromptInjection>) => save(items.map(item => item.id === id ? { ...item, ...changes } : item));
    const add = (mode: PromptInjection['mode'] = 'message') => {
        const item: PromptInjection = {
            id: uid(), name: mode === 'reasoning' ? 'Reasoning prefill' : 'New injection', enabled: true,
            role: mode === 'message' ? 'system' : 'assistant', content: '', depth: 0,
            triggers: [...INJECTION_TRIGGERS], mode,
        };
        save([...items, item]);
        setSelectedId(item.id);
    };
    const move = (direction: number) => {
        if (!selected) return;
        const index = items.findIndex(item => item.id === selected.id);
        const next = [...items];
        const destination = index + direction;
        if (destination < 0 || destination >= next.length) return;
        [next[index], next[destination]] = [next[destination], next[index]];
        save(next);
    };
    if (!campaignId) return <p className="p-6 text-text-dim">Open a campaign to edit its injections.</p>;

    return (
        <section className="mx-auto w-full min-w-0 max-w-[100rem] px-2 pb-10 text-text-primary" aria-label="Campaign injections">
            <p className="mb-4 text-xs text-text-dim">Saved automatically for this campaign only.</p>
            <div className="grid grid-cols-1 items-start gap-5 ">
                <details className="rounded-2xl border border-border bg-surface/40 p-3">
                    <summary className="cursor-pointer text-xs font-semibold">Manage injections ({items.length})</summary><div className="my-3 flex items-center justify-between px-1">
                        <span className="text-xs font-semibold uppercase tracking-wider">Injections <span className="ml-1 text-text-dim">{items.length}</span></span>
                        <span className="text-[11px] text-terminal">{items.filter(item => item.enabled && item.content.trim() && item.triggers.length).length} on</span>
                    </div>
                    <div className="space-y-2">
                        {items.map(item => <div key={item.id} className={`flex items-start gap-2 rounded-xl border p-3 transition-colors ${selected?.id === item.id ? 'border-terminal/60 bg-terminal/5' : 'border-border hover:border-text-dim'}`}>
                            <input type="checkbox" role="switch" aria-label={`Enable ${item.name}`} checked={item.enabled} onChange={event => patch(item.id, { enabled: event.target.checked })} className="mt-1 accent-terminal" />
                            <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(item.id)}>
                                <span className={`block truncate text-sm font-medium ${item.enabled ? '' : 'text-text-dim'}`}>{item.name || 'Untitled injection'}</span>
                                <span className={`mt-1 block text-[10px] uppercase tracking-wider ${roleColor[item.mode === 'message' ? item.role : 'assistant']}`}>{item.mode === 'message' ? `${item.role} · depth ${item.depth}` : item.mode === 'reasoning' ? 'Reasoning prefill' : 'Assistant prefill'}</span>
                                <span className="mt-2 block truncate text-xs text-text-dim">{item.content.trim() || 'Empty · not sent'}</span>
                            </button>
                        </div>)}
                    </div>
                    {!items.length && <p className="px-2 py-6 text-sm text-text-dim">Add a reminder, scene direction, or response prefix.</p>}
                    <button className={buttonClass + ' mt-3 w-full !border-terminal/40 !text-terminal'} onClick={() => add()}><Plus size={15} /> Add injection</button>
                    <button className="mt-3 w-full py-1 text-xs text-text-dim hover:text-terminal" onClick={() => add('reasoning')}>+ Reasoning prefill</button>
                    {removed?.campaignId === campaignId && <button className="mt-3 w-full text-xs text-terminal" onClick={() => {
                        const next = [...items]; next.splice(removed.index, 0, removed.item); save(next); setSelectedId(removed.item.id); setRemoved(null);
                    }}>Undo delete</button>}
                </details>

                {selected ? <div className="overflow-hidden rounded-2xl border border-border bg-surface/30">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
                        <span className="text-xs uppercase tracking-widest text-text-dim">Edit injection</span>
                        <div className="flex gap-1">
                            <button className={buttonClass} aria-label="Move injection up" disabled={items[0]?.id === selected.id} onClick={() => move(-1)}><ArrowUp size={14} /></button>
                            <button className={buttonClass} aria-label="Move injection down" disabled={items.at(-1)?.id === selected.id} onClick={() => move(1)}><ArrowDown size={14} /></button>
                            <button className={buttonClass} aria-label="Duplicate injection" onClick={() => {
                                const copy = { ...selected, id: uid(), name: `${selected.name} (copy)` }; save([...items, copy]); setSelectedId(copy.id);
                            }}><Copy size={14} /></button>
                            <button className={buttonClass} aria-label="Delete injection" onClick={() => {
                                setRemoved({ campaignId, item: selected, index: items.findIndex(item => item.id === selected.id) });
                                save(items.filter(item => item.id !== selected.id));
                            }}><Trash2 size={14} /></button>
                        </div>
                    </div>
                    <div className="space-y-6 p-5">
                        <label className="block text-xs text-text-dim">Name<input aria-label="Injection name" className={inputClass + ' mt-2'} value={selected.name} onChange={event => patch(selected.id, { name: event.target.value })} placeholder="e.g. Keep the tension rising" /></label>
                        <label className="block text-xs text-text-dim">Message content
                            <textarea aria-label="Injection content" className={inputClass + ' mt-2 min-h-40 resize-y font-mono leading-relaxed'} value={selected.content} onChange={event => patch(selected.id, { content: event.target.value })} placeholder="Write the exact text you want the model to receive…" />
                        </label>
                        <div>
                            <label className="block text-xs text-text-dim">Insert as
                                <select aria-label="Injection mode" className={inputClass + ' mt-2'} value={selected.mode} onChange={event => patch(selected.id, { mode: event.target.value as PromptInjection['mode'] })}>
                                    <option value="message">Message at depth</option><option value="prefill">Assistant prefill</option><option value="reasoning">Reasoning prefill</option>
                                </select>
                            </label>
                            <p className="mt-2 text-xs leading-relaxed text-text-dim">{selected.mode === 'message' ? 'A separate message in the outgoing conversation.' : selected.mode === 'reasoning' ? 'Starts an assistant prefix with <think> and your text. Requires a model/backend that accepts unfinished reasoning prefixes; it does not edit hidden thinking.' : 'Places your text at the end as an assistant prefix. Continuation support depends on your model/backend.'}</p>
                        </div>
                        {selected.mode === 'message' && <div className="grid gap-5 sm:grid-cols-2">
                            <fieldset className="min-w-0"><legend className="mb-2 text-xs text-text-dim">Role</legend><div className="flex rounded-xl border border-border p-1">
                                {(['system', 'user', 'assistant'] as const).map(role => <button key={role} aria-pressed={selected.role === role} className={`flex-1 rounded-lg px-2 py-2 text-xs capitalize ${selected.role === role ? 'bg-terminal/10 text-terminal' : 'text-text-dim'}`} onClick={() => patch(selected.id, { role })}>{role}</button>)}
                            </div></fieldset>
                            <label className="text-xs text-text-dim">Depth<input aria-label="Injection depth" type="number" min={0} step={1} className={inputClass + ' mt-2'} value={selected.depth} onChange={event => patch(selected.id, { depth: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} /></label>
                        </div>}
                        <div className="flex items-center gap-2 rounded-xl bg-terminal/5 px-3 py-2.5 text-xs text-terminal"><ArrowRight size={14} />{placementLabel(selected)}</div>

                        <fieldset className="min-w-0"><legend className="mb-3 text-xs text-text-dim">Send when generating</legend><div className="flex flex-wrap gap-2">
                            {INJECTION_TRIGGERS.map(trigger => <button key={trigger} aria-pressed={selected.triggers.includes(trigger)} className={buttonClass + (selected.triggers.includes(trigger) ? ' !border-terminal/50 !text-terminal bg-terminal/5' : '')} onClick={() => patch(selected.id, { triggers: selected.triggers.includes(trigger) ? selected.triggers.filter(t => t !== trigger) : [...selected.triggers, trigger] })}>{triggerLabels[trigger]}</button>)}
                        </div>{!selected.triggers.length && <p className="mt-2 text-xs text-amber-500">No triggers selected — this injection will not be sent.</p>}</fieldset>
                        <p className="text-xs leading-relaxed text-text-dim">Card order breaks ties at the same depth. Prefills come last. Injections stay out of saved chat history.</p>
                    </div>
                </div> : <div className="flex min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-border p-8 text-center">
                    <MessageSquare className="mb-5 text-terminal" size={32} /><h3 className="text-lg font-medium">No injections yet</h3>
                    <p className="mt-3 max-w-sm text-sm leading-relaxed text-text-dim">Choose a role, write your instruction, and see where it will land before generating.</p>
                    <button className={buttonClass + ' mt-6'} onClick={() => add()}><Plus size={15} /> Create your first injection</button>
                </div>}

                <details className="rounded-2xl border border-border p-4">
                    <summary className="cursor-pointer text-sm font-semibold">Placement preview</summary>
                    <p className="mt-1 text-xs leading-relaxed text-text-dim">Example conversation. Actual history is fitted to your context budget.</p>
                    <select aria-label="Preview generation" className={inputClass + ' my-4'} value={previewTrigger} onChange={event => setPreviewTrigger(event.target.value as InjectionTrigger)}>
                        {INJECTION_TRIGGERS.map(trigger => <option key={trigger} value={trigger}>{triggerLabels[trigger]}</option>)}
                    </select>
                    <div className="space-y-2 border-l border-border pl-3">
                        {Array.from({ length: example.length + 1 }, (_, index) => <div key={index} className="space-y-2">
                            {placements.filter(p => p.index === index).map(({ injection, message }) => <button key={injection.id} onClick={() => setSelectedId(injection.id)} className="block w-full rounded-xl border border-terminal/40 bg-terminal/5 p-3 text-left">
                                <span className="block text-[10px] uppercase tracking-wider text-terminal">{message.role} · injected</span>
                                <span className="mt-1 block truncate text-xs font-semibold">{injection.name || 'Untitled injection'}</span>
                                <span className="mt-1 block max-h-16 overflow-hidden whitespace-pre-wrap text-xs text-text-dim">{message.content}</span>
                            </button>)}
                            {example[index] && <div className="rounded-xl border border-border px-3 py-3 text-xs text-text-dim"><span className="block text-[10px] uppercase tracking-wider opacity-70">{example[index].role}</span><span className="mt-1 block">{example[index].content}</span></div>}
                        </div>)}
                        <div className="py-3 text-center text-xs text-terminal">↓ Model generates its reply</div>
                    </div>
                    <p className="mt-4 text-xs leading-relaxed text-text-dim">Depth counts player/narrator messages from the end. If history is shorter, the injection lands before the oldest available message. Tool exchanges stay together.</p>
                    {(format === 'claude' || format === 'gemini') && <p className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-500">This provider uses a separate system prompt. In-chat System injections are sent as labeled User messages to preserve depth.</p>}
                </details>
            </div>
            {settings.presets.some(p => normalizeInjections(p.promptInjections).length > 0) && (
                <details className="mt-5 rounded-xl border border-border p-3 text-xs text-text-dim">
                    <summary className="cursor-pointer">Copy from old preset injections</summary>
                    <p className="my-3">Copies are saved in this campaign. The original preset is unchanged.</p>
                    <div className="flex flex-wrap gap-2">
                        {settings.presets.filter(p => normalizeInjections(p.promptInjections).length > 0).map(p => (
                            <button key={p.id} className={buttonClass} onClick={() => save([
                                ...items, ...normalizeInjections(p.promptInjections).map(item => ({ ...item, id: uid() })),
                            ])}>Copy {p.name}</button>
                        ))}
                    </div>
                </details>
            )}
        </section>
    );
}
