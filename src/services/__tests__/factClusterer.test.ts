import { describe, it, expect } from 'vitest';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { deriveSubjectTokenUpdates } from '../campaign-state/factClusterer';
import type { DivergenceRegister, DivergenceEntry, TopicClusters } from '../../types';

// Validate that factClusterer's {groups} shape works with the shared helper after migration
describe('factClusterer extractJsonRobust migration', () => {
    it('parses a well-formed groups response', () => {
        const raw = '{"groups":[{"name":"Yuki","factIds":["f1","f2"]},{"name":"Bridge","factIds":["f3"]}]}';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups).toHaveLength(2);
        expect(value.groups[0].name).toBe('Yuki');
    });

    it('recovers from truncated groups response', () => {
        const raw = '{"groups":[{"name":"Yuki","factIds":["f1","f2"]},{"name":"Bridge","factIds":["f3';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups).toHaveLength(1);
        expect(value.groups[0].name).toBe('Yuki');
    });

    it('returns fallback when no JSON object found', () => {
        const raw = 'the AI returned no JSON';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(false);
        expect(value.groups).toHaveLength(0);
    });

    it('handles think blocks before groups JSON', () => {
        const raw = 'reasoning about groups{"groups":[{"name":"test","factIds":["1"]}]}';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups[0].name).toBe('test');
    });
});

// WO-11.2 — Find Similarity non-destructive variant. Pure derivation from a
// clustering result; never disables or deletes facts, only emits subjectToken
// updates. Singletons are left alone; multi-fact groups get a shared token.
describe('deriveSubjectTokenUpdates (WO-11.2)', () => {
    function makeEntry(id: string, subjectToken?: string): DivergenceEntry {
        return {
            id, chapterId: 'CH01', category: 'npc_events', text: `fact ${id}`,
            sceneRef: '001', npcIds: [], subjectToken, pinned: false, source: 'auto',
        };
    }
    function makeRegister(entries: DivergenceEntry[]): DivergenceRegister {
        return { entries, chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
    }

    it('assigns a synthesized token to a multi-fact group with no existing tokens', () => {
        const reg = makeRegister([makeEntry('f1'), makeEntry('f2')]);
        const clusters: TopicClusters = {
            groups: [{ id: 'g1', name: 'Yuki Tanaka', factIds: ['f1', 'f2'] }],
            generatedAt: 'now', generatedFromFactCount: 2,
        };
        const updates = deriveSubjectTokenUpdates(reg, clusters);
        expect(updates).toHaveLength(2);
        expect(new Set(updates.map(u => u.subjectToken))).toEqual(new Set(['yuki_tanaka']));
    });

    it('reuses the most common existing token among members (drift repair)', () => {
        const reg = makeRegister([
            makeEntry('f1', 'alex.identity'),
            makeEntry('f2', 'alex.identity'),
            makeEntry('f3', 'alex_drift'),
        ]);
        const clusters: TopicClusters = {
            groups: [{ id: 'g1', name: 'Alex', factIds: ['f1', 'f2', 'f3'] }],
            generatedAt: 'now', generatedFromFactCount: 3,
        };
        const updates = deriveSubjectTokenUpdates(reg, clusters);
        expect(updates).toEqual([{ id: 'f3', subjectToken: 'alex.identity' }]);
    });

    it('leaves singletons alone (never overwrites a lone fact token)', () => {
        const reg = makeRegister([makeEntry('f1', 'solo.token')]);
        const clusters: TopicClusters = {
            groups: [{ id: 'g1', name: 'Solo', factIds: ['f1'] }],
            generatedAt: 'now', generatedFromFactCount: 1,
        };
        expect(deriveSubjectTokenUpdates(reg, clusters)).toEqual([]);
    });

    it('emits no updates when no multi-fact groups exist', () => {
        const reg = makeRegister([makeEntry('f1'), makeEntry('f2')]);
        const clusters: TopicClusters = {
            groups: [
                { id: 'g1', name: 'A', factIds: ['f1'] },
                { id: 'g2', name: 'B', factIds: ['f2'] },
            ],
            generatedAt: 'now', generatedFromFactCount: 2,
        };
        expect(deriveSubjectTokenUpdates(reg, clusters)).toEqual([]);
    });
});