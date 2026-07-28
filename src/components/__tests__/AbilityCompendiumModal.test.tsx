import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyAbilityEntry } from '../../services/ability/abilitySchema';
import { useAppStore } from '../../store/useAppStore';
import type { NPCEntry } from '../../types/npc';
import { AbilityCompendiumModal } from '../AbilityCompendiumModal';

describe('AbilityCompendiumModal', () => {
    beforeEach(() => {
        const context = useAppStore.getState().context;
        useAppStore.setState({
            activeCampaignId: null,
            abilityCompendiumOpen: true,
            abilityCompendium: [],
            characterAbilities: [],
            context: { ...context, playerCharacter: null },
            playerCharacter: null,
            npcLedger: [],
        });
    });

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

    it('assigns a canonical ability to the player character', () => {
        const ability = {
            ...createEmptyAbilityEntry({ createId: () => 'ability-ash-step' }),
            name: 'Ash Step',
            effect: 'Move through flame.',
        };
        const playerCharacter = {
            id: 'pc-kael',
            name: 'Kael',
        } as unknown as NPCEntry;
        const context = useAppStore.getState().context;
        useAppStore.setState({
            abilityCompendium: [ability],
            context: { ...context, playerCharacter },
            playerCharacter,
        });

        render(<AbilityCompendiumModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Characters' }));
        fireEvent.change(screen.getByLabelText('Mastery / Rank'), { target: { value: 'Adept' } });
        fireEvent.change(screen.getByLabelText('Personal Variant Name'), { target: { value: 'Cinder Step' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save Assignment' }));

        expect(useAppStore.getState().characterAbilities).toEqual([
            expect.objectContaining({
                abilityId: 'ability-ash-step',
                ownerType: 'pc',
                ownerId: 'pc-kael',
                mastery: 'Adept',
                variantName: 'Cinder Step',
                promptEnabled: true,
            }),
        ]);
        expect(screen.getByText('Cinder Step')).toBeInTheDocument();
    });
});
