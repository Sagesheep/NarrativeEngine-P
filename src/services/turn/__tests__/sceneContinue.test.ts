import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildSceneContinueDirective,
    buildSceneContinueRequest,
    computeLastSegmentWordCount,
    buildMergedContinueView,
    generateSceneContinuation,
    MAX_CONTINUE_TOOL_CALLS,
    SCENE_CONTINUE_DIVIDER,
} from '../sceneContinue';
import { extractAndStripSceneStakes } from '../sceneStakesTag';
import type { OpenAIMessage } from '../../llm/llmService';

// ── Mocks ──────────────────────────────────────────────────────────────

const sendMessageMock = vi.fn();
vi.mock('../../chatEngine', () => ({
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
    buildPayload: vi.fn(),
}));

const sanitizeMock = vi.fn((p: unknown[]) => [...(p as unknown[])]); // identity by default
vi.mock('../../lib/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown[]) => sanitizeMock(p),
}));

const resolveToolHandlerMock = vi.fn();
vi.mock('../toolRegistry', () => ({
    resolveToolHandler: (name: string) => resolveToolHandlerMock(name),
}));

const getToolDefinitionsMock = vi.fn(() => [
    { type: 'function', function: { name: 'query_campaign_lore' } },
    { type: 'function', function: { name: 'roll_dice' } },
    { type: 'function', function: { name: 'propose_inventory_change' } },
    { type: 'function', function: { name: 'update_scene_notebook' } },
]);
vi.mock('../toolHandlers', () => ({
    getToolDefinitions: () => getToolDefinitionsMock(),
}));

beforeEach(() => {
    sendMessageMock.mockReset();
    sanitizeMock.mockImplementation((p: unknown[]) => [...(p as unknown[])]);
    resolveToolHandlerMock.mockReset();
    getToolDefinitionsMock.mockReset();
    getToolDefinitionsMock.mockImplementation(() => [
        { type: 'function', function: { name: 'query_campaign_lore' } },
        { type: 'function', function: { name: 'roll_dice' } },
        { type: 'function', function: { name: 'propose_inventory_change' } },
        { type: 'function', function: { name: 'update_scene_notebook' } },
    ]);
});

// ── Helpers ────────────────────────────────────────────────────────────

function fakeProvider(): unknown {
    return { id: 'p1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' };
}

