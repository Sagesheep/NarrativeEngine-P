import { describe, it, expect } from 'vitest';
import { DEFAULT_COMBAT_CONFIG, normalizeCombatConfig, migrateLegacyContext } from '../index';

describe('normalizeCombatConfig', () => {
    it('fills every default from nothing', () => {
        expect(normalizeCombatConfig(undefined)).toEqual(DEFAULT_COMBAT_CONFIG);
        expect(normalizeCombatConfig(null)).toEqual(DEFAULT_COMBAT_CONFIG);
        expect(normalizeCombatConfig([])).toEqual(DEFAULT_COMBAT_CONFIG);
        expect(DEFAULT_COMBAT_CONFIG).toEqual({
            partyControl: 'engine', defeatMode: 'knockout', narrationCadence: 'side', narrationLength: 'standard',
            confirmStart: true, offerOnDangerous: true, resourceLabel: 'MP',
            maxChainLength: 6, maxEquippedAbilities: 6, maxSummons: 2, mpRecovery: 'fight',
        });
    });

    it('keeps valid values', () => {
        const cfg = normalizeCombatConfig({
            partyControl: 'solo', defeatMode: 'ironman', narrationCadence: 'end', narrationLength: 'rich',
            confirmStart: false, offerOnDangerous: false, resourceLabel: ' RAM ',
            maxChainLength: 4, maxEquippedAbilities: 3, maxSummons: 0,
            mookJitterRange: 2, defaultWeaponDie: 8,
        });
        expect(cfg).toEqual({
            partyControl: 'solo', defeatMode: 'ironman', narrationCadence: 'end', narrationLength: 'rich',
            confirmStart: false, offerOnDangerous: false, resourceLabel: 'RAM',
            maxChainLength: 4, maxEquippedAbilities: 3, maxSummons: 0, mpRecovery: 'fight',
            mookJitterRange: 2, defaultWeaponDie: 8,
        });
    });

    it('rejects unknown enum values and bad numbers', () => {
        const cfg = normalizeCombatConfig({
            partyControl: 'chaos', defeatMode: 'permadeath', narrationCadence: 'never', narrationLength: 'epic',
            confirmStart: 'yes', resourceLabel: '   ', maxChainLength: 0, maxEquippedAbilities: Number.NaN, maxSummons: -1,
        });
        expect(cfg).toEqual(DEFAULT_COMBAT_CONFIG);
    });

    it('drops the abandoned keyword-detection fields', () => {
        const cfg = normalizeCombatConfig({
            combatAutoDetect: true, autoEnterThreshold: 3, askThreshold: 2,
            confirmOnBorderline: true, combatKeywords: ['fight'], recoveryBands: { healthy: 1, wounded: 2, critical: 3 },
            mookJitterRange: 1,
        });
        expect(cfg).toEqual({ ...DEFAULT_COMBAT_CONFIG, mookJitterRange: 1 });
    });
});

describe('migrateLegacyContext combat fields', () => {
    it('loads a pre-combat save with combat off and no sheet', () => {
        const ctx = migrateLegacyContext({ loreRaw: 'old world' });
        expect(ctx.combatModeActive).toBeUndefined();
        expect(ctx.combatSheet).toBeUndefined();
        expect(ctx.combatConfig).toEqual(DEFAULT_COMBAT_CONFIG);
    });

    it('normalizes a legacy combatConfig and keeps the stored switch', () => {
        const legacy = {
            combatModeActive: false,
            combatConfig: { mookJitterRange: 3, combatAutoDetect: true, combatKeywords: ['attack'] },
        } as unknown as Parameters<typeof migrateLegacyContext>[0];
        const ctx = migrateLegacyContext(legacy);
        expect(ctx.combatModeActive).toBe(false);
        expect(ctx.combatConfig).toEqual({ ...DEFAULT_COMBAT_CONFIG, mookJitterRange: 3 });
    });

    it('gives a save from before the length setting the standard length, and keeps a stored one', () => {
        const old = migrateLegacyContext({ combatConfig: { partyControl: 'solo', narrationCadence: 'round' } } as unknown as Parameters<typeof migrateLegacyContext>[0]);
        expect(old.combatConfig?.narrationLength).toBe('standard');
        expect(old.combatConfig?.narrationCadence).toBe('round');
        const kept = migrateLegacyContext({ combatConfig: { ...DEFAULT_COMBAT_CONFIG, narrationLength: 'brief' } });
        expect(kept.combatConfig?.narrationLength).toBe('brief');
        const bad = migrateLegacyContext({ combatConfig: { narrationLength: 3 } } as unknown as Parameters<typeof migrateLegacyContext>[0]);
        expect(bad.combatConfig?.narrationLength).toBe('standard');
    });

    it('is idempotent', () => {
        const once = migrateLegacyContext({ combatConfig: { ...DEFAULT_COMBAT_CONFIG, defeatMode: 'hardcore' } });
        expect(migrateLegacyContext(once).combatConfig).toEqual(once.combatConfig);
    });
});
