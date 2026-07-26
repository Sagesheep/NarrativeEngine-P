import { describe, expect, it } from 'vitest';
import type { EnemyEntry } from '../../../types';
import { buildRelevantEnemyBlock } from '../enemyPrompt';

const enemy = (patch: Partial<EnemyEntry> = {}): EnemyEntry => ({
    id: 'shield-1', name: 'Shield Rapture', aliases: 'Aegis Unit',
    classification: 'Rapture', description: 'Projects a barrier.', threatTier: 'Support',
    tags: ['shield'], faction: 'Raptures', stats: [{ name: 'HP', value: '30' }],
    actions: [{ name: 'Pulse', description: 'Deals 4 damage.' }], passiveTraits: [],
    specialBehaviors: ['Shields allies'], weaknesses: [], resistances: [], tactics: 'Mid range',
    loot: '', gmNotes: '', promptEnabled: true, createdAt: 1, updatedAt: 1, ...patch,
});

describe('buildRelevantEnemyBlock', () => {
    it('injects a matching enemy name or alias', () => {
        expect(buildRelevantEnemyBlock([enemy()], [], 'I target the Aegis Unit.'))
            .toContain('ENEMY: Shield Rapture');
    });

    it('does not inject unrelated or disabled templates', () => {
        expect(buildRelevantEnemyBlock([enemy()], [], 'I open the door.')).toBe('');
        expect(buildRelevantEnemyBlock([enemy({ promptEnabled: false })], [], 'Shield Rapture attacks.')).toBe('');
    });
});
