import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { AbilityCompendiumModal } from '../AbilityCompendiumModal';

describe('AbilityCompendiumModal', () => {
    beforeEach(() => useAppStore.setState({
        activeCampaignId: null,
        abilityCompendiumOpen: true,
        abilityCompendium: [],
    }));

    it('creates a searchable canonical definition', () => {
        render(<AbilityCompendiumModal />);
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ash Step' } });
        fireEvent.change(screen.getByLabelText('Core Effect'), { target: { value: 'Move through flame.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save Definition' }));

        expect(useAppStore.getState().abilityCompendium).toHaveLength(1);
        expect(useAppStore.getState().abilityCompendium[0]).toEqual(expect.objectContaining({
            name: 'Ash Step',
            effect: 'Move through flame.',
            promptEnabled: true,
        }));
        expect(screen.getByText('Ash Step')).toBeInTheDocument();
    });
});
