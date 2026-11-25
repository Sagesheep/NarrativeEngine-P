import { describe, expect, it } from 'vitest';
import { buildDefaultDiceSystem } from '../../../types';
import type { ManualRollRequest } from '../../../types';
import {
    MAX_RECENT_ROLLS, isRollUsable, makePreset, pushRecentRoll, rollKey, rollLabel, starterRolls,
} from '../diceQuickRolls';

const sys = buildDefaultDiceSystem();
const roll = (dieTypeId: string, count = 1, modifier: 'none' | 'adv' | 'disadv' = 'none', aggregation: 'pick_one' | 'total_all' = 'pick_one'): ManualRollRequest =>
    ({ dieTypeId, rollDef: { modifier, count, aggregation } });

describe('pushRecentRoll', () => {
    it('puts the new roll first', () => {
        expect(pushRecentRoll([roll('dt_d6')], roll('dt_d20'))).toEqual([roll('dt_d20'), roll('dt_d6')]);
    });

    it('moves a repeated roll to the front instead of duplicating it', () => {
        const list = [roll('dt_d6'), roll('dt_d20', 1, 'adv')];
        expect(pushRecentRoll(list, roll('dt_d20', 1, 'adv'))).toEqual([roll('dt_d20', 1, 'adv'), roll('dt_d6')]);
    });

    it('treats a different gate as a different roll', () => {
        expect(pushRecentRoll([roll('dt_d20')], roll('dt_d20', 1, 'adv'))).toHaveLength(2);
    });

    it('caps the list', () => {
        let list: ManualRollRequest[] | undefined;
        for (let n = 1; n <= MAX_RECENT_ROLLS + 3; n++) list = pushRecentRoll(list, roll('dt_d6', n));
        expect(list).toHaveLength(MAX_RECENT_ROLLS);
        expect(list![0].rollDef.count).toBe(MAX_RECENT_ROLLS + 3);
    });
});

describe('rollLabel', () => {
    it('labels plain, advantage, disadvantage and sum rolls', () => {
        expect(rollLabel(roll('dt_d20'), sys)).toBe('1d20');
        expect(rollLabel(roll('dt_d20', 2, 'adv'), sys)).toBe('2d20 adv');
        expect(rollLabel(roll('dt_d20', 2, 'disadv'), sys)).toBe('2d20 disadv');
        expect(rollLabel(roll('dt_d6', 8, 'none', 'total_all'), sys)).toBe('8d6 sum');
    });

    it('returns null for a die the campaign no longer has', () => {
        expect(rollLabel(roll('dt_gone'), sys)).toBeNull();
        expect(isRollUsable(roll('dt_gone'), sys)).toBe(false);
        expect(isRollUsable(roll('dt_d20'), sys)).toBe(true);
    });
});

it('starterRolls offers one plain roll per die type in the campaign', () => {
    const custom = { dieTypes: [{ id: 'dt_d66', name: 'd66', faces: 66, bands: [] }], categories: [] };
    expect(starterRolls(custom)).toEqual([roll('dt_d66')]);
    expect(starterRolls(sys)).toHaveLength(sys.dieTypes.length);
});

it('makePreset trims the name and copies the roll', () => {
    const source = roll('dt_d20', 1, 'adv');
    const preset = makePreset('  Attack ', source);
    expect(preset.name).toBe('Attack');
    expect(rollKey(preset.roll)).toBe(rollKey(source));
    expect(preset.roll.rollDef).not.toBe(source.rollDef);
    expect(makePreset('a', source).id).not.toBe(makePreset('a', source).id);
});
