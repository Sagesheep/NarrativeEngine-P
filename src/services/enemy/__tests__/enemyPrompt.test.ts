import { describe, expect, it } from 'vitest';
import type { EnemyEntry } from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';
import { buildRelevantEnemyBlock } from '../enemyPrompt';

/** Builds a valid baseline template so each test only specifies relevant differences. */
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

    it('matches complete normalized names rather than substrings', () => {
        const orc = enemy({ id: 'orc', name: 'Orc', aliases: '' });

        expect(buildRelevantEnemyBlock([orc], [], 'I walk through the orchid garden.')).toBe('');
        expect(buildRelevantEnemyBlock([orc], [], 'An ORC attacks!')).toContain('ENEMY: Orc');
    });

    it('requires multi-word names to appear as one complete phrase', () => {
        const warrior = enemy({ id: 'warrior', name: 'Orc Warrior', aliases: '' });

        expect(buildRelevantEnemyBlock([warrior], [], 'The orcish warrior attacks.')).toBe('');
        expect(buildRelevantEnemyBlock([warrior], [], 'The orc-warrior attacks.')).toContain('ENEMY: Orc Warrior');
    });

    it('caps the number of matched templates', () => {
        const enemies = Array.from({ length: 6 }, (_, index) =>
            enemy({ id: `orc-${index}`, name: `Orc ${index}`, aliases: '' }));
        const block = buildRelevantEnemyBlock(enemies, [], enemies.map(entry => entry.name).join(', '));

        expect(block.match(/^ENEMY:/gm)).toHaveLength(4);
        expect(block).not.toContain('ENEMY: Orc 4');
    });

    it('priority-trims the result to a hard token budget', () => {
        const verbose = enemy({
            name: 'Orc',
            description: 'Ancient battlefield history. '.repeat(200),
            gmNotes: 'Secret referee material. '.repeat(200),
        });
        const block = buildRelevantEnemyBlock([verbose], [], 'The Orc attacks.', 80);

        expect(block).toContain('ENEMY: Orc');
        expect(countTokens(block)).toBeLessThanOrEqual(80);
        expect(block).not.toContain('Secret referee material');
    });
});
