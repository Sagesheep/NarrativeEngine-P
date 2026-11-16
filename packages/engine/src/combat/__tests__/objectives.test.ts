import { describe, it, expect } from 'vitest';
import {
    applyAction, buildPcCombatant, chooseEngineTurn, COMBAT_EVENT_TYPES, concedeCombat, createCombat, currentActorId, distance, normalizeObjectiveRequest,
    OBJECTIVE_EVENT_TYPES, objectiveMarks, planReinforcements, planTurn, reinforcementBudget, runEngineTurns, teamLoss, undoObjectiveEvent,
    validateObjective, isWalkable, tileAt, SPAWN_COLUMNS, distanceField,
} from '../index';
import type {
    CombatAction, CombatEvent, CombatObjective, CombatSpec, CombatState, Combatant, CombatantSpec, Grid, ObjectiveRequest, Pos, ReinforcementBook,
    ReinforcementRequest,
} from '../index';
import { arena, caster, cursorFor, foe, openGrid } from './glyphFixtures';

const at = (x: number, y: number): Pos => ({ x, y });

function hero(pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return caster([], pos, { maxHp: 30, hp: 30, ...extra });
}

function ally(id: string, pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return foe(id, pos, { side: 'ally', ...extra });
}

function setUp(units: Combatant[], objective: CombatObjective, extra: Partial<CombatState> = {}): CombatState {
    return arena(units, { objective, ...extra });
}

function endTurn(s: CombatState): { state: CombatState; events: CombatEvent[] } {
    return applyAction(s, { type: 'end_turn', actorId: currentActorId(s) as string });
}

function types(events: CombatEvent[]): string[] {
    return events.map(e => e.type);
}

const sheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };
const fighter = () => buildPcCombatant({ name: 'PC', sheet, weapon: { quality: 'common', scalingStat: 'STR' } });
const grunts = (n: number): CombatantSpec[] => Array.from({ length: n }, (_, i) => ({ name: `Foe ${i + 1}`, side: 'enemy', tier: 'grunt' }));
const medium = { size: 'medium' as const, area: 'open' as const, density: 'sparse' as const };

function start(objective: ObjectiveRequest | undefined, roster: CombatantSpec[] = grunts(3), extra: Partial<CombatSpec> = {}, seed = 11) {
    return createCombat({ id: 'o', combatants: roster, map: medium, mapSeed: seed * 31 + 17, ...(objective ? { objective } : {}), ...extra }, fighter(), seed);
}

function drive(state: CombatState, log: CombatEvent[] = [], limit = 3000): CombatState {
    let s = state;
    for (let i = 0; i < limit && !s.outcome; i++) {
        const id = currentActorId(s) as string;
        if (s.combatants[id]?.controller === 'engine' || s.combatants[id]?.status !== 'up') {
            const r = runEngineTurns(s);
            log.push(...r.events);
            s = r.state;
            continue;
        }
        const action: CombatAction = chooseEngineTurn(s, id).actions[0] ?? { type: 'end_turn', actorId: id };
        const r = applyAction(s, action);
        if (r.events.some(e => e.type === 'rejected')) throw new Error(`rejected ${JSON.stringify(action)}`);
        log.push(...r.events);
        s = r.state;
    }
    return s;
}

