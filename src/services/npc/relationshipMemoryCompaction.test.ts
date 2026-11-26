import { describe, expect, it } from 'vitest';
import type { RelationshipMemoryRecord } from '../../types';
import { clashes, isPinned } from './relationshipMemoryReading';
import {
    compactRelationshipMemoryEdge,
    compactRelationshipMemoryCollections,
} from './relationshipMemoryCompaction';

function record(overrides: Partial<RelationshipMemoryRecord> = {}): RelationshipMemoryRecord {
    return {
        sceneId: '001',
        subject: 'npc-a',
        target: 'MC',
        mood: 'companionable',
        impact: 'passing',
        event: 'shared a quiet meal',
        outcome: 'stayed for dinner',
        source: 'recorded',
        ...overrides,
    };
}

describe('relationship memory truncation and eras', () => {
    it('keeps every pin and gives the edge its unpinned budget', () => {
        const pinned = Array.from({ length: 12 }, (_, index) => record({
            sceneId: `p${index}`,
            impact: 'formative',
        }));
        const unpinned = Array.from({ length: 188 }, (_, index) => record({
            sceneId: String(index + 20).padStart(3, '0'),
        }));
        const result = compactRelationshipMemoryEdge([...pinned, ...unpinned]);

        expect(pinned.every(item => result.records.includes(item))).toBe(true);
        expect(result.records.filter(item => item.source !== 'era' && !isPinned(item))).toHaveLength(30);
        expect(result.era?.absorbedCount).toBe(158);
    });

    it('never mutates or replaces the full log', () => {
        const fullLog = Array.from({ length: 40 }, (_, index) => record({ sceneId: String(index + 1) }));
        const snapshot = fullLog.slice();
        const result = compactRelationshipMemoryCollections(fullLog, []);

        expect(fullLog).toEqual(snapshot);
        expect(fullLog).toHaveLength(40);
        expect(result.npcToMc).not.toBe(fullLog);
        expect(result.reports.npcToMc.dropped).toHaveLength(10);
    });

    it('applies the survivor budget independently to each edge in a collection', () => {
        const firstEdge = Array.from({ length: 31 }, (_, index) => record({
            sceneId: String(index + 1),
            subject: 'npc-a',
        }));
        const secondEdge = Array.from({ length: 31 }, (_, index) => record({
            sceneId: String(index + 1),
            subject: 'npc-b',
        }));
        const result = compactRelationshipMemoryCollections([...firstEdge, ...secondEdge], []);

        expect(result.npcToMc.filter(item => item.subject === 'npc-a' && item.source !== 'era')).toHaveLength(30);
        expect(result.npcToMc.filter(item => item.subject === 'npc-b' && item.source !== 'era')).toHaveLength(30);
        expect(result.npcToMc.filter(item => item.source === 'era')).toHaveLength(2);
    });

    it('preserves an era mood so the era can clash with a hostile pin', () => {
        const tenderHistory = Array.from({ length: 40 }, (_, index) => record({
            sceneId: String(index + 1),
            mood: 'tender',
        }));
        const hostile = record({ sceneId: '200', mood: 'hostile', impact: 'formative' });
        const result = compactRelationshipMemoryEdge([...tenderHistory, hostile]);

        expect(result.era?.mood).toBe('tender');
        expect(clashes(result.records).some(([left, right]) =>
            (left.source === 'era' && right === hostile) || (right.source === 'era' && left === hostile),
        )).toBe(true);
    });

    it('is independent of scene and mood because truncation uses impact only', () => {
        const history = Array.from({ length: 40 }, (_, index) => record({ sceneId: String(index + 1) }));
        expect(compactRelationshipMemoryEdge(history)).toEqual(compactRelationshipMemoryEdge(history));
    });

    it('does not revise an existing era on a second pass', () => {
        const history = Array.from({ length: 40 }, (_, index) => record({ sceneId: String(index + 1) }));
        const first = compactRelationshipMemoryEdge(history);
        const second = compactRelationshipMemoryEdge(first.records);

        expect(second.records).toEqual(first.records);
        expect(second.era).toBeUndefined();
    });

    it('drops lowest impact first and oldest equal-impact records first', () => {
        const history = [
            record({ sceneId: '001', impact: 'passing' }),
            record({ sceneId: '002', impact: 'passing' }),
            record({ sceneId: '003', impact: 'remembered' }),
        ];
        const result = compactRelationshipMemoryEdge(history, { unpinnedRecordLimit: 1 });

        expect(result.dropped.map(item => item.sceneId)).toEqual(['001', '002']);
        expect(result.records).toContain(history[2]);
    });

    it('uses legacy outcome only when a dropped record has no event', () => {
        const legacy = record({ event: undefined, outcome: 'went quiet and left' });
        const result = compactRelationshipMemoryEdge([legacy], { unpinnedRecordLimit: 0 });

        expect(result.era?.event).toContain('went quiet and left');
    });
});
