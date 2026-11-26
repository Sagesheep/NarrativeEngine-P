import { describe, it, expect } from 'vitest';
import { levenshtein, normalizeEntityName } from '../../utils/entityResolution';
import type { EntityEntry } from '../../types';

describe('levenshtein', () => {
    it('returns 0 for identical strings', () => {
        expect(levenshtein('hello', 'hello')).toBe(0);
    });

    it('returns length difference for empty string cases', () => {
        expect(levenshtein('', '')).toBe(0);
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });

    it('computes single insertion', () => {
        expect(levenshtein('cat', 'cats')).toBe(1);
    });

    it('computes single deletion', () => {
        expect(levenshtein('cats', 'cat')).toBe(1);
    });

    it('computes single substitution', () => {
        expect(levenshtein('cat', 'car')).toBe(1);
    });

    it('computes multiple operations', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });

    it('handles case differences', () => {
        expect(levenshtein('Hello', 'hello')).toBe(1);
    });
});

describe('normalizeEntityName', () => {
    const knownEntities: EntityEntry[] = [
        { id: 'e1', name: 'Aldric', type: 'npc', aliases: ['Lord Aldric', 'the Bold'], firstSeen: '001' },
        { id: 'e2', name: 'Shadow Weave', type: 'faction', aliases: [], firstSeen: '002' },
        { id: 'e3', name: 'Baldur\'s Gate', type: 'location', aliases: ['BG'], firstSeen: '003' },
    ];

    it('returns exact match', () => {
        expect(normalizeEntityName('Aldric', knownEntities)).toBe('Aldric');
    });

    it('matches alias', () => {
        expect(normalizeEntityName('Lord Aldric', knownEntities)).toBe('Aldric');
    });

    it('matches case-insensitively', () => {
        expect(normalizeEntityName('aldric', knownEntities)).toBe('Aldric');
    });

    it('matches via substring', () => {
        expect(normalizeEntityName('Shadow', knownEntities)).toBe('Shadow Weave');
    });

    it('matches via fuzzy (Levenshtein)', () => {
        expect(normalizeEntityName('Aldirc', knownEntities)).toBe('Aldric');
    });

    it('returns original name when no match', () => {
        expect(normalizeEntityName('Completely Unknown', knownEntities)).toBe('Completely Unknown');
    });

    it('returns original name when no match (short name matches via substring)', () => {
        // "Al" is contained in "Aldric", so substring match returns "Aldric"
        expect(normalizeEntityName('Al', knownEntities)).toBe('Aldric');
    });
});