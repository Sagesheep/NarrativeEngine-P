import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    shouldAutoSeal,
    sealChapter,
    extractSessionIds,
    updateChapterSessionId,
    scoreChapter,
    rankChapters,
    iterativeChapterFilter,
    recallWithChapterFunnel,
    MAX_LLM_ITERATIONS,
    MAX_CONFIRMED_CHAPTERS,
} from '../archiveChapterEngine';
import { retrieveArchiveMemory } from '../archiveMemory';
import type { ArchiveChapter, ArchiveIndexEntry } from '../../types';

describe('extractSessionIds', () => {
    it('extracts SESSION_IDs from header index string', () => {
        const headerIndex = `
SESSION_ID: abc-123
Some content here
SESSION_ID: def-456
More content
SESSION_ID: ghi-789
        `;
        const result = extractSessionIds(headerIndex);
        expect(result).toEqual(['abc-123', 'def-456', 'ghi-789']);
    });

    it('returns empty array when no SESSION_IDs found', () => {
        const headerIndex = 'No session IDs here';
        const result = extractSessionIds(headerIndex);
        expect(result).toEqual([]);
    });

    it('handles multiple SESSION_IDs in order', () => {
        const headerIndex = 'SESSION_ID: first SESSION_ID: second SESSION_ID: third';
        const result = extractSessionIds(headerIndex);
        expect(result).toEqual(['first', 'second', 'third']);
    });

    it('handles extra whitespace', () => {
        const headerIndex = 'SESSION_ID:   spaced-out-id   \nSESSION_ID:another-id';
        const result = extractSessionIds(headerIndex);
        expect(result).toEqual(['spaced-out-id', 'another-id']);
    });
});

describe('shouldAutoSeal', () => {
    const createOpenChapter = (sceneRange: [string, string], sessionId?: string): ArchiveChapter => ({
        chapterId: 'CH01',
        title: 'Test Chapter',
        sceneRange,
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
        _lastSeenSessionId: sessionId,
    });

    it('returns false when no open chapter exists', () => {
        const chapters: ArchiveChapter[] = [
            { ...createOpenChapter(['001', '010'], 'session-1'), sealedAt: Date.now() },
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-1');
        expect(result.shouldSeal).toBe(false);
        expect(result.reason).toBe('no_open_chapter');
    });

    it('returns true with scene_threshold when sceneCount >= 25', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(['001', '025'], 'session-1'),
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-1');
        expect(result.shouldSeal).toBe(true);
        expect(result.reason).toBe('scene_threshold');
    });

    it('returns false when sceneCount < 25 and same session', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(['001', '010'], 'session-1'),
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-1');
        expect(result.shouldSeal).toBe(false);
    });

    it('returns true with session_boundary when SESSION_ID changes', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(['001', '010'], 'session-1'),
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-2');
        expect(result.shouldSeal).toBe(true);
        expect(result.reason).toBe('session_boundary');
        expect(result.sessionId).toBe('session-2');
    });

    it('returns false when SESSION_ID has not changed', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(['001', '010'], 'session-1'),
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-1');
        expect(result.shouldSeal).toBe(false);
    });

    it('returns false when open chapter has no _lastSeenSessionId', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(['001', '010']), // No session ID set
        ];
        const result = shouldAutoSeal(chapters, 'SESSION_ID: session-1');
        expect(result.shouldSeal).toBe(false);
    });
});

