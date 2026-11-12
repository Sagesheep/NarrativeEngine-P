import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SendArgs = [unknown, Array<{ role: string; content: string }>, (t: string) => void, (t: string) => void, (e: string) => void, unknown, AbortController, unknown, unknown, string];
const sends: SendArgs[] = [];

vi.mock('../../chatEngine', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../chatEngine')>();
    return {
        ...actual,
        sendMessage: vi.fn((...args: SendArgs) => { sends.push(args); return Promise.resolve(); }),
    };
});

import { buildPcCombatant, createCombat, runEngineTurns, applyAction, currentActorId } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import {
    BEAT_DIRECTIVE, beatHistory, buildCombatBlock, computeBeatRanges, queueCombatNarration, resetCombatNarrationForTests,
    rewriteCombatBeat, stripBeatText, waitForCombatNarration,
} from '../combatNarration';
import { groupEventsByTurn, isGroupComplete, stateAtSeq, turnLines } from '../combatEvents';
import type { ChatMessage, CombatEvent, CombatSession, CombatSheet } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function fight(rounds = 2): CombatSession {
    const pc = buildPcCombatant({ name: 'Kira', sheet });
    const created = createCombat({ id: 'f1', combatants: [{ name: 'Bandit 1', side: 'enemy', tier: 'elite' }, { name: 'Bandit 2', side: 'enemy', tier: 'elite' }] }, pc, 5);
    let state = created.state;
    const log: CombatEvent[] = [...created.events];
    const engine = runEngineTurns(state);
    state = engine.state;
    log.push(...engine.events);
    for (let i = 0; i < rounds && !state.outcome; i++) {
        const actorId = currentActorId(state)!;
        const step = applyAction(state, { type: 'defend', actorId });
        const done = applyAction(step.state, { type: 'end_turn', actorId });
        const more = runEngineTurns(done.state);
        state = more.state;
        log.push(...step.events, ...done.events, ...more.events);
    }
    return { state, log, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

beforeEach(() => {
    sends.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'They attack.', timestamp: 1 }],
        combatSession: null,
        getActiveStoryEndpoint: () => ({ endpoint: 'http://x', apiKey: '', modelName: 'm' }) as never,
    });
});

