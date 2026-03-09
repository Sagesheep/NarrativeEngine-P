import { useState } from 'react';
import { ScrollText, ChevronDown, ChevronRight, Database, List, Briefcase, RefreshCw, User, Loader2, Sparkles } from 'lucide-react';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES, DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT } from '../store/useAppStore';
import { scanInventory } from '../services/inventoryParser';
import { scanCharacterProfile } from '../services/characterProfileParser';
import { populateEngineTags } from '../services/chatEngine';
import type { EndpointConfig, ProviderConfig } from '../types';

const RULES_LIMIT = 5000;

function TokenCounter({ text, limit }: { text: string; limit: number }) {
    const chars = text.length;
    const tokens = Math.ceil(chars / 4);
    const pct = Math.min((chars / limit) * 100, 100);
    const isOver = chars > limit;

    return (
        <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1 bg-void-lighter">
                <div
                    className={`h-full transition-all duration-300 ${isOver ? 'bg-danger' : 'bg-terminal-dim'}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className={`text-[10px] font-mono ${isOver ? 'text-danger' : 'text-text-dim'}`}>
                {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tok
            </span>
        </div>
    );
}

function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onChange(); }}
            className={`relative w-7 h-3.5 rounded-full transition-colors shrink-0 ${active ? 'bg-terminal' : 'bg-border'}`}
            title={active ? 'Active — will be appended' : 'Inactive — will not be appended'}
        >
            <div
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-surface transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
}

function Section({ title, color, defaultOpen, children }: {
    title: string;
    color: string;
    defaultOpen: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="border-b border-border last:border-b-0">
            <button
                onClick={() => setOpen(!open)}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.2em] font-bold hover:bg-void-lighter transition-colors ${color}`}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {title}
            </button>
            {open && (
                <div className="px-4 pb-4 pt-1 space-y-4">
                    {children}
                </div>
            )}
        </div>
    );
}

function TemplateField({ icon, label, color, value, onChange, placeholder, rows, active, onToggle, hint }: {
    icon: React.ReactNode;
    label: string;
    color: string;
    value: string;
    onChange: (val: string) => void;
    placeholder: string;
    rows: number;
    active: boolean;
    onToggle: () => void;
    hint?: string;
}) {
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className={`flex items-center gap-2 text-[11px] uppercase tracking-wider ${color}`}>
                    {icon}
                    {label}
                </label>
                <Toggle active={active} onChange={onToggle} />
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className={`w-full bg-void border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-opacity ${active ? 'border-border' : 'border-border/40 opacity-50'
                    }`}
            />
            {hint && (
                <p className="text-[9px] text-text-dim/50 mt-1">{hint}</p>
            )}
        </div>
    );
}

