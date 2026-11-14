import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AbilityProposalBar } from '../AbilityProposalBar';
import { useAppStore } from '../../../store/useAppStore';
import { stageAbilityProposal } from '../../../services/combat/abilityProposal';
import { migrateLegacyContext } from '../../../types';
import type { GlyphAbility } from '../../../types';

vi.mock('../../Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const lance: GlyphAbility = {
    id: 'p', name: 'Frost lance', description: 'A spike of ice.', damageType: 'cold',
    form: { id: 'projectile', augments: [] }, effects: [{ id: 'slow', augments: [] }], source: 'ai',
};

describe('AbilityProposalBar card', () => {
    beforeEach(() => {
        const context = migrateLegacyContext({
            combatModeActive: true,
            combatSheet: { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false },
        });
        useAppStore.setState({ context, activeCampaignId: 'camp', abilityProposal: null, abilityEditDraft: null, spellbookOpen: false });
    });

    it('shows name, description, glyph strip, cost and rules text, and Edit first opens the workbench', () => {
        stageAbilityProposal({ id: 'p1', messageId: 'gm', ability: lance });
        render(<AbilityProposalBar />);
        const card = screen.getByTestId('ability-proposal-card');
        expect(card).toHaveTextContent('Frost lance');
        expect(card).toHaveTextContent('A spike of ice.');
        expect(card).toHaveTextContent('2 MP');
        expect(card).toHaveTextContent('Projectile, one target or square within 12 squares');
        expect(within(card).getByTestId('glyph-strip')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Edit first/ }));
        const state = useAppStore.getState();
        expect(state.spellbookOpen).toBe(true);
        expect(state.abilityEditDraft?.name).toBe('Frost lance');
        expect(state.abilityProposal).toBeNull();
    });

    it('accepts into the spellbook and dismisses', () => {
        stageAbilityProposal({ id: 'p1', messageId: 'gm', ability: lance });
        const { unmount } = render(<AbilityProposalBar />);
        fireEvent.click(screen.getByRole('button', { name: /Add to spellbook/ }));
        expect(useAppStore.getState().context.spellbook?.abilities.map(a => a.name)).toEqual(['Frost lance']);
        unmount();
        stageAbilityProposal({ id: 'p2', messageId: 'gm', ability: lance });
        render(<AbilityProposalBar />);
        fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
        expect(useAppStore.getState().abilityProposal).toBeNull();
    });
});
