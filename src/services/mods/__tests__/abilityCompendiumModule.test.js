import { afterEach, describe, expect, it, vi } from 'vitest';
import runAbilityCompendium from '../../../../mods/ability-compendium/ability-compendium.compute.js';
import * as abilityNative from '../../../../mods/ability-compendium/ability-compendium.native.js';

const T = {
    abilities: 'abilities',
    assignments: 'assignments',
    runtime: 'runtime',
    proposals: 'proposals',
    config: 'config',
    promptIndex: 'prompt-index',
};

function harness(overrides = {}) {
    const rows = new Map([
        [T.abilities, []], [T.assignments, []], [T.runtime, []],
        [T.proposals, []], [T.config, {}], [T.promptIndex, []],
        ...Object.entries(overrides.tables || {}),
    ]);
    const ctx = {
        data: {
            playerCharacter: null,
            characterSheet: { name: '', hp: 0, stats: {} },
            inventory: [],
            messages: [],
            npcLedger: [],
            ...(overrides.data || {}),
        },
        table: {
            read: vi.fn(async (name) => structuredClone(rows.get(String(name).split('.').pop()))),
            write: vi.fn(async (name, value) => rows.set(String(name).split('.').pop(), structuredClone(value))),
        },
        model: { available: vi.fn(() => false), callJson: vi.fn() },
        tokens: { count: (value) => String(value).split(/\s+/).filter(Boolean).length },
    };
    return { ctx, rows };
}

afterEach(() => abilityNative.onDisable());

describe('Ability & Power Compendium Generation 1 module', () => {
    it('builds prompt lookup rows from promoted public context fields', async () => {
        const ability = {
            id: 'fireball', name: 'Fireball', aliases: 'Orb of Flame', category: 'active', origin: 'spell',
            effect: 'A fiery explosion.', activation: 'Action', costs: ['3rd-level slot'],
            prerequisites: ['Guidance only'], interactionTags: ['fire'],
        };
        const assignment = {
            id: 'a1', abilityId: 'fireball', ownerType: 'pc', ownerId: 'pc1', mastery: 'Adept',
            trainingProgress: 2, trainingGoal: 5, promptEnabled: true,
        };
        const runtime = { characterAbilityId: 'a1', cooldownRemaining: 1, chargesRemaining: 2, activeEffects: ['Empowered'] };
        const { ctx, rows } = harness({
            tables: { [T.abilities]: [ability], [T.assignments]: [assignment], [T.runtime]: [runtime] },
            data: {
                playerCharacter: { id: 'pc1', name: 'Mira' },
                inventory: [{ id: 'wand', name: 'Wand', category: 'weapon', quantity: 1 }],
            },
        });

        await runAbilityCompendium(ctx);

        const index = rows.get(T.promptIndex);
        expect(index).toHaveLength(1);
        expect(index[0].terms).toEqual(expect.arrayContaining(['Fireball', 'Orb of Flame']));
        expect(index[0].text).toContain('A fiery explosion.');
        expect(index[0].text).toContain('Mira');
        expect(index[0].text).toContain('cooldown 1');
        expect(index[0].text).toContain('training 2/5');
        expect(ctx.table.read).not.toHaveBeenCalledWith('context');
    });

    it('does not attempt the removed character-sheet write surface', async () => {
        const { ctx } = harness({ data: { characterSheet: { name: 'Mira', hp: 10, stats: {} } } });
        await runAbilityCompendium(ctx);
        expect(ctx.write).toBeUndefined();
    });

    it('uses native interceptor output for exact-name prompt injection and tears it down on disable', async () => {
        const rows = {
            [T.config]: {},
            [T.promptIndex]: [{ terms: ['Fireball', 'Orb of Flame'], text: '[ABILITY: Fireball] Effect: flame.' }],
        };
        const ctx = harness({ tables: rows, data: { messages: [{ role: 'assistant', content: 'The spellbook opens.' }] } }).ctx;
        abilityNative.onActivate(ctx);
        await expect(abilityNative.interceptPrompt({ playerInput: 'I cast Fireball.' })).resolves.toEqual({
            contributions: [{
                id: 'mentioned-abilities',
                order: 150,
                budget: 1200,
                text: expect.stringContaining('[ABILITY: Fireball]'),
            }],
        });
        abilityNative.onDisable();
        await expect(abilityNative.interceptPrompt({ playerInput: 'I cast Fireball.' })).resolves.toBeUndefined();
    });
});

