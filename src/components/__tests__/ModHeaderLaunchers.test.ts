import { describe, expect, it } from 'vitest';
import { resolveHeaderModLaunches } from '../ModHeaderLaunchers';
import type { ValidatedMod } from '../../services/mods/modTypes';

const abilityMod: ValidatedMod = {
    id: 'ability-compendium',
    name: 'Ability & Power Compendium',
    version: '2.0.0',
    description: 'Abilities.',
    file: 'ability-compendium.mod.json',
    contributions: [{ id: 'mentioned', order: 150, text: 'Matched abilities.' }],
    tables: [],
    panels: [],
    screens: [{
        id: 'manager',
        file: 'ability-compendium.screen.js',
        label: 'Open Ability & Power Compendium',
        launch: { surface: 'header', label: 'Abilities', icon: 'sparkles' },
    }],
    screenSources: ['export default function manager() {}'],
};

describe('resolveHeaderModLaunches', () => {
    it('shows a declared launcher while its module is enabled by default', () => {
        expect(resolveHeaderModLaunches([abilityMod], undefined)).toEqual([
            expect.objectContaining({ key: 'ability-compendium.manager', launch: expect.objectContaining({ label: 'Abilities' }) }),
        ]);
    });

    it('removes the launcher when the user unselects the module in Extensions', () => {
        expect(resolveHeaderModLaunches([abilityMod], { 'mod.ability-compendium': false })).toEqual([]);
    });

    it('does not promote ordinary nested screens into the header', () => {
        const nested = {
            ...abilityMod,
            screens: [{ id: 'manager', file: 'manager.js' }],
            screenSources: ['export default function manager() {}'],
        } satisfies ValidatedMod;
        expect(resolveHeaderModLaunches([nested], {})).toEqual([]);
    });
});
