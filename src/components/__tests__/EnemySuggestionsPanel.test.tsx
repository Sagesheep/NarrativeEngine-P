import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnemyEntry, EnemySuggestion } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { EnemySuggestionsPanel } from '../EnemySuggestionsPanel';

vi.mock('../Toast', () => ({
    toast: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
    },
}));

const template: EnemyEntry = {
    id: 'orc-template',
    name: 'Orc Warrior',
    aliases: '',
    classification: 'Orc',
    description: '',
    threatTier: '',
    tags: [],
    faction: '',
    stats: [],
    actions: [],
    passiveTraits: [],
    specialBehaviors: [],
    weaknesses: [],
    resistances: [],
    tactics: '',
    loot: '',
    gmNotes: '',
    promptEnabled: true,
    createdAt: 1,
    updatedAt: 1,
};

const suggestion = (patch: Partial<EnemySuggestion> = {}): EnemySuggestion => ({
    id: 'suggestion-1',
    kind: 'alias',
    name: 'Orcish Warrior',
    targetEnemyId: template.id,
    firstSeen: 1,
    ...patch,
});

describe('EnemySuggestionsPanel', () => {
    beforeEach(() => {
        let id = 0;
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `generated-${++id}`) });
        useAppStore.setState({
            activeCampaignId: null,
            enemyCompendium: [template],
            enemySuggestions: [],
        });
    });

    it('edits and accepts an alias only after player confirmation', async () => {
        const user = userEvent.setup();
        const onAccepted = vi.fn();
        useAppStore.setState({ enemySuggestions: [suggestion()] });
        render(<EnemySuggestionsPanel onAccepted={onAccepted} />);

        const name = screen.getByDisplayValue('Orcish Warrior');
        await user.clear(name);
        await user.type(name, 'Orc Champion');
        expect(useAppStore.getState().enemyCompendium[0].aliases).toBe('');

        await user.click(screen.getByTitle('Accept suggestion'));

        expect(useAppStore.getState().enemyCompendium[0].aliases).toBe('Orc Champion');
        expect(useAppStore.getState().enemySuggestions).toEqual([]);
        expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ aliases: 'Orc Champion' }));
    });

    it('creates an editable minimal template for an accepted new enemy', async () => {
        const user = userEvent.setup();
        const onAccepted = vi.fn();
        useAppStore.setState({
            enemySuggestions: [suggestion({
                kind: 'new',
                name: 'Orc Berserker',
                targetEnemyId: undefined,
                classification: 'Orc',
            })],
        });
        render(<EnemySuggestionsPanel onAccepted={onAccepted} />);

        await user.click(screen.getByTitle('Accept suggestion'));

        expect(useAppStore.getState().enemyCompendium).toContainEqual(expect.objectContaining({
            name: 'Orc Berserker',
            classification: 'Orc',
            stats: [],
            actions: [],
        }));
        expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ name: 'Orc Berserker' }));
    });

    it('rejects a suggestion without changing the compendium', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemySuggestions: [suggestion()] });
        render(<EnemySuggestionsPanel onAccepted={vi.fn()} />);

        await user.click(screen.getByTitle('Reject suggestion'));

        expect(useAppStore.getState().enemySuggestions).toEqual([]);
        expect(useAppStore.getState().enemyCompendium).toEqual([template]);
    });
});