describe('objective model: win conditions', () => {
    it('escape: the player character ends a turn on an exit and the fight is won', () => {
        const s = setUp([hero(at(10, 0)), foe('e', at(15, 11))], { win: { kind: 'escape', exits: [at(10, 0)], everyone: false } });
        const r = endTurn(s);
        expect(r.state.outcome).toBe('victory');
        expect(r.state.combatants.pc.status).toBe('escaped');
        expect(r.state.combatants.pc.position).toBeUndefined();
        expect(r.state.objective?.result).toMatchObject({ status: 'won', by: 'escape', outcome: 'victory' });
        expect(types(r.events)).toEqual(expect.arrayContaining(['objective_progress', 'objective_met', 'combat_ended']));
        const ended = r.events.find(e => e.type === 'combat_ended');
        expect(ended?.data.objective).toMatchObject({ status: 'won', by: 'escape' });
    });

    it('escape: not met while the player character stands elsewhere', () => {
        const s = setUp([hero(at(9, 1)), foe('e', at(15, 11))], { win: { kind: 'escape', exits: [at(10, 0)], everyone: false } });
        expect(endTurn(s).state.outcome).toBeNull();
    });

    it('escape with everyone waits for every standing party member', () => {
        const s = setUp([hero(at(10, 0)), ally('a', at(3, 3)), foe('e', at(15, 11))], { win: { kind: 'escape', exits: [at(10, 0), at(11, 0)], everyone: true } });
        const first = endTurn(s);
        expect(first.state.outcome).toBeNull();
        expect(first.state.combatants.pc.status).toBe('escaped');
        expect(currentActorId(first.state)).toBe('a');
        const moved = { ...first.state, combatants: { ...first.state.combatants, a: { ...first.state.combatants.a, position: at(11, 0) } } };
        const second = endTurn(moved);
        expect(second.state.outcome).toBe('victory');
        expect(second.state.objective?.progress?.escaped).toEqual(['pc', 'a']);
    });

    it('escape: a player character thrown onto the exit leaves only at the end of its own turn', () => {
        const s = setUp([foe('e', at(15, 11)), hero(at(10, 0))], { win: { kind: 'escape', exits: [at(10, 0)], everyone: false } });
        const enemyEnd = endTurn(s);
        expect(enemyEnd.state.outcome).toBeNull();
        expect(enemyEnd.state.combatants.pc.status).toBe('up');
        expect(endTurn(enemyEnd.state).state.outcome).toBe('victory');
    });

    it('seize: held from the end of a turn to the start of the holder\'s next turn', () => {
        const s = setUp([hero(at(8, 6)), foe('e', at(15, 11))], { win: { kind: 'seize', tile: at(8, 6) } });
        const held = endTurn(s);
        expect(held.state.objective?.progress?.holderId).toBe('pc');
        expect(held.events.find(e => e.type === 'objective_progress')?.data.kind).toBe('holding');
        expect(held.state.outcome).toBeNull();
        const back = endTurn(held.state);
        expect(back.state.outcome).toBe('victory');
        expect(back.state.round).toBe(2);
        expect(back.state.objective?.result?.by).toBe('seize');
    });

    it('seize: a unit shoved onto the tile does not hold it, and a holder moved off loses the hold', () => {
        const shoved = setUp([foe('e', at(15, 11)), hero(at(8, 6))], { win: { kind: 'seize', tile: at(8, 6) } });
        const r = endTurn(shoved);
        expect(r.state.outcome).toBeNull();
        expect(r.state.objective?.progress?.holderId).toBeUndefined();
        const s = setUp([hero(at(8, 6)), foe('e', at(15, 11))], { win: { kind: 'seize', tile: at(8, 6) } });
        const held = endTurn(s).state;
        const pushed = { ...held, combatants: { ...held.combatants, pc: { ...held.combatants.pc, position: at(9, 6) } } };
        const lost = endTurn(pushed);
        expect(lost.events.some(e => e.type === 'objective_progress' && e.data.kind === 'hold_broken')).toBe(true);
        expect(lost.state.outcome).toBeNull();
    });

    it('survive: the player character standing at the end of round N wins; down with an ally standing fails', () => {
        const won = endTurn(setUp([hero(at(1, 1)), foe('e', at(15, 11))], { win: { kind: 'survive', rounds: 2 } }, { round: 2, turnIndex: 1 }));
        expect(won.state.outcome).toBe('victory');
        expect(won.state.objective?.result?.by).toBe('survive');
        const early = endTurn(setUp([hero(at(1, 1)), foe('e', at(15, 11))], { win: { kind: 'survive', rounds: 3 } }, { round: 2, turnIndex: 1 }));
        expect(early.state.outcome).toBeNull();
        const failed = endTurn(setUp([hero(at(1, 1), { status: 'down', hp: 0 }), ally('a', at(2, 2)), foe('e', at(15, 11))], { win: { kind: 'survive', rounds: 2 } }, { round: 2, turnIndex: 2 }));
        expect(failed.state.outcome).toBe('defeat');
        expect(failed.state.objective?.result).toMatchObject({ status: 'lost', by: 'survive' });
    });

    it('the round limit and the win on the same turn: the win takes it', () => {
        const obj: CombatObjective = { win: { kind: 'survive', rounds: 2 }, lose: [{ kind: 'round_limit' }], roundLimit: 2 };
        const r = endTurn(setUp([hero(at(1, 1)), foe('e', at(15, 11))], obj, { round: 2, turnIndex: 1 }));
        expect(r.state.objective?.result?.by).toBe('survive');
        const late = endTurn(setUp([hero(at(1, 1)), foe('e', at(15, 11))], { win: { kind: 'rout' }, lose: [{ kind: 'round_limit' }], roundLimit: 2 }, { round: 2, turnIndex: 1 }));
        expect(late.state.outcome).toBe('defeat');
        expect(late.state.objective?.result?.by).toBe('round_limit');
        expect(late.events.some(e => e.type === 'objective_failed')).toBe(true);
    });

    it('protect alone: the ward standing after N rounds wins; the ward falling loses at once', () => {
        const ward = () => ally('w', at(1, 2), { mark: 'ward' });
        const obj: CombatObjective = { win: { kind: 'protect', wardId: 'w', rounds: 2 }, lose: [{ kind: 'ward_falls', wardId: 'w' }] };
        const won = endTurn(setUp([hero(at(1, 1)), ward(), foe('e', at(15, 11))], obj, { round: 2, turnIndex: 2 }));
        expect(won.state.objective?.result?.by).toBe('protect');
        const fell = endTurn(setUp([hero(at(1, 1)), ally('w', at(1, 2), { mark: 'ward', status: 'down', hp: 0 }), foe('e', at(15, 11))], obj));
        expect(fell.state.outcome).toBe('defeat');
        expect(fell.state.objective?.result?.by).toBe('ward_falls');
        const thrown = endTurn(setUp([hero(at(1, 1)), ally('w', at(9, 9), { mark: 'ward', hp: 3 }), foe('e', at(15, 11))], obj));
        expect(thrown.state.outcome).toBeNull();
    });

    it('protect with rout: routing the enemy with the ward down still loses', () => {
        const obj: CombatObjective = { win: { kind: 'protect', wardId: 'w', with: { kind: 'rout' } }, lose: [{ kind: 'ward_falls', wardId: 'w' }] };
        const r = endTurn(setUp([hero(at(1, 1)), ally('w', at(1, 2), { mark: 'ward', status: 'down', hp: 0 }), foe('e', at(15, 11), { status: 'down', hp: 0 }), foe('f', at(14, 11))], obj));
        expect(r.state.objective?.result?.by).toBe('ward_falls');
        const won = endTurn(setUp([hero(at(1, 1)), ally('w', at(1, 2), { mark: 'ward' }), foe('e', at(15, 11), { status: 'down', hp: 0 })], obj));
        expect(won.state.objective?.result).toMatchObject({ status: 'won', by: 'rout' });
    });

    it('defeat_leader: the leader yielding wins, and the rest break at a heavy penalty', () => {
        const units = [hero(at(1, 1)), foe('L', at(14, 5), { status: 'surrendered', mark: 'leader', tier: 'elite' }), foe('g1', at(15, 6)), foe('g2', at(15, 7))];
        const r = endTurn(setUp(units, { win: { kind: 'defeat_leader', leaderId: 'L' } }));
        expect(r.state.outcome).toBe('victory');
        expect(r.state.objective?.result?.by).toBe('defeat_leader');
        const morale = r.events.filter(e => e.type === 'morale');
        expect(morale).toHaveLength(2);
        for (const m of morale) expect(m.data).toMatchObject({ dc: 20, broken: true, leaderDown: true });
        for (const m of morale) {
            const status = r.state.combatants[m.targetId as string].status;
            expect(status).toBe(m.data.success === true ? 'up' : 'fled');
        }
    });

    it('defeat_leader is not met while the leader stands', () => {
        const units = [hero(at(1, 1)), foe('L', at(14, 5), { mark: 'leader' }), foe('g1', at(15, 6), { status: 'down', hp: 0 })];
        expect(endTurn(setUp(units, { win: { kind: 'defeat_leader', leaderId: 'L' } })).state.outcome).toBeNull();
    });
});

