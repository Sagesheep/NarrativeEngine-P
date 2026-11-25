import { useState } from 'react';
import { X, Dices, Bookmark } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { buildDefaultDiceSystem } from '../../types';
import type { RollDefinition, RollModifier, RollAggregation, ManualRollRequest } from '../../types';
import {
    isRollUsable, makePreset, pushRecentRoll, rollLabel, starterRolls,
} from '../../services/engine/diceQuickRolls';

const CHIP = 'px-2 py-1 text-[11px] font-mono rounded border border-border bg-void text-text-primary hover:border-terminal hover:text-terminal';
const LOAD_HINT = 'Click to arm. Right-click to load into the form.';

/**
 * Dice "dice me" modal — 3-gate configurator. Opens BEFORE the roll. The player
 * picks a die type + modifier + count + aggregation. Confirming arms the roll
 * (`armedRoll`); the orchestrator runs `resolveManualRoll` at send time and
 * asserts the result as fact, mirroring the loot drop precedent.
 *
 * Quick rolls sit above the form: saved presets and the campaign's recent
 * rolls (or one 1× chip per die type before there is any history). A chip arms
 * in one tap; right-click loads it into the form for tweaking.
 *
 * Mirrors LootRollModal structurally (backdrop + click-outside ghost-click
 * guard + same styling tokens).
 */
export function DiceRollModal() {
    const open = useAppStore(s => s.diceRollModalOpen);
    // Mounting the body only while open gives every opening a fresh form.
    return open ? <DiceRollModalBody /> : null;
}

