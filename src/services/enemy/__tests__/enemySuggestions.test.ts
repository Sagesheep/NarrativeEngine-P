import { describe, expect, it } from 'vitest';
import type { EnemyEntry } from '../../../types';
import { sanitizeEnemySuggestionResponse } from '../enemySuggestions';

const enemy = (patch: Partial<EnemyEntry> = {}): EnemyEntry => ({
    id: 'orc-template',
    name: 'Orc Warrior',
    aliases: 'Greenblade',
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
    ...patch,
});

describe('enemy discovery response sanitation', () => {
    it('accepts reviewable aliases and new templates', () => {
        const result = sanitizeEnemySuggestionResponse({
            suggestions: [
                { kind: 'alias', name: 'Orcish Warrior', targetEnemyId: 'orc-template', reason: 'Used in narration' },
                { kind: 'new', name: 'Orc Berserker', classification: 'Orc' },
            ],
        }, [enemy()]);

        expect(result).toEqual([
            expect.objectContaining({ kind: 'alias', name: 'Orcish Warrior', targetEnemyId: 'orc-template' }),
            expect.objectContaining({ kind: 'new', name: 'Orc Berserker', classification: 'Orc' }),
        ]);
    });

    it('drops known names, hallucinated targets, duplicates, and excess suggestions', () => {
        const result = sanitizeEnemySuggestionResponse({
            suggestions: [
                { kind: 'new', name: 'Greenblade' },
                { kind: 'alias', name: 'Wrong Target', targetEnemyId: 'missing' },
                { kind: 'new', name: 'Orc Berserker' },
                { kind: 'new', name: 'Orc Berserker' },
                { kind: 'new', name: 'Orc Shaman' },
                { kind: 'new', name: 'Orc Archer' },
                { kind: 'new', name: 'Orc Scout' },
            ],
        }, [enemy()]);

        expect(result.map(item => item.name)).toEqual(['Orc Berserker', 'Orc Shaman', 'Orc Archer']);
    });
});
