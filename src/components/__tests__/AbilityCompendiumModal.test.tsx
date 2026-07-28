import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyAbilityEntry } from '../../services/ability/abilitySchema';
import { buildCharacterSheetAbilityImport } from '../../services/ability/characterSheetAbilityImport';
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
            abilityRuntimeStates: [],
            abilityProposals: [],
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
        fireEvent.click(screen.getByRole('button', { name: 'Add to Character' }));

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

        fireEvent.change(screen.getByLabelText('Cooldown Maximum'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('Charges Maximum'), { target: { value: '2' } });
        fireEvent.change(screen.getByLabelText('Activation Scene'), { target: { value: '007' } });
        fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

        expect(useAppStore.getState().abilityRuntimeStates[0]).toEqual(expect.objectContaining({
            characterAbilityId: useAppStore.getState().characterAbilities[0].id,
            cooldownRemaining: 3,
            cooldownMax: 3,
            chargesRemaining: 1,
            chargesMax: 2,
            uses: 1,
            lastUsedSceneId: '007',
        }));
    });

    it('accepts all pending sheet abilities and removes every migrated sheet entry', () => {
        const playerCharacter = {
            id: 'pc-veronica',
            name: 'Veronica',
        } as unknown as NPCEntry;
        const current = useAppStore.getState();
        const profile = {
            ...current.characterProfileData,
            abilities: ['Cantrip: Message', '1st-level spell: Thunderwave'],
        };
        useAppStore.setState({
            context: { ...current.context, playerCharacter, characterProfileData: profile },
            playerCharacter,
            characterProfileData: profile,
        });
        const proposals = buildCharacterSheetAbilityImport(
            profile.abilities,
            playerCharacter.id,
            [],
            [],
            [],
        ).proposals;
        useAppStore.getState().addAbilityProposals(proposals);

        render(<AbilityCompendiumModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Discoveries' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add all' }));

        expect(useAppStore.getState().abilityCompendium.map(entry => entry.name).sort())
            .toEqual(['Message', 'Thunderwave']);
        expect(useAppStore.getState().characterAbilities).toHaveLength(2);
        expect(useAppStore.getState().abilityProposals).toEqual([]);
        expect(useAppStore.getState().characterProfileData.abilities).toEqual([]);
        expect(useAppStore.getState().context.characterProfileData.abilities).toEqual([]);
    });

    it('tracks structured mastery, upgrades, training, and milestones per character', () => {
        const ability = {
            ...createEmptyAbilityEntry({ createId: () => 'ability-ash-step' }),
            name: 'Ash Step',
            masteryLadder: [
                { id: 'novice', name: 'Novice', requirements: '', benefits: '' },
                { id: 'adept', name: 'Adept', requirements: 'Three training scenes', benefits: 'Longer range' },
            ],
            upgradeNodes: [{
                id: 'passenger',
                branch: 'Utility',
                name: 'Carry Passenger',
                description: 'Bring one ally.',
                prerequisiteTierId: 'adept',
                prerequisiteUpgradeIds: [],
            }],
        };
        const playerCharacter = { id: 'pc-kael', name: 'Kael' } as unknown as NPCEntry;
        const context = useAppStore.getState().context;
        useAppStore.setState({
            abilityCompendium: [ability],
            context: { ...context, playerCharacter },
            playerCharacter,
        });

        render(<AbilityCompendiumModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Characters' }));
        fireEvent.change(screen.getByLabelText('Mastery Tier'), { target: { value: 'adept' } });
        fireEvent.change(screen.getByLabelText('Training Progress'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('Training Goal'), { target: { value: '5' } });
        fireEvent.click(screen.getByRole('button', { name: /Carry Passenger/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Add Milestone' }));
        fireEvent.change(screen.getByLabelText('Milestone 1 name'), { target: { value: 'Cross a Wildfire' } });
        fireEvent.click(screen.getByLabelText('Milestone 1 completed'));
        fireEvent.click(screen.getByRole('button', { name: 'Add to Character' }));

        expect(useAppStore.getState().characterAbilities[0]).toEqual(expect.objectContaining({
            mastery: 'Adept',
            masteryTierId: 'adept',
            unlockedUpgradeIds: ['passenger'],
            trainingProgress: 3,
            trainingGoal: 5,
            trainingMilestones: [expect.objectContaining({
                name: 'Cross a Wildfire',
                completed: true,
            })],
        }));
    });

    it('separates item-granted powers and shows whether their source item activates them', () => {
        const ability = {
            ...createEmptyAbilityEntry({ createId: () => 'ability-relic-flare' }),
            name: 'Relic Flare',
            origin: 'item-granted' as const,
            sourceInventoryItemId: 'sun-relic',
            inventoryRequiresEquipped: true,
        };
        const playerCharacter = { id: 'pc-kael', name: 'Kael' } as unknown as NPCEntry;
        const current = useAppStore.getState();
        useAppStore.setState({
            abilityCompendium: [ability],
            inventoryItems: [{
                id: 'sun-relic',
                name: 'Sun Relic',
                qty: 1,
                category: 'misc',
                keywords: [],
                equipped: true,
                lastUsedScene: '',
                importance: 5,
                notes: '',
                locationTag: 'inventory',
            }],
            context: { ...current.context, playerCharacter },
            playerCharacter,
        });

        render(<AbilityCompendiumModal />);
        expect(screen.getByRole('button', { name: 'Inventory Power 1' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Characters' }));

        expect(screen.getByText('Inventory Powers (1/1)')).toBeInTheDocument();
        expect(screen.getAllByText('Relic Flare')).not.toHaveLength(0);
        expect(screen.getByText('Sun Relic')).toBeInTheDocument();
    });
});