describe('objective model: lose conditions and side objectives', () => {
    it('pc_falls ends the fight even with allies standing, and the defeat mode still rolls fate', () => {
        const units = [foe('e', at(15, 11)), hero(at(1, 1), { status: 'down', hp: 0 }), ally('a', at(2, 2))];
        const r = endTurn(setUp(units, { win: { kind: 'rout' }, lose: [{ kind: 'pc_falls' }] }, { defeatMode: 'ironman' }));
        expect(r.state.outcome).toBe('defeat');
        expect(r.state.objective?.result?.by).toBe('pc_falls');
        expect(r.events.some(e => e.type === 'fate')).toBe(true);
        const plain = endTurn(setUp(units, { win: { kind: 'rout' } }));
        expect(plain.state.outcome).toBeNull();
    });

    it('leader_escapes: the leader leaving by its exit loses; escaped does not count as fled for morale', () => {
        const units = [foe('L', at(3, 0), { mark: 'leader', tier: 'elite' }), hero(at(12, 8)), foe('g', at(15, 11))];
        const r = endTurn(setUp(units, { win: { kind: 'rout' }, lose: [{ kind: 'leader_escapes', leaderId: 'L', exits: [at(3, 0)] }] }));
        expect(r.state.combatants.L.status).toBe('escaped');
        expect(r.state.outcome).toBe('defeat');
        expect(r.state.objective?.result?.by).toBe('leader_escapes');
        const book = { startHp: { party: 30, enemy: 60 }, leaders: {} };
        expect(teamLoss({ ...r.state, morale: book }, 'enemy').lost).toBe(0);
        const fled = { ...r.state, morale: book, combatants: { ...r.state.combatants, L: { ...r.state.combatants.L, status: 'fled' as const } } };
        expect(teamLoss(fled, 'enemy').lost).toBe(30);
    });

    it('records side objectives, met and not met', () => {
        const exitWin = (side: CombatObjective['side'], round: number, extra: Combatant[] = []) =>
            endTurn(setUp([hero(at(10, 0)), foe('e', at(15, 11)), ...extra], { win: { kind: 'escape', exits: [at(10, 0)], everyone: false }, ...(side ? { side } : {}) }, { round }));
        expect(exitWin({ kind: 'within_rounds', rounds: 3 }, 2).state.objective?.result?.side).toEqual({ kind: 'within_rounds', met: true });
        expect(exitWin({ kind: 'within_rounds', rounds: 3 }, 4).state.objective?.result?.side).toEqual({ kind: 'within_rounds', met: false });
        expect(exitWin({ kind: 'no_one_falls' }, 2).state.objective?.result?.side?.met).toBe(true);
        expect(exitWin({ kind: 'no_one_falls' }, 2, [ally('a', at(2, 2), { status: 'down', hp: 0 })]).state.objective?.result?.side?.met).toBe(false);
        const by = (status: Combatant['status']) => exitWin({ kind: 'save_bystander', bystanderId: 'n' }, 2, [foe('n', at(7, 7), { side: 'neutral', mark: 'bystander', status })]);
        expect(by('up').state.objective?.result?.side?.met).toBe(true);
        expect(by('down').state.objective?.result?.side?.met).toBe(false);
        const r = endTurn(setUp([hero(at(6, 6)), foe('e', at(15, 11))], { win: { kind: 'rout' }, side: { kind: 'reach_tile', tile: at(6, 6) } }));
        expect(r.state.objective?.progress?.reachedBy).toBe('pc');
        const conceded = concedeCombat(r.state);
        expect(conceded.state.objective?.result).toMatchObject({ status: 'lost', by: 'conceded', side: { kind: 'reach_tile', met: true } });
        expect(conceded.events.some(e => e.type === 'objective_met' && e.data.part === 'side')).toBe(true);
    });
});

