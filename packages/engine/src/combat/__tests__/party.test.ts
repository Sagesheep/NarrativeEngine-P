import { describe, it, expect } from 'vitest';
import {
    applyAction, buildMoraleBook, buildPcCombatant, checkFlee, checkOutcome, concedeCombat, createCombat, currentActorId,
    currentTurn, hpBand, isEdgeTile, isLeaderDown, parleyDc, resolveSpeaker, runEngineTurns, saveModifier, stepEngine, TIER_TABLE,
    PARLEY_DC,
} from '../index';
import type {
    CombatAction, CombatEvent, CombatSheet, CombatState, Combatant, Grid, ParleyRating, Side,
} from '../index';

const sheet: CombatSheet = {
    abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 14 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

function openGrid(width: number, height: number): Grid {
    return { width, height, tiles: new Array(width * height).fill('floor') };
}

type Def = Partial<Combatant> & { id: string; side: Side; at: [number, number] };

function unit(def: Def): Combatant {
    const { at, ...rest } = def;
    return {
        name: def.id.toUpperCase(),
        controller: def.side === 'player' ? 'player' : 'engine',
        tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [],
        ...rest,
        position: { x: at[0], y: at[1] },
    };
}

function board(defs: Def[], extra: Partial<CombatState> = {}, size: [number, number] = [8, 5]): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const d of defs) combatants[d.id] = { ...unit(d), startHp: d.startHp ?? d.hp ?? 20 };
    const base: CombatState = {
        id: 'p', round: 2, order: defs.map(d => d.id), turnIndex: 0, combatants,
        rngSeed: 11, rngCursor: 0, eventSeq: 0, outcome: null, grid: openGrid(size[0], size[1]), turnCount: 5, ...extra,
    };
    const first = base.combatants[base.order[base.turnIndex]];
    const withBook: CombatState = { ...base, morale: extra.morale ?? buildMoraleBook(base) };
    if (!('turnStart' in extra) && first?.position) withBook.turnStart = { actorId: first.id, pos: { ...first.position } };
    return withBook;
}

function act(state: CombatState, action: CombatAction): { state: CombatState; events: CombatEvent[] } {
    return applyAction(state, action);
}

function withSeed(state: CombatState, seed: number): CombatState {
    return { ...state, rngSeed: seed, rngCursor: 0 };
}

function findSeed(make: (seed: number) => boolean): number {
    for (let seed = 1; seed < 5000; seed++) if (make(seed)) return seed;
    throw new Error('no seed found');
}

