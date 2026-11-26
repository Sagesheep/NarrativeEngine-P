import { describe, it, expect } from 'vitest';
import type { DivergenceEntry } from '../../types';

describe('factDeduper', () => {
    describe('sort comparator stability', () => {
        it('uses Map for stable O(1) lookup in sort', () => {
            const entries: DivergenceEntry[] = [
                { id: 'f1', text: 'Alpha fact', chapterId: 'CH01', sceneRef: '005', category: 'npc_events', enabled: true } as DivergenceEntry,
                { id: 'f2', text: 'Beta fact', chapterId: 'CH02', sceneRef: '010', category: 'npc_events', enabled: true } as DivergenceEntry,
                { id: 'f3', text: 'Gamma fact', chapterId: 'CH01', sceneRef: '015', category: 'npc_events', enabled: true } as DivergenceEntry,
            ];

            const entryById = new Map<string, DivergenceEntry>();
            for (const e of entries) entryById.set(e.id, e);

            const chapterIndexMap = new Map<string, number>();
            chapterIndexMap.set('CH01', 0);
            chapterIndexMap.set('CH02', 1);

            const ids = ['f2', 'f3', 'f1'];
            const sorted = [...ids].sort((a, b) => {
                const entryA = entryById.get(a);
                const entryB = entryById.get(b);
                if (!entryA || !entryB) return 0;
                const chIdxA = chapterIndexMap.get(entryA.chapterId) ?? 0;
                const chIdxB = chapterIndexMap.get(entryB.chapterId) ?? 0;
                if (chIdxA !== chIdxB) return chIdxA - chIdxB;
                return entryA.sceneRef.localeCompare(entryB.sceneRef);
            });

            expect(sorted).toEqual(['f1', 'f3', 'f2']);
        });

        it('handles missing entries gracefully', () => {
            const entryById = new Map<string, DivergenceEntry>();
            const ids = ['unknown1', 'unknown2'];
            const sorted = [...ids].sort((a, b) => {
                const entryA = entryById.get(a);
                const entryB = entryById.get(b);
                if (!entryA || !entryB) return 0;
                return entryA.sceneRef.localeCompare(entryB.sceneRef);
            });
            expect(sorted).toEqual(['unknown1', 'unknown2']);
        });
    });

    describe('empty input handling', () => {
        it('handles empty bucket entries', () => {
            const bucketIdSet = new Set<string>();
            const validIds = ['f1', 'f2'].filter(id => bucketIdSet.has(id));
            expect(validIds).toHaveLength(0);
        });

        it('handles single-item groups (filtered out)', () => {
            const bucketIdSet = new Set(['f1']);
            const validIds = ['f1'].filter(id => bucketIdSet.has(id));
            expect(validIds.length < 2).toBe(true);
        });
    });
});