describe('flee and parley under every objective', () => {
    const variants: Array<[string, CombatObjective, Combatant[]]> = [
        ['rout', { win: { kind: 'rout' } }, []],
        ['defeat_leader', { win: { kind: 'defeat_leader', leaderId: 'e' } }, []],
        ['survive', { win: { kind: 'survive', rounds: 4 } }, []],
        ['escape', { win: { kind: 'escape', exits: [at(10, 0)], everyone: false } }, []],
        ['seize', { win: { kind: 'seize', tile: at(8, 6) } }, []],
        ['protect', { win: { kind: 'protect', wardId: 'w', rounds: 4 }, lose: [{ kind: 'ward_falls', wardId: 'w' }] }, [ally('w', at(0, 9), { mark: 'ward' })]],
        ['leader_escapes', { win: { kind: 'rout' }, lose: [{ kind: 'leader_escapes', leaderId: 'e', exits: [at(5, 11)] }] }, []],
    ];
    for (const [name, objective, extra] of variants) {
        it(`${name}: fleeing and parley still work and the end is recorded`, () => {
            const base = { round: 2, turnStart: { actorId: 'pc', pos: at(0, 5) } };
            const units = [hero(at(0, 5)), foe('e', at(15, 11)), ...extra];
            const fled = applyAction(setUp(units, objective, base), { type: 'flee', actorId: 'pc' });
            expect(fled.events.some(e => e.type === 'rejected')).toBe(false);
            if (extra.length === 0) {
                expect(fled.state.outcome).toBe('fled');
                expect(fled.state.objective?.result).toMatchObject({ status: 'ended', by: 'fled' });
            } else {
                expect(fled.state.outcome).toBeNull();
            }
            const cursor = cursorFor(7, rolls => rolls[0] >= 15, 1);
            const talk = applyAction(setUp(units, objective, { ...base, rngCursor: cursor }), { type: 'parley', actorId: 'pc', intent: 'ceasefire', rating: 'easy' });
            expect(talk.state.outcome).toBe('truce');
            expect(talk.state.objective?.result).toMatchObject({ status: 'ended', by: 'parley', parleyIntent: 'ceasefire' });
        });
    }
});

function mediumSetup(units: Combatant[]): { grid: Grid; combatants: Combatant[] } {
    return { grid: openGrid(14, 10), combatants: units };
}

