import { useEffect, useRef, useState } from 'react';
import { X, Package } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LootTree, LootPickNode } from '../../types';

/**
 * Loot Engine WO-05 — pre-roll modal. Opens BEFORE the loot walk. The player
 * picks a quantity and toggles which eligible options (root pick's weights
 * keys) are in this pull. Confirming arms the drop (`armLoot`); the orchestrator
 * runs `resolveLootDrop` at send time and asserts the result as fact, mirroring
 * the dice precedent. Cancel = no-op.
 *
 * Mirrors RenameNpcModal structurally (backdrop + click-outside ghost-click
 * guard + same styling tokens). Disable / toast when ctx.lootTree is undefined.
 */
export function LootRollModal() {
    const open = useAppStore(s => s.lootRollModalOpen);
    const onClose = useAppStore(s => s.closeLootRollModal);
    const armLoot = useAppStore(s => s.armLoot);
    const context = useAppStore(s => s.context);

    const [rolls, setRolls] = useState(1);
    // Checked options from the root pick's weights keys. All on by default.
    const [checked, setChecked] = useState<Record<string, boolean>>({});
    const openedAtRef = useRef(0);

    const lootTree: LootTree | undefined = context.lootTree;
    const rootPick: LootPickNode | null = (() => {
        if (!lootTree) return null;
        const root = lootTree.nodes[lootTree.root];
        return root && root.kind === 'pick' ? root : null;
    })();
    const options = rootPick ? Object.keys(rootPick.weights) : [];
    const axisLabel = rootPick?.axis ?? 'Options';

    // Reset state whenever the modal opens (mirrors RenameNpcModal's reset effect).
    useEffect(() => {
        if (open) {
            setRolls(1);
            setChecked({});
            openedAtRef.current = Date.now();
        }
    }, [open]);

    if (!open) return null;

    const handleBackdropClick = () => {
        // Ignore the ghost-click that follows the touchstart/mousedown which
        // opened this modal — otherwise it lands on the backdrop and closes us.
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const confirm = () => {
        // Build reweight for the root node: unchecked options → weight 0.
        // An option is "off" ONLY when explicitly `checked[opt] === false` — the
        // empty-default state (`checked = {}`) means "all on" (see `isChecked`
        // below), so it must NOT produce a reweight. Reading `!checked[opt]`
        // here would treat `undefined` as off and zero EVERY option on the first
        // send, arming a "kill everything" reweight and yielding 0 items.
        let reweight: Record<string, Record<string, number>> | undefined;
        const unchecked = options.filter(opt => checked[opt] === false);
        if (rootPick && unchecked.length > 0) {
            const zeroed: Record<string, number> = {};
            for (const opt of unchecked) zeroed[opt] = 0;
            reweight = { [lootTree!.root]: zeroed };
        }
        armLoot({ rolls, reweight });
        onClose();
    };

    const toggle = (opt: string) => setChecked(c => ({ ...c, [opt]: !c[opt] }));
    // When the modal opens, `checked` is empty → treat as "all on". The
    // checkbox is "on" if the key is absent OR explicitly true.
    const isChecked = (opt: string) => checked[opt] !== false;

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60" onClick={handleBackdropClick}>
            <div className="bg-surface border border-border rounded-lg w-full max-w-sm mx-4 flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Package size={14} /> Roll Loot
                    </h2>
                    <button onClick={onClose} className="text-text-dim hover:text-text-primary">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Quantity</div>
                        <select
                            value={rolls}
                            onChange={e => setRolls(Number(e.target.value))}
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                        >
                            {Array.from({ length: 9 }, (_, i) => i + 1).map(n => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                    </div>

                    {rootPick && options.length > 0 && (
                        <div>
                            <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Eligible {axisLabel}</div>
                            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                {options.map(opt => (
                                    <label key={opt} className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-text-primary bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors">
                                        <input
                                            type="checkbox"
                                            checked={isChecked(opt)}
                                            onChange={() => toggle(opt)}
                                            className="accent-terminal"
                                        />
                                        <span className="flex-1">{opt}</span>
                                        <span className="text-[10px] text-text-dim">w{rootPick.weights[opt]}</span>
                                    </label>
                                ))}
                            </div>
                            <p className="text-[10px] text-text-dim/70 mt-1">Uncheck to exclude — a one-shot reweight to 0 for this pull.</p>
                        </div>
                    )}

                    {!rootPick && (
                        <p className="text-[10px] text-text-dim/70 leading-relaxed">
                            The root node isn't a pick — quantity only; the tree will walk its authored weights.
                        </p>
                    )}

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Confirm to arm the drop. On your next send, the engine walks the loot tree and the GM narrates the find as fact.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded">Cancel</button>
                    <button
                        onClick={confirm}
                        className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30"
                    >
                        Arm Drop
                    </button>
                </div>
            </div>
        </div>
    );
}
