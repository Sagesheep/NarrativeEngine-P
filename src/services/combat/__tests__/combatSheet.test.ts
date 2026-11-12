import { describe, it, expect } from 'vitest';
import { createDefaultSheet } from '@narrative/engine';
import {
    applyCombatSheet, ensureCombatSheet, guardHpPatch, guardStatPatch, isCombatLockedStatKey, commitCombatPatch,
} from '../combatSheet';
import { applyProfilePatch } from '../../characterProfileParser';
import { normalizeParsedProfile } from '../../characterTraitParser';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = {
    abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 12, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

function contextWith(patch: Partial<GameContext> = {}): GameContext {
    return migrateLegacyContext({
        characterProfileData: {
            name: 'Ari', race: 'Human', class: 'Ranger', level: 3,
            hp: { current: 25, max: 25 },
            stats: { str: 9, Dex: 11, Luck: 4, AC: 18 },
            skills: [], abilities: [], traits: [], notes: '',
        },
        characterProfile: { identity: { name: 'Ari' }, stats: { STR: 3, wis: 4, Sanity: 7 }, activeTraits: [] },
        ...patch,
    });
}

describe('applyCombatSheet', () => {
    it('mirrors abilities, AC and proficiency into both stat views, replacing any case variant', () => {
        const patch = applyCombatSheet(contextWith(), sheet);
        expect(patch.combatSheet).toEqual(sheet);
        expect(patch.characterProfileData?.stats).toEqual({
            Luck: 4, STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 12, CHA: 10, AC: 12, Proficiency: 2,
        });
        expect(patch.characterProfile?.stats).toEqual({
            Sanity: 7, STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 12, CHA: 10, AC: 12, Proficiency: 2,
        });
        expect(patch.characterProfile?.identity).toEqual({ name: 'Ari' });
    });

    it('sets max HP from the sheet and clamps current HP', () => {
        const patch = applyCombatSheet(contextWith(), sheet);
        expect(patch.characterProfileData?.hp).toEqual({ current: 25, max: 28 });
        const low = applyCombatSheet(contextWith(), { ...sheet, abilities: { ...sheet.abilities, CON: 8 } });
        expect(low.characterProfileData?.hp).toEqual({ current: 19, max: 19 });
    });

    it('does not mutate the context it reads', () => {
        const ctx = contextWith();
        const before = JSON.stringify(ctx);
        applyCombatSheet(ctx, sheet);
        expect(JSON.stringify(ctx)).toBe(before);
    });
});

describe('ensureCombatSheet', () => {
    it('does nothing while combat is off', () => {
        expect(ensureCombatSheet(contextWith())).toEqual({});
    });

    it('creates a default sheet flagged for allocation when combat is on and none exists', () => {
        const patch = ensureCombatSheet(contextWith({ combatModeActive: true }));
        expect(patch.combatSheet).toEqual(createDefaultSheet('NORMAL'));
        expect(patch.combatSheet?.needsAllocation).toBe(true);
        expect(patch.characterProfileData?.stats.STR).toBe(8);
    });

    it('keeps an existing sheet', () => {
        expect(ensureCombatSheet(contextWith({ combatModeActive: true, combatSheet: sheet }))).toEqual({});
    });
});

describe('stat guard', () => {
    it('recognises the eight locked keys in any case', () => {
        for (const key of ['STR', 'dex', 'Con', 'int', 'WIS', 'cha', 'ac', 'proficiency', 'PROFICIENCY']) {
            expect(isCombatLockedStatKey(key)).toBe(true);
        }
        expect(isCombatLockedStatKey('Luck')).toBe(false);
        expect(isCombatLockedStatKey('strength')).toBe(false);
    });

    it('drops locked stat keys only while locked', () => {
        const incoming = { STR: 20, ac: 25, Luck: 5 };
        expect(guardStatPatch(incoming, true)).toEqual({ Luck: 5 });
        expect(guardStatPatch(incoming, false)).toEqual(incoming);
    });

    it('ignores max HP and clamps current HP only while locked', () => {
        expect(guardHpPatch({ current: 10, max: 20 }, { current: 30, max: 40 }, true)).toEqual({ current: 20, max: 20 });
        expect(guardHpPatch({ current: 10, max: 20 }, { current: 5 }, true)).toEqual({ current: 5, max: 20 });
        expect(guardHpPatch({ current: 10, max: 20 }, { current: 30, max: 40 }, false)).toEqual({ current: 30, max: 40 });
        expect(guardHpPatch({ current: 10, max: 20 }, { max: 40 }, false)).toEqual({ current: 10, max: 40 });
    });
});

describe('AI profile patches against the combat sheet', () => {
    const aiPatch = { stats: { STR: 20, Proficiency: 6, Luck: 9 }, hp: { current: 12, max: 99 }, skills: ['Stealth'] };

    it('cannot change the mirrored sheet values in the profile parser while combat is on', () => {
        const ctx = contextWith({ combatModeActive: true });
        const mirrored = { ...ctx, ...applyCombatSheet(ctx, sheet) } as GameContext;
        const next = applyProfilePatch(mirrored.characterProfileData, aiPatch, true);
        expect(next.stats.STR).toBe(15);
        expect(next.stats.Proficiency).toBe(2);
        expect(next.stats.Luck).toBe(9);
        expect(next.hp).toEqual({ current: 12, max: 28 });
        expect(next.skills).toEqual(['Stealth']);
        expect(mirrored.combatSheet).toEqual(sheet);
    });

    it('applies the same patch as before while combat is off', () => {
        const ctx = contextWith();
        const next = applyProfilePatch(ctx.characterProfileData, aiPatch, false);
        expect(next.stats).toMatchObject({ STR: 20, Proficiency: 6, Luck: 9 });
        expect(next.hp).toEqual({ current: 12, max: 99 });
    });

    it('cannot change the mirrored sheet values in the trait parser while combat is on', () => {
        const ctx = contextWith({ combatModeActive: true });
        const mirrored = { ...ctx, ...applyCombatSheet(ctx, sheet) } as GameContext;
        const parsed = { identity: { name: 'Ari' }, stats: { str: 20, CHA: 18, Sanity: 2 }, activeTraits: [] };
        const locked = normalizeParsedProfile(parsed, mirrored.characterProfile, true);
        expect(locked.stats).toMatchObject({ STR: 15, CHA: 10, Sanity: 2 });
        expect(locked.stats).not.toHaveProperty('str');
        const open = normalizeParsedProfile(parsed, mirrored.characterProfile, false);
        expect(open.stats).toMatchObject({ str: 20, CHA: 18, Sanity: 2 });
    });
});

describe('commitCombatPatch', () => {
    it('writes the context and the store profile mirror', () => {
        const calls: string[] = [];
        const patch = applyCombatSheet(contextWith(), sheet);
        commitCombatPatch({
            updateContext: (p) => calls.push(`context:${Object.keys(p).sort().join(',')}`),
            setCharacterProfileData: (p) => calls.push(`profile:${p.stats.STR}`),
        }, patch);
        expect(calls).toEqual(['context:characterProfile,characterProfileData,combatSheet', 'profile:15']);
    });

    it('does nothing for an empty patch', () => {
        const calls: string[] = [];
        commitCombatPatch({ updateContext: () => calls.push('c'), setCharacterProfileData: () => calls.push('p') }, {});
        expect(calls).toEqual([]);
    });
});