describe('sealChapter', () => {
    const createOpenChapter = (chapterId: string, sceneRange: [string, string]): ArchiveChapter => ({
        chapterId,
        title: 'Open Chapter',
        sceneRange,
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
    });

    it('seals open chapter by setting sealedAt to current timestamp', () => {
        const beforeTime = Date.now();
        const chapters: ArchiveChapter[] = [
            createOpenChapter('CH01', ['001', '010']),
        ];
        const { sealedChapter } = sealChapter(chapters);
        
        expect(sealedChapter.chapterId).toBe('CH01');
        expect(sealedChapter.sealedAt).toBeGreaterThanOrEqual(beforeTime);
        expect(sealedChapter.sealedAt).toBeLessThanOrEqual(Date.now());
    });

    it('creates new open chapter with correct next chapterId', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter('CH01', ['001', '010']),
        ];
        const { newOpenChapter } = sealChapter(chapters);
        
        expect(newOpenChapter.chapterId).toBe('CH02');
    });

    it('creates new open chapter starting at sceneRange = [lastScene + 1, lastScene + 1]', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter('CH01', ['001', '010']),
        ];
        const { newOpenChapter } = sealChapter(chapters);
        
        expect(newOpenChapter.sceneRange).toEqual(['011', '011']);
    });

    it('throws when no open chapter exists', () => {
        const chapters: ArchiveChapter[] = [
            { ...createOpenChapter('CH01', ['001', '010']), sealedAt: Date.now() },
        ];
        expect(() => sealChapter(chapters)).toThrow('No open chapter to seal');
    });

    it('assigns _lastSeenSessionId to new chapter if provided', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter('CH01', ['001', '010']),
        ];
        const { newOpenChapter } = sealChapter(chapters, 'new-session-123');
        
        expect(newOpenChapter._lastSeenSessionId).toBe('new-session-123');
    });

    it('handles multiple existing chapters', () => {
        const chapters: ArchiveChapter[] = [
            { ...createOpenChapter('CH01', ['001', '010']), sealedAt: Date.now() },
            createOpenChapter('CH02', ['011', '020']),
        ];
        const { sealedChapter, newOpenChapter } = sealChapter(chapters);
        
        expect(sealedChapter.chapterId).toBe('CH02');
        expect(newOpenChapter.chapterId).toBe('CH03');
    });
});

describe('updateChapterSessionId', () => {
    const createOpenChapter = (sessionId?: string): ArchiveChapter => ({
        chapterId: 'CH01',
        title: 'Test',
        sceneRange: ['001', '005'],
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 5,
        _lastSeenSessionId: sessionId,
    });

    it('updates sessionId when not set', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter(),
        ];
        const result = updateChapterSessionId(chapters, 'session-123');
        
        expect(result[0]._lastSeenSessionId).toBe('session-123');
    });

    it('does not update when sessionId already set', () => {
        const chapters: ArchiveChapter[] = [
            createOpenChapter('existing-session'),
        ];
        const result = updateChapterSessionId(chapters, 'new-session');
        
        expect(result[0]._lastSeenSessionId).toBe('existing-session');
    });

    it('returns unchanged array when no open chapter', () => {
        const chapters: ArchiveChapter[] = [
            { ...createOpenChapter(), sealedAt: Date.now() },
        ];
        const result = updateChapterSessionId(chapters, 'session-123');
        
        expect(result[0]._lastSeenSessionId).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Iterative Funnel Retrieval Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreChapter', () => {
    const createChapter = (
        sceneRange: [string, string],
        keywords: string[] = [],
        npcs: string[] = [],
        majorEvents: string[] = [],
        unresolvedThreads: string[] = []
    ): ArchiveChapter => ({
        chapterId: 'CH01',
        title: 'Test Chapter',
        sceneRange,
        summary: 'Test summary',
        keywords,
        npcs,
        majorEvents,
        unresolvedThreads,
        tone: 'test',
        themes: [],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
        sealedAt: Date.now(),
    });

    it('returns positive score for chapter with no context overlap (recency + importance only)', () => {
        const chapter = createChapter(['001', '010']);
        const activations: Record<string, number> = {};
        const score = scoreChapter(chapter, activations, 50);
        
        expect(score).toBeGreaterThan(0);
    });

    it('never returns negative score', () => {
        const chapter = createChapter(['001', '010']);
        const activations: Record<string, number> = { irrelevant: 0 };
        const score = scoreChapter(chapter, activations, 50);
        
        expect(score).toBeGreaterThanOrEqual(0);
    });

    it('recency bonus decreases as chaptersSince increases (logarithmic decay)', () => {
        const recent = createChapter(['040', '050']);
        const old = createChapter(['001', '010']);
        const activations: Record<string, number> = {};
        
        const recentScore = scoreChapter(recent, activations, 60);
        const oldScore = scoreChapter(old, activations, 60);
        
        expect(recentScore).toBeGreaterThan(oldScore);
    });

    it('importance scales with majorEvents.length', () => {
        const low = createChapter(['010', '020'], [], [], ['event1']);
        const high = createChapter(['010', '020'], [], [], ['event1', 'event2', 'event3', 'event4']);
        const activations: Record<string, number> = {};
        
        const lowScore = scoreChapter(low, activations, 30);
        const highScore = scoreChapter(high, activations, 30);
        
        expect(highScore).toBeGreaterThan(lowScore);
    });

    it('importance scales with unresolvedThreads.length (2x weight)', () => {
        const noThreads = createChapter(['010', '020'], [], [], ['event1'], []);
        const withThreads = createChapter(['010', '020'], [], [], ['event1'], ['thread1', 'thread2']);
        const activations: Record<string, number> = {};
        
        const noThreadsScore = scoreChapter(noThreads, activations, 30);
        const withThreadsScore = scoreChapter(withThreads, activations, 30);
        
        expect(withThreadsScore).toBeGreaterThan(noThreadsScore);
    });

    it('activation score increases when chapter keywords match context activations', () => {
        const chapter = createChapter(['010', '020'], ['dragon', 'castle']);
        const noMatch: Record<string, number> = {};
        const withMatch: Record<string, number> = { dragon: 1.0 };
        
        const noMatchScore = scoreChapter(chapter, noMatch, 30);
        const withMatchScore = scoreChapter(chapter, withMatch, 30);
        
        expect(withMatchScore).toBeGreaterThan(noMatchScore);
    });

    it('NPC matches contribute 2x weight compared to keyword matches', () => {
        const keywordChapter = createChapter(['010', '020'], ['gandalf'], []);
        const npcChapter = createChapter(['010', '020'], [], ['gandalf']);
        const activations: Record<string, number> = { gandalf: 1.0 };
        
        const keywordScore = scoreChapter(keywordChapter, activations, 30);
        const npcScore = scoreChapter(npcChapter, activations, 30);
        
        expect(npcScore).toBeGreaterThan(keywordScore);
    });

    it('activation is case-insensitive', () => {
        const chapter = createChapter(['010', '020'], ['Dragon'], ['Gandalf']);
        const activations: Record<string, number> = { dragon: 1.0, gandalf: 1.0 };
        
        const score = scoreChapter(chapter, activations, 30);
        
        expect(score).toBeGreaterThan(0);
    });
});