describe('validation and repairs', () => {
    const units = () => [hero(at(0, 5)), foe('L', at(13, 5), { name: 'Captain', tier: 'elite' }), foe('g', at(13, 6), { name: 'Grunt' }), ally('w', at(1, 4), { name: 'Ward' }), foe('n', at(6, 5), { name: 'Villager', side: 'neutral' })];

    it('chooses exit, seize and reach tiles that are walkable, reachable, outside the start areas and far enough', () => {
        const setup = mediumSetup(units());
        const field = distanceField(setup.grid, [at(0, 5)]);
        const esc = validateObjective({ win: 'escape' }, setup).objective;
        const exits = esc.win.kind === 'escape' ? esc.win.exits : [];
        expect(exits.length).toBeGreaterThan(0);
        for (const p of exits) {
            expect(isWalkable(setup.grid, p)).toBe(true);
            expect(p.x >= SPAWN_COLUMNS && p.x < 14 - SPAWN_COLUMNS).toBe(true);
            expect(p.y === 0 || p.y === 9).toBe(true);
            expect(field[p.y * 14 + p.x]).toBeGreaterThanOrEqual(7);
        }
        const seize = validateObjective({ win: 'seize', side: 'reach_tile' }, setup).objective;
        const tile = seize.win.kind === 'seize' ? seize.win.tile : at(0, 0);
        expect(tileAt(setup.grid, tile)).toBe('floor');
        expect(field[tile.y * 14 + tile.x]).toBeGreaterThanOrEqual(7);
        expect(seize.side?.kind).toBe('reach_tile');
    });

    it('reports every repair', () => {
        const setup = mediumSetup(units());
        const codes = (req: unknown) => validateObjective(req, setup).repairs.map(r => r.code);
        expect(validateObjective({ win: 'conquer' }, setup)).toMatchObject({ objective: { win: { kind: 'rout' } } });
        expect(codes({ win: 'conquer' })).toContain('unknown_kind');
        const picked = validateObjective({ win: 'defeat_leader', leader: 'Nobody' }, setup);
        expect(picked.objective.win).toEqual({ kind: 'defeat_leader', leaderId: 'L' });
        expect(picked.repairs.map(r => r.code)).toEqual(['missing_unit', 'picked_leader']);
        expect(codes({ win: 'defeat_leader', leader: 'Ward' })).toEqual(['wrong_side', 'picked_leader']);
        const twoGrunts = mediumSetup([hero(at(0, 5)), foe('a', at(13, 5)), foe('b', at(13, 6))]);
        expect(validateObjective({ win: 'defeat_leader' }, twoGrunts).objective.win.kind).toBe('rout');
        expect(validateObjective({ win: 'defeat_leader' }, twoGrunts).repairs.map(r => r.code)).toContain('fallback_rout');
        expect(codes({ win: 'protect', ward: 'Captain' })).toEqual(['wrong_side', 'fallback_rout']);
        expect(codes({ win: 'protect' })).toEqual(['missing_unit', 'fallback_rout']);
        expect(codes({ win: 'rout', side: 'save_bystander', bystander: 'Ghost' })).toEqual(['missing_unit', 'side_dropped']);
        expect(codes({ win: 'rout', side: 'sing' })).toEqual(['side_dropped']);
        const clamped = validateObjective({ win: 'survive', rounds: 50 }, setup);
        expect(clamped.objective.win).toEqual({ kind: 'survive', rounds: 8 });
        expect(clamped.repairs[0]).toMatchObject({ code: 'clamped', from: 50, to: 8 });
        expect(validateObjective({ win: 'survive', rounds: 0 }, setup).objective.win).toEqual({ kind: 'survive', rounds: 2 });
        const raised = validateObjective({ win: 'survive', rounds: 6, lose: ['round_limit'], roundLimit: 4 }, setup);
        expect(raised.objective.roundLimit).toBe(6);
        expect(raised.repairs.map(r => r.code)).toContain('round_limit_raised');
        const escape = validateObjective({ win: 'escape', lose: ['round_limit'], roundLimit: 3 }, setup);
        expect(escape.objective.roundLimit).toBeGreaterThanOrEqual(4);
        expect(escape.repairs.map(r => r.code)).toEqual(['round_limit_raised']);
        expect(codes({ win: 'rout', roundLimit: 5 })).toEqual(['lose_added']);
        expect(codes({ win: 'rout', lose: ['explode'] })).toEqual(['lose_dropped']);
        expect(codes({ win: 'rout', lose: ['ward_falls'] })).toContain('lose_dropped');
        const ward = validateObjective({ win: 'protect', ward: 'Ward' }, setup);
        expect(ward.objective.lose).toEqual([{ kind: 'ward_falls', wardId: 'w' }]);
        expect(ward.repairs.map(r => r.code)).toEqual(['lose_added']);
        const moved = validateObjective({ win: 'escape', exits: [at(0, 0)] }, setup);
        expect(moved.repairs.map(r => r.code)).toEqual(['tile_moved']);
        const movedSeize = validateObjective({ win: 'seize', seize: at(1, 5) }, setup);
        expect(movedSeize.repairs.map(r => r.code)).toEqual(['tile_moved']);
        const walled: Grid = { width: 14, height: 10, tiles: new Array(140).fill('wall') };
        for (const p of [at(0, 5), at(1, 5), at(13, 5)]) walled.tiles[p.y * 14 + p.x] = 'floor';
        expect(validateObjective({ win: 'seize' }, { grid: walled, combatants: [hero(at(0, 5)), foe('g', at(13, 5))] }).repairs.map(r => r.code)).toEqual(['no_tile', 'fallback_rout']);
        const leader = validateObjective({ win: 'rout', lose: ['leader_escapes'] }, setup);
        expect(leader.objective.lose?.[0]).toMatchObject({ kind: 'leader_escapes', leaderId: 'L' });
    });

    it('parses loose requests', () => {
        expect(normalizeObjectiveRequest('Defeat Leader')).toEqual({ win: 'defeat_leader' });
        expect(normalizeObjectiveRequest({ kind: 'survive', rounds: 4.4, lose: 'round limit', side: 'no-one falls', leader: ' Boss ' }))
            .toEqual({ win: 'survive', rounds: 4, lose: ['round_limit'], side: 'no_one_falls', leader: 'Boss' });
        expect(normalizeObjectiveRequest(null)).toBeNull();
    });

    it('createCombat validates, marks the units and returns the report', () => {
        const roster: CombatantSpec[] = [{ name: 'Captain', side: 'enemy', tier: 'elite' }, ...grunts(2), { name: 'Ward', side: 'ally', tier: 'grunt' }, { name: 'Villager', side: 'neutral', tier: 'minion' }];
        const r = start({ win: 'protect', ward: 'Ward', with: 'defeat_leader', leader: 'Captain', side: 'save_bystander', bystander: 'Villager' }, roster);
        const byName = (n: string) => Object.values(r.state.combatants).find(c => c.name === n) as Combatant;
        expect(byName('Captain').mark).toBe('leader');
        expect(byName('Ward')).toMatchObject({ mark: 'ward', tactic: 'coward' });
        expect(byName('Villager').mark).toBe('bystander');
        expect(r.objective?.objective).toEqual(r.state.objective);
        const marks = objectiveMarks(r.state);
        expect(marks).toMatchObject({ leaderId: byName('Captain').id, wardId: byName('Ward').id, bystanderId: byName('Villager').id });
    });
});