afterEach(() => {
    resetCombatNarrationForTests();
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('cadence boundaries', () => {
    it('per action: one beat per combatant turn', () => {
        const s = fight();
        const turns = groupEventsByTurn(s.log).filter(g => g.actorId && isGroupComplete(g, s.state)).length;
        expect(turns).toBeGreaterThan(2);
        expect(computeBeatRanges(s, 'action', 0, false)).toHaveLength(turns);
    });

    it('per round: one beat per completed round, final flush adds the rest', () => {
        const s = fight();
        const rounds = s.log.filter(e => e.type === 'round').length;
        expect(computeBeatRanges(s, 'round', 0, false)).toHaveLength(rounds);
        const final = computeBeatRanges(s, 'round', 0, true);
        expect(final[final.length - 1].toSeq).toBe(s.log[s.log.length - 1].seq);
    });

    it('per side: flushes when the acting side changes and never splits a side', () => {
        const s = fight();
        const ranges = computeBeatRanges(s, 'side', 0, false);
        expect(ranges.length).toBeGreaterThan(0);
        for (let i = 1; i < ranges.length; i++) expect(ranges[i].fromSeq).toBe(ranges[i - 1].toSeq + 1);
        expect(ranges.length).toBeLessThanOrEqual(computeBeatRanges(s, 'action', 0, false).length);
    });

    it('end only: nothing until the fight ends, then everything in one beat', () => {
        const s = fight();
        expect(computeBeatRanges(s, 'end', 0, false)).toEqual([]);
        expect(computeBeatRanges(s, 'end', 0, true)).toEqual([{ fromSeq: 1, toSeq: s.log[s.log.length - 1].seq }]);
    });

    it('skips events that were already narrated', () => {
        const s = fight();
        const last = s.log[s.log.length - 1].seq;
        expect(computeBeatRanges(s, 'end', last, true)).toEqual([]);
    });
});

describe('beat prompt', () => {
    it('lists the roster as HP bands and the events in order, with no numbers', () => {
        const s = fight();
        const block = buildCombatBlock(s.state, s.log, { fromSeq: 1, toSeq: s.log[s.log.length - 1].seq });
        expect(block).toContain('Kira (player character)');
        expect(block).toMatch(/Bandit 1 \(enemy\): (unhurt|hurt|badly hurt|down)/);
        expect(block).not.toMatch(/\d+ (physical|slashing|bludgeoning)/);
        expect(block).not.toMatch(/Initiative: .*\d/);
    });

    it('drops trailing engine-log lines from the beat history and strips stakes tags and headers', () => {
        const msgs: ChatMessage[] = [
            { id: 'a', role: 'assistant', content: 'x', timestamp: 1 },
            { id: 'l', role: 'system', name: 'combat-log', content: 'y', timestamp: 2 },
            { id: 'b', role: 'assistant', content: '', timestamp: 3, combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 1 } },
        ];
        expect(beatHistory(msgs, 'b').map(m => m.id)).toEqual(['a']);
        expect(stripBeatText('Scene #12 | The blade falls.\n[[SCENE_STAKES: dangerous]]')).toBe('The blade falls.');
    });
});

describe('beat streaming', () => {
    it('creates a beat message, streams into it by id with no tools, and never touches the session', async () => {
        const s = fight();
        useAppStore.getState().setCombatSession(s);
        const ranges = queueCombatNarration(s, 'end', true);
        expect(ranges).toHaveLength(1);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        const [, payload, onChunk, onDone, , tools, , , , label] = sends[0];
        expect(tools).toBeUndefined();
        expect(label).toBe('combat-beat');
        expect(payload[payload.length - 1].content).toContain(BEAT_DIRECTIVE);
        const beat = useAppStore.getState().messages.find(m => m.combatBeat)!;
        expect(beat.combatBeat).toMatchObject({ sessionId: 'f1', fromSeq: 1 });
        expect(beat.pendingCommit).toBeUndefined();
        expect(beat.swipeSet).toBeUndefined();
        expect(useAppStore.getState().combatSession?.narratedThroughSeq).toBe(ranges[0].toSeq);
        useAppStore.getState().addMessage({ id: 'later', role: 'system', name: 'combat-log', content: 'later line', timestamp: 9 });
        onChunk('Steel');
        onDone('Steel flashes. [[SCENE_STAKES: dangerous]]');
        await waitForCombatNarration();
        const after = useAppStore.getState().messages;
        expect(after.find(m => m.id === beat.id)?.content).toBe('Steel flashes.');
        expect(after.find(m => m.id === 'later')?.content).toBe('later line');
        const sessionBefore = JSON.stringify(useAppStore.getState().combatSession);
        const rewrite = rewriteCombatBeat(beat.id);
        await vi.waitFor(() => expect(sends).toHaveLength(2));
        expect(sends[1][1][sends[1][1].length - 1].content).toBe(sends[0][1][sends[0][1].length - 1].content);
        sends[1][3]('A different telling.');
        await rewrite;
        expect(useAppStore.getState().messages.find(m => m.id === beat.id)?.content).toBe('A different telling.');
        expect(JSON.stringify(useAppStore.getState().combatSession)).toBe(sessionBefore);
    });

    it('marks a failed beat for retry and leaves the log intact', async () => {
        const s = fight();
        useAppStore.getState().setCombatSession(s);
        queueCombatNarration(s, 'end', true);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        sends[0][4]('500');
        await waitForCombatNarration();
        const beat = useAppStore.getState().messages.find(m => m.combatBeat)!;
        expect(beat.combatBeat?.failed).toBe(true);
        expect(useAppStore.getState().combatSession?.log).toEqual(s.log);
    });

    it('produces beats strictly in order', async () => {
        const s = fight(3);
        useAppStore.getState().setCombatSession(s);
        const ranges = queueCombatNarration(s, 'action', false);
        expect(ranges.length).toBeGreaterThan(1);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        expect(useAppStore.getState().messages.filter(m => m.combatBeat)).toHaveLength(1);
        sends[0][3]('one');
        await vi.waitFor(() => expect(sends).toHaveLength(2));
        const beats = useAppStore.getState().messages.filter(m => m.combatBeat);
        expect(beats.map(b => b.combatBeat!.fromSeq)).toEqual([ranges[0].fromSeq, ranges[1].fromSeq]);
    });
});

describe('Phase 2 turn lines and beats (B4)', () => {
    function gridFight(): CombatSession {
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const created = createCombat({ id: 'g1', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'elite' }], map: { size: 'small', features: [{ kind: 'crates', where: 'centre' }] }, mapSeed: 2 }, pc, 21);
        let state = created.state;
        const log: CombatEvent[] = [...created.events];
        const engine = runEngineTurns(state);
        state = engine.state;
        log.push(...engine.events);
        return { state, log, narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
    }

    it('never makes a beat due in the middle of a turn, in any cadence', () => {
        const s = gridFight();
        const actor = currentActorId(s.state)!;
        expect(s.state.combatants[actor].side).toBe('player');
        const step = applyAction(s.state, { type: 'move', actorId: actor, to: { x: s.state.combatants[actor].position!.x + 1, y: s.state.combatants[actor].position!.y } });
        expect(step.events.map(e => e.type)).toEqual(['moved']);
        const mid: CombatSession = { ...s, state: step.state, log: [...s.log, ...step.events] };
        for (const cadence of ['action', 'side', 'round', 'end'] as const) {
            const ranges = computeBeatRanges(mid, cadence, 0, false);
            for (const r of ranges) expect(r.toSeq).toBeLessThan(step.events[0].seq);
        }
        const done = applyAction(step.state, { type: 'end_turn', actorId: actor });
        const after: CombatSession = { ...mid, state: done.state, log: [...mid.log, ...done.events] };
        const ranges = computeBeatRanges(after, 'action', 0, false);
        expect(ranges[ranges.length - 1].toSeq).toBe(done.events[0].seq);
    });

    it('compresses movement into one clause, with numbers for the log and without for the beat', () => {
        const s = gridFight();
        const pcId = currentActorId(s.state)!;
        const pos = s.state.combatants[pcId].position!;
        const a = applyAction(s.state, { type: 'move', actorId: pcId, to: { x: pos.x + 2, y: pos.y } });
        const b = applyAction(a.state, { type: 'move', actorId: pcId, to: { x: pos.x + 3, y: pos.y } });
        const c = applyAction(b.state, { type: 'end_turn', actorId: pcId });
        const events = [...a.events, ...b.events, ...c.events];
        const group = groupEventsByTurn(events)[0];
        expect(turnLines(group, c.state, { numbers: true })).toEqual(['Kira moves 3 squares toward Bandit.']);
        expect(turnLines(group, c.state, { numbers: false })).toEqual(['Kira closes on Bandit.']);
    });

    it('lists coarse positions in the roster and never coordinates or numbers', () => {
        const s = gridFight();
        const block = buildCombatBlock(s.state, s.log, { fromSeq: 1, toSeq: s.log[s.log.length - 1].seq });
        expect(block).toMatch(/Bandit \(enemy\): (unhurt|hurt|badly hurt|down), (adjacent|close|at range|behind cover|out of sight)/);
        expect(block).not.toMatch(/\d+ squares?/);
        expect(block).not.toMatch(/Round \d/);
        expect(block).not.toMatch(/"x"|\(\d+, ?\d+\)/);
    });

    it('rewinds moves and hazard damage when rebuilding the state at a sequence number', () => {
        const s = gridFight();
        const pcId = currentActorId(s.state)!;
        const start = s.state.combatants[pcId].position!;
        const moved = applyAction(s.state, { type: 'move', actorId: pcId, to: { x: start.x + 1, y: start.y } });
        const burned: CombatEvent = { seq: moved.state.eventSeq + 1, round: 1, turn: 9, type: 'hazard', targetId: pcId, data: { damage: 4 }, text: 'x' };
        const state = { ...moved.state, combatants: { ...moved.state.combatants, [pcId]: { ...moved.state.combatants[pcId], hp: moved.state.combatants[pcId].hp - 4 } } };
        const log = [...s.log, ...moved.events, burned];
        const before = stateAtSeq(state, log, s.log[s.log.length - 1].seq);
        expect(before.combatants[pcId].position).toEqual(start);
        expect(before.combatants[pcId].hp).toBe(s.state.combatants[pcId].hp);
    });

    it('still groups a Phase 1 log that has no turn numbers by its action events', () => {
        const legacy: CombatEvent[] = [
            { seq: 1, round: 1, type: 'combat_started', data: {}, text: 'a' },
            { seq: 2, round: 1, type: 'attack', actorId: 'pc', data: {}, text: 'b' },
            { seq: 3, round: 1, type: 'down', actorId: 'pc', targetId: 'x', data: {}, text: 'c' },
            { seq: 4, round: 1, type: 'attack', actorId: 'x', data: {}, text: 'd' },
            { seq: 5, round: 1, turn: 7, type: 'moved', actorId: 'pc', data: { squares: 1 }, text: 'e' },
        ];
        expect(groupEventsByTurn(legacy).map(g => [g.actorId, g.turn, g.events.map(e => e.seq)])).toEqual([
            ['pc', undefined, [1, 2, 3]],
            ['x', undefined, [4]],
            ['pc', 7, [5]],
        ]);
    });
});
