import { createDefaultSheet, deriveSheet } from '@narrative/engine';
import type { CharacterProfile, CharacterProfileState, CombatSheet, GameContext } from '../../types';

export const COMBAT_LOCKED_STAT_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA', 'AC', 'Proficiency'] as const;

const LOCKED_LOWER = new Set<string>(COMBAT_LOCKED_STAT_KEYS.map(k => k.toLowerCase()));

export function isCombatLockedStatKey(key: string): boolean {
    return LOCKED_LOWER.has(key.trim().toLowerCase());
}

export function isCombatStatLockActive(context: Pick<GameContext, 'combatModeActive'> | null | undefined): boolean {
    return context?.combatModeActive === true;
}

export function buildMirroredStats(sheet: CombatSheet): Record<string, number> {
    const derived = deriveSheet(sheet);
    return {
        STR: sheet.abilities.STR,
        DEX: sheet.abilities.DEX,
        CON: sheet.abilities.CON,
        INT: sheet.abilities.INT,
        WIS: sheet.abilities.WIS,
        CHA: sheet.abilities.CHA,
        AC: derived.ac,
        Proficiency: derived.proficiency,
    };
}

function mergeMirroredStats(existing: Record<string, number> | undefined, mirrored: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(existing ?? {})) {
        if (!isCombatLockedStatKey(key)) out[key] = value;
    }
    return { ...out, ...mirrored };
}

export function applyCombatSheet(context: GameContext, sheet: CombatSheet): Partial<GameContext> {
    const derived = deriveSheet(sheet);
    const mirrored = buildMirroredStats(sheet);
    const profile = context.characterProfileData;
    const current = Number.isFinite(profile.hp?.current) ? profile.hp.current : derived.maxHp;
    const characterProfileData: CharacterProfile = {
        ...profile,
        stats: mergeMirroredStats(profile.stats, mirrored),
        hp: { current: Math.max(0, Math.min(current, derived.maxHp)), max: derived.maxHp },
    };
    const patch: Partial<GameContext> = {
        combatSheet: { ...sheet, abilities: { ...sheet.abilities } },
        characterProfileData,
    };
    const traitProfile = context.characterProfile;
    if (traitProfile && typeof traitProfile === 'object') {
        const characterProfile: CharacterProfileState = {
            ...traitProfile,
            stats: mergeMirroredStats(traitProfile.stats, mirrored),
        };
        patch.characterProfile = characterProfile;
    }
    return patch;
}

export function ensureCombatSheet(context: GameContext): Partial<GameContext> {
    if (context.combatModeActive !== true || context.combatSheet) return {};
    return applyCombatSheet(context, createDefaultSheet('NORMAL'));
}

export function guardStatPatch(incoming: Record<string, number>, locked: boolean): Record<string, number> {
    if (!locked) return incoming;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(incoming)) {
        if (!isCombatLockedStatKey(key)) out[key] = value;
    }
    return out;
}

export function guardHpPatch(
    current: { current: number; max: number },
    incoming: Partial<{ current: number; max: number }>,
    locked: boolean,
): { current: number; max: number } {
    if (!locked) {
        return { current: incoming.current ?? current.current, max: incoming.max ?? current.max };
    }
    const nextCurrent = incoming.current ?? current.current;
    return { current: Math.min(nextCurrent, current.max), max: current.max };
}

export type CombatPatchActions = {
    updateContext: (patch: Partial<GameContext>) => void;
    setCharacterProfileData: (profile: CharacterProfile) => void;
};

export function commitCombatPatch(actions: CombatPatchActions, patch: Partial<GameContext>): void {
    if (Object.keys(patch).length === 0) return;
    actions.updateContext(patch);
    if (patch.characterProfileData) actions.setCharacterProfileData(patch.characterProfileData);
}
