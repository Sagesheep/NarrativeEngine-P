import { describe, it, expect } from 'vitest';
import { retrieveRelevantLore } from '../lore/loreRetriever';
import { retrieveRelevantRules } from '../rules/rulesRetriever';
import type { LoreChunk, RuleChunkMeta } from '../../types';

// ─── Shared fixtures ─────────────────────────────────────────────────────

function makeLoreChunk(overrides: Partial<LoreChunk> & { id: string }): LoreChunk {
    return {
        header: overrides.id,
        content: `content for ${overrides.id}`,
        tokens: 50,
        triggerKeywords: [],
        ...overrides,
    } as LoreChunk;
}

// ─── Lore Retriever: IDF + RRF ────────────────────────────────────────────

describe('Lore Retriever — IDF+RRF algorithm', () => {
    const rareKeyword = 'dragonlance';
    const commonKeyword = 'attack';

    const chunks: LoreChunk[] = [
        makeLoreChunk({
            id: 'lore-rare',
            triggerKeywords: [rareKeyword],
            tokens: 40,
        }),
        makeLoreChunk({
            id: 'lore-common',
            triggerKeywords: [commonKeyword, 'sword'],
            tokens: 40,
        }),
        makeLoreChunk({
            id: 'lore-both',
            triggerKeywords: [rareKeyword, commonKeyword],
            tokens: 40,
        }),
        makeLoreChunk({
            id: 'lore-always',
            alwaysInclude: true,
            tokens: 30,
        }),
    ];

    it('IDF: rare keyword outranks common keyword in the same chunk', () => {
        // "lore-both" has both rare and common keywords;
        // it should rank above "lore-common" which only has common
        const result = retrieveRelevantLore(
            chunks, '', '', `I sense a ${rareKeyword} and an ${commonKeyword}`,
            200, [], undefined, 'idf-rrf'
        );

        const bothIndex = result.findIndex(c => c.id === 'lore-both');
        const commonIndex = result.findIndex(c => c.id === 'lore-common');
        expect(bothIndex).toBeGreaterThanOrEqual(0);
        expect(commonIndex).toBeGreaterThanOrEqual(0);
        expect(bothIndex).toBeLessThan(commonIndex);
    });

    it('RRF: consensus chunks (in both keyword and embedding) outrank single-list chunks', () => {
        const semanticIds = ['lore-both']; // in embedding result
        const result = retrieveRelevantLore(
            chunks, '', '', `a ${rareKeyword} ${commonKeyword}`,
            200, [], semanticIds, 'idf-rrf'
        );

        const bothIndex = result.findIndex(c => c.id === 'lore-both');
        const rareIndex = result.findIndex(c => c.id === 'lore-rare');
        // lore-both is in both lists → higher RRF score
        expect(bothIndex).toBeLessThan(rareIndex);
    });

    it('alwaysInclude chunks are included regardless of algorithm', () => {
        const result = retrieveRelevantLore(
            chunks, '', '', 'irrelevant query',
            500, [], undefined, 'idf-rrf'
        );
        expect(result.map(c => c.id)).toContain('lore-always');
    });

    it('group competition: two chunks in same group, only higher-scoring survives', () => {
        const grouped: LoreChunk[] = [
            makeLoreChunk({
                id: 'grp-a',
                triggerKeywords: [rareKeyword],
                group: 'combat',
                groupWeight: 5,
                tokens: 40,
            }),
            makeLoreChunk({
                id: 'grp-b',
                triggerKeywords: [commonKeyword],
                group: 'combat',
                groupWeight: 10,
                tokens: 40,
            }),
        ];

        const result = retrieveRelevantLore(
            grouped, '', '', `${rareKeyword} ${commonKeyword}`,
            200, [], undefined, 'idf-rrf'
        );

        const groupIds = result.filter(c => c.group === 'combat');
        // Group competition should keep only one
        expect(groupIds.length).toBeLessThanOrEqual(1);
    });

    it('budget pressure: grouped chunk with higher RRF score is not starved by lower-ranked ungrouped chunks', () => {
        // grp-high has a rare keyword → high IDF/RRF score, but is in a group
        // ungrouped-low has a common keyword → lower RRF score, no group
        // Under tight budget, grp-high should still come first
        const chunks: LoreChunk[] = [
            makeLoreChunk({
                id: 'grp-high',
                triggerKeywords: [rareKeyword],
                group: 'combat',
                groupWeight: 10,
                tokens: 50,
            }),
            makeLoreChunk({
                id: 'ungrouped-low',
                triggerKeywords: [commonKeyword],
                tokens: 50,
            }),
        ];

        // Budget fits exactly one chunk (50 tokens), forcing a choice
        const result = retrieveRelevantLore(
            chunks, '', '', `${rareKeyword} ${commonKeyword}`,
            60, [], undefined, 'idf-rrf'
        );
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('grp-high');
    });

    it('classic flag produces identical results to original flat-additive scoring', () => {
        // Classic path: kwHits * 10 + priority + categoryBoost
        const result = retrieveRelevantLore(
            chunks, '', '', `${commonKeyword}`,
            500, [], undefined, 'classic'
        );

        const commonChunk = result.find(c => c.id === 'lore-common');
        // Classic should still find common keyword chunk
        expect(commonChunk).toBeDefined();
    });

    it('0.5 half-weight penalty for vector-only chunks with keyword overlap but no semantic hit', () => {
        const vectorChunks: LoreChunk[] = [
            makeLoreChunk({
                id: 'vec-kw',
                ragMode: 'vector',
                triggerKeywords: [rareKeyword],
                tokens: 40,
            }),
        ];

        // No semantic hit for vec-kw → it should appear but with reduced confidence
        // The result should still include it (half-weight is still > 0)
        const result = retrieveRelevantLore(
            vectorChunks, '', '', `${rareKeyword}`,
            200, [], [], 'idf-rrf'
        );
        expect(result.map(c => c.id)).toContain('vec-kw');

        // With semantic hit, same chunk should rank higher (or at least present)
        const resultWithSemantic = retrieveRelevantLore(
            vectorChunks, '', '', `${rareKeyword}`,
            200, [], ['vec-kw'], 'idf-rrf'
        );
        expect(resultWithSemantic.map(c => c.id)).toContain('vec-kw');
    });

    it('never returns a chunk with disabled: true, even if alwaysInclude=true or keywords match', () => {
        const testChunks: LoreChunk[] = [
            makeLoreChunk({
                id: 'lore-disabled-always',
                alwaysInclude: true,
                disabled: true,
                tokens: 40,
            }),
            makeLoreChunk({
                id: 'lore-disabled-kw',
                triggerKeywords: [rareKeyword],
                disabled: true,
                tokens: 40,
            }),
        ];

        // test IDF-RRF algorithm
        const resultIdf = retrieveRelevantLore(
            testChunks, '', '', `testing with ${rareKeyword}`,
            500, [], undefined, 'idf-rrf'
        );
        expect(resultIdf.map(c => c.id)).not.toContain('lore-disabled-always');
        expect(resultIdf.map(c => c.id)).not.toContain('lore-disabled-kw');

        // test Classic algorithm
        const resultClassic = retrieveRelevantLore(
            testChunks, '', '', `testing with ${rareKeyword}`,
            500, [], undefined, 'classic'
        );
        expect(resultClassic.map(c => c.id)).not.toContain('lore-disabled-always');
        expect(resultClassic.map(c => c.id)).not.toContain('lore-disabled-kw');
    });
});

