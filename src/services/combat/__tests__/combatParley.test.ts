import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ messages: Array<{ role: string; content: string }>; label: unknown; tools: unknown }> = [];

vi.mock('../../chatEngine', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../chatEngine')>();
    return {
        ...actual,
        sendMessage: vi.fn((_p: unknown, messages: Array<{ role: string; content: string }>, _chunk: unknown, onDone: (t: string) => void, _err: unknown, tools: unknown, _c: unknown, _s: unknown, _t: unknown, label: unknown) => {
            sent.push({ messages, label, tools });
            onDone('"Not today," the captain says.');
            return Promise.resolve();
        }),
    };
});

vi.mock('../../llm/apiClient', () => ({
    api: {
        archive: { append: vi.fn(async () => ({ sceneId: '007' })), getIndex: vi.fn(async () => []) },
        timeline: { get: vi.fn(async () => []) },
        chapters: { list: vi.fn(async () => []) },
    },
}));

import { applyAction, buildPcCombatant, createCombat, currentActorId, parleyDc, PARLEY_DC, runEngineTurns } from '@narrative/engine';
import type { CombatState, ParleyRating } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { resetCombatNarrationForTests, rewriteCombatBeat, waitForCombatNarration } from '../combatNarration';
import { finishCombat, setCombatStepDelay } from '../combatController';
import {
    buildRatingBlock, parseParleyRating, PARLEY_RATING_INSTRUCTION, resetParleyForTests, resumeParley, submitParley,
} from '../combatParley';
import type { ParleyDeps } from '../combatParley';
import { isCombatMessage, isRewindDeleteLocked } from '../combatLocks';
import type { CombatSession, CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 14 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function pcTurnSession(seed = 3): CombatSession {
    const pc = buildPcCombatant({ name: 'Kira', sheet });
    const created = createCombat({ id: `fight-${seed}`, combatants: [{ name: 'Captain', side: 'enemy', tier: 'elite' }, { name: 'Thug', side: 'enemy', tier: 'grunt' }] }, pc, seed);
    const engine = runEngineTurns(created.state);
    return { state: engine.state, log: [...created.events, ...engine.events], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

function load(session: CombatSession, apiFormat?: string): void {
    const base = useAppStore.getState().context;
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'Blades out.', timestamp: 1 }],
        context: { ...base, combatModeActive: true, combatSheet: sheet, combatConfig: { ...base.combatConfig, narrationCadence: 'end' }, characterProfileData: { ...base.characterProfileData, name: 'Kira', hp: { current: 20, max: 20 } }, combatTelemetry: undefined, combatAftermath: undefined } as GameContext,
        combatSession: session,
        combatBusy: false,
        pipelinePhase: 'idle',
        getActiveStoryEndpoint: () => ({ endpoint: 'http://x', apiKey: '', modelName: 'm', ...(apiFormat ? { apiFormat } : {}) }) as never,
        getActiveUtilityEndpoint: () => null as never,
    });
}

function deps(tool: ParleyDeps['callTool'], json: ParleyDeps['callJson'] = async () => { throw new Error('no fallback'); }): ParleyDeps & { tool: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const t = vi.fn(tool);
    const j = vi.fn(json);
    return { callTool: t, callJson: j, tool: t, json: j };
}

const toolSays = (args: unknown): ParleyDeps['callTool'] => async () => ({ name: 'rate_parley', arguments: typeof args === 'string' ? args : args as Record<string, unknown> });

function store(): ReturnType<typeof useAppStore.getState> {
    return useAppStore.getState();
}

function seedWhere(rating: ParleyRating, wantSuccess: boolean, intent: 'ceasefire' | 'let_go' | 'surrender_demand' | 'bargain' = 'ceasefire'): number {
    for (let seed = 1; seed < 400; seed++) {
        const s = pcTurnSession(seed);
        const pcId = currentActorId(s.state) as string;
        if (s.state.combatants[pcId]?.side !== 'player') continue;
        const r = applyAction(s.state, { type: 'parley', actorId: pcId, intent, rating });
        if (r.state.parleys?.[0]?.success === wantSuccess) return seed;
    }
    throw new Error('no seed');
}