describe('flee', () => {
    it('treats walkable tiles on the outer rows and columns as edges', () => {
        const g = openGrid(5, 4);
        expect(isEdgeTile(g, { x: 0, y: 2 })).toBe(true);
        expect(isEdgeTile(g, { x: 4, y: 1 })).toBe(true);
        expect(isEdgeTile(g, { x: 2, y: 3 })).toBe(true);
        expect(isEdgeTile(g, { x: 2, y: 2 })).toBe(false);
        expect(isEdgeTile({ ...g, tiles: g.tiles.map((t, i) => (i === 0 ? 'wall' : t)) }, { x: 0, y: 0 })).toBe(false);
    });

    it('is refused in round 1, away from an edge, after moving onto one, and once the action is spent', () => {
        const duel: Def[] = [{ id: 'pc', side: 'player', at: [0, 2] }, { id: 'e', side: 'enemy', at: [7, 2] }];
        const s = board(duel);
        expect(checkFlee(board(duel, { round: 1 }), 'pc', currentTurn(board(duel, { round: 1 }))).reason).toBe('first_round');
        const inner = board([{ id: 'pc', side: 'player', at: [2, 2] }, { id: 'e', side: 'enemy', at: [7, 2] }]);
        expect(checkFlee(inner, 'pc', currentTurn(inner)).reason).toBe('not_on_edge');
        const moved = act(inner, { type: 'move', actorId: 'pc', to: { x: 0, y: 2 } }).state;
        expect(checkFlee(moved, 'pc', currentTurn(moved)).reason).toBe('started_off_edge');
        const defended = act(s, { type: 'defend', actorId: 'pc' }).state;
        expect(checkFlee(defended, 'pc', currentTurn(defended)).reason).toBe('action_used');
        expect(act(inner, { type: 'flee', actorId: 'pc' }).events[0].type).toBe('rejected');
    });

    it('leaves without a check when no hostile is adjacent, ends the fight as fled and dismisses own summons', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'sum', side: 'ally', at: [1, 1], summonerId: 'pc', tier: 'minion' },
            { id: 'e', side: 'enemy', at: [7, 2] },
        ]);
        const r = act(s, { type: 'flee', actorId: 'pc' });
        const flee = r.events.find(e => e.type === 'flee')!;
        expect(flee.data).toMatchObject({ contested: false, success: true });
        expect(r.state.combatants.pc.status).toBe('fled');
        expect(r.state.combatants.sum.status).toBe('gone');
        expect(r.events.find(e => e.type === 'dismissed')?.data.cause).toBe('summoner_left');
        expect(r.state.outcome).toBe('fled');
        expect(r.state.rngCursor).toBe(s.rngCursor);
    });

    it('rolls d20 + DEX against the best adjacent DEX, ties to the fleer, and spends the action on a failure', () => {
        const defs: Def[] = [
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'e1', side: 'enemy', at: [1, 2], abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 } },
            { id: 'e2', side: 'enemy', at: [1, 1], abilities: { STR: 10, DEX: 18, CON: 10, INT: 10, WIS: 10, CHA: 10 } },
        ];
        const fail = findSeed(seed => act(withSeed(board(defs), seed), { type: 'flee', actorId: 'pc' }).events.find(e => e.type === 'flee')?.data.success === false);
        const pass = findSeed(seed => act(withSeed(board(defs), seed), { type: 'flee', actorId: 'pc' }).events.find(e => e.type === 'flee')?.data.success === true);
        const failed = act(withSeed(board(defs), fail), { type: 'flee', actorId: 'pc' });
        const data = failed.events.find(e => e.type === 'flee')!.data;
        expect(data.contested).toBe(true);
        expect(data.blockerId).toBe('e2');
        expect((data.total as number) < (data.againstTotal as number)).toBe(true);
        expect(data.total).toBe((data.natural as number) + 0);
        expect(data.againstTotal).toBe((data.against as number) + 4);
        expect(failed.state.combatants.pc.status).toBe('up');
        expect(failed.state.turn?.actionUsed).toBe(true);
        const passed = act(withSeed(board(defs), pass), { type: 'flee', actorId: 'pc' });
        const ok = passed.events.find(e => e.type === 'flee')!.data;
        expect((ok.total as number) >= (ok.againstTotal as number)).toBe(true);
        expect(passed.state.combatants.pc.status).toBe('fled');
    });
});

describe('outcomes with fled and surrendered combatants', () => {
    const base = (statuses: Record<string, Combatant['status']>): CombatState => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'a', side: 'ally', at: [0, 3] },
            { id: 'e', side: 'enemy', at: [7, 2] },
        ]);
        for (const [id, status] of Object.entries(statuses)) s.combatants[id] = { ...s.combatants[id], status };
        return s;
    };

    it('ends as fled when no one on the party side is up and someone fled, defeat when no one fled', () => {
        expect(checkOutcome(base({ pc: 'fled', a: 'down' }))).toBe('fled');
        expect(checkOutcome(base({ pc: 'down', a: 'fled' }))).toBe('fled');
        expect(checkOutcome(base({ pc: 'down', a: 'down' }))).toBe('defeat');
        expect(checkOutcome(base({ pc: 'fled' }))).toBeNull();
    });

    it('counts fled and surrendered enemies as beaten, even if part of the party fled', () => {
        expect(checkOutcome(base({ e: 'fled' }))).toBe('victory');
        expect(checkOutcome(base({ e: 'surrendered' }))).toBe('victory');
        expect(checkOutcome(base({ e: 'fled', pc: 'fled', a: 'down' }))).toBe('victory');
    });

    it('labels fled and surrendered combatants with their own bands', () => {
        expect(hpBand({ hp: 4, maxHp: 10, status: 'fled' })).toBe('fled');
        expect(hpBand({ hp: 4, maxHp: 10, status: 'surrendered' })).toBe('yielded');
    });
});