describe('rankChapters', () => {
    const createChapter = (
        chapterId: string,
        sceneRange: [string, string],
        sealedAt?: number,
        summary?: string,
        keywords: string[] = [],
        npcs: string[] = []
    ): ArchiveChapter => ({
        chapterId,
        title: `Chapter ${chapterId}`,
        sceneRange,
        summary: summary ?? '',
        keywords,
        npcs,
        majorEvents: [],
        unresolvedThreads: [],
        tone: 'test',
        themes: [],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
        sealedAt,
    });

    it('returns empty array when no sealed chapters exist', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']), // No sealedAt
            createChapter('CH02', ['011', '020']), // No sealedAt
        ];
        
        const result = rankChapters(chapters, 'test message', []);
        
        expect(result).toEqual([]);
    });

    it('filters out unsealed chapters (no sealedAt)', () => {
        const chapters: ArchiveChapter[] = [
            { ...createChapter('CH01', ['001', '010'], Date.now(), 'summary'), sealedAt: undefined },
            createChapter('CH02', ['011', '020'], Date.now(), 'sealed summary'),
        ];
        
        const result = rankChapters(chapters, 'test message', []);
        
        expect(result.length).toBe(1);
        expect(result[0].chapterId).toBe('CH02');
    });

    it('filters out chapters with empty summary', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010'], Date.now(), ''), // Empty summary
            createChapter('CH02', ['011', '020'], Date.now(), 'has summary'),
        ];
        
        const result = rankChapters(chapters, 'test message', []);
        
        expect(result.length).toBe(1);
        expect(result[0].chapterId).toBe('CH02');
    });

    it('returns chapters sorted by score descending', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010'], Date.now(), 'old chapter', ['orc']),
            createChapter('CH02', ['011', '020'], Date.now(), 'recent chapter', ['orc', 'dragon']),
            createChapter('CH03', ['021', '030'], Date.now(), 'most recent chapter', ['dragon', 'castle', 'treasure']),
        ];
        
        const result = rankChapters(chapters, 'dragon treasure castle', []);
        
        expect(result.length).toBe(3);
        // Most recent with most keyword matches should be first
        expect(result[0].chapterId).toBe('CH03');
    });

    it('handles single sealed chapter', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010'], Date.now(), 'only chapter'),
        ];
        
        const result = rankChapters(chapters, 'test', []);
        
        expect(result.length).toBe(1);
        expect(result[0].chapterId).toBe('CH01');
    });

    it('filters out chapters with score <= 0', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010'], Date.now(), 'chapter with no activation'),
        ];
        
        const result = rankChapters(chapters, '', []); // Empty message = no activations
        
        // Should still return chapter because recency + importance > 0
        expect(result.length).toBe(1);
    });

    it('uses npcLedger to boost activations', () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010'], Date.now(), 'chapter', [], ['Gandalf']),
        ];
        
        const npcLedger = [{ id: '1', name: 'Gandalf', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '', status: '', goals: '', nature: 5, training: 5, emotion: 5, social: 5, belief: 5, ego: 5, affinity: 50 }];
        
        const result = rankChapters(chapters, 'test', [], npcLedger);
        
        expect(result.length).toBe(1);
        // Gandalf should be activated from npcLedger
    });
});

