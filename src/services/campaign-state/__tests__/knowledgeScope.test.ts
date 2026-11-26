import { describe, it, expect } from 'vitest';
import {
    normalizeFaction,
    parseFactions,
    normalizeSubjectToken,
    parseKnownByToken,
    isKnownToAnyOnStage,
    isKnownToPlayer,
    expandKnownBy,
    compareSceneRef,
    groupDivergencesBySubject,
} from '../knowledgeScope';
import type { DivergenceEntry } from '../../../types';

function makeEntry(overrides: Partial<DivergenceEntry> = {}): DivergenceEntry {
    return {
        id: 'div_001',
        chapterId: 'CH01',
        category: 'npc_events',
        text: 'Grak allied with the player',
        sceneRef: '014',
        npcIds: [],
        pinned: false,
        source: 'auto',
        ...overrides,
    };
}

describe('knowledgeScope', () => {
    describe('normalizeFaction', () => {
        it('lowercases, trims, collapses whitespace', () => {
            expect(normalizeFaction('  Crimson   Hand ')).toBe('crimson hand');
            expect(normalizeFaction('')).toBe('');
            expect(normalizeFaction(undefined as unknown as string)).toBe('');
        });
    });

    describe('parseFactions', () => {
        it('parses single and multi-faction strings delimited by commas, slashes, and semicolons', () => {
            expect(parseFactions('Crimson Hand')).toEqual(['crimson hand']);
            expect(parseFactions('  Ironspire Knights , Mages Guild ; Thieves Guild / Shadow Hand ')).toEqual([
                'ironspire knights',
                'mages guild',
                'thieves guild',
                'shadow hand',
            ]);
            expect(parseFactions('Ironspire Knights, ironspire knights')).toEqual(['ironspire knights']);
            expect(parseFactions('')).toEqual([]);
            expect(parseFactions(undefined)).toEqual([]);
        });
    });

    describe('normalizeSubjectToken', () => {
        it('produces stable snake_case slugs', () => {
            expect(normalizeSubjectToken('Alex.Status')).toBe('alex.status');
            expect(normalizeSubjectToken('alex status')).toBe('alex_status');
            expect(normalizeSubjectToken('  ')).toBeUndefined();
        });
        it('caps length at 40 chars', () => {
            const long = 'a'.repeat(50);
            const tok = normalizeSubjectToken(long);
            expect(tok!.length).toBeLessThanOrEqual(40);
        });
    });

    describe('parseKnownByToken', () => {
        it('parses player / npc: / faction: / bare-id forms', () => {
            expect(parseKnownByToken('player')).toEqual({ kind: 'player' });
            expect(parseKnownByToken('npc:42')).toEqual({ kind: 'npc', id: '42' });
            expect(parseKnownByToken('faction:Crimson Hand')).toEqual({ kind: 'faction', name: 'crimson hand' });
            // Bare ID (no prefix) → implicit npc:<id> (existing seal-audit output)
            expect(parseKnownByToken('npc_42')).toEqual({ kind: 'npc', id: 'npc_42' });
        });
        it('returns null for empty / malformed', () => {
            expect(parseKnownByToken('')).toBeNull();
            expect(parseKnownByToken('npc:')).toBeNull();
            expect(parseKnownByToken('faction:')).toBeNull();
        });
    });

    describe('isKnownToAnyOnStage', () => {
        const ledger = [
            { id: 'npc_a', faction: 'Crimson Hand' },
            { id: 'npc_b', faction: 'Iron Guard' },
        ];

        it('public facts (undefined knownBy) are known to everyone', () => {
            expect(isKnownToAnyOnStage(undefined, ['npc_a'], ledger)).toBe(true);
        });
        it('secret facts ([]) are known to nobody', () => {
            expect(isKnownToAnyOnStage([], ['npc_a'], ledger)).toBe(false);
        });
        it('npc:<id> matches iff that NPC is on stage', () => {
            expect(isKnownToAnyOnStage(['npc:npc_a'], ['npc_a'], ledger)).toBe(true);
            expect(isKnownToAnyOnStage(['npc:npc_a'], ['npc_b'], ledger)).toBe(false);
        });
        it('bare NPC IDs are treated as npc:<id>', () => {
            expect(isKnownToAnyOnStage(['npc_a'], ['npc_a'], ledger)).toBe(true);
            expect(isKnownToAnyOnStage(['npc_a'], ['npc_b'], ledger)).toBe(false);
        });
        it('faction:<name> matches iff some on-stage NPC is in that faction', () => {
            expect(isKnownToAnyOnStage(['faction:crimson hand'], ['npc_a'], ledger)).toBe(true);
            expect(isKnownToAnyOnStage(['faction:crimson hand'], ['npc_b'], ledger)).toBe(false);
        });
        it('supports NPCs with multiple comma-delimited factions', () => {
            const multiLedger = [{ id: 'npc_m', faction: 'Crimson Hand, Thieves Guild' }];
            expect(isKnownToAnyOnStage(['faction:thieves guild'], ['npc_m'], multiLedger)).toBe(true);
            expect(isKnownToAnyOnStage(['faction:crimson hand'], ['npc_m'], multiLedger)).toBe(true);
            expect(isKnownToAnyOnStage(['faction:iron guard'], ['npc_m'], multiLedger)).toBe(false);
        });
        it('player token alone does not make a fact known to an NPC', () => {
            expect(isKnownToAnyOnStage(['player'], ['npc_a'], ledger)).toBe(false);
        });
    });

    describe('isKnownToPlayer', () => {
        it('public facts are known to the player', () => {
            expect(isKnownToPlayer(undefined)).toBe(true);
        });
        it('player token marks player knowledge', () => {
            expect(isKnownToPlayer(['player'])).toBe(true);
            expect(isKnownToPlayer(['npc:42'])).toBe(false);
            expect(isKnownToPlayer(['player', 'npc:42'])).toBe(true);
            expect(isKnownToPlayer([])).toBe(false);
        });
    });

    describe('expandKnownBy', () => {
        const ledger = [
            { id: 'npc_a', faction: 'Crimson Hand' },
            { id: 'npc_b', faction: 'Crimson Hand' },
            { id: 'npc_c', faction: 'Iron Guard' },
            { id: 'npc_d', faction: 'Mages Guild, Crimson Hand' },
        ];
        it('expands faction tokens to all NPCs in that faction', () => {
            const ids = expandKnownBy(['faction:crimson hand'], ledger);
            expect(ids.has('npc_a')).toBe(true);
            expect(ids.has('npc_b')).toBe(true);
            expect(ids.has('npc_c')).toBe(false);
            expect(ids.has('npc_d')).toBe(true);
        });
        it('includes player and npc:<id> tokens', () => {
            const ids = expandKnownBy(['player', 'npc:npc_c'], ledger);
            expect(ids.has('player')).toBe(true);
            expect(ids.has('npc_c')).toBe(true);
        });
        it('treats bare IDs as npc:<id>', () => {
            const ids = expandKnownBy(['npc_c'], ledger);
            expect(ids.has('npc_c')).toBe(true);
        });
        it('returns empty set for undefined', () => {
            expect(expandKnownBy(undefined, ledger).size).toBe(0);
        });
    });

    describe('compareSceneRef', () => {
        it('compares zero-padded numerically', () => {
            expect(compareSceneRef('014', '100')).toBeLessThan(0);
            expect(compareSceneRef('100', '014')).toBeGreaterThan(0);
            expect(compareSceneRef('014', '014')).toBe(0);
        });
        it('falls back to string compare for non-numeric', () => {
            expect(compareSceneRef('abc', 'def')).toBeLessThan(0);
        });
    });

    describe('groupDivergencesBySubject', () => {
        it('groups by subjectToken and sorts beats by sceneRef', () => {
            const entries = [
                makeEntry({ id: '1', subjectToken: 'alex.identity', sceneRef: '020' }),
                makeEntry({ id: '2', subjectToken: 'alex.identity', sceneRef: '014' }),
                makeEntry({ id: '3', subjectToken: 'mira.identity', sceneRef: '001' }),
            ];
            const groups = groupDivergencesBySubject(entries);
            // tokened groups first, alpha by token
            expect(groups[0].token).toBe('alex.identity');
            // beats inside the alex group sorted ascending by sceneRef
            expect(groups[0].entries.map(e => e.sceneRef)).toEqual(['014', '020']);
            expect(groups[1].token).toBe('mira.identity');
        });
        it('places singletons after tokened groups', () => {
            const entries = [
                makeEntry({ id: '1', sceneRef: '030' }), // no subjectToken
                makeEntry({ id: '2', subjectToken: 'aaa.x', sceneRef: '001' }),
            ];
            const groups = groupDivergencesBySubject(entries);
            expect(groups[0].token).toBe('aaa.x');
            expect(groups[1].entries[0].id).toBe('1');
        });
    });
});