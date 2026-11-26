import { describe, expect, it } from 'vitest';
import type { RelationshipMemoryRecord } from '../../types';
import {
    clashes,
    injectionScore,
    isFloored,
    isPinned,
    orderForTruncation,
    participantOverlap,
    recencyWeight,
    RELATIONSHIP_MEMORY_READING_WEIGHTS,
    selectTiers,
    themeCharge,
    tierScore,
    truncationRank,
} from './relationshipMemoryReading';

function record(overrides: Partial<RelationshipMemoryRecord> = {}): RelationshipMemoryRecord {
    return {
        sceneId: '100',
        subject: 'npc-a',
        target: 'MC',
        mood: 'hostile',
        impact: 'remembered',
        outcome: 'looked away',
        source: 'recorded',
        ...overrides,
    };
}

const quietContext = {
    currentScene: '100',
    sceneMood: 'logistical' as const,
    presentParticipants: [],
};

describe('relationship memory reading layer', () => {
    it('charges both hostile-on-hostile and hostile-on-tender, but not hostile-on-logistical', () => {
        const same = themeCharge('hostile', 'hostile');
        const contradiction = themeCharge('hostile', 'tender');
        const logistical = themeCharge('hostile', 'logistical');

        expect(same).toBeGreaterThan(0);
        expect(contradiction).toBeGreaterThan(0);
        expect(logistical).toBe(0);
        expect(same).toBe(contradiction);
    });

    it('surfaces an old charged academy memory and quiets old logistical bread-buying', () => {
        const academy = record({
            sceneId: '040',
            mood: 'tender',
            impact: 'formative',
            outcome: 'froze under his hand',
        });
        const bread = record({
            sceneId: '040',
            mood: 'logistical',
            impact: 'passing',
            outcome: 'bought bread',
        });
        const cellContext = {
            currentScene: '300',
            sceneMood: 'hostile' as const,
            presentParticipants: [],
        };

        expect(injectionScore(academy, cellContext)).toBeGreaterThan(injectionScore(bread, cellContext));
        expect(themeCharge(cellContext.sceneMood, bread.mood)).toBe(0);
    });

    it('never lets situational zeros erase a memory with impact and recency', () => {
        const score = injectionScore(record({ impact: 'passing', mood: 'logistical' }), quietContext);
        expect(score).toBeGreaterThan(0);
    });

    it('decays monotonically and floors carried records', () => {
        const fresh = record({ sceneId: '100', impact: 'remembered' });
        const older = record({ sceneId: '095', impact: 'remembered' });
        const ancient = record({ sceneId: '001', impact: 'remembered' });
        const carried = record({ sceneId: '001', impact: 'carried', carriedNote: 'never trusts an oath' });

        expect(recencyWeight(fresh, '100')).toBeGreaterThan(recencyWeight(older, '100'));
        expect(recencyWeight(older, '100')).toBeGreaterThan(recencyWeight(ancient, '100'));
        expect(recencyWeight(carried, '100000')).toBe(RELATIONSHIP_MEMORY_READING_WEIGHTS.recency.carriedFloor);
        expect(isPinned(fresh)).toBe(false);
        expect(isPinned(record({ impact: 'formative' }))).toBe(true);
        expect(isFloored(carried)).toBe(true);
    });

    it('counts present parties rather than treating overlap as a boolean', () => {
        const memory = record({ subject: 'npc-a', target: 'npc-b' });
        expect(participantOverlap(memory, [])).toBe(0);
        expect(participantOverlap(memory, ['npc-a'])).toBe(1);
        expect(participantOverlap(memory, ['npc-a', 'npc-b'])).toBe(2);
    });

    it('makes clashes pairs, excludes same-valence pairs, and orders them deterministically', () => {
        const tender = record({ sceneId: '090', mood: 'tender', impact: 'formative' });
        const hostile = record({ sceneId: '099', mood: 'hostile', impact: 'formative' });
        const sameValence = record({ sceneId: '098', mood: 'companionable', impact: 'formative' });
        const result = clashes([tender, sameValence, hostile], {
            currentScene: '100',
            sceneMood: 'hostile',
            presentParticipants: ['npc-a', 'MC'],
        });

        expect(result).toHaveLength(2);
        expect(result.every(pair => pair.length === 2)).toBe(true);
        expect(result.some(pair => pair.includes(tender) && pair.includes(hostile))).toBe(true);
        expect(result.some(pair => pair.includes(tender) && pair.includes(sameValence))).toBe(false);
        expect(clashes([tender, sameValence, hostile], {
            currentScene: '100', sceneMood: 'hostile', presentParticipants: ['npc-a', 'MC'],
        })).toEqual(result);
    });

    it('keeps clash count dominant and does not use event count or recency for tiers', () => {
        const manyPassing = Array.from({ length: 40 }, (_, index) => record({
            sceneId: String(index + 1).padStart(3, '0'),
            impact: 'passing',
        }));
        const threeCarried = [1, 2, 3].map(sceneId => record({
            sceneId: String(sceneId).padStart(3, '0'),
            impact: 'carried',
            carriedNote: 'carries this forever',
        }));
        const oneClash = [
            record({ mood: 'tender', impact: 'formative' }),
            record({ mood: 'hostile', impact: 'formative' }),
        ];

        expect(tierScore(manyPassing)).toBe(0);
        expect(tierScore(threeCarried)).toBe(Number.POSITIVE_INFINITY);
        expect(tierScore(oneClash)).toBeGreaterThan(
            RELATIONSHIP_MEMORY_READING_WEIGHTS.tier.pinWeight * 20,
        );

        const selected = selectTiers([manyPassing, threeCarried, oneClash], 1);
        expect(selected[1]?.tier).toBe('deep');
        expect(selected[1]?.forcedDeep).toBe(true);
        expect(selected[2]?.tier).toBe('cheap');
        expect(selectTiers([oneClash], 1)[0]?.tier).toBe('deep');
    });

    it('truncates by impact only, with oldest breaking equal-impact ties, and never returns pins', () => {
        const oldPassing = record({ sceneId: '010', impact: 'passing' });
        const newPassing = record({ sceneId: '090', impact: 'passing' });
        const remembered = record({ sceneId: '001', impact: 'remembered' });
        const formative = record({ sceneId: '002', impact: 'formative' });

        expect(truncationRank(oldPassing)).toBe(truncationRank(newPassing));
        expect(orderForTruncation([remembered, formative, newPassing, oldPassing])).toEqual([
            oldPassing, newPassing, remembered,
        ]);
        expect(orderForTruncation([oldPassing, newPassing])).toEqual(
            orderForTruncation([oldPassing, newPassing]),
        );
    });

    it('is deterministic for repeated scoring and tier selection', () => {
        const edge = [
            record({ sceneId: '010', mood: 'tender', impact: 'formative' }),
            record({ sceneId: '090', mood: 'hostile', impact: 'formative' }),
        ];
        const context = {
            currentScene: '100',
            sceneMood: 'hostile' as const,
            presentParticipants: ['npc-a', 'MC'],
        };
        const first = {
            score: injectionScore(edge[0], context),
            clashes: clashes(edge, context),
            tiers: selectTiers([edge], 1),
        };
        const second = {
            score: injectionScore(edge[0], context),
            clashes: clashes(edge, context),
            tiers: selectTiers([edge], 1),
        };
        expect(second).toEqual(first);
    });

    // ─── WO-3.5 §7 — Fix C regression tests ───

    it('grave lights up tender — a funeral reaches the headpat (asserted by value)', () => {
        const charge = themeCharge('grave', 'tender');
        expect(charge).toBe(2);
    });

    it('non-neutral charges are unchanged by the neutral guard', () => {
        // Pin the existing results so Fix C cannot silently move them.
        expect(themeCharge('hostile', 'hostile')).toBe(2);
        expect(themeCharge('hostile', 'tender')).toBe(2);
        expect(themeCharge('tender', 'tender')).toBe(2);
        expect(themeCharge('hostile', 'logistical')).toBe(0);
        expect(themeCharge('logistical', 'tender')).toBe(0);
        expect(themeCharge('grave', 'logistical')).toBe(0);
    });
});