function DiceRollModalBody() {
    const onClose = useAppStore(s => s.closeDiceRollModal);
    const setArmedRoll = useAppStore(s => s.setArmedRoll);
    const updateContext = useAppStore(s => s.updateContext);
    const context = useAppStore(s => s.context);

    const diceSystem = context.diceSystem ?? buildDefaultDiceSystem();
    const presets = (context.dicePresets ?? []).filter(p => isRollUsable(p.roll, diceSystem));
    const recent = (context.diceRecent ?? []).filter(r => isRollUsable(r, diceSystem));
    const hasHistory = recent.length > 0;
    const quickRolls = hasHistory ? recent : starterRolls(diceSystem);

    // rollDef is local to this roll — not stored globally. Defaults to a
    // plain single roll; the player adjusts via the 3 gates before confirming.
    const defaultRollDef: RollDefinition = { modifier: 'none', count: 1, aggregation: 'pick_one' };

    const [dieTypeId, setDieTypeId] = useState(diceSystem.dieTypes[0]?.id ?? '');
    const [rollDef, setRollDef] = useState<RollDefinition>(defaultRollDef);
    const [presetName, setPresetName] = useState<string | null>(null);
    const [openedAt] = useState(() => Date.now());

    const handleBackdropClick = () => {
        if (Date.now() - openedAt < 350) return;
        onClose();
    };

    const arm = (req: ManualRollRequest) => {
        setArmedRoll(req);
        updateContext({ diceRecent: pushRecentRoll(context.diceRecent, req) });
        onClose();
    };

    const loadIntoForm = (req: ManualRollRequest) => {
        setDieTypeId(req.dieTypeId);
        setRollDef({ ...req.rollDef });
    };

    const current: ManualRollRequest = { dieTypeId, rollDef };
    const selectedDie = diceSystem.dieTypes.find(d => d.id === dieTypeId);
    const isTotalAll = rollDef.aggregation === 'total_all';
    const preview = rollLabel(current, diceSystem) ?? '—';

    const savePreset = () => {
        const name = presetName?.trim();
        if (!name || !selectedDie) return;
        updateContext({ dicePresets: [...(context.dicePresets ?? []), makePreset(name, current)] });
        setPresetName(null);
    };

    const deletePreset = (id: string) => {
        updateContext({ dicePresets: (context.dicePresets ?? []).filter(p => p.id !== id) });
    };

    const quickChip = (req: ManualRollRequest, key: string, label: string) => (
        <button
            key={key}
            type="button"
            title={LOAD_HINT}
            onClick={() => arm(req)}
            onContextMenu={e => { e.preventDefault(); loadIntoForm(req); }}
            className={CHIP}
        >
            {label}
        </button>
    );

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60" onClick={handleBackdropClick}>
            <div className="bg-surface border border-border rounded-lg w-full max-w-sm mx-4 flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Dices size={14} /> Dice Me
                    </h2>
                    <button onClick={onClose} className="text-text-dim hover:text-text-primary">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-4 overflow-y-auto">
                    {presets.length > 0 && (
                        <div>
                            <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Presets</div>
                            <div className="flex flex-wrap gap-1.5">
                                {presets.map(p => (
                                    <span key={p.id} className="inline-flex items-stretch">
                                        <button
                                            type="button"
                                            title={LOAD_HINT}
                                            onClick={() => arm(p.roll)}
                                            onContextMenu={e => { e.preventDefault(); loadIntoForm(p.roll); }}
                                            className={`${CHIP} rounded-r-none border-r-0`}
                                        >
                                            <span className="font-sans font-semibold">{p.name}</span>
                                            <span className="text-text-dim ml-1">{rollLabel(p.roll, diceSystem)}</span>
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Delete preset ${p.name}`}
                                            title="Delete preset"
                                            onClick={() => deletePreset(p.id)}
                                            className="px-1 rounded-r border border-border bg-void text-text-dim hover:text-danger hover:border-danger"
                                        >
                                            <X size={11} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {quickRolls.length > 0 && (
                        <div>
                            <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">
                                {hasHistory ? 'Recent' : 'Quick Roll'}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {quickRolls.map(r => {
                                    const label = rollLabel(r, diceSystem);
                                    return label ? quickChip(r, `${r.dieTypeId}|${label}`, label) : null;
                                })}
                            </div>
                        </div>
                    )}

                    {/* Die type selector */}
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Die Type</div>
                        <select
                            value={dieTypeId}
                            onChange={e => setDieTypeId(e.target.value)}
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                        >
                            {diceSystem.dieTypes.map(d => (
                                <option key={d.id} value={d.id}>{d.name} (1–{d.faces})</option>
                            ))}
                        </select>
                    </div>

                    {/* Gate 1: Modifier */}
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Gate 1: Modifier</div>
                        <select
                            value={rollDef.modifier}
                            onChange={e => setRollDef({ ...rollDef, modifier: e.target.value as RollModifier })}
                            disabled={isTotalAll}
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none disabled:opacity-40"
                        >
                            <option value="none">None</option>
                            <option value="adv">Advantage (take highest)</option>
                            <option value="disadv">Disadvantage (take lowest)</option>
                        </select>
                    </div>

                    {/* Gate 2: Count */}
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Gate 2: Dice Count</div>
                        <input
                            type="number"
                            min={1}
                            max={100}
                            value={rollDef.count}
                            onChange={e => setRollDef({ ...rollDef, count: Math.max(1, parseInt(e.target.value) || 1) })}
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none text-center"
                        />
                    </div>

                    {/* Gate 3: Aggregation */}
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Gate 3: Aggregation</div>
                        <select
                            value={rollDef.aggregation}
                            onChange={e => {
                                const agg = e.target.value as RollAggregation;
                                const modifier = agg === 'total_all' ? 'none' : rollDef.modifier;
                                setRollDef({ ...rollDef, aggregation: agg, modifier });
                            }}
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                        >
                            <option value="pick_one">Pick one (highest/lowest/first)</option>
                            <option value="total_all">Total all (sum)</option>
                        </select>
                    </div>

                    {isTotalAll && (
                        <p className="text-[10px] text-text-dim/70">
                            Total all sums the dice — advantage/disadvantage is disabled (meaningless for sums).
                        </p>
                    )}

                    {/* Preview */}
                    <div className="text-[11px] text-terminal font-mono bg-terminal/10 rounded px-2 py-1.5 text-center">
                        {preview}
                    </div>

                    {presetName !== null && (
                        <form
                            className="flex gap-2"
                            onSubmit={e => { e.preventDefault(); savePreset(); }}
                        >
                            <input
                                autoFocus
                                aria-label="Preset name"
                                placeholder="Preset name, e.g. Attack"
                                value={presetName}
                                maxLength={40}
                                onChange={e => setPresetName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPresetName(null); } }}
                                className="flex-1 min-w-0 bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                            />
                            <button
                                type="submit"
                                disabled={!presetName.trim() || !selectedDie}
                                className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 disabled:opacity-30"
                            >
                                Save
                            </button>
                        </form>
                    )}

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Confirm to arm the roll. On your next send, the engine rolls real dice and the GM narrates the outcome as fact.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex items-center gap-2">
                    <button
                        onClick={() => setPresetName(presetName === null ? '' : null)}
                        disabled={!selectedDie}
                        className="mr-auto px-2 py-1.5 text-xs text-text-dim hover:text-terminal rounded flex items-center gap-1 disabled:opacity-30"
                    >
                        <Bookmark size={12} /> {presetName === null ? 'Save as preset' : 'Cancel preset'}
                    </button>
                    <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded">Cancel</button>
                    <button
                        onClick={() => arm(current)}
                        disabled={!selectedDie}
                        className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 disabled:opacity-30"
                    >
                        Arm Roll
                    </button>
                </div>
            </div>
        </div>
    );
}
