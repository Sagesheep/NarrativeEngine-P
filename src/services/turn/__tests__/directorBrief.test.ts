/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/llmCall', () => ({
    llmCall: vi.fn(),
    UtilityTimeoutError: class UtilityTimeoutError extends Error {
        elapsedMs: number;
        label: string;
        constructor(elapsedMs: number, label: string) {
            super(`Utility call "${label}" exceeded deadline (${elapsedMs}ms)`);
            this.name = 'UtilityTimeoutError';
            this.elapsedMs = elapsedMs;
            this.label = label;
        }
    },
}));

import { llmCall } from '../../../utils/llmCall';
import {
    runDirectorBrief,
    clearDirectorBriefCache,
    peekDirectorBriefCache,
    buildNpcSummary,
    buildRecentEvents,
    renderDirectorPrompt,
    parseDirectorBrief,
    resolveDirectorProvider,
    lastAssistantContent,
    DIRECTOR_BRIEF_TIMEOUT_MS,
    type DirectorBriefInput,
} from '../directorBrief';
import { tierAllows } from '../aiTier';
import type { EndpointConfig, NPCEntry, TimelineEvent, ChatMessage, Goal } from '../../../types';

const mockLlmCall = vi.mocked(llmCall);

// ── Fixtures ────────────────────────────────────────────────────────────────

function endpoint(name = 'test-model'): EndpointConfig {
    return {
        endpoint: 'http://localhost',
        modelName: name,
    } as any;
}

function npcEntry(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'npc_ingrid',
        name: 'Ingrid',
        aliases: '',
        appearance: '',
        visualProfile: undefined,
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: '',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        pcRelation: 0,
        ...over,
    } as NPCEntry;
}

function activeGoal(text: string, over: Partial<Goal> = {}): Goal {
    return {
        text,
        horizon: 'med',
        tier: 'default',
        base_heat: 1,
        lastAdvancedTick: 0,
        failStreak: 0,
        progress: 0,
        quota: 3,
        state: 'active',
        ...over,
    };
}

function tlEvent(over: Partial<TimelineEvent> = {}): TimelineEvent {
    return {
        id: 'tl_0001',
        sceneId: '001',
        chapterId: 'CH01',
        subject: 'Aldric',
        predicate: 'status',
        object: 'injured',
        summary: 'Aldric was injured.',
        importance: 5,
        source: 'llm',
        ...over,
    };
}

function asstMsg(content: string): ChatMessage {
    return { id: 'a1', role: 'assistant', content, timestamp: 0 };
}

function userMsg(content: string): ChatMessage {
    return { id: 'u1', role: 'user', content, timestamp: 0 };
}

function baseInput(over: Partial<DirectorBriefInput> = {}): DirectorBriefInput {
    return {
        provider: endpoint(),
        dossierText: '- Ingrid: silent for 3 turns while on stage.',
        lastAssistant: 'The fire crackles. Kai sips tea alone.',
        userMessage: 'I ask Ingrid what she knows.',
        npcLedger: [npcEntry()],
        onStageNpcIds: ['npc_ingrid'],
        timeline: [tlEvent()],
        campaignId: 'camp_a',
        getAuxiliaryProvider: undefined,
        signal: undefined,
        ...over,
    };
}

const VALID_BRIEF = `WRITER BRIEF
- [MANDATORY] Ingrid must speak first this scene, naming what she saw.
- [SUGGESTION] Kai's question earns a real answer, not a deflection.`;

