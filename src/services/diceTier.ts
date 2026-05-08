import type { DiceConfig } from '../types';

const DEFAULT_DICE_CONFIG: DiceConfig = {
    catastrophe: 2,
    failure: 6,
    success: 15,
    triumph: 19,
    crit: 20
};

export function mapTier(rollResult: number, diceConfig?: DiceConfig): string {
    const config = diceConfig || DEFAULT_DICE_CONFIG;
    if (rollResult <= config.catastrophe) return 'Catastrophe';
    if (rollResult <= config.failure) return 'Failure';
    if (rollResult <= config.success) return 'Success';
    if (rollResult <= config.triumph) return 'Triumph';
    return 'Narrative Boon';
}

export { DEFAULT_DICE_CONFIG };