import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCombinedSealOutput, sealChapterCombined } from '../combinedSeal';
import { parseChapterSummaryOutput } from '../chapterSummary';

const CHAPTER_ID = 'CH01';
const SCENE_IDS = ['001', '002'];
const NPC_LEDGER = [
    { id: 'npc_1', name: 'Aldric', aliases: '' },
    { id: 'npc_2', name: 'Morrigan', aliases: 'Morri' },
];

function makeValidSummaryBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        title: 'The Battle at Locust Town',
        summary: 'The party clashed with bandits at Locust Town and prevailed.',
        keywords: ['locust-town', 'bandits'],
        npcs: ['Aldric'],
        majorEvents: ['Bandits defeated'],
        unresolvedThreads: ['Who hired the bandits?'],
        tone: 'combat-heavy',
        themes: ['courage'],
        ...overrides,
    };
}

function makeSealJson(summary: Record<string, unknown>, extras: Record<string, unknown> = {}): string {
    return JSON.stringify({
        summary,
        divergences: {},
        sceneEvents: {},
        ...extras,
    });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warnSpy.mockRestore();
});

function optionalFieldWarnings(): string[] {
    return warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((msg: string) => msg.includes('Optional field'));
}

describe('parseCombinedSealOutput — WO-06 synopsis fields', () => {
    it('populates synopsis/abstractTitle/literalTitle from the nested summary object', () => {
        const raw = makeSealJson(makeValidSummaryBlock({
            synopsis: 'The party fought bandits at Locust Town and won.',
            abstractTitle: 'Old Wounds',
            literalTitle: 'The Battle at Locust Town',
        }));

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary).not.toBeNull();
        expect(result.summary?.synopsis).toBe('The party fought bandits at Locust Town and won.');
        expect(result.summary?.abstractTitle).toBe('Old Wounds');
        expect(result.summary?.literalTitle).toBe('The Battle at Locust Town');
        // Existing fields unchanged
        expect(result.summary?.title).toBe('The Battle at Locust Town');
        expect(result.summary?.summary).toContain('Locust Town');
        expect(result.summary?.keywords).toEqual(['locust-town', 'bandits']);
        // Existing top-level seal outputs intact
        expect(result.divergences).toEqual([]);
        expect(result.witnessCorrections).toBeUndefined();
        expect(result.sceneEventMap).toEqual({});
        expect(result.divergenceParseError).toBeUndefined();
        expect(result.sceneEventsParseError).toBeUndefined();
    });

    it('trims whitespace from the three new fields', () => {
        const raw = makeSealJson(makeValidSummaryBlock({
            synopsis: '  The party fought bandits at Locust Town and won.  ',
            abstractTitle: '\tOld Wounds\n',
            literalTitle: ' The Battle at Locust Town ',
        }));

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary?.synopsis).toBe('The party fought bandits at Locust Town and won.');
        expect(result.summary?.abstractTitle).toBe('Old Wounds');
        expect(result.summary?.literalTitle).toBe('The Battle at Locust Town');
    });

    it('leaves the three fields undefined when absent (silent — no warning)', () => {
        const raw = makeSealJson(makeValidSummaryBlock());

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary).not.toBeNull();
        expect(result.summary?.synopsis).toBeUndefined();
        expect(result.summary?.abstractTitle).toBeUndefined();
        expect(result.summary?.literalTitle).toBeUndefined();
        // Existing summary still valid
        expect(result.summary?.title).toBe('The Battle at Locust Town');
        // No warning about the three optional fields (erratum: missing is silent)
        expect(optionalFieldWarnings()).toEqual([]);
        // Existing outputs intact
        expect(result.divergences).toEqual([]);
        expect(result.sceneEventMap).toEqual({});
    });

    it('coerces empty-string new fields to undefined with one compact warning each', () => {
        const raw = makeSealJson(makeValidSummaryBlock({
            synopsis: '',
            abstractTitle: '   ',
            literalTitle: '',
        }));

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary?.synopsis).toBeUndefined();
        expect(result.summary?.abstractTitle).toBeUndefined();
        expect(result.summary?.literalTitle).toBeUndefined();
        // One compact warning per present-but-empty field
        const optionalWarnings = optionalFieldWarnings();
        expect(optionalWarnings).toHaveLength(3);
        expect(optionalWarnings.some(m => m.includes('synopsis'))).toBe(true);
        expect(optionalWarnings.some(m => m.includes('abstractTitle'))).toBe(true);
        expect(optionalWarnings.some(m => m.includes('literalTitle'))).toBe(true);
        // Existing summary fields still intact
        expect(result.summary?.title).toBe('The Battle at Locust Town');
        expect(result.summary?.summary).toContain('Locust Town');
        expect(result.divergences).toEqual([]);
        expect(result.sceneEventMap).toEqual({});
    });

    it('coerces wrong-type new fields to undefined with a compact warning', () => {
        const raw = makeSealJson(makeValidSummaryBlock({
            synopsis: ['not', 'a', 'string'],
            abstractTitle: 42,
            literalTitle: { nested: 'object' },
        }));

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary?.synopsis).toBeUndefined();
        expect(result.summary?.abstractTitle).toBeUndefined();
        expect(result.summary?.literalTitle).toBeUndefined();
        const optionalWarnings = optionalFieldWarnings();
        expect(optionalWarnings).toHaveLength(3);
        // Seal still succeeds — existing outputs intact
        expect(result.summary?.title).toBe('The Battle at Locust Town');
        expect(result.divergences).toEqual([]);
        expect(result.sceneEventMap).toEqual({});
    });

    it('preserves existing divergences and sceneEvents when synopsis fields are present', () => {
        const raw = makeSealJson(
            makeValidSummaryBlock({
                synopsis: 'A synopsis.',
                abstractTitle: 'A theme',
                literalTitle: 'A fact',
            }),
            {
                divergences: {
                    misc: [
                        {
                            text: 'Aldric swore an oath',
                            sceneRef: '001',
                            npcIds: ['npc_1'],
                            knownBy: ['npc_1'],
                            unrecognizedNpcNames: [],
                        },
                    ],
                },
                sceneEvents: {
                    '001': [
                        { eventType: 'promise', importance: 7, text: 'Aldric swore an oath' },
                    ],
                },
            }
        );

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary?.synopsis).toBe('A synopsis.');
        expect(result.summary?.abstractTitle).toBe('A theme');
        expect(result.summary?.literalTitle).toBe('A fact');
        expect(result.divergences).toHaveLength(1);
        expect(result.divergences[0].text).toBe('Aldric swore an oath');
        expect(result.divergences[0].npcIds).toEqual(['npc_1']);
        expect(result.sceneEventMap?.['001']).toHaveLength(1);
        expect(result.sceneEventMap?.['001'][0].eventType).toBe('promise');
    });

    it('seal still succeeds with existing outputs when summary block is missing the new fields entirely', () => {
        const raw = makeSealJson(makeValidSummaryBlock(), {
            divergences: {
                locations: [
                    {
                        text: 'Eastern gate destroyed',
                        sceneRef: '001',
                        npcIds: [],
                        knownBy: [],
                        unrecognizedNpcNames: [],
                    },
                ],
            },
        });

        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        expect(result.summary).not.toBeNull();
        expect(result.summary?.synopsis).toBeUndefined();
        expect(result.summary?.abstractTitle).toBeUndefined();
        expect(result.summary?.literalTitle).toBeUndefined();
        expect(result.divergences).toHaveLength(1);
        expect(result.divergences[0].category).toBe('locations');
        // No optional-field warnings (missing is silent per erratum)
        expect(optionalFieldWarnings()).toEqual([]);
    });

    it('garbage JSON → undefined new fields, seal falls back with existing outputs intact', () => {
        const garbage = 'this is not json at all';
        const result = parseCombinedSealOutput(garbage, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);

        // Existing fallback: summary may be null, divergences empty, divergenceParseError true
        expect(result.divergences).toEqual([]);
        expect(result.divergenceParseError).toBe(true);
        // No synopsis fields populated — they were never parsed
        expect(result.summary?.synopsis).toBeUndefined();
        expect(result.summary?.abstractTitle).toBeUndefined();
        expect(result.summary?.literalTitle).toBeUndefined();
    });
});