describe('reinforcements', () => {
    const objective = (kind: CombatObjective['win']): CombatObjective => ({ win: kind });

    it('budget by encounter threat, and none for a rout', () => {
        expect(reinforcementBudget('some', objective({ kind: 'survive', rounds: 4 }), grunts(3))).toBe(3);
        expect(reinforcementBudget('many', objective({ kind: 'survive', rounds: 4 }), grunts(3))).toBe(6);
        expect(reinforcementBudget('some', objective({ kind: 'escape', exits: [], everyone: false }), grunts(3))).toBe(2);
        expect(reinforcementBudget('many', objective({ kind: 'rout' }), grunts(3))).toBe(0);
        const rout = planReinforcements('many', objective({ kind: 'rout' }), grunts(3), null);
        expect(rout.plan).toBeNull();
        expect(rout.repairs[0].code).toBe('reinforcements_dropped');
        const over: ReinforcementRequest = { waves: [{ round: 2, combatants: [{ name: 'E', side: 'enemy', tier: 'elite' }, { name: 'M', side: 'enemy', tier: 'minion' }] }] };
        const trimmed = planReinforcements(over, objective({ kind: 'survive', rounds: 4 }), grunts(1), null);
        expect(trimmed.plan?.waves[0].combatants.map(c => c.name)).toEqual(['M']);
        expect(trimmed.repairs.map(r => r.code)).toEqual(['reinforcements_trimmed']);
        const tile = planReinforcements({ waves: [{ trigger: 'tile', combatants: [{ name: 'M', side: 'enemy', tier: 'minion' }] }] }, objective({ kind: 'survive', rounds: 4 }), grunts(3), null);
        expect(tile.plan?.waves[0].trigger).toEqual({ kind: 'round', round: 3 });
        expect(tile.repairs.map(r => r.code)).toEqual(['trigger_changed']);
    });

    it('a round wave is warned a round ahead with its tiles, then arrives on the far edge away from the party', () => {
        const r = start({ win: 'survive', rounds: 4 }, grunts(2), { reinforcements: { waves: [{ round: 2, combatants: [{ name: 'Late', side: 'enemy', tier: 'minion' }] }] } });
        const warning = r.events.find(e => e.type === 'reinforcements_warning');
        expect(warning?.data).toMatchObject({ round: 2, count: 1, edge: 'far' });
        const tiles = warning?.data.tiles as Pos[];
        expect(tiles[0].x).toBe(13);
        expect(r.state.combatants.r1).toBeUndefined();
        const log: CombatEvent[] = [];
        let s = r.state;
        for (let i = 0; i < 200 && s.round < 2 && !s.outcome; i++) {
            const id = currentActorId(s) as string;
            const step = s.combatants[id].controller === 'engine' ? runEngineTurns(s) : applyAction(s, chooseEngineTurn(s, id).actions[0]);
            log.push(...step.events);
            s = step.state;
        }
        const arrive = log.find(e => e.type === 'reinforcements_arrive');
        expect(arrive).toBeDefined();
        const unit = (arrive?.data.units as Array<{ id: string; at: Pos }>)[0];
        expect(s.combatants[unit.id]).toMatchObject({ status: 'up', name: 'Late', side: 'enemy' });
        expect(s.order).toContain(unit.id);
        expect(unit.at.x).toBe(13);
        for (const c of Object.values(s.combatants)) {
            if (c.side === 'player' && c.position) expect(distance(c.position, unit.at)).toBeGreaterThanOrEqual(4);
        }
    });

    it('waits a round when no edge tile is free', () => {
        const book: ReinforcementBook = { budget: 2, waves: [{ id: 'w1', trigger: { kind: 'round', round: 2 }, edge: 'far', units: [foe('r1', at(0, 0))], arriveRound: 2, tiles: [] }] };
        const s = setUp([hero(at(3, 2)), foe('e', at(5, 3))], { win: { kind: 'survive', rounds: 4 } }, { grid: openGrid(6, 4), turnIndex: 1, reinforcements: book });
        const r = endTurn(s);
        expect(r.state.combatants.r1).toBeUndefined();
        const delayed = r.events.find(e => e.type === 'reinforcements_warning');
        expect(delayed?.data).toMatchObject({ delayed: true, round: 3 });
        expect(r.state.reinforcements?.waves[0].arriveRound).toBe(3);
    });

    it('triggers on the leader dropping below half and on the party reaching the marked tiles', () => {
        const half: ReinforcementBook = { budget: 2, waves: [{ id: 'w1', trigger: { kind: 'leader_half', leaderId: 'L' }, edge: 'far', units: [foe('r1', at(0, 0))] }] };
        const units = [hero(at(1, 1)), foe('L', at(14, 5), { hp: 10, maxHp: 30, mark: 'leader' })];
        const r = endTurn(setUp(units, { win: { kind: 'defeat_leader', leaderId: 'L' } }, { reinforcements: half }));
        expect(r.events.find(e => e.type === 'reinforcements_warning')?.data).toMatchObject({ round: 3, trigger: 'leader_half' });
        const calm = endTurn(setUp([hero(at(1, 1)), foe('L', at(14, 5), { mark: 'leader' })], { win: { kind: 'defeat_leader', leaderId: 'L' } }, { reinforcements: half }));
        expect(calm.events.some(e => e.type === 'reinforcements_warning')).toBe(false);
        const tile: ReinforcementBook = { budget: 2, waves: [{ id: 'w1', trigger: { kind: 'tile', tiles: [at(1, 1)] }, edge: 'far', units: [foe('r1', at(0, 0))] }] };
        const reached = endTurn(setUp([hero(at(1, 1)), foe('e', at(14, 5))], { win: { kind: 'survive', rounds: 5 } }, { reinforcements: tile }));
        expect(reached.events.find(e => e.type === 'reinforcements_warning')?.data).toMatchObject({ trigger: 'tile' });
    });
});

