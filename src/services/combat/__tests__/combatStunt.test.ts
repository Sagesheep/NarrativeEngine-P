import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ messages: Array<{ role: string; content: string }>; label: unknown; tools: unknown }> = [];

vi.mock('../../chatEngine', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../chatEngine')>();
    return {
        ...actual,
        sendMessage: vi.fn((_p: unknown, messages: Array<{ role: string; content: string }>, _chunk: unknown, onDone: (t: string) => void, _err: unknown, tools: unknown, _c: unknown, _s: unknown, _t: unknown, label: unknown) => {
            sent.push({ messages, label, tools });
            onDone('{"ability":"DEX","outcomes":[{"outcome":"move","to":[0,1],"difficulty":"easy"}]}');
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

import { buildPcCombatant, createCombat, currentActorId, isEmptyTile, runEngineTurns, terrainOf } from '@narrative/engine';
import type { CombatEvent, CombatState } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { buildCombatBlock, FLOURISH_LABEL, resetCombatNarrationForTests } from '../combatNarration';
import { setCombatStepDelay } from '../combatController';
import { narrationLine, NARRATED_EVENT_TYPES, stateAtSeq } from '../combatEvents';
import {
    backFromStunt, buildStuntPrompt, cancelStunt, judgeStuntAnswer, resetStuntForTests, resumeStunt, rollStunt, STUNT_RATE_TRACKING_LABEL,
    STUNT_REFEREE_RULES, submitStunt,
} from '../combatStunt';
import type { StuntDeps } from '../combatStunt';
import type { CombatPos, CombatSession, CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 14 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function pcTurnSession(seed = 3): CombatSession {
    for (let s = seed; s < seed + 200; s++) {
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const created = createCombat({ id: `fight-${s}`, combatants: [{ name: 'Captain', side: 'enemy', tier: 'elite' }, { name: 'Thug', side: 'enemy', tier: 'grunt' }] }, pc, s);
        const engine = runEngineTurns(created.state);
        const id = currentActorId(engine.state);
        if (id && engine.state.combatants[id].side === 'player' && !engine.state.outcome) {
            return { state: engine.state, log: [...created.events, ...engine.events], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
        }
    }
    throw new Error('no player turn');
}

function pcId(state: CombatState): string {
    return currentActorId(state) as string;
}

function freeStep(state: CombatState): [number, number] {
    const at = state.combatants[pcId(state)].position as CombatPos;
    const grid = terrainOf(state)!;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        if (isEmptyTile(state, grid, { x: at.x + dx, y: at.y + dy })) return [dx, dy];
    }
    throw new Error('boxed in');
}

function moveAnswer(state: CombatState, difficulty = 'easy'): string {
    const [dx, dy] = freeStep(state);
    return JSON.stringify({ ability: 'DEX', outcomes: [{ outcome: 'move', to: [dx, dy], difficulty }] });
}

function load(session: CombatSession): void {
    const base = useAppStore.getState().context;
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'Blades out.', timestamp: 1 }],
        context: { ...base, combatModeActive: true, combatSheet: sheet, combatConfig: { ...base.combatConfig, narrationCadence: 'end' }, characterProfileData: { ...base.characterProfileData, name: 'Kira', hp: { current: 20, max: 20 } }, combatTelemetry: undefined, combatAftermath: undefined } as GameContext,
        combatSession: session,
        combatBusy: false,
        pipelinePhase: 'idle',
        getActiveStoryEndpoint: () => ({ endpoint: 'http://x', apiKey: '', modelName: 'm' }) as never,
        getActiveUtilityEndpoint: () => null as never,
    });
}

function answers(...replies: Array<string | null>): StuntDeps & { fn: ReturnType<typeof vi.fn> } {
    let i = 0;
    const fn = vi.fn(async () => replies[Math.min(i++, replies.length - 1)]);
    return { call: fn, fn };
}

const store = () => useAppStore.getState();
const live = () => store().combatSession as CombatSession;

beforeEach(() => {
    sent.length = 0;
    setCombatStepDelay(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
    resetCombatNarrationForTests();
    resetStuntForTests();
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('stunt rating', () => {
    it('shows the verdict before any roll and spends nothing yet', async () => {
        const session = pcTurnSession();
        load(session);
        const d = answers(moveAnswer(session.state, 'moderate'));
        expect(await submitStunt('I vault the table.', d)).toBe('verdict');
        const s = live();
        expect(s.stunt).toMatchObject({ stage: 'verdict', difficulty: 'moderate', words: 'I vault the table.' });
        expect(s.state.rngCursor).toBe(session.state.rngCursor);
        expect(s.state.turn?.actionUsed).toBe(false);
        expect(s.log).toHaveLength(session.log.length);
        expect(store().context.combatTelemetry).toMatchObject({ stuntDifficulties: { moderate: 1 }, stuntResults: { judged: 1 } });
        expect(store().combatBusy).toBe(false);
    });

    it('retries an invalid answer once, with the reason', async () => {
        const session = pcTurnSession();
        load(session);
        const d = answers('{"ability":"DEX","outcomes":[{"outcome":"teleport","difficulty":"easy"}]}', moveAnswer(session.state));
        expect(await submitStunt('I roll aside.', d)).toBe('verdict');
        expect(d.fn).toHaveBeenCalledTimes(2);
        const retry = d.fn.mock.calls[1][1] as Array<{ role: string; content: string }>;
        expect(retry[retry.length - 1].content).toContain('"teleport" is not on the menu');
        expect(store().context.combatTelemetry?.stuntResults).toEqual({ invalid: 1, judged: 1 });
    });

    it('gives up after a second invalid answer, telling the player and spending nothing', async () => {
        const session = pcTurnSession();
        load(session);
        const d = answers('not json at all', '{"ability":"DEX","outcomes":[{"outcome":"stun","target":"Captain","difficulty":"easy"}]}');
        expect(await submitStunt('I headbutt the captain.', d)).toBe('unjudged');
        expect(d.fn).toHaveBeenCalledTimes(2);
        expect(live().stunt).toBeUndefined();
        expect(live().state).toEqual(session.state);
        expect(store().context.combatTelemetry?.stuntResults).toEqual({ invalid: 2, unjudged: 1 });
    });

    it('refuses an impossible stunt at no cost', async () => {
        const session = pcTurnSession();
        load(session);
        const d = answers('{"ability":"STR","outcomes":[{"outcome":"hurt","target":"Captain","difficulty":"impossible"}]}');
        expect(await submitStunt('I punch the moon down onto them.', d)).toBe('impossible');
        expect(live().stunt).toBeUndefined();
        expect(live().state).toEqual(session.state);
        expect(store().context.combatTelemetry).toMatchObject({ stuntDifficulties: { impossible: 1 }, stuntResults: { impossible: 1 } });
    });

    it('cancel during the call returns the turn with nothing spent', async () => {
        const session = pcTurnSession();
        load(session);
        let release: (v: string | null) => void = () => undefined;
        const d: StuntDeps = { call: () => new Promise(r => { release = r; }) };
        const pending = submitStunt('I swing from the chandelier.', d);
        await Promise.resolve();
        expect(live().stunt?.stage).toBe('rating');
        cancelStunt();
        release(moveAnswer(session.state));
        expect(await pending).toBe('cancelled');
        expect(live().stunt).toBeUndefined();
        expect(live().state).toEqual(session.state);
    });

    it('sends the rating as a plain JSON request on the story model, with no tools', async () => {
        load(pcTurnSession());
        expect(await submitStunt('I sidestep.')).toBe('verdict');
        expect(sent).toHaveLength(1);
        expect(sent[0].label).toBe(STUNT_RATE_TRACKING_LABEL);
        expect(sent[0].tools).toBeUndefined();
    });

    it('builds a prompt with the menu, relative positions and the referee rules, and no HP numbers', () => {
        const session = pcTurnSession();
        const prompt = buildStuntPrompt(session, pcId(session.state), 'I kick sand in his eyes, and it works.');
        expect(prompt).toContain('Menu (outcome: what the engine does):');
        expect(prompt).toMatch(/- Captain \(enemy; elite\): at \[-?\d+,-?\d+\], \d+ squares? away/);
        expect(prompt).toContain('Kira tries: "I kick sand in his eyes, and it works."');
        expect(prompt).toContain(STUNT_REFEREE_RULES);
        expect(STUNT_REFEREE_RULES).toContain('neutral referee');
        expect(STUNT_REFEREE_RULES).toContain('choose the harder one');
        expect(prompt).not.toMatch(/\bHP\b|hp:|\d+\/\d+/);
    });

    it('turns names and relative squares into an engine spec and lets the engine judge it', () => {
        const session = pcTurnSession();
        const id = pcId(session.state);
        expect(judgeStuntAnswer(session.state, id, '```json\n' + moveAnswer(session.state) + '\n```')).toMatchObject({ kind: 'verdict', difficulty: 'easy' });
        expect(judgeStuntAnswer(session.state, id, '{"ability":"Dexterity","outcomes":[{"outcome":"stun","target":"Thug","difficulty":"hard"}]}').kind).toBe('invalid');
        expect(judgeStuntAnswer(session.state, id, '{"ability":"DEX","outcomes":[{"outcome":"hurt","target":"Nobody","difficulty":"easy"}]}'))
            .toEqual({ kind: 'invalid', reason: 'hurt: there is no combatant named "Nobody"' });
    });
});

describe('stunt verdict, roll and restart', () => {
    it('Back costs nothing', async () => {
        const session = pcTurnSession();
        load(session);
        await submitStunt('I vault the table.', answers(moveAnswer(session.state)));
        backFromStunt();
        expect(live().stunt).toBeUndefined();
        expect(live().state).toEqual(session.state);
    });

    it('Roll spends the action, and the typed words reach the beat block as the flourish', async () => {
        const session = pcTurnSession();
        load(session);
        await submitStunt('I vault the table.', answers(moveAnswer(session.state)));
        const events = await rollStunt();
        const check = events.find(e => e.type === 'stunt_check') as CombatEvent;
        expect(check).toBeDefined();
        const s = live();
        expect(s).not.toBeNull();
        expect(s.stunt).toBeUndefined();
        expect(s.log.some(e => e.seq === check.seq)).toBe(true);
        expect(s.flourishes).toEqual([{ seq: check.seq, text: 'I vault the table.' }]);
        const block = buildCombatBlock(s.state, s.log, { fromSeq: check.seq, toSeq: check.seq }, { flourishes: s.flourishes });
        expect(block).toContain(`${FLOURISH_LABEL} "I vault the table."`);
    });

    it('a restart during the rating call leaves the turn unspent', () => {
        const session = pcTurnSession();
        load({ ...session, stunt: { attemptId: 'a1', actorId: pcId(session.state), words: 'I leap.', stage: 'rating' } });
        resumeStunt();
        expect(live().stunt).toBeUndefined();
        expect(live().state).toEqual(session.state);
    });

    it('a restart at the verdict keeps it when it still fits, and drops it when it does not', async () => {
        const session = pcTurnSession();
        const id = pcId(session.state);
        const verdict = judgeStuntAnswer(session.state, id, moveAnswer(session.state));
        if (verdict.kind !== 'verdict') throw new Error('expected a verdict');
        load({ ...session, stunt: { attemptId: 'a1', actorId: id, words: 'I leap.', stage: 'verdict', spec: verdict.spec, difficulty: verdict.difficulty } });
        resumeStunt();
        expect(live().stunt?.stage).toBe('verdict');
        expect((await rollStunt()).some(e => e.type === 'stunt_check')).toBe(true);
        load({ ...session, stunt: { attemptId: 'a2', actorId: 'someone-else', words: 'I leap.', stage: 'verdict', spec: verdict.spec, difficulty: verdict.difficulty } });
        resumeStunt();
        expect(live().stunt).toBeUndefined();
    });
});

describe('stunt narration', () => {
    const ev = (data: Record<string, unknown>): CombatEvent => ({ seq: 99, round: 1, turn: 1, type: 'stunt_check', actorId: 'pc', data, text: '' });

    it('narrates success, failure and a natural 1 without numbers', () => {
        const state = pcTurnSession().state;
        const name = state.combatants[Object.keys(state.combatants).find(k => state.combatants[k].side === 'player')!].name;
        const s = { ...state, combatants: { ...state.combatants, pc: { ...state.combatants[Object.keys(state.combatants)[0]], id: 'pc', name } } };
        expect(narrationLine(ev({ success: true }), s)).toBe(`${name} pulls it off.`);
        expect(narrationLine(ev({ success: false, fumble: false }), s)).toBe(`${name}'s attempt does not come off.`);
        expect(narrationLine(ev({ success: false, fumble: true }), s)).toBe(`${name}'s attempt goes badly wrong.`);
        expect(NARRATED_EVENT_TYPES).toContain('stunt_check');
        expect(stateAtSeq(s, [ev({ success: true })], 0).combatants).toEqual(s.combatants);
    });
});
