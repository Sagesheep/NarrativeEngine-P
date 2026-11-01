import { useAppStore } from '../../store/useAppStore';
import { npcFieldRange, type NpcTextField } from '../../services/npc/npcFieldLimits';

/**
 * "How much of this field does the story AI read?" under a ledger text field.
 * The cap scales with the context limit and with how many NPCs share the scene
 * (npcFieldLimits.ts), so it is shown as a range: crowded scene → alone on stage.
 */
export function NarratorLimitHint({ field, length, note }: { field: NpcTextField; length: number; note?: string }) {
    const contextLimit = useAppStore(s => s.settings.contextLimit);
    const rulesBudgetPct = useAppStore(s => s.settings.rulesBudgetPct);
    const { min, max } = npcFieldRange(field, contextLimit, rulesBudgetPct);
    const reads = min === max ? `${min}` : `${min}–${max}`;
    const tone = length > max ? 'text-amber-400/80' : 'text-text-dim/60';
    return (
        <p className={`text-[9px] mt-1 ${tone}`}>
            {length} chars · story AI reads the first {reads}{min === max ? '' : ' (more when fewer NPCs share the scene)'}
            {note ? ` · ${note}` : ''}
        </p>
    );
}
