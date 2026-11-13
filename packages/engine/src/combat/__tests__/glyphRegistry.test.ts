import { describe, it, expect } from 'vitest';
import {
    abilityCost, AUGMENT_COSTS, cleanAbilityName, deriveMaxMp, describeAbility, EFFECT_IDS, EFFECTS, enemyKit, FORM_IDS, FORMS,
    glyphCount, STARTER_ABILITIES, TIER_TABLE, validateAbility, castingAbilityOf,
} from '../index';
import type { EffectId, FormId } from '../index';
import { glyph } from './glyphFixtures';

describe('glyph registry costs (D4)', () => {
    it('prices every form', () => {
        expect(Object.fromEntries(FORM_IDS.map(f => [f, FORMS[f].cost]))).toEqual({
            touch: 0, self: 0, projectile: 1, dash: 1, line: 2, cone: 2, burst: 3,
        });
    });

    it('prices every effect', () => {
        expect(Object.fromEntries(EFFECT_IDS.map(e => [e, EFFECTS[e].cost]))).toEqual({
            damage: 1, heal: 2, shield: 1, push: 1, pull: 1, stun: 3, slow: 1, haste: 4, blink: 2, swap: 2, barrier: 2, drain: 2, summon: 4,
        });
    });

    it('prices every augment', () => {
        expect(AUGMENT_COSTS).toEqual({ amplify: 2, widen: 2, extend: 1, pierce: 1, split: 2, quicken: 3 });
    });

    it('sums the glyphs of an ability', () => {
        expect(abilityCost(glyph('burst', [['damage', ['amplify']]], ['widen', 'quicken']))).toBe(3 + 2 + 3 + 1 + 2);
        const costs = Object.fromEntries(STARTER_ABILITIES.map(a => [a.id, abilityCost(a)]));
        expect(costs).toEqual({ 'fire-bolt': 2, mend: 2, fireball: 4, 'flash-step': 2, haste: 4, 'aqua-elemental': 5 });
    });

    it('declares the save of each harmful effect and the helpful ones', () => {
        expect(EFFECTS.damage.save).toBe('DEX');
        expect(EFFECTS.push.save).toBe('DEX');
        expect(EFFECTS.pull.save).toBe('DEX');
        expect(EFFECTS.stun.save).toBe('CON');
        expect(EFFECTS.slow.save).toBe('CON');
        expect(EFFECTS.swap.save).toBe('WIS');
        expect(['heal', 'shield', 'haste'].every(e => EFFECTS[e as EffectId].helpful)).toBe(true);
    });

    it('adds a save bonus to the tier table (C5)', () => {
        expect(Object.fromEntries(Object.entries(TIER_TABLE).map(([k, v]) => [k, v.save]))).toEqual({ minion: 0, grunt: 1, elite: 3, boss: 5, legendary: 7 });
    });
});

describe('validateAbility', () => {
    it('accepts the starter presets', () => {
        for (const a of STARTER_ABILITIES) expect(validateAbility(a)).toEqual([]);
    });

    it('accepts exactly the form and effect pairings the registry lists', () => {
        for (const form of FORM_IDS) {
            for (const effect of EFFECT_IDS) {
                const reasons = validateAbility(glyph(form, [effect]), { maxChainLength: 6, maxSummons: 2 });
                const swapOnArea = effect === 'swap' && !['touch', 'projectile', 'dash'].includes(form);
                const expected = FORMS[form].effects.includes(effect) && !swapOnArea;
                expect(reasons.length === 0, `${form}·${effect}`).toBe(expected);
            }
        }
    });

    const invalid: Array<[string, ReturnType<typeof glyph>, RegExp]> = [
        ['self with harmful effects (R1)', glyph('self', ['damage']), /cannot carry damage/],
        ['blink off self', glyph('touch', ['blink']), /cannot carry blink/],
        ['no effects', glyph('touch', []), /at least one effect/],
        ['five effects', glyph('touch', ['damage', 'heal', 'shield', 'push', 'slow']), /at most 4 effects/],
        ['barrier with other effects (R6)', glyph('touch', ['barrier', 'damage']), /only effect/],
        ['summon with other effects (R6)', glyph('touch', ['summon', 'heal']), /only effect/],
        ['swap with split (R3)', glyph('touch', ['swap'], ['split']), /swap cannot be combined/],
        ['swap with pierce (R3)', glyph('projectile', ['swap'], ['pierce']), /swap cannot be combined/],
        ['swap on an area (R4)', glyph('burst', ['swap']), /cannot carry swap/],
        ['barrier widened (R7)', glyph('line', ['barrier'], ['widen']), /barrier cannot be widened/],
        ['pierce on a line (R14)', glyph('line', ['damage'], ['pierce']), /does not accept pierce/],
        ['split on a dash (R13)', glyph('dash', ['damage'], ['split']), /does not accept split/],
        ['summon on a burst', glyph('burst', ['summon']), /cannot carry summon/],
        ['barrier on a projectile', glyph('projectile', ['barrier']), /cannot carry barrier/],
        ['the same augment three times', glyph('touch', [['damage', ['amplify', 'amplify', 'amplify']]]), /more than 2 times/],
        ['an augment the effect refuses', glyph('touch', [['stun', ['amplify']]]), /does not accept amplify/],
        ['extend on swap', glyph('touch', [['swap', ['extend']]]), /does not accept extend/],
        ['a duplicated effect', glyph('touch', ['damage', 'damage']), /only once/],
        ['an empty name', glyph('touch', ['damage'], [], { name: '  ' }), /needs a name/],
    ];
    for (const [label, ability, reason] of invalid) {
        it(`refuses ${label}`, () => {
            expect(validateAbility(ability).join('; ')).toMatch(reason);
        });
    }

    it('enforces the chain length and the summon cap (R19, R27)', () => {
        const long = glyph('burst', [['damage', ['amplify', 'amplify']], ['slow', ['extend']]], ['widen']);
        expect(glyphCount(long)).toBe(7);
        expect(validateAbility(long, { maxChainLength: 6 }).join()).toMatch(/limit is 6/);
        expect(validateAbility(long, { maxChainLength: 7 })).toEqual([]);
        expect(validateAbility(glyph('touch', ['summon']), { maxChainLength: 6, maxSummons: 0 }).join()).toMatch(/summons are switched off/);
    });

    it('cleans names to one line of 40 characters', () => {
        expect(cleanAbilityName('Fire\nball\t ')).toBe('Fire ball');
        expect(cleanAbilityName('x'.repeat(60))).toHaveLength(40);
    });
});

