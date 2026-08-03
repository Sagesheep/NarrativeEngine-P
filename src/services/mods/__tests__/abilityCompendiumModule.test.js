import { describe, expect, it, vi } from 'vitest';
import runAbilityCompendium from '../../../../mods/ability-compendium.compute.js';

const T = {
    abilities: 'mod.ability-compendium.abilities',
    assignments: 'mod.ability-compendium.assignments',
    runtime: 'mod.ability-compendium.runtime',
    proposals: 'mod.ability-compendium.proposals',
    config: 'mod.ability-compendium.config',
    promptIndex: 'mod.ability-compendium.prompt-index',
};

function harness(overrides = {}) {
    const rows = new Map([
        [T.abilities, []], [T.assignments, []], [T.runtime, []],
        [T.proposals, []], [T.config, {}], [T.promptIndex, []],
        ...Object.entries(overrides.tables || {}),
    ]);
    const setCharacterProfileData = vi.fn();
    const ctx = {
        data: {
            context: {}, messages: [], npcLedger: [],
            ...(overrides.data || {}),
        },
        table: {
            read: vi.fn((name) => structuredClone(rows.get(name))),
            write: vi.fn((name, value) => rows.set(name, structuredClone(value))),
        },
        write: { setCharacterProfileData },
        model: {
            available: vi.fn(() => false),
            callJson: vi.fn(),
        },
    };
    return { ctx, rows, setCharacterProfileData };
}

describe('Ability & Power Compendium module compute', () => {
    it('builds prompt lookup rows with canon, ownership, progression, and runtime context', async () => {
        const ability = {
            id: 'fireball', name: 'Fireball', aliases: 'Orb of Flame', category: 'active', origin: 'spell',
            effect: 'A fiery explosion.', activation: 'Action', costs: ['3rd-level slot'],
            prerequisites: ['Bard, Sorcerer, or Wizard (guidance only)'], interactionTags: ['fire'],
        };
        const assignment = {
            id: 'a1', abilityId: 'fireball', ownerType: 'pc', ownerId: 'pc1', mastery: 'Adept',
            trainingProgress: 2, trainingGoal: 5, promptEnabled: true,
        };
        const runtime = { characterAbilityId: 'a1', cooldownRemaining: 1, chargesRemaining: 2, activeEffects: ['Empowered'] };
        const { ctx, rows } = harness({
            tables: { [T.abilities]: [ability], [T.assignments]: [assignment], [T.runtime]: [runtime] },
            data: { context: { playerCharacter: { id: 'pc1', name: 'Mira' } } },
        });

        await runAbilityCompendium(ctx);

        const index = rows.get(T.promptIndex);
        expect(index).toHaveLength(1);
        expect(index[0].terms).toEqual(expect.arrayContaining(['Fireball', 'Orb of Flame']));
        expect(index[0].text).toContain('A fiery explosion.');
        expect(index[0].text).toContain('Prerequisites (guidance, not enforcement)');
        expect(index[0].text).toContain('Mira');
        expect(index[0].text).toContain('cooldown 1');
        expect(index[0].text).toContain('training 2/5');
    });

    it('turns character-sheet abilities into pending proposals without auto-accepting them', async () => {
        const { ctx, rows } = harness({
            data: {
                context: {
                    playerCharacter: { id: 'pc1', name: 'Mira' },
                    characterProfileData: { name: 'Mira', abilities: ['Cantrip: Mage Hand'] },
                },
            },
        });

        await runAbilityCompendium(ctx);

        expect(rows.get(T.abilities)).toEqual([]);
        expect(rows.get(T.assignments)).toEqual([]);
        expect(rows.get(T.proposals)).toEqual([
            expect.objectContaining({ kind: 'new', abilityName: 'Mage Hand', ownerId: 'pc1', sourceProfileAbility: 'Cantrip: Mage Hand' }),
        ]);
    });

    it('removes accepted source text from the sheet on the next committed pass', async () => {
        const { ctx, rows, setCharacterProfileData } = harness({
            tables: { [T.config]: { consumedProfileAbilities: ['Cantrip: Mage Hand'] } },
            data: {
                context: {
                    playerCharacter: { id: 'pc1', name: 'Mira' },
                    characterProfileData: { name: 'Mira', abilities: ['Cantrip: Mage Hand', 'Darkvision'] },
                },
            },
        });

        await runAbilityCompendium(ctx);

        expect(setCharacterProfileData).toHaveBeenCalledWith({ name: 'Mira', abilities: ['Darkvision'] });
        expect(rows.get(T.config).consumedProfileAbilities).toEqual([]);
    });
});