describe('engine allies after the player character fled', () => {
    it('run for the nearest edge and flee instead of fighting', () => {
        let s = board([
            { id: 'pc', side: 'player', at: [0, 2], status: 'fled' },
            { id: 'a', side: 'ally', at: [2, 2], hp: 20 },
            { id: 'e', side: 'enemy', at: [6, 2], hp: 99, maxHp: 99, startHp: 99 },
        ], { order: ['a', 'e', 'pc'], turnIndex: 0, turnStart: { actorId: 'a', pos: { x: 2, y: 2 } } });
        const first = stepEngine(s)!;
        const moved = first.events.find(e => e.type === 'moved');
        expect(moved?.actorId).toBe('a');
        expect(first.events.some(e => e.type === 'attack' && e.actorId === 'a')).toBe(false);
        s = runEngineTurns(first.state).state;
        for (let i = 0; i < 6 && !s.outcome; i++) s = runEngineTurns(s).state;
        expect(s.combatants.a.status === 'fled' || s.combatants.a.status === 'down').toBe(true);
        expect(s.outcome).toBe('fled');
    });

    it('lets a player-controlled ally abandon the fight once the player character has fled', () => {
        const s = board([
            { id: 'a', side: 'ally', at: [2, 2], controller: 'player' },
            { id: 'pc', side: 'player', at: [0, 2], status: 'fled' },
            { id: 'e', side: 'enemy', at: [6, 2] },
        ]);
        const r = act(s, { type: 'abandon', actorId: 'a' });
        expect(r.state.outcome).toBe('fled');
        expect(r.state.ending?.abandoned).toBe(true);
        const notYet = board([
            { id: 'a', side: 'ally', at: [2, 2], controller: 'player' },
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'e', side: 'enemy', at: [6, 2] },
        ]);
        expect(act(notYet, { type: 'abandon', actorId: 'a' }).events[0].type).toBe('rejected');
    });
});