describe('describeAbility', () => {
    it('writes rules text from the registry', () => {
        const fireball = STARTER_ABILITIES.find(a => a.id === 'fireball')!;
        expect(describeAbility(fireball, { proficiency: 2, castingMod: 3 }))
            .toBe('Burst, 3×3, within 8 squares. Targets DEX save (DC 13) or take 2d6 fire damage, half on a save. 4 MP.');
        expect(describeAbility(glyph('projectile', ['damage'], ['extend']), { proficiency: 3, castingMod: 2 }))
            .toMatch(/^Projectile, one target or square within 18 squares\. Attack roll \+5; on a hit the target takes 3d6 force damage\. 3 MP\.$/);
        expect(describeAbility(glyph('self', [['haste', ['extend']]]))).toMatch(/hasted for 3 of its turns/);
        expect(describeAbility(glyph('burst', ['damage'], ['widen']))).toMatch(/Burst, 5×5/);
        expect(describeAbility(glyph('touch', [['summon', ['amplify', 'extend']]]))).toMatch(/summons a grunt ally for 4 rounds/);
    });
});

describe('MP and casting ability', () => {
    it('derives max MP as 4 + 2 × level + 2 × casting modifier, at least 4', () => {
        expect(deriveMaxMp({ abilities: { STR: 8, DEX: 8, CON: 8, INT: 15, WIS: 8, CHA: 8 }, level: 3 })).toBe(4 + 6 + 4);
        expect(deriveMaxMp({ abilities: { STR: 8, DEX: 8, CON: 8, INT: 1, WIS: 1, CHA: 1 }, level: 1 })).toBe(4);
    });

    it('defaults the casting ability to the highest of INT, WIS and CHA', () => {
        expect(castingAbilityOf({ abilities: { STR: 8, DEX: 8, CON: 8, INT: 10, WIS: 14, CHA: 12 } })).toBe('WIS');
        expect(castingAbilityOf({ abilities: { STR: 8, DEX: 8, CON: 8, INT: 10, WIS: 14, CHA: 12 }, castingAbility: 'CHA' })).toBe('CHA');
    });
});

describe('enemy kits (D5)', () => {
    it('gives casters a bolt at every tier and a burst from elite up', () => {
        expect(enemyKit('grunt', 'brute', 'fire')).toEqual([]);
        expect(enemyKit('minion', 'caster', 'fire').map(a => [a.name, a.form.id])).toEqual([['Fire bolt', 'projectile']]);
        expect(enemyKit('elite', 'caster', 'arcane').map(a => a.form.id)).toEqual(['projectile', 'burst']);
        for (const tier of ['minion', 'grunt', 'elite', 'boss', 'legendary'] as const) {
            for (const a of enemyKit(tier, 'caster', 'fire')) expect(validateAbility(a)).toEqual([]);
        }
    });

    it('lists form ids for the editor', () => {
        const forms: FormId[] = ['touch', 'projectile', 'self', 'line', 'cone', 'burst', 'dash'];
        expect(FORM_IDS).toEqual(forms);
    });
});
