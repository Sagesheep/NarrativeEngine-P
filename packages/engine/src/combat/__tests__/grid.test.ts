import { describe, it, expect } from 'vitest';
import {
    applyAction, buildMapFromSeed, buildPcCombatant, buildTerrain, canStep, checkAttack, chooseEngineTurn, coverBetween,
    createCombat, createRng, currentActorId, distance, ensureGrid, hasLineOfSight, isFullyConnected, isValidGrid,
    MAP_SIZES, isWalkable, pathTo, placeCombatants, reachable, runEngineTurns, stepEngine, tileAt,
    DEFEND_CONDITION, HALF_COVER_BONUS, THREE_QUARTER_COVER_BONUS,
} from '../index';
import type { CombatEvent, CombatSheet, CombatState, Combatant, CombatantSpec, Grid, MapSpec, Pos, Side, Tile } from '../index';

const sheet: CombatSheet = {
    abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

const TILE_CHARS: Record<string, Tile> = { '.': 'floor', '#': 'wall', c: 'cover', '~': 'difficult', '^': 'hazard' };

function gridOf(rows: string[]): Grid {
    const tiles = rows.join('').split('').map(ch => TILE_CHARS[ch] ?? 'floor');
    return { width: rows[0].length, height: rows.length, tiles };
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

function board(rows: string[], defs: Def[], extra: Partial<CombatState> = {}): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const d of defs) combatants[d.id] = unit(d);
    return {
        id: 'b', round: 1, order: defs.map(d => d.id), turnIndex: 0, combatants,
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, grid: gridOf(rows), turnCount: 1, ...extra,
    };
}


describe('T1 map builder', () => {
    it('builds the three sizes and clamps anything else to medium', () => {
        for (const size of ['small', 'medium', 'large'] as const) {
            const g = buildTerrain({ size, area: 'open' }, createRng(1));
            expect([g.width, g.height]).toEqual([MAP_SIZES[size].width, MAP_SIZES[size].height]);
            expect(g.tiles).toHaveLength(g.width * g.height);
        }
        expect(buildTerrain({ size: 'huge' }, createRng(1)).width).toBe(14);
    });

    it('spawns sides apart on distinct floor tiles, spread vertically', () => {
        const g = buildTerrain({ size: 'small', area: 'scattered' }, createRng(2));
        const entries = [
            { id: 'pc', side: 'player' as const }, { id: 'a1', side: 'ally' as const },
            ...Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, side: 'enemy' as const })),
            { id: 'n1', side: 'neutral' as const },
        ];
        const pos = placeCombatants(g, entries);
        const all = Object.values(pos);
        expect(all).toHaveLength(entries.length);
        expect(new Set(all.map(p => `${p.x},${p.y}`)).size).toBe(all.length);
        for (const p of all) expect(isWalkable(g, p)).toBe(true);
        expect(pos.pc.x).toBeLessThanOrEqual(1);
        expect(pos.a1.x).toBeLessThanOrEqual(1);
        for (let i = 0; i < 12; i++) expect(pos[`e${i}`].x).toBeGreaterThanOrEqual(g.width - 2);
        const two = placeCombatants(openGrid(), [{ id: 'e1', side: 'enemy' }, { id: 'e2', side: 'enemy' }]);
        expect(Math.abs(two.e1.y - two.e2.y)).toBeGreaterThanOrEqual(4);
    });

    it('never leaves a combatant unable to reach another, in any area', () => {
        const specs: MapSpec[] = [
            { size: 'small', area: 'corridors', density: 'dense' },
            { size: 'medium', area: 'cavern', density: 'dense' },
            { size: 'large', area: 'ruins', density: 'dense' },
            { size: 'small', area: 'ledge', density: 'dense', hazard: 'pit' },
        ];
        for (const spec of specs) {
            for (let seed = 1; seed <= 40; seed++) {
                const g = buildTerrain(spec, createRng(seed));
                expect(isFullyConnected(g), `seed ${seed}`).toBe(true);
                const entries = [{ id: 'pc', side: 'player' as const }, { id: 'e1', side: 'enemy' as const }, { id: 'e2', side: 'enemy' as const }, { id: 'n', side: 'neutral' as const }];
                const pos = placeCombatants(g, entries);
                const combatants: Record<string, Combatant> = {};
                for (const e of entries) combatants[e.id] = unit({ id: e.id, side: e.side, at: [pos[e.id].x, pos[e.id].y] });
                const s: CombatState = { id: 's', round: 1, order: entries.map(e => e.id), turnIndex: 0, combatants, rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, grid: g, turnCount: 1 };
                for (const other of ['e1', 'e2', 'n']) {
                    const target = pos[other];
                    const adjacentReachable = reachableUnbounded(s, 'pc').some(p => distance(p, target) <= 1) || distance(pos.pc, target) <= 1;
                    expect(adjacentReachable, `seed ${seed} pc -> ${other}`).toBe(true);
                }
            }
        }
    });

    it('is deterministic for a seed and varies between seeds', () => {
        const spec: MapSpec = { size: 'medium', area: 'ruins', density: 'normal' };
        expect(buildMapFromSeed(spec, 11)).toEqual(buildMapFromSeed(spec, 11));
        const variants = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(buildMapFromSeed(spec, i + 1).tiles)));
        expect(variants.size).toBeGreaterThan(1);
    });

    it('survives garbage input', () => {
        const junk: unknown[] = [null, 'abc', 42, [], { size: 'giant', features: 'x' }, { features: [null, 5, { kind: 3 }, { kind: 'unicorn', where: 9 }, { where: 'north' }] }, { size: { a: 1 }, theme: 7 }, { area: 'volcano', density: 9, hazard: 'lava', labels: [1] }];
        for (const spec of junk) {
            const g = buildTerrain(spec, createRng(1));
            expect(isValidGrid(g)).toBe(true);
            expect(isFullyConnected(g)).toBe(true);
            expect(g.area).toBeDefined();
            expect(g.labels?.cover).toBeTruthy();
        }
    });
});