// Simulate sendMessage: invokes onChunk for each chunk (cumulative like the real
// llmService does — `fullText += delta; onChunk(fullText)`) then onDone with the
// final text + optional toolCall. If chunks is omitted, onChunk is not called.
function simulateSend(opts: {
    chunks?: string[];
    finalText?: string;
    toolCall?: { id: string; name: string; arguments: string };
    reasoning?: string;
}) {
    return function mocked(_provider: unknown, _msgs: unknown[], onChunk: (t: string) => void, onDone: (t: string, tc?: { id: string; name: string; arguments: string }, r?: string) => void) {
        let cumulative = '';
        for (const c of opts.chunks ?? []) {
            cumulative += c;
            onChunk(cumulative);
        }
        onDone(opts.finalText ?? '', opts.toolCall, opts.reasoning);
    };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('buildSceneContinueDirective', () => {
    it('substitutes {N} with targetWords', () => {
        const out = buildSceneContinueDirective({ pcName: 'Rin', targetWords: 120, allowDiceTool: true });
        // Floor-collapsed range (N ≤ ~170): both bounds hit the 120 floor.
        expect(out).toMatch(/roughly 120 words/);
    });

    it('targets 70–100% of the last segment with no ceiling', () => {
        const out = buildSceneContinueDirective({ pcName: 'Rin', targetWords: 1000, allowDiceTool: false });
        expect(out).toMatch(/between 700 and 1000 words/);
    });

    it('uses the named-PC line when pcName is non-empty', () => {
        const out = buildSceneContinueDirective({ pcName: 'Aldric', targetWords: 50, allowDiceTool: false });
        expect(out).toMatch(/The player character is Aldric\./);
        expect(out).toMatch(/End your reply at the point where Aldric would next need to choose/);
    });

    it('uses the generic PC line when pcName is empty (NORMAL case)', () => {
        const out = buildSceneContinueDirective({ pcName: '', targetWords: 50, allowDiceTool: false });
        expect(out).not.toMatch(/The player character is/);
        expect(out).toMatch(/Do not act, speak, or decide for the player's character/);
        expect(out).toMatch(/End your reply at the point where the player would next need to choose/);
    });

    it('uses the dice-allow line when allowDiceTool is true', () => {
        const out = buildSceneContinueDirective({ pcName: '', targetWords: 50, allowDiceTool: true });
        expect(out).toMatch(/you may call roll_dice/);
        expect(out).not.toMatch(/Do not initiate or invent dice rolls/);
    });

    it('uses the no-dice line when allowDiceTool is false', () => {
        const out = buildSceneContinueDirective({ pcName: '', targetWords: 50, allowDiceTool: false });
        expect(out).toMatch(/Do not initiate or invent dice rolls; narrate only from results already in history\./);
    });

    it('contains the locked scene-continue header and forbidden-restart rule', () => {
        const out = buildSceneContinueDirective({ pcName: '', targetWords: 50, allowDiceTool: false });
        expect(out).toMatch(/SCENE CONTINUE/);
        expect(out).toMatch(/Pick up exactly where your previous reply ended/);
        expect(out).toMatch(/Do not open a new scene, skip time/);
        expect(out).toMatch(/Do not emit a Scene header\./);
    });
});

describe('buildSceneContinueRequest', () => {
    it('sanitizes basePayload without mutating the input array (R3)', () => {
        const base: OpenAIMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' },
        ];
        const result = buildSceneContinueRequest({
            basePayload: base,
            assistantText: 'GM reply here.',
            directive: 'directive text',
            allowDiceTool: false,
        });
        // Original untouched
        expect(base).toHaveLength(2);
        // Result is a new array with assistant + user-role directive appended.
        // Directive must be user-role: Claude/Gemini converters hoist system
        // messages to the top-level system block, which strands a trailing
        // system directive far from the tail (the "duplicate request" bug).
        expect(result).not.toBe(base);
        expect(result).toHaveLength(4);
        expect(result[2]).toEqual({ role: 'assistant', content: 'GM reply here.' });
        expect(result[3]).toEqual({ role: 'user', content: 'directive text' });
    });

    it('omits the assistant message when assistantText is null (fallback mode)', () => {
        const base: OpenAIMessage[] = [{ role: 'system', content: 'sys' }];
        const result = buildSceneContinueRequest({
            basePayload: base,
            assistantText: null,
            directive: 'd',
            allowDiceTool: false,
        });
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ role: 'system', content: 'sys' });
        expect(result[1]).toEqual({ role: 'user', content: 'd' });
    });

    it('omits the directive message when directive is empty (fallback — directive already in payload)', () => {
        const base: OpenAIMessage[] = [{ role: 'user', content: 'directive-already-there' }];
        const result = buildSceneContinueRequest({
            basePayload: base,
            assistantText: null,
            directive: '',
            allowDiceTool: false,
        });
        expect(result).toHaveLength(1);
    });

    it('appends in order: base, assistant, user-directive (snapshot mode)', () => {
        const base: OpenAIMessage[] = [{ role: 'user', content: 'q' }];
        const result = buildSceneContinueRequest({
            basePayload: base,
            assistantText: 'a',
            directive: 'd',
            allowDiceTool: false,
        });
        expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    });
});

