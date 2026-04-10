import { describe, it, expect } from 'vitest';
import { levenshtein, normalizeEntityName } from '../lib/entityResolution.js';

// ─── levenshtein ─────────────────────────────────────────────────────────────

describe('levenshtein', () => {
    it('returns 0 for identical strings', () => {
        expect(levenshtein('same', 'same')).toBe(0);
    });

    it('returns string length when one input is empty', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });

    it('returns 1 for single character insertion', () => {
        expect(levenshtein('cat', 'cats')).toBe(1);
    });

    it('returns 1 for single character deletion', () => {
        expect(levenshtein('cats', 'cat')).toBe(1);
    });

    it('returns 1 for single character substitution', () => {
        expect(levenshtein('bat', 'cat')).toBe(1);
    });

    it('returns correct distance for multi-edit strings', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });

    it('handles common NPC name typos (2 edits)', () => {
        expect(levenshtein('aldric', 'aldrick')).toBe(1);
        expect(levenshtein('morrigan', 'morigan')).toBe(1);
    });
});

// ─── normalizeEntityName ─────────────────────────────────────────────────────

describe('normalizeEntityName', () => {
    const entities = [
        { name: 'Aldric', aliases: ['the Warrior', 'Aldric the Bold'] },
        { name: 'Morrigan', aliases: ['the Witch'] },
        { name: 'Shadowkeep', aliases: [] },
    ];

    it('returns canonical name for exact match (case-insensitive)', () => {
        expect(normalizeEntityName('aldric', entities)).toBe('Aldric');
        expect(normalizeEntityName('MORRIGAN', entities)).toBe('Morrigan');
    });

    it('returns canonical name for alias match', () => {
        expect(normalizeEntityName('the Warrior', entities)).toBe('Aldric');
        expect(normalizeEntityName('the Witch', entities)).toBe('Morrigan');
    });

    it('returns canonical name for substring match', () => {
        expect(normalizeEntityName('Shadowkeep Castle', entities)).toBe('Shadowkeep');
    });

    it('returns canonical name for near-miss (levenshtein)', () => {
        expect(normalizeEntityName('Aldrik', entities)).toBe('Aldric');
    });

    it('returns original name when no match found', () => {
        expect(normalizeEntityName('Completely Unknown', entities)).toBe('Completely Unknown');
    });

    it('returns original name for empty entity list', () => {
        expect(normalizeEntityName('Aldric', [])).toBe('Aldric');
    });
});