describe('morale and rout', () => {
    const shaken = (leaderStatus: Combatant['status'], extraEnemy = false): CombatState => {
        const defs: Def[] = [
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'boss', side: 'enemy', at: [7, 0], tier: 'elite', hp: 30, maxHp: 30, startHp: 30, status: leaderStatus },
            { id: 'g', side: 'enemy', at: [5, 2], tier: 'grunt', hp: 4, maxHp: 8, startHp: 8 },
        ];
        if (extraEnemy) defs.push({ id: 'g2', side: 'enemy', at: [5, 3], tier: 'grunt', hp: 8, maxHp: 8, startHp: 8 });
        const s = board(defs, { order: ['pc', 'g', 'boss', ...(extraEnemy ? ['g2'] : [])], turnIndex: 0 });
        if (leaderStatus !== 'up') s.combatants.boss.hp = 0;
        return s;
    };

    it('rolls d20 + tier save against DC 15 when the leader is down and half the side HP is gone, once per fight', () => {
        const s = shaken('down');
        const r = act(s, { type: 'end_turn', actorId: 'pc' });
        const morale = r.events.find(e => e.type === 'morale')!;
        expect(morale.actorId).toBe('g');
        expect(morale.data.dc).toBe(15);
        expect(morale.data.total).toBe((morale.data.natural as number) + TIER_TABLE.grunt.save);
        expect(r.state.combatants.g.moraleRolled).toBe(true);
        expect(r.state.combatants.g.routed).toBe(morale.data.success !== true);
        const again = act({ ...r.state, turnIndex: 0, turn: undefined }, { type: 'end_turn', actorId: 'pc' });
        expect(again.events.some(e => e.type === 'morale')).toBe(false);
    });

    it('uses DC 10 when only outnumbered, and never rolls when neither condition holds or HP loss is under half', () => {
        const outnumbered = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'a', side: 'ally', at: [0, 3] },
            { id: 'g', side: 'enemy', at: [5, 2], hp: 2, maxHp: 8, startHp: 8 },
            { id: 'g2', side: 'enemy', at: [6, 2], hp: 0, maxHp: 8, startHp: 8, status: 'down' },
        ], { order: ['pc', 'g', 'a', 'g2'] });
        outnumbered.morale = { ...outnumbered.morale!, leaders: { party: 'pc', enemy: 'g' } };
        const r = act(outnumbered, { type: 'end_turn', actorId: 'pc' });
        expect(r.events.find(e => e.type === 'morale')?.data.dc).toBe(10);
        const fresh = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'g', side: 'enemy', at: [5, 2], hp: 8, maxHp: 8, startHp: 8 },
            { id: 'g2', side: 'enemy', at: [6, 2], hp: 8, maxHp: 8, startHp: 8 },
        ], { order: ['pc', 'g', 'g2'] });
        expect(act(fresh, { type: 'end_turn', actorId: 'pc' }).events.some(e => e.type === 'morale')).toBe(false);
    });

    it('never rolls for elites, bosses or summons', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'el', side: 'enemy', at: [5, 2], tier: 'elite', hp: 5, maxHp: 30, startHp: 30 },
            { id: 's', side: 'enemy', at: [6, 2], tier: 'minion', hp: 1, maxHp: 4, startHp: 4, summonerId: 'el' },
            { id: 'lead', side: 'enemy', at: [7, 2], tier: 'boss', hp: 0, maxHp: 65, startHp: 65, status: 'down' },
        ], { order: ['pc', 'el', 's', 'lead'] });
        const r = runEngineTurns(act(s, { type: 'end_turn', actorId: 'pc' }).state);
        expect(r.events.some(e => e.type === 'morale')).toBe(false);
    });

    it('gives a side of equal tiers no leader, and never counts a summon', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'g1', side: 'enemy', at: [5, 2] },
            { id: 'g2', side: 'enemy', at: [6, 2] },
            { id: 'g3', side: 'enemy', at: [6, 1] },
            { id: 'sum', side: 'enemy', at: [6, 3], tier: 'boss', summonerId: 'g1' },
        ]);
        expect(s.morale?.leaders).toEqual({});
        expect(s.morale?.startHp.enemy).toBe(60);
    });

    it('never rolls at the leader-down DC for three grunts', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'g1', side: 'enemy', at: [5, 2], hp: 0, status: 'down' },
            { id: 'g2', side: 'enemy', at: [6, 2], hp: 4, maxHp: 20, startHp: 20 },
            { id: 'g3', side: 'enemy', at: [6, 1], hp: 4, maxHp: 20, startHp: 20 },
        ], { order: ['pc', 'g1', 'g2', 'g3'] });
        expect(isLeaderDown(s, 'enemy')).toBe(false);
        const r = act(s, { type: 'end_turn', actorId: 'pc' });
        expect(r.events.some(e => e.type === 'morale' && e.data.dc === 15)).toBe(false);
    });

    it('takes the elite of one elite and two minions as leader, and the minions roll at DC 15 once it is down', () => {
        const defs: Def[] = [
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'el', side: 'enemy', at: [7, 0], tier: 'elite', hp: 0, maxHp: 30, startHp: 30, status: 'down' },
            { id: 'm1', side: 'enemy', at: [5, 2], tier: 'minion', hp: 1, maxHp: 4, startHp: 4 },
            { id: 'm2', side: 'enemy', at: [5, 3], tier: 'minion', hp: 4, maxHp: 4, startHp: 4 },
        ];
        const s = board(defs, { order: ['pc', 'el', 'm1', 'm2'] });
        expect(s.morale?.leaders.enemy).toBe('el');
        expect(isLeaderDown(s, 'enemy')).toBe(true);
        const r = act(s, { type: 'end_turn', actorId: 'pc' });
        expect(r.events.find(e => e.type === 'morale')?.data.dc).toBe(15);
    });

    it('takes the first elite in turn order when two elites outrank a grunt', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'g', side: 'enemy', at: [5, 2] },
            { id: 'e1', side: 'enemy', at: [6, 2], tier: 'elite' },
            { id: 'e2', side: 'enemy', at: [6, 1], tier: 'elite' },
        ], { order: ['pc', 'g', 'e1', 'e2'] });
        expect(s.morale?.leaders.enemy).toBe('e1');
    });

    it('gives a side of a single combatant no leader', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'b', side: 'enemy', at: [6, 2], tier: 'boss' },
        ]);
        expect(s.morale?.leaders).toEqual({});
        expect(isLeaderDown({ ...s, combatants: { ...s.combatants, b: { ...s.combatants.b, status: 'down' } } }, 'enemy')).toBe(false);
    });

    it('still names a speaker when the enemy side has no leader', () => {
        const s = board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'g1', side: 'enemy', at: [5, 2] },
            { id: 'g2', side: 'enemy', at: [6, 2] },
        ]);
        expect(resolveSpeaker(s, null)?.id).toBe('g1');
    });

    it('sends a routed enemy to the nearest edge, then flees it, and survives a save and restore mid-rout', () => {
        const seed = findSeed(n => act(withSeed(shaken('down', true), n), { type: 'end_turn', actorId: 'pc' }).state.combatants.g.routed === true);
        const routed = act(withSeed(shaken('down', true), seed), { type: 'end_turn', actorId: 'pc' }).state;
        expect(currentActorId(routed)).toBe('g');
        const step = stepEngine(routed)!;
        const move = step.events.find(e => e.type === 'moved' && e.actorId === 'g');
        expect(move).toBeDefined();
        expect(step.events.some(e => e.type === 'attack' && e.actorId === 'g')).toBe(false);
        const saved = JSON.parse(JSON.stringify(step.state)) as CombatState;
        const a = runEngineTurns(step.state);
        const b = runEngineTurns(saved);
        expect(b.state).toEqual(a.state);
        expect(b.events).toEqual(a.events);
        let s = a.state;
        for (let i = 0; i < 6 && s.combatants.g.status === 'up' && !s.outcome; i++) {
            const pcTurn = act(s, { type: 'end_turn', actorId: 'pc' });
            s = runEngineTurns(pcTurn.state).state;
        }
        expect(['fled', 'down']).toContain(s.combatants.g.status);
    });
});

