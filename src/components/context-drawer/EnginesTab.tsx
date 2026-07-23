import { useState } from 'react';
import { Loader2, Sparkles, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES, DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT } from '../../store/useAppStore';
import { populateEngineTags } from '../../services/chatEngine';
import { Toggle } from './Toggle';
import { NPCPressureInspector } from '../NPCPressureInspector';
import { buildDefaultDiceSystem } from '../../types';
import { validateBands } from '../../services/engine/diceTier';
import { countTokens } from '../../services/infrastructure/tokenizer';
import {
    minifyBookkeepingStub,
    minifySelectedInventory,
    minifySelectedProfile,
} from '../../services/turn/contextMinifier';
import type { DieType, OutcomeBand, DiceCategory, CharacterProfile } from '../../types';

function uid(prefix: string) { return `${prefix}_${Math.random().toString(36).slice(2, 9)}`; }

export function EnginesTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const openDivergenceEntry = useAppStore((s) => s.openDivergenceEntry);
    const [populatingField, setPopulatingField] = useState<string | null>(null);

    const renderPopulateButton = (fieldKey: string, onPopulate: () => Promise<void>) => (
        <button
            onClick={async () => {
                setPopulatingField(fieldKey);
                await onPopulate();
                setPopulatingField(null);
            }}
            disabled={populatingField !== null}
            className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
            title="AI-populate tags based on campaign lore"
        >
            {populatingField === fieldKey ? <Loader2 size={9} className="animate-spin" /> : <Sparkles size={9} />}
            Populate
        </button>
    );

    const surpriseDefaults = { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 };
    const encounterDefaults = { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 };
    const worldDefaults = { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] };

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Configure thresholds and tags for the local narrative engines.
            </p>

            <div className="space-y-4">
                {/* Surprise Engine */}
                <div className="space-y-2">
                    <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                            Surprise Engine
                        </div>
                        <Toggle active={context.surpriseEngineActive ?? false} onChange={() => updateContext({ surpriseEngineActive: !(context.surpriseEngineActive ?? false) })} />
                    </div>
                    <div className="bg-void border border-border p-3 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 95)</label>
                                <input
                                    type="number"
                                    value={context.surpriseConfig?.initialDC ?? 95}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), initialDC: isNaN(val) ? 95 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 3)</label>
                                <input
                                    type="number"
                                    value={context.surpriseConfig?.dcReduction ?? 3}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), dcReduction: isNaN(val) ? 3 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                        </div>

                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Types (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('surpriseTypes', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTypes');
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), types: result } });
                                    })}
                                    <span className={(context.surpriseConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.surpriseConfig?.types.join(', ') ?? DEFAULT_SURPRISE_TYPES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), types: tags } });
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
                                    {renderPopulateButton('surpriseTones', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTones');
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), tones: result } });
                                    })}
                                    <span className={(context.surpriseConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.surpriseConfig?.tones.join(', ') ?? DEFAULT_SURPRISE_TONES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), tones: tags } });
                                }}
                                placeholder="GOOD, BAD, NEUTRAL..."
                                rows={2}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                            />
                        </div>
                    </div>
                </div>

                {/* Encounter Engine */}
                <div className="space-y-2">
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
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 198)</label>
                                <input
                                    type="number"
                                    value={context.encounterConfig?.initialDC ?? 198}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), initialDC: isNaN(val) ? 198 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 2)</label>
                                <input
                                    type="number"
                                    value={context.encounterConfig?.dcReduction ?? 2}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), dcReduction: isNaN(val) ? 2 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                        </div>

                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Types (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('encounterTypes', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
                                        const result = await populateEngineTags(provider, lore, current, 'encounterTypes');
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), types: result } });
                                    })}
                                    <span className={(context.encounterConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.encounterConfig?.types.join(', ') ?? DEFAULT_ENCOUNTER_TYPES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), types: tags } });
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
                                    {renderPopulateButton('encounterTones', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
                                        const result = await populateEngineTags(provider, lore, current, 'encounterTones');
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), tones: result } });
                                    })}
                                    <span className={(context.encounterConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.encounterConfig?.tones.join(', ') ?? DEFAULT_ENCOUNTER_TONES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), tones: tags } });
                                }}
                                placeholder="TENSE, DESPERATE, EPICK..."
                                rows={2}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                            />
                        </div>
                    </div>
                </div>

                {/* World Engine */}
                <div className="space-y-2">
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
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 498)</label>
                                <input
                                    type="number"
                                    value={context.worldEventConfig?.initialDC ?? 498}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), initialDC: isNaN(val) ? 498 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 2)</label>
                                <input
                                    type="number"
                                    value={context.worldEventConfig?.dcReduction ?? 2}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), dcReduction: isNaN(val) ? 2 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                        </div>
                        {(['who', 'where', 'why', 'what'] as const).map((field) => {
                            const defaults: Record<string, string[]> = { who: DEFAULT_WORLD_WHO, where: DEFAULT_WORLD_WHERE, why: DEFAULT_WORLD_WHY, what: DEFAULT_WORLD_WHAT };
                            const labels: Record<string, string> = { who: '"Who" Elements', where: '"Where" Elements', why: '"Why" Elements', what: '"What" Elements' };
                            const placeholders: Record<string, string> = {
                                who: 'a rogue splinter group, a powerful leader...',
                                where: 'in a neighboring city, deep underground...',
                                why: 'to seize power, for brutal vengeance...',
                                what: 'declared hostilities, discovered a relic...',
                            };
                            return (
                                <div key={field} className="flex flex-col mt-2">
                                    <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                        <span>{labels[field]} (Comma Separated)</span>
                                        <span className="flex items-center gap-2">
                                            {renderPopulateButton(`world${field.charAt(0).toUpperCase() + field.slice(1)}`, async () => {
                                                const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                if (!provider) return;
                                                const lore = context.loreRaw || context.rulesRaw || '';
                                                const current = context.worldEventConfig?.[field] || defaults[field];
                                                const result = await populateEngineTags(provider, lore, current, `world${field.charAt(0).toUpperCase() + field.slice(1)}` as 'worldWho' | 'worldWhere' | 'worldWhy' | 'worldWhat');
                                                updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), [field]: result } });
                                            })}
                                            <span className={(context.worldEventConfig?.[field]?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                        </span>
                                    </label>
                                    <textarea
                                        value={context.worldEventConfig?.[field]?.join(', ') ?? defaults[field].join(', ')}
                                        onChange={(e) => {
                                            const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), [field]: tags } });
                                        }}
                                        placeholder={placeholders[field]}
                                        rows={2}
                                        className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Dice Fairness Engine (generalized) */}
                <DiceFairnessSection context={context} updateContext={updateContext} />

            </div>

            <NPCPressureInspector />

            <BookkeepingBudgetSection />

            <button
                onClick={() => openDivergenceEntry()}
                className="w-full flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest text-amber-400 border border-amber-500/30 rounded py-2 hover:bg-amber-500/10 transition-colors"
            >
                <Plus size={12} /> Add Campaign Fact
            </button>
        </div>
    );
}