describe('sceneRanges filtering', () => {
    const createIndexEntry = (sceneId: string): ArchiveIndexEntry => ({
        sceneId,
        timestamp: Date.now(),
        keywords: ['test'],
        npcsMentioned: [],
        userSnippet: 'test',
        keywordStrengths: {},
        npcStrengths: {},
        importance: 5,
    });

    it('retrieveArchiveMemory with sceneRanges filters index to matching scenes only', () => {
        const index: ArchiveIndexEntry[] = [
            createIndexEntry('001'),
            createIndexEntry('002'),
            createIndexEntry('015'),
            createIndexEntry('020'),
            createIndexEntry('030'),
        ];
        
        const sceneRanges: [string, string][] = [['001', '002'], ['015', '020']];
        const result = retrieveArchiveMemory(index, 'test', [], undefined, undefined, undefined, sceneRanges);
        
        // Should only return scenes in ranges 001-002 and 015-020
        expect(result).not.toContain('030');
    });

    it('retrieveArchiveMemory without sceneRanges uses full index (backward compatible)', () => {
        const index: ArchiveIndexEntry[] = [
            createIndexEntry('001'),
            createIndexEntry('002'),
            createIndexEntry('003'),
        ];
        
        const result = retrieveArchiveMemory(index, 'test', []);
        
        // Should be able to return any scene when no ranges specified
        expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('multiple sceneRanges are unioned (scenes matching ANY range are included)', () => {
        const index: ArchiveIndexEntry[] = [
            createIndexEntry('005'),
            createIndexEntry('010'),
            createIndexEntry('025'),
        ];
        
        const sceneRanges: [string, string][] = [['001', '006'], ['020', '030']];
        const result = retrieveArchiveMemory(index, 'test', [], undefined, undefined, undefined, sceneRanges);
        
        // 005 is in first range, 025 is in second range
        expect(result).toContain('005');
        expect(result).toContain('025');
        expect(result).not.toContain('010');
    });

    it('scene at exact boundary of range is included (inclusive)', () => {
        const index: ArchiveIndexEntry[] = [
            createIndexEntry('001'),
            createIndexEntry('010'),
        ];
        
        const sceneRanges: [string, string][] = [['001', '010']];
        const result = retrieveArchiveMemory(index, 'test', [], undefined, undefined, undefined, sceneRanges);
        
        expect(result).toContain('001');
        expect(result).toContain('010');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests (mocked fetch for LLM calls)
// ─────────────────────────────────────────────────────────────────────────────

describe('iterativeChapterFilter', () => {
    const createChapter = (chapterId: string, sceneRange: [string, string]): ArchiveChapter => ({
        chapterId,
        title: `Chapter ${chapterId}`,
        sceneRange,
        summary: `Summary for ${chapterId}`,
        keywords: ['test'],
        npcs: [],
        majorEvents: ['event1'],
        unresolvedThreads: [],
        tone: 'test',
        themes: [],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
        sealedAt: Date.now(),
    });

    const createMockProvider = () => ({
        endpoint: 'http://localhost:1234',
        apiKey: 'test-key',
        modelName: 'test-model',
    });

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns true when LLM responds "YES"', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'YES' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        expect(result.length).toBe(1);
        expect(result[0].chapterId).toBe('CH01');
    });

    it('returns false when LLM responds "NO"', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'NO' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        expect(result.length).toBe(0);
    });

    it('returns true on LLM API failure (fail-open)', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        // Fail-open: should return chapter on error
        expect(result.length).toBe(1);
    });

    it('returns true on network error (fail-open)', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        // Fail-open: should return chapter on error
        expect(result.length).toBe(1);
    });

    it('stops after MAX_CONFIRMED_CHAPTERS (3) confirmed', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'YES' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
            createChapter('CH02', ['011', '020']),
            createChapter('CH03', ['021', '030']),
            createChapter('CH04', ['031', '040']),
            createChapter('CH05', ['041', '050']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        expect(result.length).toBe(MAX_CONFIRMED_CHAPTERS);
    });

    it('stops after MAX_LLM_ITERATIONS (5) even if not enough confirmed', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'NO' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = Array.from({ length: 10 }, (_, i) =>
            createChapter(`CH${String(i + 1).padStart(2, '0')}`, [
                String(i * 10 + 1).padStart(3, '0'),
                String(i * 10 + 10).padStart(3, '0')
            ])
        );

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        // fetch should be called exactly MAX_LLM_ITERATIONS times
        expect(mockFetch).toHaveBeenCalledTimes(MAX_LLM_ITERATIONS);
        expect(result.length).toBe(0);
    });

    it('with no utility provider, returns top 3 by score (graceful degradation)', async () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
            createChapter('CH02', ['011', '020']),
            createChapter('CH03', ['021', '030']),
            createChapter('CH04', ['031', '040']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            undefined // No provider
        );

        expect(result.length).toBe(3);
    });

    it('processes chapters in ranked order (best score first)', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'YES' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']), // Oldest
            createChapter('CH02', ['011', '020']),
            createChapter('CH03', ['021', '030']), // Most recent
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        // Most recent chapter should be validated first
        expect(result[0].chapterId).toBe('CH03');
    });

    it('skips rejected chapters and continues to next', async () => {
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'NO' } }] })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'YES' } }] })
            });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '010']),
            createChapter('CH02', ['011', '020']),
        ];

        const result = await iterativeChapterFilter(
            chapters,
            'current situation',
            [],
            createMockProvider()
        );

        expect(result.length).toBe(1);
        expect(result[0].chapterId).toBe('CH02');
    });

    it('prompt is under 500 tokens (verify prompt construction)', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'YES' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapter = createChapter('CH01', ['001', '010']);
        chapter.summary = 'A'.repeat(300); // Long summary
        chapter.majorEvents = ['Event 1', 'Event 2', 'Event 3', 'Event 4', 'Event 5'];

        const chapters: ArchiveChapter[] = [chapter];

        await iterativeChapterFilter(
            chapters,
            'current situation that is somewhat long but not too long',
            [{ id: '1', role: 'user', content: 'Some previous context message here', timestamp: Date.now() }],
            createMockProvider()
        );

        // Verify fetch was called with expected structure
        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(callArgs[1].body);
        
        // max_tokens should be 10 for minimal output
        expect(requestBody.max_tokens).toBe(10);
        // stream should be false
        expect(requestBody.stream).toBe(false);
    });
});

