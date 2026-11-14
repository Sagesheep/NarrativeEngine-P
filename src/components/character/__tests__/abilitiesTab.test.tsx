import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AbilitiesTab } from '../tabs/AbilitiesTab';
import { CharacterLedgerModal } from '../CharacterLedgerModal';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GameContext } from '../../../types';

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
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null, abilityEditDraft: null, abilityProposal: null, spellbookOpen: false });
}

describe('AbilitiesTab summary', () => {
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

    it('mirrors max MP, says when nothing is equipped, and opens the spellbook', () => {
        seed();
        render(<AbilitiesTab />);
        expect(screen.getByTestId('spellbook-mp')).toHaveTextContent('Max MP: 16');
        expect(useAppStore.getState().context.characterProfileData.mp).toEqual({ current: 16, max: 16 });
        expect(screen.getByText(/Your spellbook is empty/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Open spellbook' }));
        expect(useAppStore.getState().spellbookOpen).toBe(true);
    });

    it('lists equipped abilities as cards in hotbar order with their keys and rules text', () => {
        seed({
            spellbook: {
                abilities: [
                    { id: 'a', name: 'Fire bolt', form: { id: 'projectile', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' },
                    { id: 'b', name: 'Mend', form: { id: 'touch', augments: [] }, effects: [{ id: 'heal', augments: [] }], source: 'preset' },
                ],
                equippedIds: ['b', 'a'],
            },
        });
        render(<AbilitiesTab />);
        const cards = screen.getAllByTestId(/^ability-/);
        expect(cards.map(c => c.getAttribute('data-testid'))).toEqual(['ability-b', 'ability-a']);
        expect(cards[0]).toHaveTextContent('Mend');
        expect(cards[0]).toHaveTextContent('1');
        expect(cards[1]).toHaveTextContent('Projectile, one target or square within 12 squares');
        expect(cards[1]).toHaveTextContent('2 MP');
    });
});