describe('computeLastSegmentWordCount — R6 (last segment only)', () => {
    it('counts the whole content when no divider present', () => {
        expect(computeLastSegmentWordCount('one two three four')).toBe(4);
    });

    it('counts only the last segment after a divider', () => {
        const content = `First segment here.${SCENE_CONTINUE_DIVIDER}Second segment words only.`;
        expect(computeLastSegmentWordCount(content)).toBe(4);
    });

    it('counts only the last segment after multiple dividers (repeated continues compose)', () => {
        const content = `A${SCENE_CONTINUE_DIVIDER}B${SCENE_CONTINUE_DIVIDER}C${SCENE_CONTINUE_DIVIDER}one two three`;
        expect(computeLastSegmentWordCount(content)).toBe(3);
    });

    it('returns 0 for an empty last segment', () => {
        expect(computeLastSegmentWordCount(`text${SCENE_CONTINUE_DIVIDER}`)).toBe(0);
    });
});

describe('buildMergedContinueView', () => {
    it('merges with the divider when preContinueContent is non-empty', () => {
        const merged = buildMergedContinueView('pre', 'partial');
        expect(merged).toBe(`pre${SCENE_CONTINUE_DIVIDER}partial`);
    });

    it('returns just the partial when preContinueContent is empty', () => {
        expect(buildMergedContinueView('', 'partial')).toBe('partial');
    });
});

describe('generateSceneContinuation — post-processing (R7: strip before merge)', () => {
    it('strips the Scene header from the continuation text', async () => {
        sendMessageMock.mockImplementation(simulateSend({
            finalText: 'Scene #42 | The tavern door creaks open.',
        }));
        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'previous reply',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, () => {});
        expect(result.text).toBe('The tavern door creaks open.');
    });

    it('strips the [[SCENE_STAKES]] tag and returns the parsed stakes', async () => {
        const tagText = 'The guard raises an alarm.\n[[SCENE_STAKES: tense]]';
        sendMessageMock.mockImplementation(simulateSend({ finalText: tagText }));
        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, () => {});
        // Cross-check: extractAndStripSceneStakes on the raw text returns 'tense'
        const { stakes: refStakes } = extractAndStripSceneStakes(tagText);
        expect(refStakes).toBe('tense');
        expect(result.stakes).toBe('tense');
        expect(result.text).not.toContain('SCENE_STAKES');
        expect(result.text).toMatch(/The guard raises an alarm\./);
    });

    it('returns stakes === null when no stakes tag was present', async () => {
        sendMessageMock.mockImplementation(simulateSend({
            finalText: 'A quiet evening passes uneventfully.',
        }));
        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, () => {});
        expect(result.stakes).toBeNull();
        expect(result.text).toBe('A quiet evening passes uneventfully.');
    });
});