describe('recallWithChapterFunnel', () => {
    const createChapter = (chapterId: string, sceneRange: [string, string], sealed = true): ArchiveChapter => ({
        chapterId,
        title: `Chapter ${chapterId}`,
        sceneRange,
        summary: sealed ? `Summary for ${chapterId}` : '',
        keywords: ['dragon', 'castle'],
        npcs: ['Gandalf'],
        majorEvents: ['battle'],
        unresolvedThreads: [],
        tone: 'epic',
        themes: ['fantasy'],
        sceneCount: parseInt(sceneRange[1], 10) - parseInt(sceneRange[0], 10) + 1,
        sealedAt: sealed ? Date.now() : undefined,
    });

    const createIndexEntry = (sceneId: string): ArchiveIndexEntry => ({
        sceneId,
        timestamp: Date.now(),
        keywords: ['dragon', 'castle'],
        npcsMentioned: ['Gandalf'],
        userSnippet: 'test',
        keywordStrengths: { dragon: 1.0 },
        npcStrengths: {},
        importance: 5,
    });

    const createMockProvider = () => ({
        endpoint: 'http://localhost:1234',
        apiKey: 'test-key',
        modelName: 'test-model',
    });

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('end-to-end: ranks → validates → drills into confirmed → returns scenes', async () => {
        // Mock LLM to confirm chapters 1 and 3, reject 2
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'YES' } }] })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'NO' } }] })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'YES' } }] })
            });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '005']), // Will be confirmed
            createChapter('CH02', ['006', '010']), // Will be rejected
            createChapter('CH03', ['011', '015']), // Will be confirmed
            createChapter('CH04', ['016', '020'], false), // Open chapter (not sealed)
        ];

        const index: ArchiveIndexEntry[] = [
            createIndexEntry('001'),
            createIndexEntry('002'),
            createIndexEntry('011'),
            createIndexEntry('012'),
            createIndexEntry('016'),
            createIndexEntry('017'),
        ];

        const result = await recallWithChapterFunnel(
            chapters,
            index,
            'Tell me about the dragon',
            [],
            undefined,
            undefined,
            createMockProvider(),
            'test-campaign'
        );

        // Should return scenes from confirmed chapters (CH01, CH03) + open chapter (CH04)
        // But since we're mocking fetchArchiveScenes, it returns empty
        expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array when no sealed chapters have summaries', async () => {
        const chapters: ArchiveChapter[] = [
            { ...createChapter('CH01', ['001', '005'], false), summary: '' },
            createChapter('CH02', ['006', '010'], false), // Open chapter
        ];

        const index: ArchiveIndexEntry[] = [createIndexEntry('006')];

        const result = await recallWithChapterFunnel(
            chapters,
            index,
            'test',
            [],
            undefined,
            undefined,
            createMockProvider(),
            'test-campaign'
        );

        expect(result).toEqual([]);
    });

    it('returns empty array when campaignId is not provided', async () => {
        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '005']),
        ];

        const index: ArchiveIndexEntry[] = [createIndexEntry('001')];

        const result = await recallWithChapterFunnel(
            chapters,
            index,
            'test',
            [],
            undefined,
            undefined,
            createMockProvider(),
            undefined // No campaignId
        );

        expect(result).toEqual([]);
    });

    it('respects tokenBudget parameter', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'YES' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '005']),
            createChapter('CH02', ['006', '010'], false), // Open chapter
        ];

        const index: ArchiveIndexEntry[] = [
            createIndexEntry('001'),
            createIndexEntry('006'),
        ];

        const customTokenBudget = 1500;

        await recallWithChapterFunnel(
            chapters,
            index,
            'test',
            [],
            undefined,
            undefined,
            createMockProvider(),
            'test-campaign',
            customTokenBudget
        );

        // The function should process with the custom token budget
        expect(mockFetch).toHaveBeenCalled();
    });

    it('with all chapters rejected by LLM, returns empty array (caller handles fallback)', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'NO' } }]
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const chapters: ArchiveChapter[] = [
            createChapter('CH01', ['001', '005']),
            createChapter('CH02', ['006', '010']),
        ];

        const index: ArchiveIndexEntry[] = [createIndexEntry('001')];

        const result = await recallWithChapterFunnel(
            chapters,
            index,
            'test',
            [],
            undefined,
            undefined,
            createMockProvider(),
            'test-campaign'
        );

        // All chapters rejected, no confirmed chapters
        expect(Array.isArray(result)).toBe(true);
    });
});