describe('parley', () => {
    const talk = (extra: Partial<CombatState> = {}, enemyHp = 8): CombatState => board([
        { id: 'pc', side: 'player', at: [0, 2], abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 14 }, proficiency: 2 },
        { id: 'boss', side: 'enemy', at: [6, 1], tier: 'elite', hp: 30, maxHp: 30, startHp: 30, name: 'Captain' },
        { id: 'g', side: 'enemy', at: [6, 3], hp: enemyHp, maxHp: 8, startHp: 8 },
        { id: 'n', side: 'neutral', at: [3, 0] },
    ], { order: ['pc', 'boss', 'g', 'n'], ...extra });

    it('maps each rating to its DC, with no roll for hopeless', () => {
        const ratings: ParleyRating[] = ['easy', 'even', 'hard'];
        for (const rating of ratings) {
            const r = act(talk(), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating });
            const ev = r.events.find(e => e.type === 'parley')!;
            expect(ev.data.dc).toBe(PARLEY_DC[rating as 'easy']);
            expect(ev.data.total).toBe((ev.data.natural as number) + 2 + 2);
            expect(ev.data.success).toBe((ev.data.total as number) >= (ev.data.dc as number));
        }
        const hopeless = act(talk(), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'hopeless' });
        const ev = hopeless.events.find(e => e.type === 'parley')!;
        expect(ev.data).toMatchObject({ success: false, effect: 'failed' });
        expect(ev.data.dc).toBeUndefined();
        expect(hopeless.state.rngCursor).toBe(talk().rngCursor);
        expect(hopeless.state.outcome).toBeNull();
    });

    it('shifts the DC by side losses and earlier failures; taunts and other words count for nothing', () => {
        expect(parleyDc(talk(), 'even')).toBe(13);
        const beaten = talk();
        beaten.combatants.boss = { ...beaten.combatants.boss, hp: 5 };
        expect(parleyDc(beaten, 'even')).toBe(10);
        const hurt = talk();
        hurt.combatants.pc = { ...hurt.combatants.pc, hp: 5 };
        expect(parleyDc(hurt, 'even')).toBe(16);
        const failures = talk({ parleys: [
            { round: 1, turn: 1, actorId: 'pc', intent: 'ceasefire', rating: 'hopeless', success: false, effect: 'failed' },
            { round: 1, turn: 2, actorId: 'pc', intent: 'taunt', rating: 'easy', success: false, effect: 'none' },
            { round: 2, turn: 3, actorId: 'pc', intent: 'bargain', rating: 'hard', dc: 18, natural: 2, total: 6, success: false, effect: 'failed' },
        ] });
        expect(parleyDc(failures, 'even')).toBe(17);
        const taunt = act(talk(), { type: 'parley', actorId: 'pc', intent: 'taunt', rating: 'easy' });
        expect(taunt.events.find(e => e.type === 'parley')!.data).toMatchObject({ effect: 'none', success: false });
        expect(taunt.state.rngCursor).toBe(talk().rngCursor);
        expect(taunt.state.turn?.actionUsed).toBe(true);
    });

    it('applies each successful intent: truce, carried away, or the enemies yield', () => {
        const winSeed = findSeed(n => act(withSeed(talk(), n), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'easy' }).state.outcome === 'truce');
        const truce = act(withSeed(talk(), winSeed), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'easy' });
        expect(truce.state.outcome).toBe('truce');
        expect(truce.events.find(e => e.type === 'combat_ended')?.text).toBe('The fighting stops under a truce.');
        const leave = act(withSeed(talk({ defeatMode: 'ironman' }), winSeed), { type: 'parley', actorId: 'pc', intent: 'let_go', rating: 'easy' });
        expect(leave.state.outcome).toBe('fled');
        expect(leave.state.ending?.carried).toBe(true);
        expect(leave.state.fate).toBeUndefined();
        const yielded = act(withSeed(talk(), winSeed), { type: 'parley', actorId: 'pc', intent: 'surrender_demand', rating: 'easy' });
        expect(yielded.state.outcome).toBe('victory');
        expect(yielded.state.combatants.boss.status).toBe('surrendered');
        expect(yielded.state.combatants.g.status).toBe('surrendered');
        expect(yielded.state.combatants.n.status).toBe('up');
    });

    it('lets a natural 20 fail when the total is short, and refuses a second attempt in the same turn', () => {
        const tough = talk();
        const seed = findSeed(n => {
            const ev = act(withSeed(tough, n), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'hard' }).events.find(e => e.type === 'parley');
            return ev?.data.natural === 20;
        });
        const r = act(withSeed({ ...tough, parleys: Array.from({ length: 3 }, (_, i) => ({ round: 1, turn: i, actorId: 'pc', intent: 'ceasefire' as const, rating: 'hard' as const, success: false, effect: 'failed' as const })) }, seed), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'hard' });
        const ev = r.events.find(e => e.type === 'parley')!;
        if (ev.data.natural === 20) expect(ev.data.success).toBe((ev.data.total as number) >= 24);
        const again = act(act(talk(), { type: 'parley', actorId: 'pc', intent: 'taunt', rating: 'easy' }).state, { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'easy' });
        expect(again.events[0].type).toBe('rejected');
    });

    it('validates the speaker: a named up enemy, else the leader, else the first enemy up', () => {
        const s = talk();
        expect(resolveSpeaker(s, 'g')?.id).toBe('g');
        expect(resolveSpeaker(s, 'captain')?.id).toBe('boss');
        expect(resolveSpeaker(s, 'n')?.id).toBe('boss');
        expect(resolveSpeaker(s, 'nobody')?.id).toBe('boss');
        const leaderDown = talk();
        leaderDown.combatants.boss = { ...leaderDown.combatants.boss, status: 'down', hp: 0 };
        expect(resolveSpeaker(leaderDown, null)?.id).toBe('g');
    });

    it('only lets the player character parley', () => {
        const s = board([
            { id: 'a', side: 'ally', at: [0, 2], controller: 'player' },
            { id: 'pc', side: 'player', at: [0, 3] },
            { id: 'e', side: 'enemy', at: [6, 2] },
        ]);
        expect(act(s, { type: 'parley', actorId: 'a', intent: 'ceasefire', rating: 'easy' }).events[0].type).toBe('rejected');
    });
});