function rewind(state: CombatState, log: readonly CombatEvent[], seq: number): Record<string, Combatant> {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) combatants[id] = { ...c, ...(c.position ? { position: { ...c.position } } : {}) };
    for (const e of [...log].filter(e => e.seq > seq).sort((a, b) => b.seq - a.seq)) undoObjectiveEvent(combatants, e);
    return combatants;
}

describe('event lists and replay', () => {
    it('adds the objective events to the event list and undoes each of them', () => {
        expect(COMBAT_EVENT_TYPES).toEqual(expect.arrayContaining([...OBJECTIVE_EVENT_TYPES]));
        for (const t of OBJECTIVE_EVENT_TYPES) expect(undoObjectiveEvent({}, { seq: 1, round: 1, type: t, data: {}, text: '' })).toBe(true);
        expect(undoObjectiveEvent({}, { seq: 1, round: 1, type: 'attack', data: {}, text: '' })).toBe(false);
    });

    it('round trip: escaped units come back where they stood, reinforcements vanish before they arrive', () => {
        const s = setUp([hero(at(10, 0)), foe('e', at(15, 11))], { win: { kind: 'escape', exits: [at(10, 0)], everyone: false } });
        const r = endTurn(s);
        const back = rewind(r.state, r.events, s.eventSeq);
        expect(back.pc).toMatchObject({ status: 'up', position: at(10, 0) });
        const log: CombatEvent[] = [];
        const started = start({ win: 'survive', rounds: 5 }, grunts(3), { reinforcements: 'many', partyControl: 'engine' }, 3);
        log.push(...started.events);
        const end = drive(started.state, log);
        const arrived = log.filter(e => e.type === 'reinforcements_arrive').flatMap(e => (e.data.units as Array<{ id: string }>).map(u => u.id));
        expect(arrived.length).toBeGreaterThan(0);
        const atStart = rewind(end, log, 0);
        for (const id of arrived) expect(atStart[id]).toMatchObject({ status: 'gone' });
        for (const id of arrived) expect(atStart[id].position).toBeUndefined();
    });

    it('fights without an objective carry no objective state or events', () => {
        const r = start(undefined);
        expect('objective' in r).toBe(false);
        expect('objective' in r.state).toBe(false);
        expect('reinforcements' in r.state).toBe(false);
        const log: CombatEvent[] = [...r.events];
        drive(r.state, log);
        expect(log.some(e => OBJECTIVE_EVENT_TYPES.includes(e.type))).toBe(false);
        expect(log.some(e => e.type === 'combat_ended' && 'objective' in e.data)).toBe(false);
    });
});