export function ContextDrawer() {
    const { context, updateContext, drawerOpen, toggleDrawer, loreChunks, updateLoreChunk, messages, getActiveStoryEndpoint } = useAppStore();
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
    const [isScanningInventory, setIsScanningInventory] = useState(false);
    const [isScanningProfile, setIsScanningProfile] = useState(false);
    const [populatingField, setPopulatingField] = useState<string | null>(null);

    if (!drawerOpen) return null;

    const handleCheckInventory = async () => {
        if (isScanningInventory) return;
        setIsScanningInventory(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newInventory = await scanInventory(provider as ProviderConfig | EndpointConfig, messages, context.inventory);
            updateContext({ inventory: newInventory });
        } catch (e) {
            console.error('Failed to scan inventory:', e);
            // Optionally, we could show a toast here. For now, it fails silently in UI.
        } finally {
            setIsScanningInventory(false);
        }
    };

    const handlePopulateProfile = async () => {
        if (isScanningProfile) return;
        setIsScanningProfile(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newProfile = await scanCharacterProfile(provider as ProviderConfig | EndpointConfig, messages, context.characterProfile);
            updateContext({ characterProfile: newProfile });
        } catch (e) {
            console.error('Failed to scan character profile:', e);
        } finally {
            setIsScanningProfile(false);
        }
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

    return (
        <>
            {/* Mobile backdrop */}
            <div
                className="fixed inset-0 bg-overlay z-40 md:hidden"
                onClick={toggleDrawer}
            />
            <aside className="
                fixed inset-0 z-50 w-full bg-surface flex flex-col overflow-hidden
                md:static md:w-80 md:z-auto md:border-r md:border-border md:shrink-0
            ">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-[11px] text-terminal uppercase tracking-[0.25em] font-bold glow-green">
                        ◆ CONTEXT BANK
                    </h2>
                    <button
                        onClick={toggleDrawer}
                        className="md:hidden text-text-dim hover:text-terminal text-xs uppercase tracking-wider"
                    >
                        ✕ Close
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {/* Context Section */}
                    <Section title="◆ System Context" color="text-terminal glow-green" defaultOpen={true}>
                        <div>
                            <label className="flex items-center gap-2 text-[11px] text-ice uppercase tracking-wider mb-2">
                                <ScrollText size={13} />
                                Rules / Mechanics
                            </label>
                            <textarea
                                value={context.rulesRaw}
                                onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                                placeholder="Paste game rules, mechanics, character stats..."
                                rows={6}
                                className="w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y"
                            />
                            <TokenCounter text={context.rulesRaw} limit={RULES_LIMIT} />
                        </div>
                    </Section>

                    {/* World Info Section */}
                    {loreChunks.length > 0 && (
                        <Section title="◆ World Info" color="text-ice" defaultOpen={false}>
                            <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                                Chunks trigger when keywords appear in recent messages
                            </p>
                            <div className="space-y-3">
                                {(() => {
                                    const alwaysOn = loreChunks.filter(c => c.alwaysInclude);
                                    const conditional = loreChunks.filter(c => !c.alwaysInclude);

                                    const renderChunk = (chunk: typeof loreChunks[0]) => (
                                        <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${chunk.alwaysInclude ? 'border-terminal/40 shadow-[0_0_10px_rgba(74,222,128,0.05)]' : 'border-border'}`}>
                                            {/* Header row */}
                                            <div className="flex items-center justify-between mb-1.5">
                                                <span className="text-[10px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                                                    {chunk.header}
                                                </span>
                                                <span className="text-[9px] text-text-dim shrink-0">
                                                    {chunk.tokens}tk
                                                </span>
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
                        </Section>
                    )}

                    {/* Engine Tuning Section */}
                    <Section title="◇ Engine Tuning" color="text-ice" defaultOpen={false}>
                        <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                            Configure thresholds and tags for the local narrative engines.
                        </p>

                        <div className="space-y-4">
                            {/* Surprise Engine Tuning */}
                            <div className="space-y-2">
                                <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                                        Surprise Engine
                                    </div>
                                    <Toggle active={context.surpriseEngineActive ?? true} onChange={() => updateContext({ surpriseEngineActive: !(context.surpriseEngineActive ?? true) })} />
                                </div>
                                <div className="bg-void border border-border p-3 space-y-3">
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                Initial DC (Default 95)
                                            </label>
                                            <input
                                                type="number"
                                                value={context.surpriseConfig?.initialDC ?? 95}
                                                onChange={(e) => {
                                                    const val = parseInt(e.target.value);
                                                    updateContext({
                                                        surpriseConfig: {
                                                            ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 }),
                                                            initialDC: isNaN(val) ? 95 : val
                                                        }
                                                    });
                                                }}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                            />
                                        </div>
                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                DC Drop per turn (Def 3)
                                            </label>
                                            <input
                                                type="number"
                                                value={context.surpriseConfig?.dcReduction ?? 3}
                                                onChange={(e) => {
                                                    const val = parseInt(e.target.value);
                                                    updateContext({
                                                        surpriseConfig: {
                                                            ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 }),
                                                            dcReduction: isNaN(val) ? 3 : val
                                                        }
                                                    });
                                                }}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex flex-col">
                                        <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                            <span>Event Types (Comma Separated)</span>
                                            <span className="flex items-center gap-2">
                                                <button
                                                    onClick={async () => {
                                                        setPopulatingField('surpriseTypes');
                                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                        if (!provider) { setPopulatingField(null); return; }
                                                        const lore = context.loreRaw || context.rulesRaw || '';
                                                        const current = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
                                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTypes');
                                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 98, dcReduction: 3 }), types: result } });
                                                        setPopulatingField(null);
                                                    }}
                                                    disabled={populatingField !== null}
                                                    className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                    title="AI-populate tags based on campaign lore"
                                                >
                                                    {populatingField === 'surpriseTypes' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                    Populate
                                                </button>
                                                <span className={(context.surpriseConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                    Min 3 tags
                                                </span>
                                            </span>
                                        </label>
                                        <textarea
                                            value={context.surpriseConfig?.types.join(', ') ?? DEFAULT_SURPRISE_TYPES.join(', ')}
                                            onChange={(e) => {
                                                const raw = e.target.value;
                                                const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                updateContext({
                                                    surpriseConfig: {
                                                        ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 98, dcReduction: 3 }),
                                                        types: tags
                                                    }
                                                });
                                            }}
                                            placeholder="ENVIRONMENTAL_HAZARD, NPC_ACTION..."
                                            rows={3}
                                            className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                        />
                                    </div>
                                    <div className="flex flex-col">
                                        <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                            <span>Event Tones (Comma Separated)</span>
                                            <span className="flex items-center gap-2">
                                                <button
                                                    onClick={async () => {
                                                        setPopulatingField('surpriseTones');
                                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                        if (!provider) { setPopulatingField(null); return; }
                                                        const lore = context.loreRaw || context.rulesRaw || '';
                                                        const current = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
                                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTones');
                                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 }), tones: result } });
                                                        setPopulatingField(null);
                                                    }}
                                                    disabled={populatingField !== null}
                                                    className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                    title="AI-populate tones based on campaign lore"
                                                >
                                                    {populatingField === 'surpriseTones' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                    Populate
                                                </button>
                                                <span className={(context.surpriseConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                    Min 3 tags
                                                </span>
                                            </span>
                                        </label>
                                        <textarea
                                            value={context.surpriseConfig?.tones.join(', ') ?? DEFAULT_SURPRISE_TONES.join(', ')}
                                            onChange={(e) => {
                                                const raw = e.target.value;
                                                const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                updateContext({
                                                    surpriseConfig: {
                                                        ...(context.surpriseConfig || { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 }),
                                                        tones: tags
                                                    }
                                                });
                                            }}
                                            placeholder="GOOD, BAD, NEUTRAL..."
                                            rows={2}
                                            className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                        />
                                    </div>
                                </div>

                                {/* Encounter Engine Tuning */}
                                <div className="space-y-2 mt-4">
                                    <div className="text-[10px] text-ember uppercase tracking-wider font-bold border-b border-ember/20 pb-1 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-ember" />
                                            Encounter Engine
                                        </div>
                                        <Toggle active={context.encounterEngineActive ?? true} onChange={() => updateContext({ encounterEngineActive: !(context.encounterEngineActive ?? true) })} />
                                    </div>
                                    <div className="bg-void border border-border p-3 space-y-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="flex flex-col">
                                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                    Initial DC (Default 198)
                                                </label>
                                                <input
                                                    type="number"
                                                    value={context.encounterConfig?.initialDC ?? 198}
                                                    onChange={(e) => {
                                                        const val = parseInt(e.target.value);
                                                        updateContext({
                                                            encounterConfig: {
                                                                ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }),
                                                                initialDC: isNaN(val) ? 198 : val
                                                            }
                                                        });
                                                    }}
                                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                                />
                                            </div>
                                            <div className="flex flex-col">
                                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                    DC Drop per turn (Def 2)
                                                </label>
                                                <input
                                                    type="number"
                                                    value={context.encounterConfig?.dcReduction ?? 2}
                                                    onChange={(e) => {
                                                        const val = parseInt(e.target.value);
                                                        updateContext({
                                                            encounterConfig: {
                                                                ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }),
                                                                dcReduction: isNaN(val) ? 2 : val
                                                            }
                                                        });
                                                    }}
                                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>Event Types (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('encounterTypes');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
                                                            const result = await populateEngineTags(provider, lore, current, 'encounterTypes');
                                                            updateContext({ encounterConfig: { ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }), types: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tags based on campaign lore"
                                                    >
                                                        {populatingField === 'encounterTypes' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.encounterConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.encounterConfig?.types.join(', ') ?? DEFAULT_ENCOUNTER_TYPES.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        encounterConfig: {
                                                            ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }),
                                                            types: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="AMBUSH, RIVAL_APPEARANCE..."
                                                rows={3}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                        <div className="flex flex-col">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>Event Tones (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('encounterTones');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
                                                            const result = await populateEngineTags(provider, lore, current, 'encounterTones');
                                                            updateContext({ encounterConfig: { ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }), tones: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tones based on campaign lore"
                                                    >
                                                        {populatingField === 'encounterTones' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.encounterConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.encounterConfig?.tones.join(', ') ?? DEFAULT_ENCOUNTER_TONES.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        encounterConfig: {
                                                            ...(context.encounterConfig || { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 }),
                                                            tones: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="TENSE, DESPERATE, EPICK..."
                                                rows={2}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* World Engine Tuning */}
                                <div className="space-y-2 mt-4">
                                    <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                                            World Engine
                                        </div>
                                        <Toggle active={context.worldEngineActive ?? true} onChange={() => updateContext({ worldEngineActive: !(context.worldEngineActive ?? true) })} />
                                    </div>
                                    <div className="bg-void border border-border p-3 space-y-3">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="flex flex-col">
                                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                    Initial DC (Default 498)
                                                </label>
                                                <input
                                                    type="number"
                                                    value={context.worldEventConfig?.initialDC ?? 498}
                                                    onChange={(e) => {
                                                        const val = parseInt(e.target.value);
                                                        updateContext({
                                                            worldEventConfig: {
                                                                ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2 }),
                                                                initialDC: isNaN(val) ? 498 : val
                                                            }
                                                        });
                                                    }}
                                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                                />
                                            </div>
                                            <div className="flex flex-col">
                                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">
                                                    DC Drop per turn (Def 2)
                                                </label>
                                                <input
                                                    type="number"
                                                    value={context.worldEventConfig?.dcReduction ?? 2}
                                                    onChange={(e) => {
                                                        const val = parseInt(e.target.value);
                                                        updateContext({
                                                            worldEventConfig: {
                                                                ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2 }),
                                                                dcReduction: isNaN(val) ? 2 : val
                                                            }
                                                        });
                                                    }}
                                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                                />
                                            </div>
                                        </div>
                                        <div className="flex flex-col mt-2">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>"Who" Elements (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('worldWho');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.worldEventConfig?.who || DEFAULT_WORLD_WHO;
                                                            const result = await populateEngineTags(provider, lore, current, 'worldWho');
                                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }), who: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tags based on campaign lore"
                                                    >
                                                        {populatingField === 'worldWho' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.worldEventConfig?.who?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.worldEventConfig?.who?.join(', ') ?? DEFAULT_WORLD_WHO.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        worldEventConfig: {
                                                            ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }),
                                                            who: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="a rogue splinter group, a powerful leader..."
                                                rows={2}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                        <div className="flex flex-col mt-2">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>"Where" Elements (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('worldWhere');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.worldEventConfig?.where || DEFAULT_WORLD_WHERE;
                                                            const result = await populateEngineTags(provider, lore, current, 'worldWhere');
                                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }), where: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tags based on campaign lore"
                                                    >
                                                        {populatingField === 'worldWhere' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.worldEventConfig?.where?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.worldEventConfig?.where?.join(', ') ?? DEFAULT_WORLD_WHERE.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        worldEventConfig: {
                                                            ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }),
                                                            where: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="in a neighboring city, deep underground..."
                                                rows={2}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                        <div className="flex flex-col mt-2">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>"Why" Elements (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('worldWhy');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.worldEventConfig?.why || DEFAULT_WORLD_WHY;
                                                            const result = await populateEngineTags(provider, lore, current, 'worldWhy');
                                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }), why: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tags based on campaign lore"
                                                    >
                                                        {populatingField === 'worldWhy' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.worldEventConfig?.why?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.worldEventConfig?.why?.join(', ') ?? DEFAULT_WORLD_WHY.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        worldEventConfig: {
                                                            ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }),
                                                            why: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="to seize power, for brutal vengeance..."
                                                rows={2}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                        <div className="flex flex-col mt-2">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                                <span>"What" Elements (Comma Separated)</span>
                                                <span className="flex items-center gap-2">
                                                    <button
                                                        onClick={async () => {
                                                            setPopulatingField('worldWhat');
                                                            const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                            if (!provider) { setPopulatingField(null); return; }
                                                            const lore = context.loreRaw || context.rulesRaw || '';
                                                            const current = context.worldEventConfig?.what || DEFAULT_WORLD_WHAT;
                                                            const result = await populateEngineTags(provider, lore, current, 'worldWhat');
                                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }), what: result } });
                                                            setPopulatingField(null);
                                                        }}
                                                        disabled={populatingField !== null}
                                                        className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                                                        title="AI-populate tags based on campaign lore"
                                                    >
                                                        {populatingField === 'worldWhat' ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
                                                        Populate
                                                    </button>
                                                    <span className={(context.worldEventConfig?.what?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>
                                                        Min 3 tags
                                                    </span>
                                                </span>
                                            </label>
                                            <textarea
                                                value={context.worldEventConfig?.what?.join(', ') ?? DEFAULT_WORLD_WHAT.join(', ')}
                                                onChange={(e) => {
                                                    const raw = e.target.value;
                                                    const tags = raw.split(',').map(t => t.trim()).filter(Boolean);
                                                    updateContext({
                                                        worldEventConfig: {
                                                            ...(context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] }),
                                                            what: tags
                                                        }
                                                    });
                                                }}
                                                placeholder="declared hostilities, discovered a relic..."
                                                rows={2}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <div className="text-[10px] text-ice uppercase tracking-wider font-bold border-b border-ice/20 pb-1 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-ice" />
                                        Dice Fairness Engine
                                    </div>
                                    <Toggle active={context.diceFairnessActive ?? true} onChange={() => updateContext({ diceFairnessActive: !(context.diceFairnessActive ?? true) })} />
                                </div>
                                <div className="bg-void border border-border p-3 space-y-2">
                                    {[
                                        { label: 'Catastrophe (<=)', key: 'catastrophe' as const, def: 2 },
                                        { label: 'Failure (<=)', key: 'failure' as const, def: 6 },
                                        { label: 'Success (<=)', key: 'success' as const, def: 15 },
                                        { label: 'Triumph (<=)', key: 'triumph' as const, def: 19 },
                                        { label: 'Critical (<=)', key: 'crit' as const, def: 20 },
                                    ].map(({ label, key, def }) => (
                                        <div key={key} className="flex flex-col">
                                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1" title={`Default: ${def} (Min:1, Max:20)`}>
                                                {label}
                                            </label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={20}
                                                placeholder={`Def: ${def} (Min:1, Max:20)`}
                                                title={`Default: ${def} (Min:1, Max:20)`}
                                                value={context.diceConfig?.[key] ?? ''}
                                                onChange={(e) => {
                                                    const val = parseInt(e.target.value);
                                                    updateContext({
                                                        diceConfig: {
                                                            ...(context.diceConfig || {
                                                                catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20
                                                            }),
                                                            [key]: isNaN(val) ? 0 : val
                                                        }
                                                    });
                                                }}
                                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </Section>

                    {/* Bookkeeping Section */}
                    <Section title="◇ Bookkeeping" color="text-ember" defaultOpen={true}>
                        <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                            Toggle ON = appended to context. Use Check Inventory to auto-update.
                        </p>

                        <div>
                            <TemplateField
                                icon={<Briefcase size={13} />}
                                label="Player Inventory"
                                color="text-ice"
                                value={context.inventory}
                                onChange={(v) => updateContext({ inventory: v })}
                                placeholder={"- 50 Gold Coins\n- Rusty Sword\n- 3x Healing Potions"}
                                rows={6}
                                active={context.inventoryActive}
                                onToggle={() => updateContext({ inventoryActive: !context.inventoryActive })}
                            />
                            <div className="mt-2 flex justify-end">
                                <button
                                    onClick={handleCheckInventory}
                                    disabled={isScanningInventory}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                                    title="Silent AI generation based on recent chat history"
                                >
                                    <RefreshCw size={12} className={`text-terminal ${isScanningInventory ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                                    {isScanningInventory ? 'Scanning...' : 'Check Inventory'}
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-border/50">
                            <TemplateField
                                icon={<User size={13} />}
                                label="Character Profile"
                                color="text-ember"
                                value={context.characterProfile}
                                onChange={(v) => updateContext({ characterProfile: v })}
                                placeholder={"Name: Eldon\nRace: Elf\nClass: Rogue\nLevel: 3\n\nAbilities:\n- Stealth\n- Backstab"}
                                rows={6}
                                active={context.characterProfileActive}
                                onToggle={() => updateContext({ characterProfileActive: !context.characterProfileActive })}
                            />
                            <div className="mt-2 flex justify-end">
                                <button
                                    onClick={handlePopulateProfile}
                                    disabled={isScanningProfile}
                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                                    title="Silent AI generation based on recent chat history"
                                >
                                    <RefreshCw size={12} className={`text-terminal ${isScanningProfile ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
                                    {isScanningProfile ? 'Scanning...' : 'Populate Profile'}
                                </button>
                            </div>
                        </div>
                    </Section>

                    {/* Save File Section */}
                    <Section title="◇ Save File" color="text-ember" defaultOpen={false}>
                        <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                            Toggle ON = appended to context (top→bottom order)
                        </p>

                        <TemplateField
                            icon={<Database size={13} />}
                            label="Canon State"
                            color="text-ember"
                            value={context.canonState}
                            onChange={(v) => updateContext({ canonState: v })}
                            placeholder="Paste canon state data..."
                            rows={6}
                            active={context.canonStateActive}
                            onToggle={() => updateContext({ canonStateActive: !context.canonStateActive })}
                        />

                        <TemplateField
                            icon={<List size={13} />}
                            label="Header Index"
                            color="text-ice"
                            value={context.headerIndex}
                            onChange={(v) => updateContext({ headerIndex: v })}
                            placeholder="Paste header index..."
                            rows={4}
                            active={context.headerIndexActive}
                            onToggle={() => updateContext({ headerIndexActive: !context.headerIndexActive })}
                        />


                    </Section>
                </div>
            </aside>
        </>
    );
}