describe('generateSceneContinuation — tool loop (§5)', () => {
    it('resolves a roll_dice tool call and re-sends, then returns the final text', async () => {
        // First call: model emits a tool_call for roll_dice.
        sendMessageMock.mockImplementationOnce(simulateSend({
            finalText: 'The guard spots you.',
            toolCall: { id: 'tc1', name: 'roll_dice', arguments: '{"dice":"1d20","reason":"Stealth"}' },
        }));
        // Second call: model emits final narrative using the roll result.
        sendMessageMock.mockImplementationOnce(simulateSend({
            finalText: 'You slip past unnoticed.',
        }));

        resolveToolHandlerMock.mockImplementation(() => () => ({
            toolResult: JSON.stringify({ result: 15, breakdown: '[15]' }),
            accumulation: 'append',
            traceResult: true,
        }));

        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [{ role: 'user', content: 'init' }],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: true,
            combatModeActive: false,
        }, () => {});

        // Two send calls (initial + post-tool).
        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        // Tool exchange folded into the SECOND request payload (transient — not into basePayload).
        const secondCallPayload = sendMessageMock.mock.calls[1][1] as OpenAIMessage[];
        expect(secondCallPayload.some(m => m.role === 'tool' && m.name === 'roll_dice')).toBe(true);
        expect(secondCallPayload.some(m => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls))).toBe(true);
        // Final text combines the pre-tool preamble + final text.
        expect(result.text).toContain('You slip past unnoticed.');
    });

    it('caps tool calls at MAX_CONTINUE_TOOL_CALLS and treats further output as final', async () => {
        // Always returns a tool call — should fire MAX_CONTINUE_TOOL_CALLS times then
        // the (MAX+1)-th call's finalText is treated as final.
        sendMessageMock.mockImplementation(simulateSend({
            finalText: 'preamble ',
            toolCall: { id: 'tc', name: 'roll_dice', arguments: '{"dice":"1d6"}' },
        }));
        // Override the LAST call to return plain text (no tool call) so the loop can terminate.
        let calls = 0;
        sendMessageMock.mockImplementation((_p, _m, _onChunk, onDone) => {
            calls++;
            if (calls > MAX_CONTINUE_TOOL_CALLS) {
                onDone('final narrative.', undefined);
            } else {
                onDone('preamble ', { id: `tc${calls}`, name: 'roll_dice', arguments: '{"dice":"1d6"}' });
            }
        });

        resolveToolHandlerMock.mockImplementation(() => () => ({
            toolResult: '{}',
            accumulation: 'append',
            traceResult: false,
        }));

        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: null,
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: true,
            combatModeActive: false,
        }, () => {});

        // Should have stopped at MAX_CONTINUE_TOOL_CALLS + 1 (one final plain-text send).
        expect(calls).toBe(MAX_CONTINUE_TOOL_CALLS + 1);
        expect(result.text).toContain('final narrative');
    });

    it('does NOT offer tools when allowDiceTool is false', async () => {
        sendMessageMock.mockImplementation(simulateSend({ finalText: 'no tools here' }));
        await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, () => {});
        const toolsArg = sendMessageMock.mock.calls[0][5];
        expect(toolsArg).toBeUndefined();
    });

    it('offers ONLY the roll_dice tool when allowDiceTool is true (filtered from the full tool set)', async () => {
        sendMessageMock.mockImplementation(simulateSend({ finalText: 'with tools' }));
        await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: true,
            combatModeActive: false,
        }, () => {});
        const toolsArg = sendMessageMock.mock.calls[0][5] as Array<{ function: { name: string } }>;
        expect(toolsArg).toBeDefined();
        expect(toolsArg.map(t => t.function.name)).toEqual(['roll_dice']);
    });
});

describe('generateSceneContinuation — onChunk streaming', () => {
    it('passes the merged partial text (accumulated + current chunk) to onChunk', async () => {
        sendMessageMock.mockImplementation(simulateSend({
            chunks: ['Hello ', 'world.'],
            finalText: 'Hello world.',
        }));
        const seen: string[] = [];
        await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, (p) => seen.push(p));
        expect(seen).toEqual(['Hello ', 'Hello world.']);
    });
});

describe('generateSceneContinuation — abort handling', () => {
    it('rejects with AbortError when the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
            abortSignal: ac.signal,
        }, () => {})).rejects.toThrow('Aborted');
    });
});

describe('Merge semantics (R6 + stakes override)', () => {
    it('a second continue measures targetWords from only the last segment', () => {
        const firstContent = 'Original GM reply.';
        const afterFirst = buildMergedContinueView(firstContent, 'Continuation passage with several words.');
        // Second continue should count only the segment after the last divider.
        const words = computeLastSegmentWordCount(afterFirst);
        expect(words).toBe(5); // "Continuation passage with several words."
        // And the divider was inserted correctly
        expect(afterFirst).toContain(SCENE_CONTINUE_DIVIDER);
    });

    it('reasoningContent from the continuation is discarded (R4)', async () => {
        // The handler signature only passes (finalText, toolCall, reasoningContent) — verify
        // our service drops the reasoning parameter (we only forward (finalText, toolCall)).
        sendMessageMock.mockImplementation(simulateSend({
            finalText: 'no reasoning carried',
            reasoning: 'this should be discarded',
        }));
        const result = await generateSceneContinuation({
            provider: fakeProvider() as never,
            basePayload: [],
            assistantText: 'prev',
            directive: 'd',
            temperature: 0.7,
            allowDiceTool: false,
            combatModeActive: false,
        }, () => {});
        // No field on the result carries reasoning — confirm shape is { text, stakes } only.
        expect(Object.keys(result).sort()).toEqual(['stakes', 'text']);
    });
});