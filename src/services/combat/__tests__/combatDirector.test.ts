import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../combatNarration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../combatNarration')>();
    return {
        ...actual,
        queueCombatNarration: vi.fn(() => []),
        waitForCombatNarration: vi.fn(async () => {}),
        queueParleyReply: vi.fn(),
        rewriteCombatBeat: vi.fn(async () => true),
    };
});

vi.mock('../../llm/apiClient', () => ({
    api: {
        archive: { append: vi.fn(async () => ({ sceneId: '009' })), getIndex: vi.fn(async () => []) },
        timeline: { get: vi.fn(async () => []) },
        chapters: { list: vi.fn(async () => []) },
    },
}));

import { buildPcCombatant, createCombat, currentActorId, yetToAct } from '@narrative/engine';
import type { CombatantSpec } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import {
    abortCombat, commitSession, playerAction, resumeStoredSession, runEngineTurnsStepped, setCombatStepDelay,
} from '../combatController';
import {
    DIRECTOR_RULES, DIRECTOR_WAIT_MS, buildDirectorPrompt, installCombatDirector, isDirectorPending, lastDirectorRecord, parseDirectorReply,
    readUsage, uninstallCombatDirector,
} from '../combatDirector';
import type { DirectorCallOutput } from '../combatDirector';
import { resetParleyForTests, submitParley } from '../combatParley';
import type { CombatSession, CombatSheet, GameContext, NPCEntry } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 14 }, budget: 'NORMAL', level: 3, needsAllocation: false };

const OFFICERS: CombatantSpec[] = [
    { name: 'Captain Vey', side: 'enemy', tier: 'elite', npcId: 'npc-vey' },
    { name: 'Lieutenant Oro', side: 'enemy', tier: 'elite' },
    { name: 'Thug', side: 'enemy', tier: 'grunt' },
];

function made(seed: number, combatants: CombatantSpec[] = OFFICERS): CombatSession {
    const pc = buildPcCombatant({ name: 'Kira', sheet });
    const created = createCombat({ id: `dir-${seed}`, mapSeed: seed, combatants }, pc, seed);
    return { state: created.state, log: [...created.events], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

function idOf(s: CombatSession, name: string): string {
    return Object.values(s.state.combatants).find(c => c.name === name)?.id as string;
}

function isElite(s: CombatSession, id: string | undefined): boolean {
    return !!id && s.state.combatants[id]?.tier === 'elite' && s.state.combatants[id]?.side === 'enemy';
}

function findSeed(test: (s: CombatSession) => boolean): number {
    for (let seed = 1; seed < 500; seed++) if (test(made(seed))) return seed;
    throw new Error('no seed');
}

const officerFirst = findSeed(s => {
    const order = s.state.order;
    const pcAt = order.indexOf('pc');
    const second = order.findIndex((id, i) => i > 0 && isElite(s, id));
    return isElite(s, order[0]) && pcAt > 0 && second > pcAt;
});

const playerFirst = findSeed(s => s.state.order[0] === 'pc');

const VEY: NPCEntry = { id: 'npc-vey', name: 'Captain Vey', voice: 'clipped, cold, never raises her voice', personality: 'ruthless and proud' } as NPCEntry;

function load(session: CombatSession | null, config: Record<string, unknown> = {}): void {
    const base = useAppStore.getState().context;
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'SECRET STORY TEXT', timestamp: 1 }],
        context: {
            ...base,
            combatModeActive: true,
            combatSheet: sheet,
            combatConfig: { ...base.combatConfig, narrationCadence: 'end', combatDirector: 'on', ...config },
            characterProfileData: { ...base.characterProfileData, name: 'Kira', hp: { current: 20, max: 20 } },
            combatTelemetry: undefined,
            combatAftermath: undefined,
        } as GameContext,
        npcLedger: [VEY],
        combatSession: session,
        combatBusy: false,
        pipelinePhase: 'idle',
        getActiveStoryEndpoint: () => ({ endpoint: 'http://x', apiKey: '', modelName: 'm' }) as never,
        getActiveUtilityEndpoint: () => null as never,
    });
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