describe('the AI plays the objective', () => {
    const finalTile = (s: CombatState, steps: CombatAction[], id: string): Pos => {
        let p = s.combatants[id].position as Pos;
        for (const st of steps) if (st.type === 'move') p = st.to;
        return p;
    };

    it('the player\'s stand-in heads for the exit under escape, and onto the seize tile', () => {
        const exit = at(2, 0);
        const units = [hero(at(7, 8), { controller: 'player' }), foe('e', at(15, 11))];
        const plain = planTurn(arena(units), 'pc');
        const run = planTurn(setUp(units, { win: { kind: 'escape', exits: [exit], everyone: false } }), 'pc');
        expect(distance(finalTile(arena(units), run.steps, 'pc'), exit)).toBeLessThan(distance(finalTile(arena(units), plain.steps, 'pc'), exit));
        const seize = planTurn(setUp([hero(at(5, 6)), foe('e', at(15, 11))], { win: { kind: 'seize', tile: at(9, 6) } }), 'pc');
        expect(finalTile(arena(units), seize.steps, 'pc')).toEqual(at(9, 6));
    });

    it('enemies weigh the ward as a high-value target', () => {
        const units = [foe('e', at(5, 5)), hero(at(6, 5), { hp: 20, maxHp: 30, ac: 12 }), ally('w', at(4, 5), { hp: 20, maxHp: 30, ac: 12, mark: 'ward' })];
        const plan = planTurn(setUp(units, { win: { kind: 'protect', wardId: 'w', rounds: 4 }, lose: [{ kind: 'ward_falls', wardId: 'w' }] }), 'e');
        expect(plan.steps.find(s => s.type === 'attack')).toMatchObject({ targetId: 'w' });
    });

    it('enemies guard the exit instead of chasing under escape', () => {
        const exit = at(13, 0);
        const units = [foe('e', at(13, 1)), hero(at(3, 9))];
        const plain = planTurn(arena(units), 'e');
        const guard = planTurn(setUp(units, { win: { kind: 'escape', exits: [exit], everyone: false } }), 'e');
        expect(distance(finalTile(arena(units), guard.steps, 'e'), exit)).toBeLessThan(distance(finalTile(arena(units), plain.steps, 'e'), exit));
    });

    it('the leader runs for its exit under leader_escapes, and screens behind its guards under defeat_leader', () => {
        const exit = at(2, 11);
        const units = [foe('L', at(12, 3), { mark: 'leader', tier: 'elite' }), hero(at(8, 3)), foe('g', at(10, 4))];
        const run = planTurn(setUp(units, { win: { kind: 'rout' }, lose: [{ kind: 'leader_escapes', leaderId: 'L', exits: [exit] }] }), 'L');
        expect(distance(finalTile(arena(units), run.steps, 'L'), exit)).toBeLessThan(distance(at(12, 3), exit));
        const screen = planTurn(setUp([foe('g', at(14, 10)), foe('L', at(12, 3), { mark: 'leader', tier: 'elite' }), hero(at(2, 3))], { win: { kind: 'defeat_leader', leaderId: 'L' } }, {}), 'g');
        expect(distance(finalTile(arena([foe('g', at(14, 10))]), screen.steps, 'g'), at(12, 3))).toBeLessThanOrEqual(3);
    });

    it('a bystander moves away from danger and attacks no one; the ward keeps away too', () => {
        const units = [foe('n', at(7, 5), { side: 'neutral', mark: 'bystander' }), foe('e', at(8, 5)), hero(at(1, 1))];
        const s = setUp(units, { win: { kind: 'rout' }, side: { kind: 'save_bystander', bystanderId: 'n' } });
        const plan = planTurn(s, 'n');
        expect(plan.steps.some(st => st.type === 'attack' || st.type === 'use_ability')).toBe(false);
        expect(distance(finalTile(s, plan.steps, 'n'), at(8, 5))).toBeGreaterThan(1);
        const ward = setUp([ally('w', at(7, 5), { mark: 'ward', tactic: 'coward' }), foe('e', at(9, 5)), hero(at(5, 5))], { win: { kind: 'protect', wardId: 'w', rounds: 3 } });
        const wp = planTurn(ward, 'w');
        expect(distance(finalTile(ward, wp.steps, 'w'), at(9, 5))).toBeGreaterThan(2);
    });

    it('enemies may target the bystander; the party does not', () => {
        const units = [foe('e', at(5, 5)), foe('n', at(6, 5), { side: 'neutral', mark: 'bystander', hp: 4, maxHp: 4 }), hero(at(12, 10))];
        const s = setUp(units, { win: { kind: 'rout' }, side: { kind: 'save_bystander', bystanderId: 'n' } });
        expect(planTurn(s, 'e').steps.find(st => st.type === 'attack')).toMatchObject({ targetId: 'n' });
        const pcTurn = setUp([hero(at(5, 5), { controller: 'player' }), foe('n', at(6, 5), { side: 'neutral', mark: 'bystander' }), foe('e', at(14, 10))], { win: { kind: 'rout' }, side: { kind: 'save_bystander', bystanderId: 'n' } });
        expect(planTurn(pcTurn, 'pc').steps.some(st => st.type === 'attack' && st.targetId === 'n')).toBe(false);
    });
});

describe('seeded objective fights', () => {
    const cases: Array<[ObjectiveRequest, ReinforcementRequest | undefined, CombatantSpec[]]> = [
        [{ win: 'defeat_leader', leader: 'Sergeant' }, 'some', [{ name: 'Sergeant', side: 'enemy', tier: 'grunt' }, ...grunts(2)]],
        [{ win: 'survive', rounds: 4, side: 'no_one_falls' }, 'many', grunts(3)],
        [{ win: 'escape', everyone: true, lose: ['round_limit'], roundLimit: 6 }, 'some', grunts(3)],
        [{ win: 'protect', ward: 'Ward', with: 'rout', side: 'within_rounds' }, undefined, [...grunts(2), { name: 'Ward', side: 'ally', tier: 'grunt' }]],
        [{ win: 'seize', side: 'reach_tile' }, 'some', grunts(3)],
        [{ win: 'rout', lose: ['leader_escapes', 'pc_falls'], leader: 'Sergeant', side: 'save_bystander', bystander: 'Villager' }, undefined,
            [{ name: 'Sergeant', side: 'enemy', tier: 'grunt' }, ...grunts(1), { name: 'Villager', side: 'neutral', tier: 'minion' }]],
    ];

    it('every planned action is legal, every fight ends with a recorded result, and replays are identical', () => {
        for (const [objective, reinforcements, roster] of cases) {
            for (let i = 0; i < 12; i++) {
                const run = () => {
                    const r = start(objective, roster, { partyControl: i % 2 ? 'engine' : 'player', ...(reinforcements ? { reinforcements } : {}), map: { size: 'medium', area: i % 3 ? 'scattered' : 'open', density: 'normal' } }, 100 + i);
                    const log: CombatEvent[] = [...r.events];
                    return { state: drive(r.state, log), log };
                };
                const a = run();
                expect(a.state.outcome).not.toBeNull();
                expect(a.state.objective?.result).toBeDefined();
                expect(JSON.stringify(run().log)).toBe(JSON.stringify(a.log));
            }
        }
    }, 60000);
});
