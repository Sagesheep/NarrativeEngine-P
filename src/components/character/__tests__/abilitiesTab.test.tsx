import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { STARTER_ABILITIES } from '@narrative/engine';
import { AbilitiesTab } from '../tabs/AbilitiesTab';
import { CharacterLedgerModal } from '../CharacterLedgerModal';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GameContext, GlyphAbility } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function seed(patch: Partial<GameContext> = {}) {
    const context = migrateLegacyContext({
        combatModeActive: true,
        combatSheet: sheet,
        characterProfileData: {
            name: 'Kira', race: 'Human', class: 'Mage', level: 3,
            hp: { current: 25, max: 25 }, stats: {}, skills: [], abilities: [], traits: [], notes: '',
        },
        ...patch,
    });
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null, abilityEditDraft: null, abilityProposal: null });
}

const book = () => useAppStore.getState().context.spellbook!;
const shape = (a: GlyphAbility) => ({ form: a.form, effects: a.effects, damageType: a.damageType });

function build(name: string, steps: () => void) {
    fireEvent.click(screen.getByRole('button', { name: 'New ability' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
    steps();
    fireEvent.click(screen.getByRole('button', { name: 'Save ability' }));
}

const setForm = (form: string) => fireEvent.change(screen.getByLabelText('Form'), { target: { value: form } });
const removeEffect = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Remove ${label}` }));
const addEffect = (id: string) => fireEvent.change(screen.getByLabelText('Add effect…'), { target: { value: id } });
const setType = (type: string) => fireEvent.change(screen.getByLabelText('Damage type (optional, default force)'), { target: { value: type } });

describe('AbilitiesTab', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('shows the tab only while combat is on', () => {
        seed({ combatModeActive: false });
        useAppStore.setState({ pcPanelOpen: true });
        const { unmount } = render(<CharacterLedgerModal />);
        expect(screen.queryByRole('button', { name: /Spellbook/ })).toBeNull();
        unmount();
        seed();
        useAppStore.setState({ pcPanelOpen: true });
        render(<CharacterLedgerModal />);
        fireEvent.click(screen.getByRole('button', { name: /Spellbook/ }));
        expect(screen.getByText(/Abilities built from glyphs/)).toBeInTheDocument();
        useAppStore.setState({ pcPanelOpen: false });
    });

    it('offers the starter presets when empty and mirrors max MP', () => {
        seed();
        render(<AbilitiesTab />);
        expect(screen.getByTestId('spellbook-mp')).toHaveTextContent('Max MP: 16');
        expect(useAppStore.getState().context.characterProfileData.mp).toEqual({ current: 16, max: 16 });
        fireEvent.click(screen.getByRole('button', { name: 'Add Fireball' }));
        expect(book().abilities).toHaveLength(1);
        expect(shape(book().abilities[0])).toEqual(shape(STARTER_ABILITIES.find(a => a.id === 'fireball')!));
        expect(book().abilities[0].source).toBe('preset');
        expect(screen.getByText(/Burst, 3×3, within 8 squares/)).toBeInTheDocument();
    });

    it('builds each of the six presets from scratch, shows cost and rules, and equips them', () => {
        seed();
        render(<AbilitiesTab />);
        build('Fire bolt', () => setType('fire'));
        build('Mend', () => { setForm('touch'); removeEffect('Damage'); addEffect('heal'); });
        build('Fireball', () => { setForm('burst'); setType('fire'); });
        build('Flash step', () => setForm('dash'));
        build('Haste', () => {
            setForm('self');
            expect(screen.getByRole('alert')).toHaveTextContent('the self form cannot carry damage');
            expect(screen.getByRole('button', { name: 'Save ability' })).toBeDisabled();
            removeEffect('Damage');
            addEffect('haste');
            expect(screen.getByTestId('builder-cost')).toHaveTextContent('Cost: 4 MP');
        });
        build('Aqua elemental', () => {
            setForm('touch');
            removeEffect('Damage');
            addEffect('summon');
            fireEvent.change(screen.getByLabelText('Summon: Add augment…'), { target: { value: 'extend' } });
            setType('water');
        });
        const saved = book().abilities;
        expect(saved.map(a => a.name)).toEqual(STARTER_ABILITIES.map(a => a.name));
        saved.forEach((a, i) => expect(shape(a)).toEqual(shape(STARTER_ABILITIES[i])));
        for (const a of saved) {
            fireEvent.click(within(screen.getByTestId(`ability-${a.id}`)).getByRole('checkbox'));
        }
        expect(book().equippedIds).toEqual(saved.map(a => a.id));
    });

    it('refuses to equip past the equip limit', () => {
        seed({ combatConfig: { ...migrateLegacyContext({}).combatConfig!, maxEquippedAbilities: 1 } });
        render(<AbilitiesTab />);
        fireEvent.click(screen.getByRole('button', { name: 'Add Mend' }));
        fireEvent.click(screen.getByRole('button', { name: 'New ability' }));
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bolt' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save ability' }));
        const [mend, bolt] = book().abilities;
        fireEvent.click(within(screen.getByTestId(`ability-${mend.id}`)).getByRole('checkbox'));
        expect(within(screen.getByTestId(`ability-${bolt.id}`)).getByRole('checkbox')).toBeDisabled();
        expect(book().equippedIds).toEqual([mend.id]);
    });
});