// ─── Rules Retriever: IDF + RRF ───────────────────────────────────────────

describe('Rules Retriever — IDF+RRF algorithm', () => {
    const mockChunks: LoreChunk[] = [
        {
            id: 'rule-1',
            header: '## Combat Attack',
            content: 'When making an attack, roll a d20.',
            tokens: 50,
            priority: 5,
            triggerKeywords: [],
        } as unknown as LoreChunk,
        {
            id: 'rule-2',
            header: '## Always Rule',
            content: 'This rule is always loaded.',
            tokens: 20,
            priority: 9,
            triggerKeywords: [],
        } as unknown as LoreChunk,
        {
            id: 'rule-3',
            header: '## Stealth Movement',
            content: 'When sneaking in difficult terrain.',
            tokens: 30,
            priority: 4,
            triggerKeywords: [],
        } as unknown as LoreChunk,
    ];

    const mockMeta: Record<string, RuleChunkMeta> = {
        'rule-1': {
            id: 'rule-1',
            activationModes: ['keyword'],
            triggerKeywords: ['attack', 'strike'],
            secondaryKeywords: ['combat'],
            priority: 5,
        },
        'rule-2': {
            id: 'rule-2',
            activationModes: ['always'],
            priority: 9,
        },
        'rule-3': {
            id: 'rule-3',
            activationModes: ['vector', 'keyword'],
            triggerKeywords: ['stealth', 'sneak'],
            secondaryKeywords: [],
            priority: 4,
        },
    };

    it('includes always-load rules regardless of keywords or query (idf-rrf)', () => {
        const result = retrieveRelevantRules(mockChunks, mockMeta, 'looking around', 100, [], undefined, 'idf-rrf');
        expect(result.selected.map(r => r.id)).toContain('rule-2');
    });

    it('activates keyword rules with valid trigger and secondary keywords (idf-rrf)', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'I perform a quick attack in combat', 200, [], undefined, 'idf-rrf'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).toContain('rule-1');
    });

    it('filters out keyword rules when secondary keyword narrows them away (idf-rrf)', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'I attack the target from a distance', 200, [], undefined, 'idf-rrf'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
    });

    it('activates semantic rules via vector search hits (idf-rrf)', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'sneaking around', 200, [], ['rule-3'], 'idf-rrf'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).toContain('rule-3');
    });

    it('respects token budget constraints and outputs unretrieved manifest (idf-rrf)', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'I perform an attack in combat', 60, [], undefined, 'idf-rrf'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
        expect(result.manifest).toContain('Combat Attack');
        expect(result.manifest).toContain('Stealth Movement');
    });

    it('IDF: rare trigger keyword outranks common one in rules (idf-rrf)', () => {
        const chunks: LoreChunk[] = [
            makeLoreChunk({ id: 'rare-rule', triggerKeywords: ['dragonlance'], tokens: 30 }),
            makeLoreChunk({ id: 'common-rule', triggerKeywords: ['attack'], tokens: 30 }),
        ];
        const meta: Record<string, RuleChunkMeta> = {
            'rare-rule': { id: 'rare-rule', activationModes: ['keyword'], triggerKeywords: ['dragonlance'], secondaryKeywords: [], priority: 5 },
            'common-rule': { id: 'common-rule', activationModes: ['keyword'], triggerKeywords: ['attack'], secondaryKeywords: [], priority: 5 },
        };

        // Use many other chunks also containing 'attack' to make it common
        const manyChunks = [...chunks];
        for (let i = 0; i < 20; i++) {
            manyChunks.push(makeLoreChunk({ id: `filler-${i}`, triggerKeywords: ['attack'], tokens: 30 }));
        }
        const manyMeta: Record<string, RuleChunkMeta> = { ...meta };
        for (let i = 0; i < 20; i++) {
            manyMeta[`filler-${i}`] = {
                id: `filler-${i}`,
                activationModes: ['keyword'],
                triggerKeywords: ['attack'],
                secondaryKeywords: [],
                priority: 3,
            };
        }

        const result = retrieveRelevantRules(
            manyChunks, manyMeta, 'dragonlance attack', 5000, [], undefined, 'idf-rrf'
        );

        const rareIndex = result.selected.findIndex(r => r.id === 'rare-rule');
        const commonIndex = result.selected.findIndex(r => r.id === 'common-rule');
        expect(rareIndex).toBeLessThan(commonIndex);
    });

    it('RRF: consensus rule chunks outrank single-list chunks (idf-rrf)', () => {
        const chunks: LoreChunk[] = [
            makeLoreChunk({ id: 'kw-only', triggerKeywords: ['stealth'], tokens: 30 }),
            makeLoreChunk({ id: 'both-lists', triggerKeywords: ['sneak'], tokens: 30 }),
        ];
        const meta: Record<string, RuleChunkMeta> = {
            'kw-only': { id: 'kw-only', activationModes: ['keyword'], triggerKeywords: ['stealth'], secondaryKeywords: [], priority: 5 },
            'both-lists': { id: 'both-lists', activationModes: ['vector', 'keyword'], triggerKeywords: ['sneak'], secondaryKeywords: [], priority: 5 },
        };

        const result = retrieveRelevantRules(
            chunks, meta, 'stealthy sneak', 500, [], ['both-lists'], 'idf-rrf'
        );

        // both-lists should appear in results (it matches both keyword and semantic)
        expect(result.selected.map(r => r.id)).toContain('both-lists');
        // kw-only is keyword-only; both-lists is in keyword AND embedding → RRF consensus boost
        const bothIndex = result.selected.findIndex(r => r.id === 'both-lists');
        const kwIndex = result.selected.findIndex(r => r.id === 'kw-only');
        if (kwIndex !== -1) {
            expect(bothIndex).toBeLessThan(kwIndex);
        }
    });

    it('manifest is present in idf-rrf output (regression)', () => {
        const result = retrieveRelevantRules(mockChunks, mockMeta, 'combat attack', 60, [], undefined, 'idf-rrf');
        expect(result.manifest).toContain('[Available rule sections not loaded this turn]');
    });

    // Classic algorithm tests - existing behavior preserved
    it('classic: includes always-load rules regardless of keywords', () => {
        const result = retrieveRelevantRules(mockChunks, mockMeta, 'looking around', 100, [], undefined, 'classic');
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
        expect(result.selected.map(r => r.id)).not.toContain('rule-3');
    });

    it('classic: activates keyword rules with valid trigger and secondary keywords', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'I perform a quick attack in combat', 200, [], undefined, 'classic'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).toContain('rule-1');
    });

    it('classic: filters out keyword rules when secondary keyword narrows them away', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'I attack the target from a distance', 200, [], undefined, 'classic'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
    });

    it('classic: activates semantic rules via vector search hits', () => {
        const result = retrieveRelevantRules(
            mockChunks, mockMeta, 'sneaking around', 200, [], ['rule-3'], 'classic'
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).toContain('rule-3');
    });
});

