import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, createCombat, ensureGrid, freshTurn, openArena, terrainOf } from '@narrative/engine';
import type { CombatAction, CombatEvent, CombatState, Combatant, Grid, PcCarriedInput, Pos, ThrowPayload, Tile } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, groupEventsByTurn, stateAtSeq, turnLines } from '../combatEvents';
import { carriedItemsFor } from '../combatController';
import type { InventoryItem } from '../../../types';

const sheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };
const at = (x: number, y: number): Pos => ({ x, y });

const ITEMS: PcCarriedInput[] = [
    { id: 'dagger', name: 'Iron dagger', quality: 'common' },
    { id: 'glaive', name: 'Glaive of Ash', quality: 'rare', equipped: true },
];

function board(patch: { grid?: Grid; ally?: Partial<Combatant>; foe?: Partial<Combatant>; items?: PcCarriedInput[] } = {}): CombatState {
    const pc = buildPcCombatant({ name: 'Kira', sheet, weapon: { name: 'Glaive of Ash', quality: 'rare' }, ...(patch.items ? { items: patch.items } : {}) });
    const { state } = createCombat({
        id: 't',
        combatants: [{ name: 'Thug', side: 'enemy', tier: 'grunt' }, { name: 'Bram', side: 'ally', tier: 'grunt' }],
    }, pc, 5);
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

type Run = { events: CombatEvent[]; state: CombatState; before: CombatState };

function play(base: CombatState, action: CombatAction, accept: (events: CombatEvent[]) => boolean): Run {
    for (let seed = 1; seed < 600; seed++) {
        const before = { ...base, rngSeed: seed, rngCursor: 0 };
        const r = applyAction(before, action);
        if (!r.events.some(e => e.type === 'rejected') && accept(r.events)) return { events: r.events, state: r.state, before };
    }
    throw new Error('no seed found');
}

const throwing = (payload: ThrowPayload, aim: Pos): CombatAction => ({ type: 'use_ability', actorId: 'pc', abilityId: 'builtin:throw', aim, payload });

function shape(state: CombatState): unknown {
    return {
        combatants: Object.fromEntries(Object.entries(state.combatants).map(([id, c]) => [id, {
            position: c.position, hp: c.hp, status: c.status, carried: c.carried ?? [], damage: c.damage, weaponName: c.weaponName ?? null, range: c.range ?? null,
        }])),
        terrainEdits: state.terrainEdits ?? [],
        fieldItems: state.fieldItems ?? [],
    };
}

function same(run: Run): void {
    expect(shape(stateAtSeq(run.state, run.events, run.before.eventSeq))).toEqual(shape(run.before));
}

function lines(events: CombatEvent[], state: CombatState): string[] {
    return groupEventsByTurn(events).flatMap(g => turnLines(g, state, { numbers: false }));
}

const types = (events: CombatEvent[]) => events.map(e => e.type);

describe('Throw replays and narrates (21)', () => {
    it('knows the new event types', () => {
        for (const t of ['thrown', 'item_dropped', 'item_recovered']) expect(NARRATED_EVENT_TYPES).toContain(t);
    });

    it('a lifted creature: a failed lift narrates the struggle, a landing in a hazard undoes cleanly', () => {
        const hazard = board({ grid: withTiles([[at(8, 5), 'hazard']]) });
        const thrown = play(hazard, throwing({ kind: 'creature', id: Object.keys(hazard.combatants).find(id => hazard.combatants[id].name === 'Thug') as string }, at(8, 5)), ev => ev.some(e => e.type === 'hazard'));
        expect(types(thrown.events)).toEqual(['ability', 'save', 'thrown', 'ability_damage', 'hazard']);
        same(thrown);
        expect(lines(thrown.events, thrown.state)).toEqual(['Kira hurls Thug across the field.', 'Thug is hurt by the hazard underfoot.']);
        const held = play(hazard, throwing({ kind: 'creature', id: thrown.events[1].targetId as string }, at(8, 5)), ev => ev.some(e => e.type === 'save' && e.data.success === true));
        expect(types(held.events)).toEqual(['ability', 'save']);
        same(held);
        expect(lines(held.events, held.state)).toEqual(['Kira tries to lift Thug, who wrenches free.']);
    });

    it('a willing ally is thrown clear, and the line names no one else', () => {
        const base = board();
        const ally = Object.keys(base.combatants).find(id => base.combatants[id].name === 'Bram') as string;
        const r = play(base, throwing({ kind: 'creature', id: ally }, at(2, 5)), () => true);
        expect(types(r.events)).toEqual(['ability', 'thrown']);
        same(r);
        expect(r.state.combatants[ally].position).toEqual(at(2, 5));
        expect(lines(r.events, r.state)).toEqual(['Kira throws Bram clear to a new spot.']);
    });

    it('a cover object leaves the terrain edits undone on replay and narrates as a heave', () => {
        const grid = withTiles([[at(6, 5), 'cover']], { cover: 'Crate' });
        const base = board({ grid, foe: { position: at(9, 5) } });
        const cover: ThrowPayload = { kind: 'cover', at: at(6, 5) };
        const hit = play(base, throwing(cover, at(9, 5)), ev => ev.some(e => e.type === 'thrown' && e.data.hit === true));
        same(hit);
        expect(hit.state.terrainEdits).toHaveLength(2);
        expect(lines(hit.events, hit.state)).toEqual(['Kira heaves the crate across the room and it crashes into Thug.']);
        const miss = play(base, throwing(cover, at(9, 5)), ev => ev.some(e => e.type === 'thrown' && e.data.hit === false));
        same(miss);
        expect(lines(miss.events, miss.state)).toEqual(['Kira heaves the crate across the room; it smashes where Thug stood.']);
        const empty = play(base, throwing(cover, at(8, 6)), () => true);
        same(empty);
        expect(lines(empty.events, empty.state)).toEqual(['Kira heaves the crate across the room; it smashes down on open ground.']);
        expect(stateAtSeq(hit.state, hit.events, hit.before.eventSeq).terrainEdits ?? []).toEqual([]);
    });

    it('a carried item is dropped and picked up again, and each step undoes', () => {
        const base = board({ items: ITEMS });
        const drop = play(base, throwing({ kind: 'item', itemId: 'dagger' }, at(8, 5)), () => true);
        expect(types(drop.events)).toContain('item_dropped');
        same(drop);
        expect(drop.state.fieldItems).toHaveLength(1);
        expect(lines(drop.events, drop.state)[0]).toMatch(/^Kira (throws|hurls) the Iron dagger/);
        const disarm = play(base, throwing({ kind: 'item', itemId: 'glaive' }, at(7, 5)), () => true);
        same(disarm);
        expect(disarm.state.combatants.pc.damage.sides).toBe(4);
        const dropped = disarm.state;
        const walk: CombatAction = { type: 'move', actorId: 'pc', to: at(7, 5) };
        const moved = applyAction({ ...dropped, turn: { ...(dropped.turn as NonNullable<CombatState['turn']>), moveLeft: 6 } }, walk);
        expect(types(moved.events)).toEqual(['moved', 'item_recovered']);
        const log = [...disarm.events, ...moved.events];
        expect(shape(stateAtSeq(moved.state, log, dropped.eventSeq))).toEqual(shape(dropped));
        expect(shape(stateAtSeq(moved.state, log, disarm.before.eventSeq))).toEqual(shape(disarm.before));
        expect(lines(moved.events, moved.state).some(l => l === 'Kira picks up the Glaive of Ash.')).toBe(true);
    });

    it('the fight ending recovers the item and still undoes', () => {
        const base = board({ items: ITEMS, foe: { position: at(8, 5), hp: 1 } });
        const kill = play(base, throwing({ kind: 'item', itemId: 'dagger' }, at(8, 5)), ev => ev.some(e => e.type === 'item_recovered'));
        expect(kill.state.outcome).toBe('victory');
        expect(kill.state.fieldItems ?? []).toEqual([]);
        same(kill);
        expect(lines(kill.events, kill.state).join(' ')).not.toContain('gathered');
    });

    it('a saved fight with an edited surface and a dropped item reloads identically', () => {
        const grid = withTiles([[at(6, 5), 'cover']]);
        const base = board({ grid, items: ITEMS, foe: { position: at(9, 5) } });
        const covered = play(base, throwing({ kind: 'cover', at: at(6, 5) }, at(7, 6)), () => true).state;
        const again = { ...covered, turn: { ...(covered.turn as NonNullable<CombatState['turn']>), actionUsed: false } };
        const live = play(again, throwing({ kind: 'item', itemId: 'dagger' }, at(8, 6)), () => true).state;
        const reloaded = ensureGrid(JSON.parse(JSON.stringify(live)) as CombatState);
        expect(reloaded.terrainEdits).toEqual(live.terrainEdits);
        expect(reloaded.fieldItems).toEqual(live.fieldItems);
        expect(terrainOf(reloaded)?.tiles).toEqual(terrainOf(live)?.tiles);
        const surface = terrainOf(reloaded) as Grid;
        expect(surface.tiles[5 * surface.width + 6]).toBe('floor');
        expect(grid.tiles[5 * grid.width + 6]).toBe('cover');
    });

    it('maps the inventory to carried items: weapons and throwable things only', () => {
        const item = (patch: Partial<InventoryItem>): InventoryItem => ({
            id: 'x', name: 'Thing', qty: 1, category: 'misc', keywords: [], equipped: false, lastUsedScene: '', importance: 1, notes: '', ...patch,
        });
        const out = carriedItemsFor([
            item({ id: 'a', name: 'Rapier', category: 'weapon', quality: 'rare', equipped: true }),
            item({ id: 'b', name: 'Spare club', category: 'weapon' }),
            item({ id: 'c', name: 'Bottle', category: 'misc', keywords: ['Throwable'] }),
            item({ id: 'd', name: 'Rope', category: 'misc' }),
            item({ id: 'e', name: 'Plate', category: 'armor', equipped: true }),
        ]);
        expect(out).toEqual([
            { id: 'a', name: 'Rapier', quality: 'rare', equipped: true },
            { id: 'b', name: 'Spare club' },
            { id: 'c', name: 'Bottle', throwable: true },
        ]);
        expect(carriedItemsFor(undefined)).toEqual([]);
    });
});
