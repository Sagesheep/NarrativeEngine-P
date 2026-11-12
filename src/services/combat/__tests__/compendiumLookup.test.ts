import { describe, expect, it } from 'vitest';
import { validateEnemyEntry } from '../../../../public/bundled-mods/enemies/validator.js';
import {
    compendiumFor, ENEMY_COMPENDIUM_KEY, findCompendiumTemplate, isUniqueIndividual, parseLeadingNumber, readCompendium, templateOverlay,
} from '../compendiumLookup';
import type { CompendiumTemplate } from '../compendiumLookup';

const raw = {
    id: 'rath', name: 'Rathalos', aliases: 'Fire Wyvern,  King of the Skies ',
    stats: [
        { name: 'Hit Points', value: '120 (16d10+32)' },
        { name: 'Defense', value: '17' },
        { name: 'To Hit', value: '+9' },
        { name: 'Damage', value: '2d10 + 5' },
        { name: 'Speed', value: '40 ft' },
    ],
    weaknesses: ['thunder', 'dragon'],
    resistances: ['fire'],
};

const validated = validateEnemyEntry(raw, 0, 1).value as unknown as CompendiumTemplate;
const state = (templates: unknown[], moduleEnabled?: Record<string, boolean>) => ({
    modTables: { [ENEMY_COMPENDIUM_KEY]: templates },
    settings: { moduleEnabled },
});

describe('T8 compendium lookup', () => {
    it('reads entries in the shape the enemies mod validator produces', () => {
        expect(validated).toMatchObject({ name: 'Rathalos', aliases: 'Fire Wyvern,  King of the Skies' });
        expect(Array.isArray(validated.stats)).toBe(true);
    });

    it('matches the name or a trimmed alias, case-insensitively and exactly', () => {
        const s = state([validated]);
        expect(findCompendiumTemplate('rathalos', s)?.name).toBe('Rathalos');
        expect(findCompendiumTemplate('  FIRE wyvern ', s)?.name).toBe('Rathalos');
        expect(findCompendiumTemplate('king of the skies', s)?.name).toBe('Rathalos');
        expect(findCompendiumTemplate('Rathal', s)).toBeNull();
        expect(findCompendiumTemplate('Rathalos Rider', s)).toBeNull();
        expect(findCompendiumTemplate(undefined, s)).toBeNull();
    });

    it('returns nothing when the enemies mod is disabled, absent or its table is empty', () => {
        expect(readCompendium(state([validated], { 'mod.enemies': false }))).toEqual([]);
        expect(findCompendiumTemplate('Rathalos', state([validated], { 'mod.enemies': false }))).toBeNull();
        expect(findCompendiumTemplate('Rathalos', { modTables: {}, settings: {} })).toBeNull();
        expect(findCompendiumTemplate('Rathalos', state([]))).toBeNull();
        expect(findCompendiumTemplate('Rathalos', { modTables: { [ENEMY_COMPENDIUM_KEY]: 'junk' } })).toBeNull();
    });

    it('maps only stats that parse cleanly under recognised names', () => {
        const { overlay, fields } = templateOverlay(validated, { name: 'Rathalos' });
        expect(overlay).toEqual({
            mode: 'replace', maxHp: 120, ac: 17, attackBonus: 9, damage: { count: 2, sides: 10, bonus: 5 },
            weaknesses: ['thunder', 'dragon'], resistances: ['fire'],
        });
        expect(fields).toEqual(['hp', 'ac', 'attack', 'damage']);
        expect(parseLeadingNumber('about 40')).toBeNull();
        expect(parseLeadingNumber('2d6')).toBeNull();
        expect(parseLeadingNumber('+5')).toBe(5);
        const messy: CompendiumTemplate = { name: 'Slime', stats: [{ name: 'HP', value: 'lots' }, { name: 'Damage', value: 'acid splash' }, { name: 'armour', value: '9' }] };
        expect(templateOverlay(messy, { name: 'Slime' })).toMatchObject({ overlay: { mode: 'replace', ac: 9 }, fields: ['ac'] });
    });

    it('treats a matching species with an NPC id or another name as a unique individual', () => {
        expect(isUniqueIndividual({ name: 'Rathalos' }, validated)).toBe(false);
        expect(isUniqueIndividual({ name: 'Rathalos 2' }, validated)).toBe(false);
        expect(isUniqueIndividual({ name: 'Fire Wyvern' }, validated)).toBe(false);
        expect(isUniqueIndividual({ name: 'One-Eyed Rathalos' }, validated)).toBe(true);
        expect(isUniqueIndividual({ name: 'Rathalos', npcId: 'npc-9' }, validated)).toBe(true);
        const unique = templateOverlay(validated, { name: 'One-Eyed Rathalos' });
        expect(unique.overlay).toMatchObject({ mode: 'floor', maxHp: 120, ac: 17 });
        expect(unique.overlay.attackBonus).toBeUndefined();
        expect(unique.overlay.damage).toBeUndefined();
        expect(unique.fields).toEqual(['hp', 'ac']);
    });

    it('reports the source per combatant for the proposal card', () => {
        const s = state([validated]);
        expect(compendiumFor({ name: 'Rathalos', species: 'Rathalos' }, s).source).toEqual({ kind: 'compendium', templateName: 'Rathalos', fields: ['hp', 'ac', 'attack', 'damage'], unique: false });
        expect(compendiumFor({ name: 'Bandit', species: 'human' }, s).source).toEqual({ kind: 'tier' });
        expect(compendiumFor({ name: 'Bandit' }, s)).toEqual({ source: { kind: 'tier' } });
        expect(compendiumFor({ name: 'Rathalos', species: 'Rathalos' }, state([validated], { 'mod.enemies': false }))).toEqual({ source: { kind: 'tier' } });
    });

    it('never changes the compendium it reads', () => {
        const templates = [validated];
        const snapshot = JSON.stringify(templates);
        compendiumFor({ name: 'Old Rathalos', species: 'Rathalos', npcId: 'x' }, state(templates));
        expect(JSON.stringify(templates)).toBe(snapshot);
    });
});