beforeEach(() => {
    sent.length = 0;
    setCombatStepDelay(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
    resetCombatNarrationForTests();
    resetParleyForTests();
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('parley rating', () => {
    it.each(['easy', 'even', 'hard'] as const)('a %s rating from the tool call sets the DC; the model supplies no number', async (rating) => {
        const session = pcTurnSession(seedWhere(rating, false));
        load(session);
        const expected = parleyDc(session.state, rating);
        const d = deps(toolSays({ intent: 'ceasefire', rating, speaker: 'Captain', dc: 1, outcome: 'success', roll: 20 }));
        expect(await submitParley('Lay down your arms and live.', d)).toBe(true);
        await waitForCombatNarration();
        const s = store().combatSession as CombatSession;
        const record = s.state.parleys?.[0];
        expect(record?.rating).toBe(rating);
        expect(record?.dc).toBe(expected);
        expect(record?.dc).toBe(PARLEY_DC[rating]);
        expect(record?.success).toBe(false);
        expect(d.tool).toHaveBeenCalledTimes(1);
        expect(store().context.combatTelemetry?.parleySources?.tool).toBe(1);
    });

    it('accepts arguments as a JSON string and validates the speaker', async () => {
        const session = pcTurnSession(seedWhere('hard', false));
        load(session);
        await submitParley('You fight for coin. I pay better.', deps(toolSays('{"intent":"bargain","rating":"hard","speaker":"Nobody"}')));
        await waitForCombatNarration();
        const record = store().combatSession?.state.parleys?.[0];
        expect(record?.intent).toBe('bargain');
        const speaker = record?.speakerId ? store().combatSession?.state.combatants[record.speakerId] : undefined;
        expect(speaker?.side).toBe('enemy');
        expect(speaker?.status).toBe('up');
    });

    it('falls back to a utility JSON call when no tool call comes back', async () => {
        load(pcTurnSession(seedWhere('hard', false)));
        const d = deps(async () => null, async () => 'Sure: {"intent":"taunt","rating":"easy","speaker":"Thug"}');
        await submitParley('Your mother was a goat.', d);
        await waitForCombatNarration();
        const record = store().combatSession?.state.parleys?.[0];
        expect(record).toMatchObject({ intent: 'taunt', rating: 'easy', effect: 'none' });
        expect(d.json).toHaveBeenCalledTimes(1);
        expect(store().context.combatTelemetry?.parleySources?.json).toBe(1);
    });

    it('rates hard with intent other when both the tool call and the fallback fail', async () => {
        load(pcTurnSession(seedWhere('hard', false)));
        await submitParley('Hm.', deps(async () => null, async () => 'no json here'));
        await waitForCombatNarration();
        expect(store().combatSession?.state.parleys?.[0]).toMatchObject({ intent: 'other', rating: 'hard', effect: 'none' });
        expect(store().context.combatTelemetry?.parleySources?.default).toBe(1);
    });

    it('skips the tool call for Ollama-format providers', async () => {
        load(pcTurnSession(seedWhere('hard', false)), 'ollama');
        const d = deps(toolSays({ intent: 'ceasefire', rating: 'easy', speaker: 'Captain' }), async () => '{"intent":"ceasefire","rating":"hopeless","speaker":"Captain"}');
        await submitParley('Stop.', d);
        await waitForCombatNarration();
        expect(d.tool).not.toHaveBeenCalled();
        expect(store().combatSession?.state.parleys?.[0]).toMatchObject({ rating: 'hopeless', effect: 'failed' });
    });

    it('rates hopeless without any model call when only summoned enemies remain', async () => {
        const session = pcTurnSession(seedWhere('hard', false));
        const state: CombatState = { ...session.state, combatants: { ...session.state.combatants } };
        for (const c of Object.values(state.combatants)) if (c.side === 'enemy') state.combatants[c.id] = { ...c, summonerId: 'someone' };
        load({ ...session, state });
        const d = deps(toolSays({ intent: 'ceasefire', rating: 'easy', speaker: 'Captain' }), async () => '{}');
        await submitParley('Go away.', d);
        await waitForCombatNarration();
        expect(d.tool).not.toHaveBeenCalled();
        expect(d.json).not.toHaveBeenCalled();
        expect(store().context.combatTelemetry?.parleyRatings).toEqual({ hopeless: 1 });
        expect(store().context.combatTelemetry?.parleySources).toEqual({ engine: 1 });
    });

    it('parses lenient and strict rating JSON and rejects unknown values', () => {
        expect(parseParleyRating({ intent: 'Let Go', rating: 'EASY', speaker: ' Vey ' })).toEqual({ intent: 'let_go', rating: 'easy', speaker: 'Vey' });
        expect(parseParleyRating('{"intent":"ceasefire","rating":"certain"}')).toBeNull();
        expect(parseParleyRating('nothing')).toBeNull();
    });

    it('builds the rating prompt with the roster, the situation, earlier attempts and the player\'s words', () => {
        const session = { ...pcTurnSession(2), parleyLines: [{ attemptId: 'old', words: 'Please stop.' }, { attemptId: 'now', words: 'Last chance.' }] };
        const block = buildRatingBlock(session, 'Last chance.', 'now');
        expect(block).toContain('Enemies:');
        expect(block).toContain('- Captain: elite');
        expect(block).toContain('Situation: ');
        expect(block).toContain('"Please stop."');
        expect(block).toContain('says: "Last chance."');
        expect(PARLEY_RATING_INSTRUCTION).toContain('Refusing is the default.');
    });
});

describe('parley flow', () => {
    it('posts the line, then the reply, spends the action, and locks the line against edits', async () => {
        load(pcTurnSession(seedWhere('hard', false)));
        await submitParley('Walk away and nobody else dies.', deps(toolSays({ intent: 'ceasefire', rating: 'hard', speaker: 'Captain' })));
        await waitForCombatNarration();
        const msgs = store().messages;
        const line = msgs.find(m => m.combatParley?.part === 'line');
        const reply = msgs.find(m => m.combatParley?.part === 'reply');
        expect(line?.role).toBe('user');
        expect(reply?.role).toBe('assistant');
        expect(msgs.indexOf(line!)).toBeLessThan(msgs.indexOf(reply!));
        expect(reply?.content).toContain('Not today');
        expect(reply?.combatBeat?.block).toContain('Engine result: The enemies refuse.');
        expect(isCombatMessage(line!)).toBe(true);
        expect(isRewindDeleteLocked(line!, null, false)).toBe(true);
        expect(store().combatSession?.parley).toBeUndefined();
        const rating = sent.find(s => s.label === 'combat-parley-rate');
        expect(rating).toBeUndefined();
        const replyCall = sent.find(s => s.label === 'combat-parley-reply');
        expect(replyCall?.tools).toBeUndefined();
        const last = replyCall?.messages[replyCall.messages.length - 1];
        expect(last?.content).toContain('[PARLEY REPLY');
        expect(replyCall?.messages.some(m => m.content === 'Walk away and nobody else dies.')).toBe(false);
    });

    it('ends a successful ceasefire as a truce only after the reply is posted', async () => {
        load(pcTurnSession(seedWhere('easy', true)));
        await submitParley('We both bleed for nothing. Stop.', deps(toolSays({ intent: 'ceasefire', rating: 'easy', speaker: 'Captain' })));
        await finishCombat();
        const msgs = store().messages;
        const reply = msgs.findIndex(m => m.combatParley?.part === 'reply');
        const result = msgs.findIndex(m => m.name === 'combat-result');
        expect(reply).toBeGreaterThan(-1);
        expect(result).toBeGreaterThan(reply);
        expect(msgs[result].content).toContain('Combat ended: truce.');
        expect(store().combatSession).toBeNull();
        expect(store().context.combatAftermath?.text).toContain('truce');
    });

    it('rewrite re-runs only the reply and never re-rates or re-rolls', async () => {
        load(pcTurnSession(seedWhere('hard', false)));
        const d = deps(toolSays({ intent: 'ceasefire', rating: 'hard', speaker: 'Captain' }));
        await submitParley('Yield.', d);
        await waitForCombatNarration();
        const before = store().combatSession as CombatSession;
        const reply = store().messages.find(m => m.combatParley?.part === 'reply')!;
        sent.length = 0;
        await rewriteCombatBeat(reply.id);
        const after = store().combatSession as CombatSession;
        expect(d.tool).toHaveBeenCalledTimes(1);
        expect(after.state.parleys).toHaveLength(1);
        expect(after.state.rngCursor).toBe(before.state.rngCursor);
        expect(sent).toHaveLength(1);
        expect(sent[0].label).toBe('combat-parley-reply');
    });

    it('resumes a restart before the rating by rating again', async () => {
        const session = pcTurnSession(seedWhere('hard', false));
        load({ ...session, parley: { attemptId: 'a1', words: 'Stand down.', lineMessageId: 'line-1', stage: 'rating' }, parleyLines: [{ attemptId: 'a1', words: 'Stand down.' }] });
        useAppStore.setState({ messages: [...store().messages, { id: 'line-1', role: 'user', content: 'Stand down.', timestamp: 2, combatParley: { sessionId: session.state.id, attemptId: 'a1', part: 'line' } }] });
        const d = deps(toolSays({ intent: 'ceasefire', rating: 'hard', speaker: 'Captain' }));
        await resumeParley(d);
        await waitForCombatNarration();
        expect(d.tool).toHaveBeenCalledTimes(1);
        expect(store().combatSession?.state.parleys).toHaveLength(1);
        expect(store().messages.filter(m => m.combatParley?.part === 'line')).toHaveLength(1);
        expect(store().messages.filter(m => m.combatParley?.part === 'reply')).toHaveLength(1);
    });

    it('resumes a restart after the roll by producing only the reply', async () => {
        const session = pcTurnSession(seedWhere('hard', false));
        const pcId = currentActorId(session.state) as string;
        const rolled = applyAction(session.state, { type: 'parley', actorId: pcId, intent: 'ceasefire', rating: 'hard', attemptId: 'a1' });
        const ev = rolled.events.find(e => e.type === 'parley')!;
        load({
            ...session,
            state: rolled.state,
            log: [...session.log, ...rolled.events],
            parley: { attemptId: 'a1', words: 'Stand down.', lineMessageId: 'line-1', stage: 'rolled', intent: 'ceasefire', rating: 'hard', eventSeq: ev.seq },
            parleyLines: [{ attemptId: 'a1', words: 'Stand down.' }],
        });
        const d = deps(toolSays({ intent: 'ceasefire', rating: 'easy', speaker: 'Captain' }));
        await resumeParley(d);
        await waitForCombatNarration();
        expect(d.tool).not.toHaveBeenCalled();
        expect(d.json).not.toHaveBeenCalled();
        expect(store().combatSession?.state.parleys).toHaveLength(1);
        expect(store().combatSession?.state.rngCursor).toBe(rolled.state.rngCursor);
        expect(store().messages.filter(m => m.combatParley?.part === 'reply')).toHaveLength(1);
        expect(store().combatSession?.parley).toBeUndefined();
    });

    it('refuses to parley when it is not the player character\'s turn or the action is spent', async () => {
        const session = pcTurnSession(seedWhere('hard', false));
        const pcId = currentActorId(session.state) as string;
        const defended = applyAction(session.state, { type: 'defend', actorId: pcId });
        load({ ...session, state: defended.state });
        expect(await submitParley('Talk?', deps(toolSays({ intent: 'ceasefire', rating: 'easy', speaker: 'Captain' })))).toBe(false);
        expect(store().messages.some(m => m.combatParley)).toBe(false);
    });
});