describe('parseChapterSummaryOutput — WO-06 synopsis fields (unit)', () => {
    it('preserves and trims a non-empty synopsis/abstractTitle/literalTitle', () => {
        const json = JSON.stringify(makeValidSummaryBlock({
            synopsis: '  Trim me  ',
            abstractTitle: 'Theme ',
            literalTitle: ' Fact ',
        }));

        const out = parseChapterSummaryOutput(json);

        expect(out?.synopsis).toBe('Trim me');
        expect(out?.abstractTitle).toBe('Theme');
        expect(out?.literalTitle).toBe('Fact');
        expect(out?.title).toBe('The Battle at Locust Town');
    });

    it('missing fields stay undefined silently (no warning)', () => {
        const json = JSON.stringify(makeValidSummaryBlock());

        const out = parseChapterSummaryOutput(json);

        expect(out?.synopsis).toBeUndefined();
        expect(out?.abstractTitle).toBeUndefined();
        expect(out?.literalTitle).toBeUndefined();
        expect(optionalFieldWarnings()).toEqual([]);
    });

    it('present-but-empty/wrong-type fields coerce to undefined with a compact warning', () => {
        const json = JSON.stringify(makeValidSummaryBlock({
            synopsis: '',
            abstractTitle: 99,
            literalTitle: ['x'],
        }));

        const out = parseChapterSummaryOutput(json);

        expect(out?.synopsis).toBeUndefined();
        expect(out?.abstractTitle).toBeUndefined();
        expect(out?.literalTitle).toBeUndefined();
        expect(optionalFieldWarnings()).toHaveLength(3);
    });

    it('does not invalidate an otherwise valid summary when synopsis fields are invalid', () => {
        const json = JSON.stringify(makeValidSummaryBlock({
            synopsis: null,
            abstractTitle: 42,
            literalTitle: {},
        }));

        const out = parseChapterSummaryOutput(json);

        expect(out).not.toBeNull();
        expect(out?.title).toBe('The Battle at Locust Town');
        expect(out?.summary).toContain('Locust Town');
        expect(out?.keywords).toEqual(['locust-town', 'bandits']);
        expect(out?.synopsis).toBeUndefined();
        expect(out?.abstractTitle).toBeUndefined();
        expect(out?.literalTitle).toBeUndefined();
    });
});
// A good summary whose facts block never parses used to be thrown away after the
// retries, leaving the chapter with no summary at all.
describe('sealChapterCombined — keeps a good summary when only the facts fail', () => {
    it('returns the summary with the facts error after every retry fails the facts', async () => {
        const modelCall = vi.fn(async () => JSON.stringify({ summary: makeValidSummaryBlock() }));
        const result = await sealChapterCombined(
            undefined, [{ sceneId: '001', content: 'x' }], CHAPTER_ID, 'Ch 1', SCENE_IDS, NPC_LEDGER,
            2, 0, undefined, [], modelCall,
        );
        expect(modelCall).toHaveBeenCalledTimes(3);
        expect(result.summary?.title).toBe('The Battle at Locust Town');
        expect(result.divergenceParseError).toBe(true);
        expect(result.divergences).toEqual([]);
    });
});