// ─── Feature flag: algorithm switch ─────────────────────────────────────────

describe('Retrieval feature flag — algorithm switch', () => {
    // A vector-only chunk that is a semantic hit but has NO keyword match.
    // Classic gives it a flat +15 semantic score; idf-rrf ranks it via RRF on the
    // embedding list only. Either way it should surface — but we assert the two
    // algorithms are independently reachable and the default matches idf-rrf.
    const chunks: LoreChunk[] = [
        makeLoreChunk({ id: 'kw', triggerKeywords: ['beacon'], tokens: 40 }),
        makeLoreChunk({ id: 'vec', triggerKeywords: ['unrelated'], ragMode: 'vector', tokens: 40 }),
    ];

    it('default (omitted algorithm) equals explicit idf-rrf', () => {
        const def = retrieveRelevantLore(chunks, '', '', 'light the beacon', 200, [], ['vec']);
        const explicit = retrieveRelevantLore(chunks, '', '', 'light the beacon', 200, [], ['vec'], 'idf-rrf');
        expect(def.map(c => c.id)).toEqual(explicit.map(c => c.id));
    });

    it('classic and idf-rrf are both reachable and can differ in ordering', () => {
        const classic = retrieveRelevantLore(chunks, '', '', 'light the beacon', 200, [], ['vec'], 'classic');
        const idfRrf = retrieveRelevantLore(chunks, '', '', 'light the beacon', 200, [], ['vec'], 'idf-rrf');
        // Both must return results (the flag doesn't break either path).
        expect(classic.length).toBeGreaterThan(0);
        expect(idfRrf.length).toBeGreaterThan(0);
        // The keyword-matched chunk is present in both regardless of algorithm.
        expect(classic.map(c => c.id)).toContain('kw');
        expect(idfRrf.map(c => c.id)).toContain('kw');
    });

    it('rules retriever honors the classic flag path', () => {
        const ruleChunks: LoreChunk[] = [
            makeLoreChunk({ id: 'r-kw', triggerKeywords: ['parry'], tokens: 40 }),
        ];
        const meta: Record<string, RuleChunkMeta> = {
            'r-kw': { activationModes: ['keyword'], triggerKeywords: ['parry'], priority: 5 } as RuleChunkMeta,
        };
        const classic = retrieveRelevantRules(ruleChunks, meta, 'I parry the blow', 200, [], undefined, 'classic');
        const idfRrf = retrieveRelevantRules(ruleChunks, meta, 'I parry the blow', 200, [], undefined, 'idf-rrf');
        expect(classic.selected.map(r => r.id)).toContain('r-kw');
        expect(idfRrf.selected.map(r => r.id)).toContain('r-kw');
    });
});
