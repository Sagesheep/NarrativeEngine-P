import { useEffect, useRef, useState } from 'react';
import { X, Dices } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { buildDefaultDiceSystem } from '../../types';
import type { RollDefinition, RollModifier, RollAggregation, ManualRollRequest } from '../../types';

/**
 * Dice "dice me" modal — 3-gate configurator. Opens BEFORE the roll. The player
 * picks a die type + modifier + count + aggregation. Confirming arms the roll
 * (`armedRoll`); the orchestrator runs `resolveManualRoll` at send time and
 * asserts the result as fact, mirroring the loot drop precedent.
 *
 * Mirrors LootRollModal structurally (backdrop + click-outside ghost-click
 * guard + same styling tokens).
 */
export function DiceRollModal() {
    const open = useAppStore(s => s.diceRollModalOpen);
    const onClose = useAppStore(s => s.closeDiceRollModal);
    const setArmedRoll = useAppStore(s => s.setArmedRoll);
    const context = useAppStore(s => s.context);

    const diceSystem = context.diceSystem ?? buildDefaultDiceSystem();

    // rollDef is local to this roll — not stored globally. Defaults to a
    // plain single roll; the player adjusts via the 3 gates before confirming.
    const defaultRollDef: RollDefinition = { modifier: 'none', count: 1, aggregation: 'pick_one' };

    const [dieTypeId, setDieTypeId] = useState(diceSystem.dieTypes[0]?.id ?? '');
    const [rollDef, setRollDef] = useState<RollDefinition>(defaultRollDef);
    const openedAtRef = useRef(0);

    useEffect(() => {
        if (open) {
            setDieTypeId(diceSystem.dieTypes[0]?.id ?? '');
            setRollDef(defaultRollDef);
            openedAtRef.current = Date.now();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    if (!open) return null;

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const confirm = () => {
        const req: ManualRollRequest = { dieTypeId, rollDef };
        setArmedRoll(req);
        onClose();
    };

    const selectedDie = diceSystem.dieTypes.find(d => d.id === dieTypeId);
    const isTotalAll = rollDef.aggregation === 'total_all';

    const preview = (() => {
        if (!selectedDie) return '—';
        const modLabel = !isTotalAll && rollDef.modifier === 'adv'
            ? ' (adv: highest)'
            : !isTotalAll && rollDef.modifier === 'disadv'
            ? ' (disadv: lowest)'
            : isTotalAll ? ' (sum)' : '';
        return `${rollDef.count}${selectedDie.name}${modLabel}`;
    })();

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60" onClick={handleBackdropClick}>
            <div className="bg-surface border border-border rounded-lg w-full max-w-sm mx-4 flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Dices size={14} /> Dice Me
                    </h2>
                    <button onClick={onClose} className="text-text-dim hover:text-text-primary">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
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

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Confirm to arm the roll. On your next send, the engine rolls real dice and the GM narrates the outcome as fact.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded">Cancel</button>
                    <button
                        onClick={confirm}
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