function openGrid(): Grid {
    return { width: 14, height: 10, tiles: new Array<Tile>(140).fill('floor') };
}

function reachableUnbounded(state: CombatState, id: string): Pos[] {
    const s: CombatState = { ...state, combatants: { ...state.combatants, [id]: { ...state.combatants[id], speed: 999 } }, turn: { actorId: id, moveLeft: 999, actionUsed: false } };
    return reachable(s, id);
}

describe('T2 movement', () => {
    it('forbids squeezing diagonally past a wall or cover corner', () => {
        expect(canStep(gridOf(['.#', '..']), { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
        expect(canStep(gridOf(['.c', '..']), { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
        expect(canStep(gridOf(['..', 'c.']), { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
        expect(canStep(gridOf(['.~', '^.']), { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(true);
        expect(canStep(gridOf(['..', '.#']), { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
    });

    it('charges 2 for difficult terrain and limits moves to the remaining budget', () => {
        const s = board(['.~......'], [{ id: 'pc', side: 'player', at: [0, 0] }]);
        const costs = Object.fromEntries(reachable(s, 'pc').map(p => [p.x, p.cost]));
        expect(costs).toEqual({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 });
    });

    it('passes through allies, never through hostiles or neutrals, and never ends on an occupied tile', () => {
        const through = (rows: string[], side: Side, status: Combatant['status'] = 'up') => {
            const s = board(rows, [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'x', side, at: [1, 0], status }]);
            return reachable(s, 'pc').map(p => p.x);
        };
        expect(through(['...'], 'ally')).toEqual([2]);
        expect(through(['...'], 'enemy')).toEqual([]);
        expect(through(['...'], 'neutral')).toEqual([]);
        expect(through(['...'], 'enemy', 'down')).toEqual([1, 2]);
        const s = board(['...'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'a', side: 'ally', at: [1, 0] }]);
        expect(pathTo(s, 'pc', { x: 1, y: 0 })).toBeNull();
        expect(pathTo(s, 'pc', { x: 2, y: 0 })).toEqual({ path: [{ x: 1, y: 0 }, { x: 2, y: 0 }], cost: 2 });
    });

    it('steers engine pathfinding around hazards when another route exists', () => {
        const s = board(['.^^^.', '.....'], [{ id: 'e', side: 'enemy', at: [0, 0] }, { id: 'pc', side: 'player', at: [4, 0], hp: 99 }]);
        const plan = chooseEngineTurn(s, 'e');
        expect(plan.actions[0].type).toBe('move');
        const moved = applyAction(plan.state, plan.actions[0]);
        const path = moved.events.find(e => e.type === 'moved')!.data.path as Pos[];
        expect(path.every(p => tileAt(s.grid!, p) !== 'hazard')).toBe(true);
        const player = board(['.^^^.', '.....'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [4, 1] }]);
        expect(pathTo(player, 'pc', { x: 3, y: 0 })!.path.some(p => tileAt(player.grid!, p) === 'hazard')).toBe(true);
        const corridor = board(['.^^.'], [{ id: 'e', side: 'enemy', at: [0, 0] }, { id: 'pc', side: 'player', at: [3, 0] }]);
        expect(chooseEngineTurn(corridor, 'e').actions[0]).toEqual({ type: 'move', actorId: 'e', to: { x: 2, y: 0 } });
    });
});

describe('T2 range, line of sight and cover', () => {
    it('applies close, reach and ranged distances', () => {
        const at = (range: Combatant['range'], dist: number, rows = '..............') => {
            const s = board([rows], [{ id: 'pc', side: 'player', at: [0, 0], range }, { id: 'e', side: 'enemy', at: [dist, 0] }]);
            return checkAttack(s, 'pc', 'e');
        };
        expect(at('close', 1).ok).toBe(true);
        expect(at('close', 2)).toMatchObject({ ok: false, reason: 'out_of_range' });
        expect(at('reach', 2).ok).toBe(true);
        expect(at('reach', 3).ok).toBe(false);
        expect(at('reach', 2, '.#............')).toMatchObject({ ok: false, reason: 'no_line_of_sight' });
        expect(at('ranged', 12).ok).toBe(true);
        expect(at('ranged', 13)).toMatchObject({ ok: false, reason: 'out_of_range' });
        expect(at('ranged', 6, '...#..........')).toMatchObject({ ok: false, reason: 'no_line_of_sight' });
    });

    it('gives +2 AC for one cover crossing and +5 for two, only to ranged attacks', () => {
        const g = gridOf(['..c.cc..']);
        expect(coverBetween(g, { x: 0, y: 0 }, { x: 3, y: 0 })).toBe(HALF_COVER_BONUS);
        expect(coverBetween(g, { x: 0, y: 0 }, { x: 7, y: 0 })).toBe(THREE_QUARTER_COVER_BONUS);
        expect(hasLineOfSight(g, { x: 0, y: 0 }, { x: 7, y: 0 })).toBe(true);
        const s = board(['.c.'], [{ id: 'pc', side: 'player', at: [0, 0], range: 'reach' }, { id: 'e', side: 'enemy', at: [2, 0] }]);
        expect(checkAttack(s, 'pc', 'e')).toMatchObject({ ok: true, cover: 0 });
        const r = board(['.c.'], [{ id: 'pc', side: 'player', at: [0, 0], range: 'ranged' }, { id: 'e', side: 'enemy', at: [2, 0] }]);
        expect(checkAttack(r, 'pc', 'e')).toMatchObject({ ok: true, cover: HALF_COVER_BONUS });
        const hit = applyAction(r, { type: 'attack', actorId: 'pc', targetId: 'e' }).events.find(e => e.type === 'attack')!;
        expect(hit.data).toMatchObject({ cover: 2, ac: 14 });
    });

    it('does not let combatants block line of sight', () => {
        const s = board(['.....'], [
            { id: 'pc', side: 'player', at: [0, 0], range: 'ranged' }, { id: 'f', side: 'enemy', at: [2, 0] }, { id: 'e', side: 'enemy', at: [4, 0] },
        ]);
        expect(checkAttack(s, 'pc', 'e')).toMatchObject({ ok: true, cover: 0 });
    });

    it('gives a ranged attack disadvantage while a hostile is adjacent', () => {
        const s = board(['......'], [
            { id: 'pc', side: 'player', at: [1, 0], range: 'ranged' }, { id: 'near', side: 'enemy', at: [0, 0] }, { id: 'far', side: 'enemy', at: [5, 0] },
        ]);
        expect(checkAttack(s, 'pc', 'far').disadvantage).toBe(true);
        const attack = applyAction(s, { type: 'attack', actorId: 'pc', targetId: 'far' }).events.find(e => e.type === 'attack')!;
        expect(attack.data.disadvantage).toBe(true);
        expect(applyAction(s, { type: 'attack', actorId: 'pc', targetId: 'far' }).state.rngCursor).toBeGreaterThanOrEqual(2);
    });
});

describe('T3 turn economy', () => {
    const duelRow = () => board(['........'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [4, 0], hp: 99, maxHp: 99 }]);

    it('allows moving, attacking and moving again in one turn', () => {
        let s = duelRow();
        s = applyAction(s, { type: 'move', actorId: 'pc', to: { x: 3, y: 0 } }).state;
        expect(s.turn).toEqual({ actorId: 'pc', moveLeft: 3, actionUsed: false });
        const attacked = applyAction(s, { type: 'attack', actorId: 'pc', targetId: 'e' });
        expect(currentActorId(attacked.state)).toBe('pc');
        expect(attacked.state.turn?.actionUsed).toBe(true);
        expect(applyAction(attacked.state, { type: 'attack', actorId: 'pc', targetId: 'e' }).events[0]).toMatchObject({ type: 'rejected' });
        const back = applyAction(attacked.state, { type: 'move', actorId: 'pc', to: { x: 1, y: 0 } });
        expect(back.events.find(e => e.type === 'moved')!.data).toMatchObject({ from: { x: 3, y: 0 }, to: { x: 1, y: 0 }, cost: 2, squares: 2, awayFromId: 'e' });
        expect(back.state.turn?.moveLeft).toBe(1);
        const ended = applyAction(back.state, { type: 'end_turn', actorId: 'pc' });
        expect(currentActorId(ended.state)).toBe('e');
        expect(ended.state.turn).toEqual({ actorId: 'e', moveLeft: 6, actionUsed: false });
        expect(ended.state.turnCount).toBe(2);
    });

    it('ends the turn automatically once the action is spent and no movement remains', () => {
        let s = board(['.......'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [6, 0], hp: 99, maxHp: 99 }]);
        const moved = applyAction(s, { type: 'move', actorId: 'pc', to: { x: 5, y: 0 } });
        expect(moved.events[0].data).toMatchObject({ towardId: 'e', squares: 5 });
        s = applyAction(moved.state, { type: 'move', actorId: 'pc', to: { x: 6, y: 0 } }).state;
        expect(s.turn?.actorId).toBe('pc');
        const blocked = board(['..'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [1, 0], hp: 99, maxHp: 99 }]);
        expect(currentActorId(applyAction(blocked, { type: 'attack', actorId: 'pc', targetId: 'e' }).state)).toBe('e');
        const defended = applyAction(blocked, { type: 'defend', actorId: 'pc' });
        expect(currentActorId(defended.state)).toBe('e');
    });

    it('rejects moves beyond the budget or onto blocked tiles without changing state', () => {
        const s = board(['..........', '..#.......'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [9, 0] }]);
        for (const to of [{ x: 7, y: 0 }, { x: 2, y: 1 }, { x: 9, y: 0 }, { x: 20, y: 0 }]) {
            const r = applyAction(s, { type: 'move', actorId: 'pc', to });
            expect(r.state).toBe(s);
            expect(r.events[0].type).toBe('rejected');
        }
    });

    it('stamps every event with the turn counter', () => {
        const s = duelRow();
        const moved = applyAction(s, { type: 'move', actorId: 'pc', to: { x: 3, y: 0 } });
        const ended = applyAction(moved.state, { type: 'end_turn', actorId: 'pc' });
        expect(moved.events.map(e => e.turn)).toEqual([1]);
        expect(ended.events.map(e => e.turn)).toEqual([1]);
        const enemy = applyAction(ended.state, { type: 'end_turn', actorId: 'e' });
        expect(enemy.events.map(e => [e.type, e.turn])).toEqual([['end_turn', 2], ['round', 2]]);
    });
});

describe('T4 enemy policy', () => {
    const melee = (rows: string[], foe: Pos, pc: Pos, extra: Partial<Def> = {}) =>
        board(rows, [{ id: 'e', side: 'enemy', at: [foe.x, foe.y], ...extra }, { id: 'pc', side: 'player', at: [pc.x, pc.y] }]);

    it('melee: attacks an adjacent hostile without moving', () => {
        expect(chooseEngineTurn(melee(['....'], { x: 0, y: 0 }, { x: 1, y: 0 }), 'e').actions).toEqual([
            { type: 'attack', actorId: 'e', targetId: 'pc' }, { type: 'end_turn', actorId: 'e' },
        ]);
    });

    it('melee: moves next to a hostile it can reach, then attacks', () => {
        expect(chooseEngineTurn(melee(['......'], { x: 0, y: 0 }, { x: 4, y: 0 }), 'e').actions).toEqual([
            { type: 'move', actorId: 'e', to: { x: 3, y: 0 } }, { type: 'attack', actorId: 'e', targetId: 'pc' }, { type: 'end_turn', actorId: 'e' },
        ]);
    });

    it('melee: closes along the cheapest path when nothing is reachable this turn', () => {
        expect(chooseEngineTurn(melee(['............'], { x: 0, y: 0 }, { x: 11, y: 0 }), 'e').actions).toEqual([
            { type: 'move', actorId: 'e', to: { x: 6, y: 0 } }, { type: 'end_turn', actorId: 'e' },
        ]);
    });

    it('melee: picks the lowest-HP hostile it can reach', () => {
        const s = board(['.......'], [
            { id: 'e', side: 'enemy', at: [3, 0] }, { id: 'pc', side: 'player', at: [0, 0], hp: 3 }, { id: 'a', side: 'ally', at: [6, 0], hp: 10 },
        ]);
        expect(chooseEngineTurn(s, 'e').actions[1]).toEqual({ type: 'attack', actorId: 'e', targetId: 'pc' });
    });

    it('breaks HP ties with the rng and advances the cursor', () => {
        const s = board(['...'], [{ id: 'e', side: 'enemy', at: [1, 0] }, { id: 'pc', side: 'player', at: [0, 0] }, { id: 'a', side: 'ally', at: [2, 0] }]);
        const plan = chooseEngineTurn(s, 'e');
        expect(['pc', 'a']).toContain((plan.actions[0] as { targetId: string }).targetId);
        expect(plan.state.rngCursor).toBe(s.rngCursor + 1);
    });

    it('ranged: shoots without moving when it has a clear shot and no hostile adjacent', () => {
        const s = melee(['........'], { x: 6, y: 0 }, { x: 0, y: 0 }, { range: 'ranged' });
        expect(chooseEngineTurn(s, 'e').actions).toEqual([{ type: 'attack', actorId: 'e', targetId: 'pc' }, { type: 'end_turn', actorId: 'e' }]);
    });

    it('ranged: steps out of reach before shooting when a hostile is adjacent', () => {
        const s = melee(['....', '....'], { x: 1, y: 1 }, { x: 0, y: 1 }, { range: 'ranged' });
        const plan = chooseEngineTurn(s, 'e');
        expect(plan.actions[0]).toEqual({ type: 'move', actorId: 'e', to: { x: 2, y: 0 } });
        expect(plan.actions[1]).toEqual({ type: 'attack', actorId: 'e', targetId: 'pc' });
    });

    it('ranged: shoots anyway when no safe tile exists', () => {
        const s = melee(['..#'], { x: 1, y: 0 }, { x: 0, y: 0 }, { range: 'ranged' });
        expect(chooseEngineTurn(s, 'e').actions[0]).toEqual({ type: 'attack', actorId: 'e', targetId: 'pc' });
    });

    it('ranged: moves to the nearest tile with a shot when line of sight is blocked', () => {
        const s = melee(['...#..', '......'], { x: 5, y: 0 }, { x: 0, y: 0 }, { range: 'ranged' });
        expect(checkAttack(s, 'e', 'pc').ok).toBe(false);
        expect(chooseEngineTurn(s, 'e').actions.slice(0, 2)).toEqual([
            { type: 'move', actorId: 'e', to: { x: 4, y: 1 } }, { type: 'attack', actorId: 'e', targetId: 'pc' },
        ]);
    });

    it('ends its turn when it has no legal move or attack', () => {
        const walled = melee(['.#.'], { x: 0, y: 0 }, { x: 2, y: 0 });
        expect(chooseEngineTurn(walled, 'e').actions).toEqual([{ type: 'end_turn', actorId: 'e' }]);
        const alone = board(['...'], [{ id: 'e', side: 'enemy', at: [0, 0] }, { id: 'n', side: 'neutral', at: [1, 0] }]);
        expect(chooseEngineTurn(alone, 'e').actions).toEqual([{ type: 'end_turn', actorId: 'e' }]);
    });

    it('runs whole engine turns one action at a time until a player turn', () => {
        const s = melee(['......'], { x: 0, y: 0 }, { x: 4, y: 0 });
        const step = stepEngine(s)!;
        expect(step.events.map(e => e.type)).toEqual(['moved']);
        expect(currentActorId(step.state)).toBe('e');
        const rest = runEngineTurns(step.state);
        expect(currentActorId(rest.state) === 'pc' || rest.state.outcome !== null).toBe(true);
        expect(rest.events[0].type).toBe('attack');
    });
});

describe('T4 environment step', () => {
    it('burns combatants on hazards when the order wraps, before the round advances', () => {
        const s = board(['^...'], [{ id: 'pc', side: 'player', at: [0, 0], hp: 30, maxHp: 30 }, { id: 'e', side: 'enemy', at: [3, 0] }], {
            grid: { ...gridOf(['^...']), hazardType: 'acid' },
        });
        const a = applyAction(s, { type: 'end_turn', actorId: 'pc' });
        const b = applyAction(a.state, { type: 'end_turn', actorId: 'e' });
        expect(b.events.map(e => e.type)).toEqual(['end_turn', 'hazard', 'round']);
        const burn = b.events[1];
        expect(burn.targetId).toBe('pc');
        expect(burn.data.damageType).toBe('acid');
        expect(b.state.combatants.pc.hp).toBe(30 - (burn.data.damage as number));
        expect(burn.data.damage as number).toBeGreaterThanOrEqual(1);
        expect(burn.data.damage as number).toBeLessThanOrEqual(6);
    });

    it('ticks condition durations but leaves the defend flag to its own rule', () => {
        const s = board(['....'], [
            { id: 'pc', side: 'player', at: [0, 0] },
            { id: 'e', side: 'enemy', at: [3, 0], conditions: [{ id: 'slowed', rounds: 1 }, { id: 'hasted', rounds: 3 }] },
        ]);
        const defended = applyAction(s, { type: 'defend', actorId: 'pc' });
        const pcDone = applyAction(defended.state, { type: 'end_turn', actorId: 'pc' });
        const wrapped = applyAction(pcDone.state, { type: 'end_turn', actorId: 'e' });
        expect(wrapped.events.map(e => e.type)).toEqual(['end_turn', 'condition_ended', 'round']);
        expect(wrapped.state.combatants.e.conditions).toEqual([{ id: 'hasted', rounds: 2 }]);
        expect(wrapped.state.combatants.pc.conditions).toEqual([]);
        const keep = board(['....'], [{ id: 'e', side: 'enemy', at: [3, 0] }, { id: 'pc', side: 'player', at: [0, 0] }]);
        const eDef = applyAction(applyAction(keep, { type: 'defend', actorId: 'e' }).state, { type: 'end_turn', actorId: 'e' });
        const pcEnd = applyAction(eDef.state, { type: 'end_turn', actorId: 'pc' });
        expect(pcEnd.state.combatants.e.conditions).toEqual([]);
        const order = board(['....'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [3, 0] }]);
        const eFirst = applyAction(applyAction(order, { type: 'end_turn', actorId: 'pc' }).state, { type: 'defend', actorId: 'e' });
        expect(eFirst.state.combatants.e.conditions).toEqual([{ id: DEFEND_CONDITION, rounds: 1 }]);
    });

    it('emits nothing for a quiet round and can end the fight', () => {
        const quiet = board(['....'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [3, 0] }]);
        const wrapped = applyAction(applyAction(quiet, { type: 'end_turn', actorId: 'pc' }).state, { type: 'end_turn', actorId: 'e' });
        expect(wrapped.events.map(e => e.type)).toEqual(['end_turn', 'round']);
        const lethal = board(['...^'], [{ id: 'pc', side: 'player', at: [0, 0] }, { id: 'e', side: 'enemy', at: [3, 0], hp: 1 }]);
        const won = applyAction(applyAction(lethal, { type: 'end_turn', actorId: 'pc' }).state, { type: 'end_turn', actorId: 'e' });
        expect(won.events.map(e => e.type)).toEqual(['end_turn', 'hazard', 'down', 'combat_ended']);
        expect(won.state.outcome).toBe('victory');
    });
});

const pcInput = { name: 'Kira', sheet, weapon: { quality: 'common' as const, scalingStat: 'STR' as const, damageType: 'slashing' } };
const grunts = (n: number, extra: Partial<CombatantSpec> = {}): CombatantSpec[] =>
    Array.from({ length: n }, (_, i) => ({ name: `Bandit ${i + 1}`, side: 'enemy' as const, tier: 'grunt' as const, ...extra }));

function playOut(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let current = state;
    const events: CombatEvent[] = [];
    for (let i = 0; i < 2000 && !current.outcome; i++) {
        const engine = stepEngine(current);
        if (engine) {
            current = engine.state;
            events.push(...engine.events);
            continue;
        }
        const plan = chooseEngineTurn(current, currentActorId(current)!);
        const step = applyAction(plan.state, plan.actions[0]);
        current = step.events.some(e => e.type === 'rejected') ? applyAction(plan.state, { type: 'end_turn', actorId: currentActorId(current)! }).state : step.state;
        events.push(...step.events.filter(e => e.type !== 'rejected'));
    }
    return { state: current, events };
}

describe('grid fights end to end', () => {
    it('places every combatant on the grid and records the map seed', () => {
        const { state } = createCombat({ id: 'g', combatants: grunts(3), map: { size: 'small' }, mapSeed: 99 }, buildPcCombatant(pcInput), 5);
        expect(state.grid?.width).toBe(10);
        expect(state.mapSeed).toBe(99);
        expect(state.turnCount).toBe(1);
        expect(state.turn?.actorId).toBe(state.order[0]);
        for (const c of Object.values(state.combatants)) expect(c.position).toBeDefined();
        expect(state.combatants.pc.position!.x).toBeLessThanOrEqual(1);
    });

    it('keeps the terrain fixed for a map seed whatever the roster', () => {
        const a = createCombat({ id: 'g', combatants: grunts(2), map: { size: 'medium', area: 'scattered' }, mapSeed: 4 }, buildPcCombatant(pcInput), 1);
        const b = createCombat({ id: 'g', combatants: grunts(5, { tier: 'elite' }), map: { size: 'medium', area: 'scattered' }, mapSeed: 4 }, buildPcCombatant(pcInput), 77);
        expect(a.state.grid).toEqual(b.state.grid);
    });

    it('gives casters a ranged attack and honours an explicit range', () => {
        const { state } = createCombat({ id: 'g', combatants: [{ name: 'Mage', side: 'enemy', tier: 'grunt', archetype: 'caster' }, { name: 'Archer', side: 'enemy', tier: 'grunt', range: 'ranged' }, { name: 'Thug', side: 'enemy', tier: 'grunt' }] }, buildPcCombatant(pcInput), 1);
        expect(Object.values(state.combatants).map(c => [c.name, c.range])).toEqual([['Kira', 'close'], ['Mage', 'ranged'], ['Archer', 'ranged'], ['Thug', 'close']]);
    });

    it('plays a seeded golden fight on the grid', () => {
        const start = createCombat({ id: 'gold', combatants: grunts(2), map: { size: 'small', area: 'open', density: 'sparse' }, mapSeed: 3 }, buildPcCombatant(pcInput), 1234);
        const { state, events } = playOut(start.state);
        expect(state.outcome).not.toBeNull();
        expect([...start.events, ...events].map(e => `${e.seq}|${e.round}|${e.turn}|${e.text}`)).toMatchSnapshot();
    });

    it('replays identically after a save and restore', () => {
        const start = createCombat({ id: 'det', combatants: grunts(3, { range: 'ranged' }), map: { area: 'corridors' } }, buildPcCombatant(pcInput), 99);
        const mid = runEngineTurns(start.state).state;
        const saved = JSON.parse(JSON.stringify(mid)) as CombatState;
        const a = playOut(mid);
        const b = playOut(saved);
        expect(b.events).toEqual(a.events);
        expect(b.state).toEqual(a.state);
    });

    it('B6: an engine turn interrupted after its first action resumes to the same result', () => {
        for (const seed of [3, 8, 21, 42]) {
            let s = createCombat({ id: 'r', combatants: grunts(2), map: { size: 'small' } }, buildPcCombatant(pcInput), seed).state;
            if (s.combatants[currentActorId(s)!].controller === 'player') s = applyAction(s, { type: 'end_turn', actorId: 'pc' }).state;
            const whole = runEngineTurns(s);
            const first = stepEngine(s)!;
            const reloaded = ensureGrid(JSON.parse(JSON.stringify(first.state)) as CombatState);
            const rest = runEngineTurns(reloaded);
            expect(rest.state).toEqual(whole.state);
            expect([...first.events, ...rest.events]).toEqual(whole.events);
        }
    });
});

describe('B2 ensureGrid', () => {
    function phaseOne(turnIndex: number): CombatState {
        const pc = buildPcCombatant(pcInput);
        const foe: Combatant = {
            id: 'foe', name: 'Bandit', side: 'enemy', controller: 'engine', tier: 'grunt',
            abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
            maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
            initiative: 5, status: 'up', conditions: [],
        };
        return { id: 'old', round: 2, order: [pc.id, foe.id], turnIndex, combatants: { [pc.id]: pc, foe }, rngSeed: 42, rngCursor: 17, eventSeq: 9, outcome: null };
    }

    it('gives a Phase 1 session an open medium arena, spawn positions and a turn without drawing random numbers', () => {
        for (const turnIndex of [0, 1]) {
            const old = phaseOne(turnIndex);
            const up = ensureGrid(old);
            expect(up.grid).toEqual({ width: 14, height: 10, tiles: new Array(140).fill('floor'), area: 'open', labels: { wall: 'wall', cover: 'crates', difficult: 'rough ground', hazard: 'hazard' } });
            expect(up.rngCursor).toBe(17);
            expect(up.eventSeq).toBe(9);
            expect(up.combatants.pc.position!.x).toBeLessThanOrEqual(1);
            expect(up.combatants.foe.position!.x).toBeGreaterThanOrEqual(12);
            expect(up.turn).toEqual({ actorId: old.order[turnIndex], moveLeft: 6, actionUsed: false });
            expect(ensureGrid(up)).toBe(up);
            expect(ensureGrid(phaseOne(turnIndex))).toEqual(up);
        }
    });

    it('lets an upgraded Phase 1 fight continue', () => {
        const up = ensureGrid(phaseOne(1));
        const engine = runEngineTurns(up);
        expect(engine.events[0].type).toBe('moved');
        expect(currentActorId(engine.state) === 'pc' || engine.state.outcome !== null).toBe(true);
        const { state } = playOut(engine.state);
        expect(state.outcome).not.toBeNull();
    });

    it('replaces an invalid grid and repairs bad positions', () => {
        const bad = { ...phaseOne(0), grid: { width: 3, height: 3, tiles: ['floor'] } as Grid };
        expect(ensureGrid(bad).grid?.width).toBe(14);
        const unknownTile = { ...phaseOne(0), grid: { width: 4, height: 4, tiles: new Array(16).fill('lava') } as unknown as Grid };
        expect(isValidGrid(unknownTile.grid)).toBe(false);
        const stacked = ensureGrid({ ...phaseOne(0), grid: openGrid() });
        const clash = ensureGrid({ ...stacked, combatants: { ...stacked.combatants, foe: { ...stacked.combatants.foe, position: { ...stacked.combatants.pc.position! } } } });
        expect(clash.combatants.foe.position).not.toEqual(clash.combatants.pc.position);
        expect(clash.combatants.pc.position).toEqual(stacked.combatants.pc.position);
    });
});