describe('hard modes', () => {
    const lost = (mode: CombatState['defeatMode'], pcStatus: Combatant['status'] = 'up', allyStatus: Combatant['status'] = 'down'): CombatState => board([
        { id: 'e', side: 'enemy', at: [1, 2], attackBonus: 50, damage: { count: 10, sides: 6, bonus: 50, type: 'slashing' } },
        { id: 'pc', side: 'player', at: [0, 2], hp: 1, status: pcStatus },
        { id: 'a', side: 'ally', at: [0, 0], status: allyStatus, hp: allyStatus === 'up' ? 20 : 0 },
    ], { order: ['e', 'pc', 'a'], ...(mode ? { defeatMode: mode } : {}) });

    it('keeps knockout as before: no fate roll', () => {
        const r = act(lost('knockout'), { type: 'attack', actorId: 'e', targetId: 'pc' });
        expect(r.state.outcome).toBe('defeat');
        expect(r.state.fate).toBeUndefined();
        expect(r.events.some(e => e.type === 'fate')).toBe(false);
    });

    it('kills the player character on an ironman defeat without a roll', () => {
        const before = lost('ironman');
        const r = act(before, { type: 'attack', actorId: 'e', targetId: 'pc' });
        expect(r.state.outcome).toBe('defeat');
        expect(r.state.fate).toEqual({ pcId: 'pc', mode: 'ironman', dies: true });
    });

    it('rolls d20 in hardcore: 1 to 7 dies, 8 to 20 survives', () => {
        const seen = new Set<boolean>();
        for (let seed = 1; seed < 60 && seen.size < 2; seed++) {
            const r = act(withSeed(lost('hardcore'), seed), { type: 'attack', actorId: 'e', targetId: 'pc' });
            const fate = r.state.fate!;
            expect(fate.mode).toBe('hardcore');
            expect(fate.dies).toBe((fate.natural as number) <= 7);
            seen.add(fate.dies);
        }
        expect(seen.size).toBe(2);
    });

    it('rolls when the fight ends as fled with the player character down and left behind', () => {
        const s = board([
            { id: 'a', side: 'ally', at: [0, 2] },
            { id: 'pc', side: 'player', at: [3, 3], status: 'down', hp: 0 },
            { id: 'e', side: 'enemy', at: [6, 2] },
        ], { defeatMode: 'ironman', order: ['a', 'pc', 'e'] });
        const r = act({ ...s, combatants: { ...s.combatants, a: { ...s.combatants.a, controller: 'player' } } }, { type: 'flee', actorId: 'a' });
        expect(r.state.outcome).toBe('fled');
        expect(r.state.fate?.dies).toBe(true);
    });

    it('lets a downed player character survive a victory, and concede always applies the rules', () => {
        const v = board([
            { id: 'a', side: 'ally', at: [5, 2], attackBonus: 50, damage: { count: 10, sides: 6, bonus: 50, type: 'slashing' } },
            { id: 'pc', side: 'player', at: [0, 2], status: 'down', hp: 0 },
            { id: 'e', side: 'enemy', at: [6, 2], hp: 1 },
        ], { defeatMode: 'ironman', order: ['a', 'pc', 'e'] });
        const won = act(v, { type: 'attack', actorId: 'a', targetId: 'e' });
        expect(won.state.outcome).toBe('victory');
        expect(won.state.fate).toBeUndefined();
        const conceded = concedeCombat(board([
            { id: 'pc', side: 'player', at: [0, 2] },
            { id: 'e', side: 'enemy', at: [6, 2] },
        ], { defeatMode: 'ironman' }));
        expect(conceded.state.outcome).toBe('defeat');
        expect(conceded.state.ending?.conceded).toBe(true);
        expect(conceded.state.fate?.dies).toBe(true);
        expect(concedeCombat(board([{ id: 'pc', side: 'player', at: [0, 2] }, { id: 'e', side: 'enemy', at: [6, 2] }], { defeatMode: 'knockout' })).state.fate).toBeUndefined();
    });
});