describe('runDirectorBrief', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearDirectorBriefCache();
    });

    // ── Tier gating ─────────────────────────────────────────────────────────
    describe('tier gating (lite never calls)', () => {
        it('tierAllows lite/directorBrief is false', () => {
            expect(tierAllows('lite', 'directorBrief')).toBe(false);
        });
        it('tierAllows pro/directorBrief is true', () => {
            expect(tierAllows('pro', 'directorBrief')).toBe(true);
        });
        it('tierAllows max/directorBrief is true', () => {
            expect(tierAllows('max', 'directorBrief')).toBe(true);
        });

        // WO-04b §7: the service itself is ungated — `turnOrchestrator.ts` owns
        // the gate. The focused `runTurn` call-site tests live in
        // `turnOrchestratorDirector.test.ts` (mocking heavy collaborators).
        // The old "lite tier never reaches runDirectorBrief" service test was
        // removed because it asserted the wrong layer: it called
        // `runDirectorBrief` directly and confirmed the LLM was invoked —
        // documenting that the *service* does not gate, which is the inverse of
        // what a tier-gating test should assert. The call-site test now proves
        // the gate at the correct layer.
    });

    // ── Happy path ──────────────────────────────────────────────────────────
    describe('happy path', () => {
        it('returns the parsed brief on a valid LLM response', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBe(VALID_BRIEF);
            expect(mockLlmCall).toHaveBeenCalledTimes(1);
        });

        it('passes the verbatim prompt template to llmCall with slot values inlined', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            await runDirectorBrief(baseInput({
                dossierText: 'DOSSIER',
                lastAssistant: 'LAST_GM',
                userMessage: 'USER_MSG',
                npcLedger: [npcEntry({ name: 'Ingrid', disposition: 'wary guard' })],
                onStageNpcIds: ['npc_ingrid'],
                timeline: [tlEvent({ subject: 'Aldric', summary: 'SUMMARY' })],
            }));
            const prompt = mockLlmCall.mock.calls[0][1] as string;
            // FABLE-AUTHORED template markers (verbatim)
            expect(prompt).toContain('You are the Continuity Director of an ongoing role-played campaign.');
            expect(prompt).toContain('<watchdog_dossier>');
            expect(prompt).toContain('</watchdog_dossier>');
            expect(prompt).toContain('<previous_gm_turn>');
            expect(prompt).toContain('</previous_gm_turn>');
            expect(prompt).toContain('<player_input>');
            expect(prompt).toContain('</player_input>');
            expect(prompt).toContain('<active_npcs>');
            expect(prompt).toContain('</active_npcs>');
            expect(prompt).toContain('<recent_events>');
            expect(prompt).toContain('</recent_events>');
            expect(prompt).toContain('OUTPUT exactly this, nothing else:');
            expect(prompt).toContain('WRITER BRIEF');
            // Slot fills
            expect(prompt).toContain('DOSSIER');
            expect(prompt).toContain('LAST_GM');
            expect(prompt).toContain('USER_MSG');
            expect(prompt).toContain('Ingrid');
            expect(prompt).toContain('SUMMARY');
        });

        it('uses auxiliary provider when one resolves; falls back to story provider', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const aux = endpoint('aux-model');
            await runDirectorBrief(baseInput({
                provider: endpoint('story-model'),
                getAuxiliaryProvider: () => aux,
            }));
            const usedProvider = mockLlmCall.mock.calls[0][0];
            expect((usedProvider as EndpointConfig).modelName).toBe('aux-model');
        });

        it('falls back to story provider when auxiliary has no modelName', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const auxNoModel = { endpoint: 'http://localhost' } as any;
            await runDirectorBrief(baseInput({
                provider: endpoint('story-model'),
                getAuxiliaryProvider: () => auxNoModel,
            }));
            const usedProvider = mockLlmCall.mock.calls[0][0];
            expect((usedProvider as EndpointConfig).modelName).toBe('story-model');
        });

        it('falls back to story provider when getAuxiliaryProvider returns undefined', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            await runDirectorBrief(baseInput({
                provider: endpoint('story-model'),
                getAuxiliaryProvider: () => undefined,
            }));
            const usedProvider = mockLlmCall.mock.calls[0][0];
            expect((usedProvider as EndpointConfig).modelName).toBe('story-model');
        });

        it('uses 120_000ms timeout (DIRECTOR_BRIEF_TIMEOUT_MS)', () => {
            expect(DIRECTOR_BRIEF_TIMEOUT_MS).toBe(120_000);
        });

        it('passes trackingLabel and priority to llmCall (no own thinkingEffort — WO-04b §3)', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            await runDirectorBrief(baseInput());
            const opts = mockLlmCall.mock.calls[0][2] as any;
            expect(opts.trackingLabel).toBe('director-brief');
            expect(opts.priority).toBe('low');
            expect(opts.timeoutMs).toBe(120_000);
            // WO-04b §3: no own `thinkingEffort` property — llmCall inherits the
            // chosen endpoint's configured `thinkingEffort` (llmCall.ts:95).
            expect(Object.prototype.hasOwnProperty.call(opts, 'thinkingEffort')).toBe(false);
            expect(opts.thinkingEffort).toBeUndefined();
        });

        it('forwards the abort signal to llmCall', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const controller = new AbortController();
            await runDirectorBrief(baseInput({ signal: controller.signal }));
            const opts = mockLlmCall.mock.calls[0][2] as any;
            expect(opts.signal).toBe(controller.signal);
        });
    });

    // ── Once-per-input cache ─────────────────────────────────────────────────
    describe('once-per-input cache', () => {
        it('caches the brief and reuses it for the same (campaignId, userMessage)', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const input = baseInput();
            const first = await runDirectorBrief(input);
            const second = await runDirectorBrief(input);
            expect(first).toBe(VALID_BRIEF);
            expect(second).toBe(VALID_BRIEF);
            expect(mockLlmCall).toHaveBeenCalledTimes(1);
        });

        it('re-calls the LLM when userMessage changes', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            mockLlmCall.mockResolvedValueOnce('WRITER BRIEF\n- [SUGGESTION] Proceed naturally.');
            await runDirectorBrief(baseInput({ userMessage: 'first' }));
            await runDirectorBrief(baseInput({ userMessage: 'second' }));
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
        });

        it('re-calls the LLM when campaignId changes', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            mockLlmCall.mockResolvedValueOnce('WRITER BRIEF\n- [SUGGESTION] Proceed naturally.');
            await runDirectorBrief(baseInput({ campaignId: 'camp_a' }));
            await runDirectorBrief(baseInput({ campaignId: 'camp_b' }));
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
        });

        it('caches a null parse-failure result (does not re-spend tokens on swipe)', async () => {
            mockLlmCall.mockResolvedValueOnce('totally not a brief');
            const input = baseInput();
            const first = await runDirectorBrief(input);
            const second = await runDirectorBrief(input);
            expect(first).toBeNull();
            expect(second).toBeNull();
            expect(mockLlmCall).toHaveBeenCalledTimes(1);
        });

        it('clearDirectorBriefCache forces a fresh call', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const input = baseInput();
            await runDirectorBrief(input);
            clearDirectorBriefCache();
            await runDirectorBrief(input);
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
        });

        it('peekDirectorBriefCache exposes the cached entry for tests', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            await runDirectorBrief(baseInput({ campaignId: 'camp_x', userMessage: 'hi' }));
            const entry = peekDirectorBriefCache();
            expect(entry).not.toBeNull();
            expect(entry!.campaignId).toBe('camp_x');
            expect(entry!.userMessage).toBe('hi');
            expect(entry!.brief).toBe(VALID_BRIEF);
        });

        it('lazy-clears when campaignId changes (no explicit clearDirectorBriefCache call)', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            mockLlmCall.mockResolvedValueOnce('WRITER BRIEF\n- [SUGGESTION] Proceed naturally.');
            await runDirectorBrief(baseInput({ campaignId: 'camp_a', userMessage: 'shared' }));
            // Same userMessage but new campaignId — the stale cache entry must
            // not leak across campaigns (invariant 7).
            await runDirectorBrief(baseInput({ campaignId: 'camp_b', userMessage: 'shared' }));
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
        });
    });

    // ── Graceful failures ────────────────────────────────────────────────────
    describe('graceful failures (returns null, never throws)', () => {
        it('returns null on UtilityTimeoutError (timeout)', async () => {
            const { UtilityTimeoutError } = await import('../../../utils/llmCall');
            mockLlmCall.mockRejectedValueOnce(
                new UtilityTimeoutError(120_000, 'director-brief'),
            );
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBeNull();
        });

        it('returns null on AbortError (user abort) without logging a warning', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const abortErr = new DOMException('Aborted', 'AbortError');
            mockLlmCall.mockRejectedValueOnce(abortErr);
            const controller = new AbortController();
            controller.abort();
            const brief = await runDirectorBrief(baseInput({ signal: controller.signal }));
            expect(brief).toBeNull();
            // Should not warn for user abort.
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('returns null on a generic error and logs a warning', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockLlmCall.mockRejectedValueOnce(new Error('API error 500'));
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBeNull();
            expect(warnSpy).toHaveBeenCalledWith('[DirectorBrief] failed:', expect.any(Error));
            warnSpy.mockRestore();
        });

        it('returns null on parse failure (no WRITER BRIEF header in response)', async () => {
            mockLlmCall.mockResolvedValueOnce('Sure! Here is your brief: ...');
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBeNull();
        });

        it('returns null on empty response', async () => {
            mockLlmCall.mockResolvedValueOnce('');
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBeNull();
        });

        it('returns null when no provider resolves (story undefined, no auxiliary resolver)', async () => {
            const brief = await runDirectorBrief(baseInput({ provider: undefined, getAuxiliaryProvider: undefined }));
            expect(brief).toBeNull();
            expect(mockLlmCall).not.toHaveBeenCalled();
        });

        it('returns null when no provider resolves (story undefined, auxiliary returns undefined)', async () => {
            const brief = await runDirectorBrief(baseInput({ provider: undefined, getAuxiliaryProvider: () => undefined }));
            expect(brief).toBeNull();
            expect(mockLlmCall).not.toHaveBeenCalled();
        });

        it('returns null when no provider resolves (story undefined, auxiliary has no modelName)', async () => {
            const auxNoModel = { endpoint: 'http://localhost' } as any;
            const brief = await runDirectorBrief(baseInput({ provider: undefined, getAuxiliaryProvider: () => auxNoModel }));
            expect(brief).toBeNull();
            expect(mockLlmCall).not.toHaveBeenCalled();
        });

        it('strips <think>...</think> tags before parsing', async () => {
            mockLlmCall.mockResolvedValueOnce(
                '<think>let me consider...</think>\nWRITER BRIEF\n- [SUGGESTION] Proceed naturally.',
            );
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBe('WRITER BRIEF\n- [SUGGESTION] Proceed naturally.');
        });

        it('does NOT cache on timeout/abort (swipe retry may succeed)', async () => {
            const { UtilityTimeoutError } = await import('../../../utils/llmCall');
            mockLlmCall.mockRejectedValueOnce(
                new UtilityTimeoutError(120_000, 'director-brief'),
            );
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const input = baseInput();
            const first = await runDirectorBrief(input);
            const second = await runDirectorBrief(input);
            expect(first).toBeNull();
            expect(second).toBe(VALID_BRIEF);
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
        });
    });

    // ── WO-04b §1: failure-total boundary ─────────────────────────────────────
    describe('failure-total boundary (WO-04b §1)', () => {
        it('returns null when getAuxiliaryProvider throws; the promise must not reject', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const throwing = () => { throw new Error('aux resolver exploded'); };
            const brief = await runDirectorBrief(baseInput({ getAuxiliaryProvider: throwing as any }));
            expect(brief).toBeNull();
            // The catch path logs a warning (not an abort, not a timeout).
            expect(warnSpy).toHaveBeenCalledWith('[DirectorBrief] failed:', expect.any(Error));
            // llmCall must never have been reached — the throw happened in preflight.
            expect(mockLlmCall).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('returns null when getAuxiliaryProvider throws AND storyProvider is undefined', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const throwing = () => { throw new Error('aux resolver exploded'); };
            const brief = await runDirectorBrief(baseInput({ provider: undefined, getAuxiliaryProvider: throwing as any }));
            expect(brief).toBeNull();
            expect(mockLlmCall).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('does NOT cache when getAuxiliaryProvider throws (retry may succeed)', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const throwing = () => { throw new Error('aux resolver exploded'); };
            const input = baseInput({ getAuxiliaryProvider: throwing as any });
            const first = await runDirectorBrief(input);
            expect(first).toBeNull();
            // The cache must NOT hold the null — a retry with a non-throwing
            // resolver should reach the LLM. Swap the resolver to a working
            // one and confirm a fresh call.
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const second = await runDirectorBrief({ ...input, getAuxiliaryProvider: () => endpoint('aux') });
            expect(second).toBe(VALID_BRIEF);
            expect(mockLlmCall).toHaveBeenCalledTimes(1);
            // And the cache now holds the successful brief.
            const entry = peekDirectorBriefCache();
            expect(entry?.brief).toBe(VALID_BRIEF);
            warnSpy.mockRestore();
        });

        it('returns null when buildNpcSummary throws (defensive: it does not throw today, but the boundary must hold)', async () => {
            // buildNpcSummary is currently throw-free, but the failure-total
            // boundary must cover it. We force a throw by passing a poisoned
            // ledger whose `archived` getter throws — the filter inside
            // buildNpcSummary will surface the throw.
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const poisonedLedger: NPCEntry[] = [{
                ...npcEntry(),
                get archived() { throw new Error('poisoned archived getter'); },
            } as any];
            const brief = await runDirectorBrief(baseInput({ npcLedger: poisonedLedger }));
            expect(brief).toBeNull();
            expect(mockLlmCall).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('preserves no-warning behavior for an explicitly aborted outer signal when llmCall throws', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const abortErr = new DOMException('Aborted', 'AbortError');
            mockLlmCall.mockRejectedValueOnce(abortErr);
            const controller = new AbortController();
            controller.abort();
            const brief = await runDirectorBrief(baseInput({ signal: controller.signal }));
            expect(brief).toBeNull();
            // User abort — no warning logged.
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it('caches a successful brief even when the auxiliary resolver is used (auxiliary-first path is cached too)', async () => {
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const aux = endpoint('aux-model');
            const input = baseInput({
                provider: undefined,                 // no story provider
                getAuxiliaryProvider: () => aux,    // auxiliary resolves
            });
            const first = await runDirectorBrief(input);
            const second = await runDirectorBrief(input);
            expect(first).toBe(VALID_BRIEF);
            expect(second).toBe(VALID_BRIEF);
            expect(mockLlmCall).toHaveBeenCalledTimes(1);
        });

        // ── WO-04c: parser exceptions inside the failure-total boundary ──
        // parseDirectorBrief calls `raw.replace(/<think[\s\S]*?<\/think>/gi, '')`
        // then `cleaned.search(/WRITER BRIEF/i)` then `cleaned.slice(idx).trim()`.
        // A string-typed test double whose `replace` throws (e.g. a Proxy that
        // rejects on method access) exercises the boundary without changing
        // parseDirectorBrief itself. The thrown exception must enter the
        // existing catch (log once, return null, leave the cache empty).
        it('resolves to null when the parser throws (string-typed double whose replace throws)', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // A string-typed double: behaves like a string for truthiness, but
            // `.replace` throws. `parseDirectorBrief` first checks `if (!raw)`
            // (truthy pass), then calls `raw.replace(...)` → throws.
            const throwingRaw = new String('WRITER BRIEF\n- [MANDATORY] X') as unknown as { replace: () => never };
            (throwingRaw as any).replace = () => { throw new Error('poisoned replace'); };
            mockLlmCall.mockResolvedValueOnce(throwingRaw as any);
            const brief = await runDirectorBrief(baseInput());
            expect(brief).toBeNull();
            // Thrown parser exception logs once as a normal Director failure.
            expect(warnSpy).toHaveBeenCalledWith('[DirectorBrief] failed:', expect.any(Error));
            // The cache must be empty — a thrown parser exception is NOT cached.
            expect(peekDirectorBriefCache()).toBeNull();
            warnSpy.mockRestore();
        });

        it('does NOT cache a thrown parser result — retry with a valid response re-invokes llmCall', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // First call: llmCall resolves to a throwing string double.
            const throwingRaw = new String('WRITER BRIEF\n- [MANDATORY] X') as unknown as { replace: () => never };
            (throwingRaw as any).replace = () => { throw new Error('poisoned replace'); };
            mockLlmCall.mockResolvedValueOnce(throwingRaw as any);
            // Second call: llmCall resolves to a valid brief string.
            mockLlmCall.mockResolvedValueOnce(VALID_BRIEF);
            const input = baseInput();
            const first = await runDirectorBrief(input);
            const second = await runDirectorBrief(input);
            expect(first).toBeNull();
            expect(second).toBe(VALID_BRIEF);
            // The retry actually re-invoked llmCall — proving the thrown parser
            // result was NOT cached. (If it had been cached, the second call
            // would have short-circuited at the cache check and llmCall would
            // have been called only once.)
            expect(mockLlmCall).toHaveBeenCalledTimes(2);
            // The cache now holds the successful brief from the retry.
            expect(peekDirectorBriefCache()?.brief).toBe(VALID_BRIEF);
            warnSpy.mockRestore();
        });
    });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('buildNpcSummary', () => {
    it('returns a placeholder for an empty ledger', () => {
        expect(buildNpcSummary([], undefined)).toBe('(no NPCs in ledger)');
    });

    it('lists on-stage NPCs first with name, disposition, faction, relation band, active goal', () => {
        const ingrid = npcEntry({
            id: 'npc_ingrid',
            name: 'Ingrid',
            disposition: 'wary guard',
            faction: 'City Watch',
            storyRelevance: '',
            pcRelation: 2,
            goalRecords: [activeGoal('Find the mole')],
        });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid']);
        expect(summary).toContain('Ingrid');
        expect(summary).toContain('wary guard');
        expect(summary).toContain('faction: City Watch');
        expect(summary).toContain('PC relation: close');
        expect(summary).toContain('goal: Find the mole');
    });

    it('falls back to legacy affinity for the relation band when pcRelation is undefined', () => {
        const ingrid = npcEntry({ pcRelation: undefined, affinity: 70 });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid']);
        expect(summary).toContain('PC relation: friendly');
    });

    it('omits the relation band when both pcRelation and affinity are missing', () => {
        const ingrid = npcEntry({ pcRelation: undefined, affinity: undefined as any });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid']);
        expect(summary).not.toContain('PC relation');
    });

    it('omits the goal line when no active goals are present', () => {
        const ingrid = npcEntry({
            goalRecords: [activeGoal('Done', { state: 'achieved' })],
        });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid']);
        expect(summary).not.toContain('goal:');
    });

    it('prefers medium-horizon active goals over long-horizon', () => {
        const ingrid = npcEntry({
            goalRecords: [
                activeGoal('long goal', { horizon: 'long' }),
                activeGoal('medium goal', { horizon: 'med' }),
            ],
        });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid']);
        expect(summary).toContain('goal: medium goal');
        expect(summary).not.toContain('long goal');
    });

    it('caps the summary at the token budget (stops adding NPCs when full)', () => {
        // Build 50 NPCs; with a 30-token cap only the first one or two should fit.
        const npcs: NPCEntry[] = Array.from({ length: 50 }, (_, i) =>
            npcEntry({
                id: `npc_${i}`,
                name: `NPC ${i}`,
                disposition: 'guard',
                faction: 'Watch',
                pcRelation: 1,
                goalRecords: [activeGoal('Find the artifact')],
            }),
        );
        const summary = buildNpcSummary(npcs, undefined, 30);
        // The summary must be short — at most a few lines.
        const lines = summary.split('\n');
        expect(lines.length).toBeLessThan(5);
    });

    it('returns a placeholder when no on-stage NPCs fit the budget', () => {
        const ingrid = npcEntry({ id: 'npc_ingrid', name: 'Ingrid', disposition: 'x'.repeat(500) });
        const summary = buildNpcSummary([ingrid], ['npc_ingrid'], 5);
        expect(summary).toContain('no on-stage NPCs fit the budget');
    });
});

describe('buildRecentEvents', () => {
    it('returns a placeholder for an empty timeline', () => {
        expect(buildRecentEvents([])).toBe('(no recent timeline events)');
        expect(buildRecentEvents(undefined)).toBe('(no recent timeline events)');
    });

    it('renders the last 5 events newest-last, with scene id + subject/predicate/object', () => {
        const events: TimelineEvent[] = Array.from({ length: 7 }, (_, i) =>
            tlEvent({
                id: `tl_${i}`,
                sceneId: `00${i}`,
                subject: `S${i}`,
                predicate: 'status',
                object: `O${i}`,
                summary: `Event ${i}`,
            }),
        );
        const out = buildRecentEvents(events);
        const lines = out.split('\n');
        expect(lines).toHaveLength(5);
        // Last 5 = events 2..6 (slice(-5)).
        expect(lines[0]).toContain('S2');
        expect(lines[4]).toContain('S6');
        // Each line has the [sceneId] prefix and the S/P/O: summary shape.
        expect(lines[0]).toMatch(/^- \[002\] S2 status O2: Event 2/);
    });

    it('respects the count parameter', () => {
        const events: TimelineEvent[] = Array.from({ length: 10 }, (_, i) =>
            tlEvent({ id: `tl_${i}`, sceneId: `00${i}`, subject: `S${i}`, summary: `E${i}` }),
        );
        const out = buildRecentEvents(events, 3);
        expect(out.split('\n')).toHaveLength(3);
    });
});

describe('renderDirectorPrompt', () => {
    it('inlines every slot value verbatim', () => {
        const prompt = renderDirectorPrompt({
            dossierText: 'DOSSIER',
            lastAssistant: 'LAST_GM',
            userMessage: 'USER_MSG',
            npcSummary: 'NPC_SUMMARY',
            recentEvents: 'EVENTS',
        });
        expect(prompt).toContain('<watchdog_dossier>\nDOSSIER\n</watchdog_dossier>');
        expect(prompt).toContain('<previous_gm_turn>\nLAST_GM\n</previous_gm_turn>');
        expect(prompt).toContain('<player_input>\nUSER_MSG\n</player_input>');
        expect(prompt).toContain('<active_npcs>\nNPC_SUMMARY\n</active_npcs>');
        expect(prompt).toContain('<recent_events>\nEVENTS\n</recent_events>');
    });

    it('contains the continuity-first consideration steps and output contract', () => {
        const prompt = renderDirectorPrompt({
            dossierText: '', lastAssistant: '', userMessage: '', npcSummary: '', recentEvents: '',
        });
        expect(prompt).toContain('1. World-law and continuity');
        expect(prompt).toContain('2. Fair adjudication');
        expect(prompt).toContain('3. Watchdog triage');
        expect(prompt).toContain('4. Restraint');
        expect(prompt).toContain('Do not turn a clever, lawful, or tactically sound player action into a moral failing');
        expect(prompt).toContain('do not schedule disagreement, decentering, callbacks, staleness changes, twists, or emotional escalation');
        // Output contract.
        expect(prompt).toContain('Each directive is one imperative line naming specific characters.');
        expect(prompt).toContain('If nothing is needed, output "WRITER BRIEF" followed by "- [SUGGESTION] Proceed naturally."');
    });
});

describe('parseDirectorBrief', () => {
    it('returns the brief starting at WRITER BRIEF header', () => {
        const out = parseDirectorBrief('WRITER BRIEF\n- [MANDATORY] X\n- [SUGGESTION] Y');
        expect(out).toBe('WRITER BRIEF\n- [MANDATORY] X\n- [SUGGESTION] Y');
    });

    it('strips <think> tags before extracting', () => {
        const out = parseDirectorBrief('<think>reasoning</think>\nWRITER BRIEF\n- [SUGGESTION] Z');
        expect(out).toBe('WRITER BRIEF\n- [SUGGESTION] Z');
    });

    it('returns null when WRITER BRIEF header is absent', () => {
        expect(parseDirectorBrief('Here is your brief: ...')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(parseDirectorBrief('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
        expect(parseDirectorBrief('   \n\n  ')).toBeNull();
    });

    it('tolerates a preamble before the WRITER BRIEF header', () => {
        const out = parseDirectorBrief('Sure! Here you go:\nWRITER BRIEF\n- [MANDATORY] A');
        expect(out).toBe('WRITER BRIEF\n- [MANDATORY] A');
    });
});

describe('resolveDirectorProvider', () => {
    // WO-04b §2: the auxiliary resolver is called even when storyProvider is
    // undefined — a preset with only an auxiliary endpoint still resolves a
    // Director provider. Returns undefined only when both are absent/invalid.
    it('returns the auxiliary provider when storyProvider is undefined and auxiliary has a modelName', () => {
        const aux = endpoint('aux');
        expect(resolveDirectorProvider(undefined, () => aux)).toBe(aux);
    });

    it('returns undefined when storyProvider is undefined and auxiliary returns undefined', () => {
        expect(resolveDirectorProvider(undefined, () => undefined)).toBeUndefined();
    });

    it('returns undefined when both storyProvider and auxiliary are undefined', () => {
        expect(resolveDirectorProvider(undefined, undefined)).toBeUndefined();
    });

    it('returns the auxiliary provider when it has a modelName', () => {
        const story = endpoint('story');
        const aux = endpoint('aux');
        expect(resolveDirectorProvider(story, () => aux)).toBe(aux);
    });

    it('falls back to story provider when auxiliary returns undefined', () => {
        const story = endpoint('story');
        expect(resolveDirectorProvider(story, () => undefined)).toBe(story);
    });

    it('falls back to story provider when auxiliary has no modelName', () => {
        const story = endpoint('story');
        const auxNoModel = { endpoint: 'http://x' } as any;
        expect(resolveDirectorProvider(story, () => auxNoModel)).toBe(story);
    });

    it('falls back to story provider when no getAuxiliaryProvider is passed', () => {
        const story = endpoint('story');
        expect(resolveDirectorProvider(story, undefined)).toBe(story);
    });
});

describe('lastAssistantContent', () => {
    it('returns the last assistant message content', () => {
        const msgs = [asstMsg('old'), userMsg('hi'), asstMsg('new')];
        expect(lastAssistantContent(msgs)).toBe('new');
    });

    it('skips user/tool messages and finds the last assistant one', () => {
        const msgs = [asstMsg('real'), userMsg('after')];
        expect(lastAssistantContent(msgs)).toBe('real');
    });

    it('returns empty string when there are no assistant messages', () => {
        expect(lastAssistantContent([userMsg('only user')])).toBe('');
    });

    it('returns empty string for empty messages', () => {
        expect(lastAssistantContent([])).toBe('');
    });
});