function deferred<T>(): Deferred<T> {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function hangingCall() {
    const signals: AbortSignal[] = [];
    const replies: Array<Deferred<DirectorCallOutput>> = [];
    const call = vi.fn((_p: unknown, _prompt: string, signal: AbortSignal) => {
        const d = deferred<DirectorCallOutput>();
        replies.push(d);
        signals.push(signal);
        signal.addEventListener('abort', () => d.reject(new Error('aborted')));
        return d.promise;
    });
    return { call, signals, reply: (out: DirectorCallOutput) => replies[0].resolve(out) };
}

const live = () => useAppStore.getState().combatSession as CombatSession;
const ordersIn = (s: CombatSession) => s.log.filter(e => e.type === 'order_given');
type WarnSpy = { mock: { calls: unknown[][] } };
const directorWarnings = (spy: WarnSpy) => spy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('director'));

let warn: WarnSpy;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    setCombatStepDelay(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    resetParleyForTests();
});

afterEach(() => {
    uninstallCombatDirector();
    useAppStore.setState({ combatSession: null });
    cancelPendingSaves();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('reading the director reply', () => {
    it('reads strict JSON, fenced JSON with prose and a bare array, with loose field names', () => {
        expect(parseDirectorReply('{"orders":[{"id":"u3","order":"focus","target":"pc","line":"Down she goes."}]}'))
            .toEqual([{ unitId: 'u3', kind: 'focus', targetId: 'pc', line: 'Down she goes.' }]);
        expect(parseDirectorReply('Here you go:\n```json\n{"orders":[{"unit":"Captain Vey","kind":"Fall Back"}]}\n```'))
            .toEqual([{ unitId: 'Captain Vey', kind: 'Fall Back' }]);
        expect(parseDirectorReply('[{"id":"u5","order":"switch_tactic","tactic":"guard"}]'))
            .toEqual([{ unitId: 'u5', kind: 'switch_tactic', tactic: 'guard' }]);
    });

    it('repairs a reply cut off mid-way and drops entries without a unit or an order', () => {
        const parsed = parseDirectorReply('{"orders":[{"id":"u3","order":"hold"},{"order":"press"},{"id":"u4"},{"id":"u6","order":"press","line":"Now!');
        expect(parsed?.[0]).toEqual({ unitId: 'u3', kind: 'hold' });
        expect(parsed?.some(o => o.kind === 'press' && !o.unitId)).toBe(false);
    });

    it('returns null for prose and an empty list for no orders', () => {
        expect(parseDirectorReply('They should attack the weakest.')).toBeNull();
        expect(parseDirectorReply('{"note":"none"}')).toBeNull();
        expect(parseDirectorReply('{"orders":[]}')).toEqual([]);
    });

    it('reads token counts from the common usage shapes', () => {
        expect(readUsage({ usage: { prompt_tokens: 900, completion_tokens: 40 } })).toEqual({ promptTokens: 900, replyTokens: 40 });
        expect(readUsage({ usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({ promptTokens: 10, replyTokens: 2 });
        expect(readUsage({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } })).toEqual({ promptTokens: 7, replyTokens: 3 });
        expect(readUsage({ choices: [] })).toEqual({});
    });
});

describe('the director prompt', () => {
    it('carries the brief, the menu, the voices and the anti-sycophancy rules, and no story history', () => {
        const s = made(officerFirst);
        load(s);
        const prompt = buildDirectorPrompt(s, [VEY]) as string;
        expect(prompt).toContain('[COMBAT DIRECTOR — round 1]');
        for (const rule of DIRECTOR_RULES) expect(prompt).toContain(rule);
        expect(prompt).toContain('never go easy on the player');
        expect(prompt).toContain('not what the player would wish');
        expect(prompt).toContain('better story for the player');
        expect(prompt).toContain('- fall_back:');
        expect(prompt).toContain(`id "${idOf(s, 'Captain Vey')}": Captain Vey (enemy, elite`);
        expect(prompt).toContain('voice: clipped, cold, never raises her voice; personality: ruthless and proud');
        expect(prompt).toContain('Last round: none; the fight has just begun.');
        expect(prompt).toContain('"directed":[');
        expect(prompt).not.toContain('SECRET STORY TEXT');
        expect(prompt).toContain('{"orders":[');
    });

    it('is not built when no officer stands', () => {
        const s = made(3, [{ name: 'Thug', side: 'enemy', tier: 'grunt' }]);
        expect(buildDirectorPrompt(s)).toBeNull();
    });
});

describe('when the call is made', () => {
    it('makes no call when the setting is off', () => {
        const s = made(officerFirst);
        load(s, { combatDirector: 'off' });
        const { call } = hangingCall();
        installCombatDirector({ call });
        commitSession(s);
        expect(call).not.toHaveBeenCalled();
        expect(isDirectorPending()).toBe(false);
    });

    it('makes no call when no directed unit stands', () => {
        const s = made(3, [{ name: 'Thug', side: 'enemy', tier: 'grunt' }, { name: 'Thug', side: 'enemy', tier: 'grunt' }]);
        load(s);
        const { call } = hangingCall();
        installCombatDirector({ call });
        commitSession(s);
        expect(call).not.toHaveBeenCalled();
    });

    it('makes one call at the start of each round, not one per commit', async () => {
        const s = made(playerFirst);
        load(s);
        const call = vi.fn(async (_p: unknown, _prompt: string, _signal: AbortSignal) => ({ text: '{"orders":[]}' }));
        installCombatDirector({ call });
        commitSession(s);
        commitSession(live());
        expect(call).toHaveBeenCalledTimes(1);
        const pcId = 'pc';
        for (let i = 0; i < 6 && live().state.round === 1 && !live().state.outcome; i++) {
            if (currentActorId(live().state) === pcId) await playerAction({ type: 'end_turn', actorId: pcId });
            else await runEngineTurnsStepped();
            await vi.advanceTimersByTimeAsync(0);
        }
        expect(live().state.round).toBeGreaterThanOrEqual(2);
        expect(call).toHaveBeenCalledTimes(2);
        expect(call.mock.calls[1][1]).toContain('[COMBAT DIRECTOR — round 2]');
        expect(call.mock.calls[1][1]).toContain('Last round:\n- ');
    });
});

describe('a reply in time', () => {
    it('applies the orders before the officer acts, posts the line and records the call', async () => {
        const s = made(officerFirst);
        load(s);
        const vey = s.state.order[0];
        const d = deferred<DirectorCallOutput>();
        const call = vi.fn(() => d.promise);
        installCombatDirector({ call });
        commitSession(s);
        const running = runEngineTurnsStepped();
        await vi.advanceTimersByTimeAsync(1000);
        expect(live().log.some(e => e.actorId === vey && e.type !== 'order_given' && e.seq > s.state.eventSeq)).toBe(false);
        d.resolve({ text: JSON.stringify({ orders: [{ id: vey, order: 'focus', target: 'pc', line: 'Cut her down!' }, { id: 'pc', order: 'hold' }] }), promptTokens: 900, replyTokens: 40 });
        await running;
        const order = ordersIn(live())[0];
        expect(order).toMatchObject({ actorId: vey, data: { kind: 'focus', targetId: 'pc', line: 'Cut her down!' } });
        const firstAct = live().log.find(e => e.actorId === vey && e.type !== 'order_given' && e.seq > s.state.eventSeq);
        expect(firstAct && firstAct.seq > order.seq).toBe(true);
        const record = lastDirectorRecord();
        expect(record).toMatchObject({ round: 1, result: 'ok', accepted: 1, rejected: 1, promptTokens: 900, replyTokens: 40, late: false });
        const telemetry = useAppStore.getState().context.combatTelemetry?.director;
        expect(telemetry).toMatchObject({ sessionId: s.state.id, calls: 1, failed: 0, accepted: 1, rejected: 1, promptTokens: 900, replyTokens: 40, waits: 1 });
        expect(telemetry?.last).toHaveLength(1);
        expect(directorWarnings(warn)).toHaveLength(0);
    });
});

describe('the board never stalls', () => {
    it('an officer waits at most the limit, then acts on its tactic; a late reply only reaches units that have not acted', async () => {
        const s = made(officerFirst);
        load(s);
        const vey = s.state.order[0];
        const other = s.state.order.find((id, i) => i > 0 && isElite(s, id)) as string;
        const { call, reply } = hangingCall();
        installCombatDirector({ call });
        commitSession(s);
        const running = runEngineTurnsStepped();
        await vi.advanceTimersByTimeAsync(DIRECTOR_WAIT_MS - 1);
        expect(live().log.some(e => e.actorId === vey && e.seq > s.state.eventSeq)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await running;
        expect(live().log.some(e => e.actorId === vey && e.seq > s.state.eventSeq)).toBe(true);
        expect(live().state.round).toBe(1);
        expect(yetToAct(live().state, other)).toBe(true);
        reply({ text: JSON.stringify({ orders: [{ id: vey, order: 'press' }, { id: other, order: 'fall_back', line: 'Back, back!' }] }) });
        await vi.advanceTimersByTimeAsync(0);
        const orders = ordersIn(live());
        expect(orders.map(e => e.actorId)).toEqual([other]);
        expect(live().state.combatants[vey].order).toBeUndefined();
        expect(lastDirectorRecord()).toMatchObject({ result: 'ok', accepted: 1, rejected: 1, late: true });
        expect(useAppStore.getState().context.combatTelemetry?.director).toMatchObject({ lateReplies: 1, waits: 1, waitedMs: DIRECTOR_WAIT_MS });
    });

    it('a failed call means no orders, one warning, and the officer acts at once', async () => {
        const s = made(officerFirst);
        load(s);
        const call = vi.fn(async () => { throw new Error('HTTP 500'); });
        installCombatDirector({ call });
        commitSession(s);
        await runEngineTurnsStepped();
        expect(ordersIn(live())).toHaveLength(0);
        expect(live().log.some(e => e.actorId === s.state.order[0] && e.seq > s.state.eventSeq)).toBe(true);
        expect(directorWarnings(warn)).toHaveLength(1);
        expect(lastDirectorRecord()?.result).toBe('failed');
    });

    it('an unparsable reply means no orders and one warning', async () => {
        const s = made(officerFirst);
        load(s);
        installCombatDirector({ call: async () => ({ text: 'Vey should charge, obviously.' }) });
        commitSession(s);
        await runEngineTurnsStepped();
        expect(ordersIn(live())).toHaveLength(0);
        expect(directorWarnings(warn)).toHaveLength(1);
        expect(lastDirectorRecord()?.result).toBe('unparsable');
    });
});

describe('cancelling a pending call', () => {
    async function pendingOnPlayerTurn() {
        const s = made(playerFirst);
        load(s);
        const hanging = hangingCall();
        installCombatDirector({ call: hanging.call });
        commitSession(s);
        expect(isDirectorPending()).toBe(true);
        return { s, ...hanging };
    }

    async function expectCancelled(signals: AbortSignal[]) {
        await vi.advanceTimersByTimeAsync(0);
        expect(signals[0].aborted).toBe(true);
        expect(ordersIn(live() ?? { log: [] } as unknown as CombatSession)).toHaveLength(0);
        expect(directorWarnings(warn).filter((c: unknown[]) => String(c[0]).includes('cancelled'))).toHaveLength(1);
    }

    it('ending the fight', async () => {
        const { signals } = await pendingOnPlayerTurn();
        await abortCombat();
        await expectCancelled(signals);
        expect(isDirectorPending()).toBe(false);
        expect(lastDirectorRecord()?.result).toBe('cancelled');
    });

    it('fleeing', async () => {
        const { signals } = await pendingOnPlayerTurn();
        await playerAction({ type: 'flee', actorId: 'pc' });
        await expectCancelled(signals);
    });

    it('parley', async () => {
        const { signals } = await pendingOnPlayerTurn();
        const parleyDeps = {
            callTool: vi.fn(async () => ({ name: 'rate_parley', arguments: '{"intent":"ceasefire","rating":"hard","speaker":"Captain Vey"}' })),
            callJson: vi.fn(async () => ''),
        };
        await submitParley('Stand down.', parleyDeps);
        await expectCancelled(signals);
    });

    it('reload, which also gives the round in progress no call', async () => {
        const { signals, call } = await pendingOnPlayerTurn();
        resumeStoredSession();
        await expectCancelled(signals);
        expect(isDirectorPending()).toBe(false);
        commitSession(live());
        expect(call).toHaveBeenCalledTimes(1);
    });

    it('switching campaign', async () => {
        const { signals } = await pendingOnPlayerTurn();
        useAppStore.setState({ activeCampaignId: 'c2' });
        await vi.advanceTimersByTimeAsync(0);
        expect(signals[0].aborted).toBe(true);
        expect(isDirectorPending()).toBe(false);
    });

    it('undo, when the stored fight goes back before the call', async () => {
        const { s, signals } = await pendingOnPlayerTurn();
        useAppStore.getState().setCombatSession({ ...s, state: { ...s.state, eventSeq: s.state.eventSeq - 1 } });
        await expectCancelled(signals);
    });
});