// ─── Dice Fairness Section (generalized dice engine) ───────────────────

type DiceFairnessSectionProps = {
    context: ReturnType<typeof useAppStore.getState>['context'];
    updateContext: ReturnType<typeof useAppStore.getState>['updateContext'];
};

function DiceFairnessSection({ context, updateContext }: DiceFairnessSectionProps) {
    const [expandedDie, setExpandedDie] = useState<string | null>(null);
    const diceSystem = context.diceSystem ?? buildDefaultDiceSystem();

    const updateDiceSystem = (patch: Partial<typeof diceSystem>) => {
        updateContext({ diceSystem: { ...diceSystem, ...patch } });
    };

    // ── Die Types helpers ──
    const addDieType = () => {
        const newDie: DieType = {
            id: uid('dt'),
            name: 'd6',
            faces: 6,
            bands: [
                { id: uid('b'), label: 'Failure', min: 1, max: 3 },
                { id: uid('b'), label: 'Success', min: 4, max: 6 },
            ],
        };
        updateDiceSystem({ dieTypes: [...diceSystem.dieTypes, newDie] });
        setExpandedDie(newDie.id);
    };

    const removeDieType = (id: string) => {
        // Remove the die type and any categories referencing it (reassign to d20)
        const fallbackId = diceSystem.dieTypes.find(d => d.name === 'd20')?.id ?? diceSystem.dieTypes[0]?.id;
        const categories = diceSystem.categories.map(c =>
            c.dieTypeId === id && fallbackId ? { ...c, dieTypeId: fallbackId } : c
        );
        updateDiceSystem({
            dieTypes: diceSystem.dieTypes.filter(d => d.id !== id),
            categories,
        });
    };

    const updateDieType = (id: string, patch: Partial<DieType>) => {
        updateDiceSystem({
            dieTypes: diceSystem.dieTypes.map(d => d.id === id ? { ...d, ...patch } : d),
        });
    };

    // ── Band helpers ──
    const addBand = (dieId: string) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        const usedMax = die.bands.reduce((m, b) => Math.max(m, b.max), 0);
        const newMax = Math.min(usedMax + 1, die.faces);
        const newMin = usedMax + 1;
        if (newMin > die.faces) return; // no room
        const band: OutcomeBand = { id: uid('b'), label: 'New Band', min: newMin, max: newMax };
        updateDieType(dieId, { bands: [...die.bands, band] });
    };

    const updateBand = (dieId: string, bandId: string, patch: Partial<OutcomeBand>) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        updateDieType(dieId, {
            bands: die.bands.map(b => b.id === bandId ? { ...b, ...patch } : b),
        });
    };

    const removeBand = (dieId: string, bandId: string) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        updateDieType(dieId, { bands: die.bands.filter(b => b.id !== bandId) });
    };

    // ── Category helpers ──
    const addCategory = () => {
        if (diceSystem.categories.length >= 10) return;
        const fallbackId = diceSystem.dieTypes[0]?.id ?? '';
        const cat: DiceCategory = { id: uid('cat'), name: 'New Category', dieTypeId: fallbackId };
        updateDiceSystem({ categories: [...diceSystem.categories, cat] });
    };

    const updateCategory = (id: string, patch: Partial<DiceCategory>) => {
        updateDiceSystem({
            categories: diceSystem.categories.map(c => c.id === id ? { ...c, ...patch } : c),
        });
    };

    const removeCategory = (id: string) => {
        updateDiceSystem({ categories: diceSystem.categories.filter(c => c.id !== id) });
    };

    // ── Roll definition helpers ── (removed: rollDef is per-roll, not global)

    return (
        <div className="space-y-2">
            <div className="text-[10px] text-ice uppercase tracking-wider font-bold border-b border-ice/20 pb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-ice" />
                    Dice Fairness Engine
                </div>
                <Toggle active={context.diceFairnessActive ?? true} onChange={() => updateContext({ diceFairnessActive: !(context.diceFairnessActive ?? true) })} />
            </div>

            {(context.diceFairnessActive ?? true) && (
                <div className="text-[9px] text-amber-400/70 italic px-1">
                    ⚡ Pool mode active — pre-rolled dice injected. Turn OFF to let the AI call roll_dice on demand.
                </div>
            )}

            <div className="bg-void border border-border p-3 space-y-3">
                {/* ── Die Types Registry ── */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-text-dim uppercase tracking-wider font-bold">Die Types</span>
                        <button onClick={addDieType} className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors">
                            <Plus size={9} /> Add
                        </button>
                    </div>
                    {diceSystem.dieTypes.map((die) => {
                        const isExpanded = expandedDie === die.id;
                        const validation = validateBands(die.bands, die.faces);
                        return (
                            <div key={die.id} className="border border-border/50 rounded bg-surface/30">
                                <div className="flex items-center gap-2 px-2 py-1.5">
                                    <button
                                        onClick={() => setExpandedDie(isExpanded ? null : die.id)}
                                        className="text-text-dim hover:text-text-primary transition-colors"
                                    >
                                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                    </button>
                                    <input
                                        type="text"
                                        value={die.name}
                                        onChange={(e) => updateDieType(die.id, { name: e.target.value })}
                                        className="w-16 bg-surface border border-border px-1.5 py-1 text-[11px] font-mono text-text-primary focus:border-terminal outline-none"
                                    />
                                    <span className="text-[9px] text-text-dim">faces:</span>
                                    <input
                                        type="number"
                                        min={2}
                                        max={1000}
                                        value={die.faces}
                                        onChange={(e) => {
                                            const faces = parseInt(e.target.value) || 2;
                                            updateDieType(die.id, { faces });
                                        }}
                                        className="w-14 bg-surface border border-border px-1.5 py-1 text-[11px] font-mono text-text-primary focus:border-terminal outline-none"
                                    />
                                    {!validation.valid && (
                                        <span className="text-[9px] text-danger" title={validation.error}>⚠</span>
                                    )}
                                    <div className="ml-auto flex items-center gap-1">
                                        <span className="text-[9px] text-text-dim">{die.bands.length} bands</span>
                                        <button
                                            onClick={() => removeDieType(die.id)}
                                            className="text-text-dim hover:text-danger transition-colors"
                                            title="Remove die type"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
                                        {!validation.valid && (
                                            <div className="text-[9px] text-danger px-1 py-1 bg-danger/10 rounded">{validation.error}</div>
                                        )}
                                        {die.bands.map((band, i) => (
                                            <div key={band.id} className="flex items-center gap-1.5">
                                                <span className="text-[9px] text-text-dim w-4">{i + 1}.</span>
                                                <input
                                                    type="text"
                                                    value={band.label}
                                                    onChange={(e) => updateBand(die.id, band.id, { label: e.target.value })}
                                                    placeholder="Label"
                                                    className="flex-1 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                                                />
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={die.faces}
                                                    value={band.min}
                                                    onChange={(e) => updateBand(die.id, band.id, { min: parseInt(e.target.value) || 1 })}
                                                    className="w-12 bg-surface border border-border px-1 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none text-center"
                                                    title="Min (inclusive)"
                                                />
                                                <span className="text-[9px] text-text-dim">–</span>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={die.faces}
                                                    value={band.max}
                                                    onChange={(e) => updateBand(die.id, band.id, { max: parseInt(e.target.value) || 1 })}
                                                    className="w-12 bg-surface border border-border px-1 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none text-center"
                                                    title="Max (inclusive)"
                                                />
                                                <button
                                                    onClick={() => removeBand(die.id, band.id)}
                                                    className="text-text-dim hover:text-danger transition-colors"
                                                >
                                                    <Trash2 size={9} />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => addBand(die.id)}
                                            className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors py-1"
                                        >
                                            <Plus size={9} /> Add Band
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* ── Categories (up to 10) ── */}
                <div className="space-y-2 border-t border-border/30 pt-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-text-dim uppercase tracking-wider font-bold">Categories (max 10)</span>
                        <button
                            onClick={addCategory}
                            disabled={diceSystem.categories.length >= 10}
                            className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                        >
                            <Plus size={9} /> Add
                        </button>
                    </div>
                    {diceSystem.categories.map((cat) => (
                        <div key={cat.id} className="flex items-center gap-2">
                            <input
                                type="text"
                                value={cat.name}
                                onChange={(e) => updateCategory(cat.id, { name: e.target.value })}
                                className="flex-1 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                            />
                            <select
                                value={cat.dieTypeId}
                                onChange={(e) => updateCategory(cat.id, { dieTypeId: e.target.value })}
                                className="w-20 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                            >
                                {diceSystem.dieTypes.map(d => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                ))}
                            </select>
                            <button
                                onClick={() => removeCategory(cat.id)}
                                className="text-text-dim hover:text-danger transition-colors"
                            >
                                <Trash2 size={10} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Bookkeeping Budget (prompt-budget controls moved out of the old Bookkeeping tab) ─────
//
// `TokenGauge` (stub/full token readout), the global Smart Injection ON/OFF
// (`context.smartBookkeepingActive`), and the Auto-Update interval
// (`autoBookkeepingInterval` — "scan every N turns") are prompt-budget knobs,
// not character data, so they live in Engine Tuning. The per-dataset injection
// toggle that gates a *specific* dataset (`characterProfileActive`) stays
// glued to its dataset in the Record tab.

const ALL_PROFILE_FIELDS = ['name', 'race', 'class', 'level', 'hp', 'mp', 'stats', 'skills', 'abilities', 'traits', 'notes'];

function BookkeepingBudgetSection() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const autoBookkeepingInterval = useAppStore((s) => s.autoBookkeepingInterval);
    const setAutoBookkeepingInterval = useAppStore((s) => s.setAutoBookkeepingInterval);

    const inventoryItems = useAppStore((s) => s.inventoryItems ?? s.context.inventoryItems ?? []);
    const characterProfileData = useAppStore((s) => s.characterProfileData ?? s.context.characterProfileData ?? s.context.characterProfile);
    const [showSettings, setShowSettings] = useState(false);

    const profile = characterProfileData as CharacterProfile;
    const stub = countTokens(minifyBookkeepingStub(profile, inventoryItems));
    const full = countTokens(minifySelectedInventory(inventoryItems, ['weapon', 'armor', 'consumable', 'currency', 'key', 'misc', 'equipped']) + '\n' + minifySelectedProfile(profile, ALL_PROFILE_FIELDS));

    return (
        <div className="space-y-2">
            <div className="text-[10px] text-amber-400 uppercase tracking-wider font-bold border-b border-amber-500/20 pb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    Bookkeeping Budget
                </div>
            </div>

            <div className="bg-void border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                    <button
                        onClick={() => updateContext({ smartBookkeepingActive: !context.smartBookkeepingActive })}
                        className={`px-3 py-1.5 text-[10px] uppercase tracking-wider rounded transition-colors border ${
                            context.smartBookkeepingActive
                                ? 'bg-terminal/10 border-terminal text-terminal'
                                : 'bg-void border-border text-text-dim'
                        }`}
                    >
                        {context.smartBookkeepingActive ? 'Smart Injection: ON' : 'Smart Injection: OFF'}
                    </button>
                </div>

                <div className="flex items-center justify-between text-[9px] text-text-dim/50">
                    <span>Stub: {stub}t</span>
                    <span>Full: ~{full}t</span>
                </div>

                <div>
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="flex items-center gap-1.5 text-text-dim/60 hover:text-text-primary text-[9px] uppercase tracking-wider transition-colors"
                    >
                        {showSettings ? 'Hide' : 'Auto-Update Settings'}
                    </button>
                    {showSettings && (
                        <div className="mt-2 space-y-2">
                            <div className="flex items-center gap-2">
                                <label className="text-[9px] text-text-dim/60 uppercase tracking-wider whitespace-nowrap">Scan every N turns:</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={autoBookkeepingInterval}
                                    onChange={(e) => setAutoBookkeepingInterval(Number(e.target.value))}
                                    className="w-16 px-2 py-1 bg-void border border-border rounded text-text-primary text-[11px] text-center focus:outline-none focus:border-terminal"
                                />
                            </div>
                            <p className="text-[8px] text-text-dim/40">
                                Auto-scanned every N turns via background queue.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