describe('party control in the engine', () => {
    const pcInput = { name: 'Kira', sheet, weapon: { quality: 'common' as const, scalingStat: 'STR' as const } };

    it('hands allies to the player only in player mode and gives ally casters the caster kit in every mode', () => {
        const pc = buildPcCombatant(pcInput);
        const spec = { id: 'f', combatants: [
            { name: 'Mage', side: 'ally' as const, tier: 'grunt' as const, archetype: 'caster' as const },
            { name: 'Bandit', side: 'enemy' as const, tier: 'grunt' as const },
        ] };
        const engine = createCombat({ ...spec, partyControl: 'engine' }, pc, 3).state;
        const player = createCombat({ ...spec, partyControl: 'player', defeatMode: 'hardcore' }, pc, 3).state;
        const mage = (s: CombatState) => Object.values(s.combatants).find(c => c.name === 'Mage')!;
        expect(mage(engine).controller).toBe('engine');
        expect(mage(player).controller).toBe('player');
        expect(mage(engine).kit?.length).toBeGreaterThan(0);
        expect(mage(engine).maxMp).toBeUndefined();
        expect(player.partyControl).toBe('player');
        expect(player.defeatMode).toBe('hardcore');
        expect(Object.values(player.combatants).every(c => c.startHp === c.hp)).toBe(true);
    });

    it('saves a player-controlled ally with its tier bonus, the player character with proficiency', () => {
        const ally = unit({ id: 'a', side: 'ally', at: [0, 0], controller: 'player', tier: 'elite' });
        expect(saveModifier(ally, 'CON')).toBe(TIER_TABLE.elite.save);
        const pc = unit({ id: 'pc', side: 'player', at: [0, 1], proficiency: 2 });
        expect(saveModifier(pc, 'CON')).toBe(2);
    });

    it('gives summons of the party to the player in player mode only', () => {
        const summonKit = [{ id: 'sum', name: 'Wolf', form: { id: 'touch' as const, augments: [] }, effects: [{ id: 'summon' as const, augments: [] }], source: 'preset' as const }];
        const make = (partyControl: CombatState['partyControl']) => board([
            { id: 'pc', side: 'player', at: [0, 2], kit: summonKit, maxMp: 20, mp: 20, proficiency: 2 },
            { id: 'e', side: 'enemy', at: [7, 2] },
        ], { partyControl });
        for (const [mode, controller] of [['player', 'player'], ['engine', 'engine']] as const) {
            const r = act(make(mode), { type: 'use_ability', actorId: 'pc', abilityId: 'sum', aim: { x: 1, y: 2 } });
            const summoned = Object.values(r.state.combatants).find(c => c.summonerId === 'pc');
            expect(summoned?.controller).toBe(controller);
        }
    });
});
