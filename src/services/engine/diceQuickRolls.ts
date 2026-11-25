import type { DicePreset, DiceSystemConfig, ManualRollRequest } from '../../types';

/** How many distinct recent rolls Dice Me keeps per campaign. */
export const MAX_RECENT_ROLLS = 5;

/** Identity of a roll: same die and same three gates. */
export function rollKey(req: ManualRollRequest): string {
    const { modifier, count, aggregation } = req.rollDef;
    return `${req.dieTypeId}|${modifier}|${count}|${aggregation}`;
}

/** Puts `req` first, drops any earlier copy of it and trims to the cap. */
export function pushRecentRoll(
    recent: ManualRollRequest[] | undefined,
    req: ManualRollRequest,
    max = MAX_RECENT_ROLLS,
): ManualRollRequest[] {
    const key = rollKey(req);
    return [req, ...(recent ?? []).filter(r => rollKey(r) !== key)].slice(0, max);
}

/** True when the roll's die still exists in the campaign's dice setup. */
export function isRollUsable(req: ManualRollRequest, diceSystem: DiceSystemConfig): boolean {
    return diceSystem.dieTypes.some(d => d.id === req.dieTypeId);
}

/**
 * Short label for a roll, e.g. `1d20`, `2d20 adv`, `8d6 sum`. Shared by the
 * Dice Me preview and its quick-roll chips so a chip reads the same as the
 * roll it arms. Returns `null` when the die is gone.
 */
export function rollLabel(req: ManualRollRequest, diceSystem: DiceSystemConfig): string | null {
    const die = diceSystem.dieTypes.find(d => d.id === req.dieTypeId);
    if (!die) return null;
    const { modifier, count, aggregation } = req.rollDef;
    const suffix = aggregation === 'total_all'
        ? ' sum'
        : modifier === 'adv' ? ' adv' : modifier === 'disadv' ? ' disadv' : '';
    return `${count}${die.name}${suffix}`;
}

/** One plain 1× roll per die type: the recent row before there is any history. */
export function starterRolls(diceSystem: DiceSystemConfig): ManualRollRequest[] {
    return diceSystem.dieTypes.map(d => ({
        dieTypeId: d.id,
        rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' },
    }));
}

export function makePreset(name: string, roll: ManualRollRequest): DicePreset {
    return {
        id: `dp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        roll: { dieTypeId: roll.dieTypeId, rollDef: { ...roll.rollDef } },
    };
}
