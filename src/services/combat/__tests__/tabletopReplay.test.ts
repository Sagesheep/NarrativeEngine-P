import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, createCombat, freshTurn, openArena } from '@narrative/engine';
import type { CombatAction, CombatEvent, CombatState, Combatant, Grid, Pos, Tile } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, groupEventsByTurn, stateAtSeq, turnLines } from '../combatEvents';

const sheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };

const at = (x: number, y: number): Pos => ({ x, y });

function board(patch: { grid?: Grid; ally?: Partial<Combatant>; foe?: Partial<Combatant> } = {}): CombatState {
    const { state } = createCombat({
        id: 't',
        combatants: [{ name: 'Thug', side: 'enemy', tier: 'grunt' }, { name: 'Bram', side: 'ally', tier: 'grunt' }],
    }, buildPcCombatant({ name: 'Kira', sheet }), 5);
    const combatants = { ...state.combatants };
    const ids = Object.keys(combatants).filter(id => id !== 'pc');
    const foeId = ids.find(id => combatants[id].side === 'enemy') as string;
    const allyId = ids.find(id => combatants[id].side === 'ally') as string;
    combatants.pc = { ...combatants.pc, position: at(5, 5) };
    combatants[foeId] = { ...combatants[foeId], position: at(6, 5), ...patch.foe };
    combatants[allyId] = { ...combatants[allyId], position: at(4, 5), ...patch.ally };
    const next: CombatState = { ...state, combatants, order: ['pc', foeId, allyId], turnIndex: 0, grid: patch.grid ?? openArena('medium'), turnCount: 1 };
    return { ...next, turn: freshTurn(next, 'pc') };
}

function withTiles(tiles: Array<[Pos, Tile]>, labels?: Grid['labels']): Grid {
    const grid = openArena('medium');
    const out = [...grid.tiles];
    for (const [p, t] of tiles) out[p.y * grid.width + p.x] = t;
    return { ...grid, tiles: out, hazardType: 'fire', ...(labels ? { labels } : {}) };
}

function play(base: CombatState, action: CombatAction, accept: (events: CombatEvent[]) => boolean): { events: CombatEvent[]; state: CombatState; before: CombatState } {
    for (let seed = 1; seed < 400; seed++) {
        const before = { ...base, rngSeed: seed, rngCursor: 0 };
        const r = applyAction(before, action);
        if (!r.events.some(e => e.type === 'rejected') && accept(r.events)) return { events: r.events, state: r.state, before };
    }
    throw new Error('no seed found');
}

const use = (abilityId: string, aim: Pos | null = null): CombatAction => ({ type: 'use_ability', actorId: 'pc', abilityId, aim });

function same(run: { events: CombatEvent[]; state: CombatState; before: CombatState }) {
    const replay = stateAtSeq(run.state, run.events, run.before.eventSeq);
    for (const [id, c] of Object.entries(run.before.combatants)) {
        expect(replay.combatants[id].position).toEqual(c.position);
        expect(replay.combatants[id].hp).toBe(c.hp);
        expect(replay.combatants[id].status).toBe(c.status);
    }
}

function lines(events: CombatEvent[], state: CombatState): string[] {
    return groupEventsByTurn(events).flatMap(g => turnLines(g, state, { numbers: false }));
}

describe('tabletop actions replay and narrate (5B-2)', () => {
    it('knows the rallied event type', () => {
        expect(NARRATED_EVENT_TYPES).toContain('rallied');
    });

    it('Dash: header only, nothing to undo, narrated as a sprint', () => {
        const r = play(board(), use('builtin:dash'), () => true);
        expect(r.events.map(e => e.type)).toEqual(['ability']);
        same(r);
        expect(lines(r.events, r.state)).toEqual(['Kira sprints.']);
        expect(r.events[0].text).toBe('Kira uses Dash.');
    });

    it('Shove: replays a push into a hazard and narrates success, failure and a wall', () => {
        const foeAt = at(6, 5);
        const pushed = play(board({ grid: withTiles([[at(7, 5), 'hazard']]) }), use('builtin:shove', foeAt), ev => ev.some(e => e.type === 'hazard'));
        expect(pushed.events.map(e => e.type)).toEqual(['ability', 'save', 'pushed', 'hazard']);
        same(pushed);
        expect(lines(pushed.events, pushed.state)).toEqual(['Kira shoves Thug back.', 'Thug is hurt by the hazard underfoot.']);
        const held = play(board(), use('builtin:shove', foeAt), ev => ev.some(e => e.type === 'save' && e.data.success === true));
        expect(held.events.map(e => e.type)).toEqual(['ability', 'save']);
        same(held);
        expect(lines(held.events, held.state)).toEqual(['Kira shoves Thug, who holds their ground.']);
        const walled = play(board({ grid: withTiles([[at(7, 5), 'wall']]) }), use('builtin:shove', foeAt), ev => ev.some(e => e.type === 'pushed'));
        expect(lines(walled.events, walled.state)).toEqual(['Kira shoves Thug, who has nowhere to go.']);
        same(walled);
    });

    it('Jump: replays the leap and names the terrain jumped over when there is one', () => {
        const r = play(board({ grid: withTiles([[at(4, 4), 'hazard']], { hazard: 'lava' }) }), use('builtin:jump', at(3, 3)), () => true);
        expect(r.events.map(e => e.type)).toEqual(['ability', 'teleported']);
        expect(r.events[1].data).toMatchObject({ kind: 'leap', over: ['hazard'] });
        same(r);
        expect(lines(r.events, r.state)).toEqual(['Kira leaps across the lava.']);
        const plain = play(board(), use('builtin:jump', at(5, 3)), () => true);
        expect(lines(plain.events, plain.state)).toEqual(['Kira leaps across to a new spot.']);
        same(plain);
    });

    it('Throw: replays the attack and narrates it as something snatched up', () => {
        const far = board({ foe: { position: at(9, 5) } });
        const hit = play(far, use('builtin:throw', at(9, 5)), ev => ev.some(e => e.type === 'attack' && e.data.hit === true));
        expect(hit.events.map(e => e.type)).toEqual(['ability', 'attack']);
        same(hit);
        expect(lines(hit.events, hit.state)[0]).toMatch(/^Kira .* Thug.* with something snatched up \(bludgeoning\)\.$/);
        const miss = play(far, use('builtin:throw', at(9, 5)), ev => ev.some(e => e.type === 'attack' && e.data.hit === false));
        same(miss);
        expect(lines(miss.events, miss.state)[0]).toMatch(/misses|turned aside/);
    });

    it('Help: replays a standing-up and a shake-off, and narrates both', () => {
        const down = play(board({ ally: { status: 'down', hp: 0 } }), use('builtin:help', at(4, 5)), () => true);
        expect(down.events.map(e => e.type)).toEqual(['ability', 'rallied']);
        expect(down.state.combatants[down.events[1].targetId as string]).toMatchObject({ status: 'up', hp: 1 });
        same(down);
        expect(lines(down.events, down.state)).toEqual(['Kira hauls Bram back to their feet.']);
        const stunned = play(board({ ally: { conditions: [{ id: 'stunned', turns: 1 }] } }), use('builtin:help', at(4, 5)), () => true);
        same(stunned);
        expect(lines(stunned.events, stunned.state)).toEqual(['Kira shakes Bram out of it.']);
    });
});
