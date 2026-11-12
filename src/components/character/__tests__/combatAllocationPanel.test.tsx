import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createDefaultSheet } from '@narrative/engine';
import { CombatAllocationPanel } from '../tabs/CombatAllocationPanel';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { useToastStore } from '../../Toast';
import { migrateLegacyContext } from '../../../types';
import type { GameContext } from '../../../types';
import { minifySelectedProfile } from '../../../services/turn/contextMinifier';
import { formatTraitsForContext } from '../../../services/retrieval/semanticMemory';

function seed(patch: Partial<GameContext>) {
    const context = migrateLegacyContext({
        characterProfileData: {
            name: 'Ari', race: 'Human', class: 'Ranger', level: 3,
            hp: { current: 25, max: 25 }, stats: { STR: 11, Luck: 3 },
            skills: [], abilities: [], traits: [], notes: '',
        },
        characterProfile: { identity: { name: 'Ari' }, stats: { str: 11 }, activeTraits: [] },
        ...patch,
    });
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null });
}

const raise = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Raise ${name}` }));
const value = (key: string) => screen.getByTestId(`combat-ability-${key}`).textContent;

describe('CombatAllocationPanel', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        useToastStore.setState({ toasts: [] });
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('renders nothing while combat is off', () => {
        seed({ combatModeActive: false, combatSheet: createDefaultSheet('NORMAL') });
        const { container } = render(<CombatAllocationPanel />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the non-blocking allocation prompt for a new sheet', () => {
        seed({ combatModeActive: true, combatSheet: createDefaultSheet('NORMAL') });
        render(<CombatAllocationPanel />);
        expect(screen.getByRole('status')).toHaveTextContent('Distribute your ability points to use combat.');
        expect(screen.getByTestId('combat-points-left')).toHaveTextContent('Points left: 27');
    });

    it('spends points and updates the derived preview', () => {
        seed({ combatModeActive: true, combatSheet: createDefaultSheet('NORMAL') });
        render(<CombatAllocationPanel />);
        for (let i = 0; i < 6; i++) raise('Constitution');
        expect(value('CON')).toBe('14');
        expect(screen.getByTestId('combat-points-left')).toHaveTextContent('Points left: 20');
        expect(screen.getByTestId('combat-derived-hp')).toHaveTextContent('28');
        raise('Dexterity');
        raise('Dexterity');
        expect(screen.getByTestId('combat-derived-ac')).toHaveTextContent('10');
    });

    it('rejects overspending', () => {
        seed({ combatModeActive: true, combatSheet: createDefaultSheet('NORMAL') });
        render(<CombatAllocationPanel />);
        for (let i = 0; i < 10; i++) raise('Strength');
        for (let i = 0; i < 10; i++) raise('Dexterity');
        for (let i = 0; i < 10; i++) raise('Constitution');
        expect([value('STR'), value('DEX'), value('CON')]).toEqual(['15', '15', '15']);
        expect(screen.getByTestId('combat-points-left')).toHaveTextContent('Points left: 0');
        raise('Wisdom');
        expect(value('WIS')).toBe('8');
        expect(screen.getByRole('button', { name: 'Raise Wisdom' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Raise Strength' })).toBeDisabled();
    });

    it('applies an archetype preset', () => {
        seed({ combatModeActive: true, combatSheet: createDefaultSheet('NORMAL') });
        render(<CombatAllocationPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Brute' }));
        expect(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(value)).toEqual(['15', '13', '15', '8', '12', '8']);
        expect(screen.getByTestId('combat-points-left')).toHaveTextContent('Points left: 0');
    });

    it('saves the sheet, clears the prompt and writes the mirrored profile', () => {
        seed({ combatModeActive: true, combatSheet: createDefaultSheet('NORMAL') });
        render(<CombatAllocationPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Skirmisher' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save abilities' }));

        const s = useAppStore.getState();
        expect(s.context.combatSheet).toEqual({
            abilities: { STR: 12, DEX: 15, CON: 14, INT: 8, WIS: 13, CHA: 10 },
            budget: 'NORMAL', archetype: 'skirmisher', level: 3, needsAllocation: false,
        });
        const expectedStats = { STR: 12, DEX: 15, CON: 14, INT: 8, WIS: 13, CHA: 10, AC: 12, Proficiency: 2 };
        expect(s.characterProfileData.stats).toEqual({ Luck: 3, ...expectedStats });
        expect(s.context.characterProfileData.stats).toEqual({ Luck: 3, ...expectedStats });
        expect(s.characterProfileData.hp).toEqual({ current: 25, max: 28 });
        expect(s.context.characterProfile.stats).toEqual(expectedStats);

        expect(minifySelectedProfile(s.context.characterProfileData, ['hp', 'stats'])).toBe(
            'HP:25/28 | LUC:3|STR:12|DEX:15|CON:14|INT:8|WIS:13|CHA:10|AC:12|PRO:2',
        );
        expect(formatTraitsForContext(s.context.characterProfile, { core: [], extended: [] })).toContain(
            'STR 12 | DEX 15 | CON 14 | INT 8 | WIS 13 | CHA 10 | AC 12 | PROFICIENCY 2',
        );
        expect(screen.queryByRole('status')).toBeNull();
    });
});
