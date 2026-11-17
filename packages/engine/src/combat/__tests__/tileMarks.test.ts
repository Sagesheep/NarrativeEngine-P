import { describe, it, expect } from 'vitest';
import {
    abilityTargets, applyAction, BUILTIN_SHOVE_ID, BUILTIN_THROW_ID, buildPcCombatant, checkAttack, COMBAT_EVENT_TYPES, createCombat, dimBonus, ELEMENT_IDS,
    ELEMENTS, expectedMarkHarm, MARK_EVENT_TYPES, markIdAt, marksOf, pathTo, planTurn, REACTIONS, runEngineTurns, slideAt, stepEngine, terrainOf, TILE_MARK_IDS,
    TILE_MARKS, undoElementEvent, undoPlacedEvent,
} from '../index';
import type { CombatEvent, CombatState, Combatant, ElementId, GlyphAbility, PlacedEffect, Pos, ThrowPayload, TileMarkId } from '../index';
import { arena, caster, casterSheet, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const at = (x: number, y: number): Pos => ({ x, y });
const cast = (s: CombatState, abilityId: string, aim: Pos | null = null, actorId = 'pc') =>
    applyAction(s, { type: 'use_ability', actorId, abilityId, aim });
const end = (s: CombatState, actorId: string) => applyAction(s, { type: 'end_turn', actorId });
const of = (events: CombatEvent[], type: string) => events.filter(e => e.type === type);
const clean = (seed = 7, n = 12) => cursorFor(seed, r => r.every(x => x !== 1 && x !== 20), n);
const failSave = cursorFor(7, r => r[0] <= 5, 1);
const has = (c: Combatant, id: string) => c.conditions.some(x => x.id === id);
const key = (p: Pos) => `${p.x},${p.y}`;
const tilesOf = (s: CombatState, mark: TileMarkId) => marksOf(s).filter(m => m.mark === mark).flatMap(m => m.tiles).map(key).sort();

const corridor = () => openGrid(16, 12, Array.from({ length: 16 }, (_, x) => [at(x, 4), at(x, 6)]).flat());

function marked(s: CombatState, mark: TileMarkId, tiles: Pos[], extra: Partial<PlacedEffect> = {}): CombatState {
    const n = (s.nextPlaced ?? 0) + 1;
    const record: PlacedEffect = {
        id: `placed${n}`, kind: 'mark', mark, ownerId: 'pc', side: 'player', name: 'Test', trigger: 'enter', tiles: tiles.map(t => ({ ...t })),
        element: 'fire', placedRound: s.round, expiresRound: s.round + TILE_MARKS[mark].rounds, ...extra,
    };
    return { ...s, placed: [...(s.placed ?? []), record], nextPlaced: n };
}

const sigilAt = (s: CombatState, tile: Pos): CombatState => {
    const n = (s.nextPlaced ?? 0) + 1;
    const payload: GlyphAbility = { ...glyph('sigil', ['damage'], [], { id: 'trap' }), form: { id: 'sigil', augments: [] } };
    const record: PlacedEffect = {
        id: `placed${n}`, kind: 'sigil', ownerId: 'pc', side: 'player', name: 'Trap', trigger: 'enter', tiles: [tile], payload,
        placedRound: s.round, expiresRound: s.round + 5,
    };
    return { ...s, placed: [...(s.placed ?? []), record], nextPlaced: n };
};

function fire(element: ElementId, form: 'burst' | 'cone' | 'line' | 'projectile' | 'touch', effects: Array<'damage' | 'heal'> = ['damage']): GlyphAbility {
    return glyph(form, effects, [], { id: `${form}-${element}`, element });
}

function corridorDuel(extra: Partial<Combatant> = {}, state: Partial<CombatState> = {}): CombatState {
    return arena([caster([], at(2, 5)), foe('f', at(10, 5), { hp: 60, maxHp: 60, ...extra })], { grid: corridor(), ...state });
}

const moveTo = (s: CombatState, id: string, to: Pos) => applyAction(s, { type: 'move', actorId: id, to });

describe('the mark and reaction tables', () => {
    it('hold a row for every mark and point every element at a real one', () => {
        expect(Object.keys(TILE_MARKS).sort()).toEqual([...TILE_MARK_IDS].sort());
        for (const id of TILE_MARK_IDS) {
            expect(TILE_MARKS[id].rounds).toBeGreaterThan(0);
            expect(TILE_MARKS[id].extraCost).toBeGreaterThanOrEqual(0);
        }
        for (const e of ELEMENT_IDS) {
            const { mark, clears } = ELEMENTS[e];
            if (mark) expect(TILE_MARKS[mark]).toBeDefined();
            if (clears) expect(REACTIONS.some(r => r.element === e && 'mark' in r.on && r.on.mark === clears && r.effect.kind === 'clear')).toBe(true);
        }
        expect(TILE_MARKS.flames.harm).toEqual({ amount: 1, element: 'fire' });
        expect(TILE_MARKS.molten.harm?.element).toBe('lava');
        expect(TILE_MARKS.rubble.extraCost).toBe(1);
        expect(TILE_MARKS.sticky.extraCost).toBeGreaterThan(TILE_MARKS.rubble.extraCost);
        expect(TILE_MARKS.slick.slide).toBe(1);
        expect(TILE_MARKS.dim.coverBonus).toBe(2);
    });

    it('lists the reactions the order names and only real ids', () => {
        const ids = REACTIONS.map(r => r.id).sort();
        expect(ids).toEqual(['brighten', 'burn_away', 'conduct', 'cool', 'douse', 'freeze', 'melt']);
        for (const r of REACTIONS) {
            expect(ELEMENT_IDS).toContain(r.element);
            if ('mark' in r.on) expect(TILE_MARKS[r.on.mark]).toBeDefined();
            if (r.effect.kind === 'become') expect(TILE_MARKS[r.effect.mark]).toBeDefined();
        }
    });

    it('registers the new event types', () => {
        for (const type of MARK_EVENT_TYPES) expect(COMBAT_EVENT_TYPES).toContain(type);
    });
});

describe('leaving a mark', () => {
    const burst = fire('fire', 'burst');
    const duel = (extra: Partial<CombatState> = {}) =>
        arena([caster([burst], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean(), ...extra });

    it('puts the element\'s mark on the covered squares for the table duration, as one placed record', () => {
        const s = duel();
        const aim = abilityTargets(s, 'pc', burst, at(8, 5));
        const r = cast(s, burst.id, at(8, 5));
        const marks = marksOf(r.state);
        expect(marks).toHaveLength(1);
        expect(marks[0]).toMatchObject({ kind: 'mark', mark: 'flames', ownerId: 'pc', side: 'player', element: 'fire', placedRound: 1, expiresRound: 1 + TILE_MARKS.flames.rounds });
        expect(marks[0].tiles.map(key).sort()).toEqual(aim.tiles.map(key).sort());
        expect(marks[0].tiles).toHaveLength(9);
        const placed = of(r.events, 'placed').find(e => (e.data.placed as PlacedEffect).kind === 'mark');
        expect(placed?.data).toMatchObject({ kind: 'mark', mark: 'flames', element: 'fire' });
        expect(placed?.text).toContain('flames');
    });

    it('never marks a wall, cover or the caster\'s own square', () => {
        const grid = openGrid(16, 12, [at(9, 5)], [[at(9, 4), 'cover']]);
        const s = arena([caster([burst], at(5, 5)), foe('f', at(7, 5), { ac: 0, hp: 99, maxHp: 99 })], { grid, rngCursor: clean() });
        const r = cast(s, burst.id, at(7, 5));
        const tiles = marksOf(r.state).flatMap(m => m.tiles).map(key);
        expect(tiles).not.toContain('9,5');
        expect(tiles).not.toContain('9,4');
        const near = cast(arena([caster([burst], at(5, 5)), foe('f', at(7, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() }), burst.id, at(6, 5));
        expect(abilityTargets(near.state, 'pc', burst, at(6, 5)).tiles.map(key)).toContain('5,5');
        expect(marksOf(near.state).flatMap(m => m.tiles).map(key)).not.toContain('5,5');
    });

    it('is left by a cone and a line as well, and by a sigil going off or a delayed area', () => {
        for (const form of ['cone', 'line'] as const) {
            const a = fire('fire', form);
            const s = arena([caster([a], at(5, 5)), foe('f', at(7, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
            const r = cast(s, a.id, at(7, 5));
            expect(marksOf(r.state).length).toBeGreaterThan(0);
            expect(marksOf(r.state)[0].mark).toBe('flames');
        }
        const delayed = glyph('burst', ['damage'], ['delay'], { id: 'late', element: 'fire' });
        const s = arena([caster([delayed], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const laid = cast(s, 'late', at(8, 5));
        expect(marksOf(laid.state)).toHaveLength(0);
        const went = end(laid.state, 'pc');
        const next = end(went.state, 'f');
        expect(marksOf(next.state).length).toBeGreaterThan(0);
        const sigil = glyph('sigil', ['damage'], [], { id: 'trapfire', element: 'fire' });
        const t = arena([caster([sigil], at(5, 5)), foe('f', at(9, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const trapped = cast(t, 'trapfire', at(7, 5));
        expect(marksOf(trapped.state)).toHaveLength(0);
        const stepped = moveTo(end(trapped.state, 'pc').state, 'f', at(7, 5));
        expect(of(stepped.events, 'placed_triggered')).toHaveLength(1);
        expect(tilesOf(stepped.state, 'flames')).toEqual(['7,5']);
    });

    it('is not left by a single-target ability, a helpful chain or an element with no mark', () => {
        for (const a of [fire('fire', 'projectile'), fire('fire', 'touch'), fire('fire', 'burst', ['heal']), fire('kinetic', 'burst'), fire('steel', 'burst'), fire('lightning', 'burst')]) {
            const s = arena([caster([a], at(5, 5)), foe('f', at(6, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
            const r = cast(s, a.id, a.form.id === 'projectile' || a.form.id === 'touch' ? at(6, 5) : at(7, 5));
            expect(r.events.some(e => e.type === 'rejected')).toBe(false);
            expect(marksOf(r.state)).toHaveLength(0);
            expect(r.state.placed).toBeUndefined();
        }
    });

    it('is not left by an ability with no element, and then nothing about the fight changes', () => {
        const plain = glyph('burst', ['damage'], [], { id: 'plain' });
        const s = arena([caster([plain], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const r = cast(s, 'plain', at(8, 5));
        expect(r.state.placed).toBeUndefined();
        expect(r.state.nextPlaced).toBeUndefined();
        expect(r.events.some(e => MARK_EVENT_TYPES.includes(e.type) || e.type === 'placed')).toBe(false);
        expect(terrainOf(r.state)).toBe(r.state.grid);
    });

    it('lays each element\'s own mark', () => {
        const wanted: Array<[ElementId, TileMarkId]> = [['earth', 'rubble'], ['ice', 'slick'], ['slime', 'sticky'], ['lava', 'molten'], ['darkness', 'dim'], ['fire', 'flames']];
        for (const [element, mark] of wanted) {
            const a = fire(element, 'burst');
            const s = arena([caster([a], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
            const r = cast(s, a.id, at(8, 5));
            expect(marksOf(r.state).map(m => m.mark)).toEqual([mark]);
            expect(marksOf(r.state)[0].expiresRound).toBe(1 + TILE_MARKS[mark].rounds);
        }
    });

    it('holds one mark per square: a newer mark replaces the older one and leaves the rest', () => {
        const s = marked(duel(), 'rubble', [at(8, 5), at(9, 5), at(12, 5)]);
        const r = cast(s, burst.id, at(8, 5));
        expect(markIdAt(r.state, at(8, 5))).toBe('flames');
        expect(markIdAt(r.state, at(9, 5))).toBe('flames');
        expect(markIdAt(r.state, at(12, 5))).toBe('rubble');
        expect(tilesOf(r.state, 'rubble')).toEqual(['12,5']);
        const ended = of(r.events, 'placed_ended');
        expect(ended).toHaveLength(1);
        expect(ended[0].data).toMatchObject({ why: 'replaced', kind: 'mark' });
        expect(of(r.events, 'placed').filter(e => e.data.continued === true)).toHaveLength(1);
    });

    it('fades after its rounds and the ground is plain again', () => {
        let state = marked(corridorDuel(), 'rubble', [at(8, 5)]);
        expect(terrainOf(state)?.extraCost?.[5 * 16 + 8]).toBe(1);
        const events: CombatEvent[] = [];
        for (let i = 0; i < 40 && marksOf(state).length > 0; i++) {
            const r = end(state, state.order[state.turnIndex]);
            events.push(...r.events);
            state = r.state;
        }
        const ended = of(events, 'placed_ended').filter(e => e.data.kind === 'mark');
        expect(ended).toHaveLength(1);
        expect(ended[0].data.why).toBe('expired');
        expect(state.round).toBe(1 + TILE_MARKS.rubble.rounds);
        expect(terrainOf(state)?.extraCost).toBeUndefined();
    });
});

describe('flames and molten ground', () => {
    it('hurt a unit for each marked square it walks over, once per square', () => {
        const s = marked(end(corridorDuel(), 'pc').state, 'flames', [at(9, 5), at(8, 5)]);
        const r = moveTo(s, 'f', at(6, 5));
        const hurt = of(r.events, 'mark_harm');
        expect(hurt).toHaveLength(2);
        expect(hurt[0].data).toMatchObject({ mark: 'flames', damage: 1, damageType: 'fire', why: 'enter', hpBefore: 60, hpAfter: 59 });
        expect(r.state.combatants.f.hp).toBe(58);
        expect(r.state.combatants.f.position).toEqual(at(6, 5));
    });

    it('hurts a unit that starts its turn on one, and everyone alike', () => {
        const s = marked(corridorDuel(), 'flames', [at(10, 5), at(2, 5)]);
        const r = end(s, 'pc');
        expect(of(r.events, 'mark_harm')).toHaveLength(1);
        expect(r.events.find(e => e.type === 'mark_harm')).toMatchObject({ targetId: 'f', data: { why: 'turn_start', damage: 1 } });
        const back = end(r.state, 'f');
        expect(back.events.find(e => e.type === 'mark_harm')).toMatchObject({ targetId: 'pc', data: { why: 'turn_start' } });
    });

    it('count weak, resisted and immune like any hit of that element', () => {
        const run = (extra: Partial<Combatant>) => end(marked(corridorDuel(extra), 'flames', [at(10, 5)]), 'pc').events.find(e => e.type === 'mark_harm');
        const molten = (extra: Partial<Combatant>) => end(marked(corridorDuel(extra), 'molten', [at(10, 5)]), 'pc').events.find(e => e.type === 'mark_harm');
        expect(molten({ weak: ['lava'] })?.data).toMatchObject({ damage: 3, weakness: true });
        expect(molten({ resist: ['lava'] })?.data).toMatchObject({ damage: 1, resisted: true });
        expect(run({ immune: ['fire'] })?.data).toMatchObject({ damage: 0, immune: true });
        const lava = end(marked(corridorDuel({ immune: ['lava'] }), 'molten', [at(10, 5)]), 'pc').events.find(e => e.type === 'mark_harm');
        expect(lava?.data).toMatchObject({ damage: 0, immune: true, mark: 'molten' });
        const soaked = end(marked(corridorDuel({ hp: 60 }), 'molten', [at(10, 5)]), 'pc').events.find(e => e.type === 'mark_harm');
        expect(soaked?.data).toMatchObject({ damage: TILE_MARKS.molten.harm?.amount, damageType: 'lava' });
    });

    it('can fell a unit, which passes the turn on', () => {
        const s = marked(end(corridorDuel({ hp: 2, maxHp: 60 }), 'pc').state, 'flames', [at(9, 5), at(8, 5)]);
        const r = moveTo(s, 'f', at(6, 5));
        expect(r.state.combatants.f.status).toBe('down');
        expect(of(r.events, 'down')).toHaveLength(1);
        expect(r.state.outcome).toBe('victory');
    });

    it('molten ground is difficult as well as harmful', () => {
        const s = marked(end(corridorDuel(), 'pc').state, 'molten', [at(8, 5)]);
        const r = moveTo(s, 'f', at(6, 5));
        expect(of(r.events, 'moved')[0].data.cost).toBe(5);
        expect(of(r.events, 'mark_harm')).toHaveLength(1);
    });
});

describe('rubble and sticky ground', () => {
    const open = corridorDuel();

    it('cost extra movement and nothing else', () => {
        expect(pathTo({ ...open, turnIndex: 1, turn: { actorId: 'f', moveLeft: 6, actionUsed: false } }, 'f', at(6, 5))?.cost).toBe(4);
        const rubble = marked(open, 'rubble', [at(8, 5)]);
        const sticky = marked(open, 'sticky', [at(8, 5)]);
        const at6 = (s: CombatState) => pathTo({ ...s, turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }, 'f', at(6, 5))?.cost;
        expect(at6(rubble)).toBe(5);
        expect(at6(sticky)).toBe(4 + TILE_MARKS.sticky.extraCost);
        const r = moveTo(end(rubble, 'pc').state, 'f', at(6, 5));
        expect(r.state.turn?.moveLeft).toBe(6 - 5);
        expect(of(r.events, 'mark_harm')).toHaveLength(0);
    });

    it('can put a destination out of reach', () => {
        const sticky = marked(end(open, 'pc').state, 'sticky', [at(9, 5), at(8, 5)]);
        expect(moveTo(sticky, 'f', at(7, 5)).events[0].type).toBe('rejected');
        expect(moveTo(sticky, 'f', at(8, 5)).events[0].type).toBe('moved');
    });

    it('stack on a tile that is already difficult', () => {
        const grid = openGrid(16, 12, Array.from({ length: 16 }, (_, x) => [at(x, 4), at(x, 6)]).flat(), [[at(8, 5), 'difficult']]);
        const s = marked(arena([caster([], at(2, 5)), foe('f', at(10, 5))], { grid }), 'rubble', [at(8, 5)]);
        expect(pathTo({ ...s, turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }, 'f', at(6, 5))?.cost).toBe(6);
    });
});

describe('slick ground', () => {
    it('stops a walking unit on the square and slides it one square on, in the direction it was going', () => {
        const s = marked(end(corridorDuel(), 'pc').state, 'slick', [at(8, 5)]);
        const r = moveTo(s, 'f', at(6, 5));
        expect(of(r.events, 'moved')[0].data).toMatchObject({ stoppedBy: 'slick', to: at(8, 5) });
        const slid = of(r.events, 'pushed')[0];
        expect(slid.data).toMatchObject({ kind: 'slide', slick: true, mark: 'slick', moves: [{ id: 'f', from: at(8, 5), to: at(7, 5) }] });
        expect(r.state.combatants.f.position).toEqual(at(7, 5));
        expect(r.state.turn?.moveLeft).toBe(6 - 2);
    });

    it('does not slide into a wall or a unit', () => {
        const wall = marked(end(arena([caster([], at(2, 5)), foe('f', at(10, 5))], { grid: openGrid(16, 12, [...Array.from({ length: 16 }, (_, x) => [at(x, 4), at(x, 6)]).flat(), at(7, 5)]) }), 'pc').state, 'slick', [at(8, 5)]);
        const r = moveTo(wall, 'f', at(8, 5));
        expect(of(r.events, 'pushed')).toHaveLength(0);
        expect(r.state.combatants.f.position).toEqual(at(8, 5));
        const crowd = arena([caster([], at(2, 5)), foe('f', at(10, 5)), foe('g', at(7, 5))], { grid: corridor() });
        const blocked = moveTo(marked(end(crowd, 'pc').state, 'slick', [at(8, 5)]), 'f', at(8, 5));
        expect(of(blocked.events, 'pushed')).toHaveLength(0);
    });

    it('slides a pushed unit too, and the engine avoids it when it can', () => {
        const push = glyph('touch', ['push'], [], { id: 'shoo' });
        const base = arena([caster([push], at(5, 5)), foe('f', at(6, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const plain = cast(base, 'shoo', at(6, 5));
        const landed = of(plain.events, 'pushed')[0].data.moves as Array<{ to: Pos }>;
        const to = landed[0].to;
        const slick = cast(marked(base, 'slick', [to]), 'shoo', at(6, 5));
        const slides = of(slick.events, 'pushed');
        expect(slides).toHaveLength(2);
        expect(slides[1].data).toMatchObject({ kind: 'slide' });
        expect(slick.state.combatants.f.position).toEqual(at(to.x + 1, to.y));
        const open = marked({ ...corridorDuel(), turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }, 'slick', [at(8, 5)]);
        expect(slideAt(open, at(8, 5))).toBe(1);
        expect(slideAt(open, at(7, 5))).toBe(0);
    });
});

describe('dim ground', () => {
    it('adds cover to attacks into or out of it, and only those', () => {
        const base = arena([caster([], at(2, 5)), foe('f', at(10, 5), { range: 'ranged' }), foe('g', at(2, 8), { range: 'ranged' })], { grid: corridor() });
        const hit = (s: CombatState) => checkAttack(s, 'f', 'pc').cover;
        expect(hit(base)).toBe(0);
        expect(hit(marked(base, 'dim', [at(2, 5)]))).toBe(2);
        expect(hit(marked(base, 'dim', [at(10, 5)]))).toBe(2);
        expect(hit(marked(base, 'dim', [at(5, 5)]))).toBe(0);
        expect(hit(marked(marked(base, 'dim', [at(10, 5)]), 'dim', [at(2, 5)]))).toBe(2);
        expect(dimBonus(marked(base, 'dim', [at(4, 4)]), at(4, 4), at(9, 9))).toBe(2);
        expect(dimBonus(base, at(4, 4), at(9, 9))).toBe(0);
    });

    it('raises the armour an ability attack must beat', () => {
        const bolt = glyph('projectile', ['damage'], [], { id: 'zap' });
        const base = arena([caster([bolt], at(5, 5)), foe('f', at(9, 5), { ac: 10, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const plain = of(cast(base, 'zap', at(9, 5)).events, 'ability_attack')[0].data;
        const dim = of(cast(marked(base, 'dim', [at(9, 5)]), 'zap', at(9, 5)).events, 'ability_attack')[0].data;
        expect(dim.ac).toBe((plain.ac as number) + 2);
        expect(dim.cover).toBe((plain.cover as number) + 2);
    });
});

describe('reactions with marks', () => {
    const water = fire('water', 'burst');
    const arenaFor = (a: GlyphAbility, extra: Partial<CombatState> = {}) =>
        arena([caster([a], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean(), ...extra });

    it('water douses flames across the area and keeps the flames outside it', () => {
        const s = marked(arenaFor(water), 'flames', [at(6, 5), at(7, 5), at(8, 5), at(9, 5), at(10, 5), at(11, 5)]);
        const r = cast(s, water.id, at(8, 5));
        expect(tilesOf(r.state, 'flames')).toEqual(['10,5', '11,5', '6,5']);
        const reaction = of(r.events, 'reaction')[0];
        expect(reaction.data).toMatchObject({ reaction: 'douse', element: 'water', kind: 'clear', mark: 'flames' });
        expect((reaction.data.tiles as Pos[]).map(key).sort()).toEqual(['7,5', '8,5', '9,5']);
        expect(of(r.events, 'placed_ended')[0].data).toMatchObject({ why: 'cleared' });
        expect(marksOf(r.state).every(m => m.mark === 'flames' && m.expiresRound === 4)).toBe(true);
        expect(marksOf(r.state).some(m => m.mark !== 'flames')).toBe(false);
    });

    it('water clears flames before the area pushes anyone through them', () => {
        const wide = glyph('burst', ['damage'], ['widen'], { id: 'flood', element: 'water' });
        const s = marked(arenaFor(wide), 'flames', [at(9, 5), at(8, 5)]);
        const r = cast(s, 'flood', at(7, 5));
        const order = r.events.map(e => e.type);
        const shove = r.events.findIndex(e => e.type === 'pushed' && e.targetId === 'f');
        expect(order.indexOf('reaction')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('reaction')).toBeLessThan(shove);
        expect(r.events[shove].data.moves).toMatchObject([{ id: 'f', from: at(8, 5), to: at(9, 5) }]);
        expect(of(r.events, 'mark_harm')).toHaveLength(0);
        expect(tilesOf(r.state, 'flames')).toEqual([]);
    });

    it('water cools molten ground to rubble', () => {
        const s = marked(arenaFor(water), 'molten', [at(7, 5), at(8, 5)]);
        const r = cast(s, water.id, at(8, 5));
        expect(tilesOf(r.state, 'molten')).toEqual([]);
        expect(tilesOf(r.state, 'rubble')).toEqual(['7,5', '8,5']);
        expect(of(r.events, 'reaction')[0].data).toMatchObject({ reaction: 'cool', kind: 'become', becomes: 'rubble' });
        const rubble = marksOf(r.state).find(m => m.mark === 'rubble') as PlacedEffect;
        expect(rubble.expiresRound).toBe(1 + TILE_MARKS.rubble.rounds);
        expect(rubble.element).toBe('water');
    });

    it('fire melts slick ground and burns sticky ground away, then leaves its own flames', () => {
        const a = fire('fire', 'burst');
        for (const [mark, id] of [['slick', 'melt'], ['sticky', 'burn_away']] as const) {
            const s = marked(arenaFor(a), mark, [at(7, 5), at(8, 5)]);
            const r = cast(s, a.id, at(8, 5));
            expect(of(r.events, 'reaction')[0].data).toMatchObject({ reaction: id, kind: 'clear', mark });
            expect(tilesOf(r.state, mark)).toEqual([]);
            expect(markIdAt(r.state, at(7, 5))).toBe('flames');
            expect(marksOf(r.state).map(m => m.mark)).toEqual(['flames']);
        }
    });

    it('light clears dim and leaves nothing', () => {
        const a = fire('light', 'burst');
        const s = marked(arenaFor(a), 'dim', [at(7, 5), at(8, 5), at(14, 5)]);
        const r = cast(s, a.id, at(8, 5));
        expect(of(r.events, 'reaction')[0].data).toMatchObject({ reaction: 'brighten', mark: 'dim' });
        expect(tilesOf(r.state, 'dim')).toEqual(['14,5']);
    });

    it('does nothing for an arrival with no row, and the newer mark simply takes the square', () => {
        const a = fire('earth', 'burst');
        const s = marked(arenaFor(a), 'flames', [at(8, 5)]);
        const r = cast(s, a.id, at(8, 5));
        expect(of(r.events, 'reaction')).toHaveLength(0);
        expect(markIdAt(r.state, at(8, 5))).toBe('rubble');
        const cold = fire('ice', 'burst');
        const sl = marked(arenaFor(cold), 'flames', [at(8, 5)]);
        expect(of(cast(sl, cold.id, at(8, 5)).events, 'reaction')).toHaveLength(0);
    });

    it('is only for an ability that does something hostile', () => {
        const heal = fire('water', 'burst', ['heal']);
        const s = marked(arenaFor(heal), 'flames', [at(8, 5)]);
        const r = cast(s, heal.id, at(8, 5));
        expect(of(r.events, 'reaction')).toHaveLength(0);
        expect(markIdAt(r.state, at(8, 5))).toBe('flames');
    });

    it('also happens for a delayed area when it goes off', () => {
        const late = glyph('burst', ['damage'], ['delay'], { id: 'lateWater', element: 'water' });
        const s = marked(arenaFor(late), 'flames', [at(8, 5), at(7, 5)]);
        const laid = cast(s, 'lateWater', at(8, 5));
        expect(of(laid.events, 'reaction')).toHaveLength(0);
        const next = end(end(laid.state, 'pc').state, 'f');
        expect(of(next.events, 'reaction')).toHaveLength(1);
        expect(tilesOf(next.state, 'flames')).toEqual([]);
    });
});

describe('reactions with a soaked unit', () => {
    const touchOf = (element: ElementId) => glyph('touch', ['damage'], [], { id: `t-${element}`, element });
    const duel = (a: GlyphAbility, target: Partial<Combatant>, others: Combatant[] = []) =>
        arena([caster([a], at(5, 5)), foe('f', at(6, 5), { ac: 0, hp: 99, maxHp: 99, ...target }), ...others], { rngCursor: clean() });
    const soaked = { conditions: [{ id: 'soaked', turns: 2 }] };

    it('ice makes the chill of a soaked unit last one turn longer', () => {
        const a = touchOf('ice');
        const dry = cast(duel(a, {}), a.id, at(6, 5));
        expect(dry.state.combatants.f.conditions.find(c => c.id === 'slowed')).toMatchObject({ turns: 1, element: 'ice' });
        expect(of(dry.events, 'reaction')).toHaveLength(0);
        const wet = cast(duel(a, soaked), a.id, at(6, 5));
        expect(wet.state.combatants.f.conditions.find(c => c.id === 'slowed')).toMatchObject({ turns: 2, element: 'ice' });
        const reaction = of(wet.events, 'reaction')[0];
        expect(reaction).toMatchObject({ targetId: 'f', data: { reaction: 'freeze', kind: 'extend', condition: 'slowed', turns: 2 } });
        expect(reaction.data.before).toMatchObject({ id: 'slowed', turns: 1 });
        expect(wet.state.combatants.f.conditions.find(c => c.id === 'soaked')).toBeDefined();
    });

    it('does not apply to an immune unit, which gets no chill to deepen', () => {
        const a = touchOf('ice');
        const r = cast(duel(a, { ...soaked, immune: ['ice'] }), a.id, at(6, 5));
        expect(of(r.events, 'reaction')).toHaveLength(0);
        expect(has(r.state.combatants.f, 'slowed')).toBe(false);
    });

    it('lightning into a soaked unit arcs to every adjacent foe, otherwise to one', () => {
        const a = touchOf('lightning');
        const others = [foe('g', at(6, 6), { ac: 0, hp: 99, maxHp: 99 }), foe('h', at(7, 5), { ac: 0, hp: 99, maxHp: 99 }), foe('far', at(12, 9), { ac: 0, hp: 99, maxHp: 99 })];
        const dry = cast(duel(a, {}, others), a.id, at(6, 5));
        expect(of(dry.events, 'ability_damage').filter(e => e.data.arc === true)).toHaveLength(1);
        const wet = cast(duel(a, soaked, others), a.id, at(6, 5));
        const arcs = of(wet.events, 'ability_damage').filter(e => e.data.arc === true);
        expect(arcs.map(e => e.targetId).sort()).toEqual(['g', 'h']);
        expect(of(wet.events, 'reaction')[0].data).toMatchObject({ reaction: 'conduct', kind: 'arc_all' });
        expect(wet.state.combatants.far.hp).toBe(99);
    });

    it('lightning never arcs to a friend and says nothing when nothing is adjacent', () => {
        const a = touchOf('lightning');
        const friend = { ...foe('pal', at(6, 6), { ac: 0, hp: 99, maxHp: 99 }), side: 'ally' as const };
        const r = cast(duel(a, soaked, [friend]), a.id, at(6, 5));
        expect(of(r.events, 'reaction')).toHaveLength(0);
        expect(r.state.combatants.pal.hp).toBe(99);
    });
});

describe('forced movement onto marks and sigils', () => {
    it('a shoved unit that lands on a sigil sets it off', () => {
        const base = arena([caster([], at(5, 5), { abilities: { STR: 18, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 } }), foe('f', at(6, 5), { hp: 99, maxHp: 99 })], { rngCursor: failSave });
        const shove = (s: CombatState) => applyAction(s, { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_SHOVE_ID, aim: at(6, 5) });
        const plain = shove(base);
        const to = (of(plain.events, 'pushed')[0].data.moves as Array<{ to: Pos }>)[0].to;
        const withSigil = shove(sigilAt(base, to));
        expect(of(withSigil.events, 'placed_triggered')).toHaveLength(1);
        expect(withSigil.state.placed).toEqual([]);
        expect(withSigil.state.combatants.f.hp).toBeLessThan(99);
    });

    it('a pushed unit that lands on flames is hurt', () => {
        const push = glyph('touch', ['push'], [], { id: 'shoo' });
        const base = arena([caster([push], at(5, 5)), foe('f', at(6, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() });
        const to = (of(cast(base, 'shoo', at(6, 5)).events, 'pushed')[0].data.moves as Array<{ to: Pos }>)[0].to;
        const burnt = cast(marked(base, 'flames', [to]), 'shoo', at(6, 5));
        expect(of(burnt.events, 'mark_harm')).toHaveLength(1);
        expect(burnt.state.combatants.f.hp).toBe(98);
    });

    it('a thrown creature that lands on a sigil sets it off, like any other entry', () => {
        const pc = () => caster([], at(2, 2), { abilities: { STR: 16, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 } });
        const base = arena([pc(), foe('m', at(3, 2), { tier: 'minion', hp: 30, maxHp: 30 }), foe('f', at(9, 9))], { rngCursor: failSave });
        const creature: ThrowPayload = { kind: 'creature', id: 'm' };
        const toss = (s: CombatState) => applyAction(s, { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_THROW_ID, aim: at(5, 2), payload: creature });
        const plain = toss(base);
        expect(of(plain.events, 'thrown')).toHaveLength(1);
        expect(of(plain.events, 'placed_triggered')).toHaveLength(0);
        const trapped = toss(sigilAt(base, at(5, 2)));
        const kinds = trapped.events.map(e => e.type);
        expect(kinds.indexOf('placed_triggered')).toBeGreaterThan(kinds.indexOf('thrown'));
        expect(trapped.state.placed).toEqual([]);
        expect(trapped.state.combatants.m.position).toEqual(at(5, 2));
        expect(trapped.state.combatants.m.hp).toBeLessThan(plain.state.combatants.m.hp);
    });

    it('a thrown creature that lands on flames burns and on slick slides on', () => {
        const pc = () => caster([], at(2, 2), { abilities: { STR: 16, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 } });
        const base = arena([pc(), foe('m', at(3, 2), { tier: 'minion', hp: 30, maxHp: 30 }), foe('f', at(9, 9))], { rngCursor: failSave });
        const toss = (s: CombatState) => applyAction(s, { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_THROW_ID, aim: at(5, 2), payload: { kind: 'creature', id: 'm' } });
        const burnt = toss(marked(base, 'flames', [at(5, 2)]));
        expect(of(burnt.events, 'mark_harm')).toHaveLength(1);
        const slid = toss(marked(base, 'slick', [at(5, 2)]));
        expect(of(slid.events, 'pushed')[0].data).toMatchObject({ kind: 'slide' });
        expect(slid.state.combatants.m.position).toEqual(at(6, 2));
    });

    it('a blink, a dash or a leap that ends on flames burns the traveller', () => {
        const blink = glyph('self', ['blink'], [], { id: 'hop' });
        const base = arena([caster([blink], at(5, 5)), foe('f', at(12, 9))], { rngCursor: clean() });
        const dest = at(8, 5);
        const r = cast(marked(base, 'flames', [dest]), 'hop', dest);
        expect(r.events.some(e => e.type === 'rejected')).toBe(false);
        expect(of(r.events, 'mark_harm')).toHaveLength(1);
        expect(of(r.events, 'mark_harm')[0].targetId).toBe('pc');
    });
});

describe('the planner and marks', () => {
    it('does not plan through or onto flames when it can go around, and leaves a burning square', () => {
        const flames = [at(7, 4), at(7, 5), at(7, 6)];
        const s = marked(arena([caster([], at(2, 5)), foe('f', at(12, 5), { attackBonus: 5 })], { turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }), 'flames', flames);
        const plan = planTurn(s, 'f');
        const move = plan.steps.find(a => a.type === 'move');
        expect(move).toBeDefined();
        const to = (move as { to: Pos }).to;
        expect(flames.map(key)).not.toContain(key(to));
        const route = pathTo(s, 'f', to);
        expect(route?.path.some(p => flames.map(key).includes(key(p)))).toBe(false);
        const standing = marked(arena([caster([], at(5, 5)), foe('f', at(6, 5), { attackBonus: 5 })], { turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }), 'flames', [at(6, 5)]);
        const away = planTurn(standing, 'f').steps[0];
        expect(away.type).toBe('move');
        expect(key((away as { to: Pos }).to)).not.toBe('6,5');
        const calm = planTurn(arena([caster([], at(5, 5)), foe('f', at(6, 5), { attackBonus: 5 })], { turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false } }), 'f').steps[0];
        expect(calm.type).toBe('attack');
    });

    it('prefers to push a foe onto flames', () => {
        const push = glyph('touch', ['push'], [], { id: 'shoo' });
        const make = (withFlames: boolean) => {
            const base = arena([{ ...caster([], at(4, 5)), controller: 'engine' as const }, foe('f', at(5, 5), {
                kit: [push], proficiency: 3, castingAbility: 'INT', abilities: { STR: 10, DEX: 10, CON: 10, INT: 18, WIS: 10, CHA: 10 },
                tier: 'elite', archetype: 'caster', damage: { count: 1, sides: 1, bonus: 0, type: 'slashing' },
            })], { turnIndex: 1, turn: { actorId: 'f', moveLeft: 0, actionUsed: false } });
            return withFlames ? marked(base, 'flames', [at(2, 5), at(2, 4), at(2, 6)]) : base;
        };
        const choose = (s: CombatState) => planTurn(s, 'f').steps.find(a => a.type === 'use_ability' || a.type === 'attack');
        const calm = choose(make(false));
        const lit = choose(make(true));
        expect(lit && lit.type === 'use_ability' && lit.abilityId).toBe('shoo');
        expect(calm?.type === 'use_ability' ? calm.abilityId : 'weapon').not.toBe('shoo');
        expect(expectedMarkHarm(make(true), foe('x', at(0, 0)), at(2, 5))).toBe(1);
    });

    it('reads no random numbers and leaves the state alone', () => {
        const s = marked(marked(arena([caster([], at(2, 5)), foe('f', at(12, 5))], { turnIndex: 1, turn: { actorId: 'f', moveLeft: 8, actionUsed: false }, rngCursor: 41 }), 'flames', [at(7, 5)]), 'slick', [at(8, 5)]);
        const snapshot = JSON.stringify(s);
        planTurn(s, 'f');
        expect(JSON.stringify(s)).toBe(snapshot);
        expect(s.rngCursor).toBe(41);
    });

    it('plays whole seeded fights with every marking element and never has a planned step refused', () => {
        const elements: ElementId[] = ['fire', 'water', 'earth', 'ice', 'slime', 'darkness', 'light', 'lava'];
        let marksSeen = 0;
        let harmSeen = 0;
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            const kit = [glyph('burst', ['damage'], [], { id: 'k1', element }), glyph('cone', ['damage'], [], { id: 'k2', element })];
            const created = createCombat({
                id: `m${i}`, combatants: [{ name: 'Hexer', side: 'enemy', tier: 'elite', archetype: 'caster' }, { name: 'Brute', side: 'enemy', tier: 'grunt' }],
                map: { size: 'medium', area: 'scattered' },
            }, buildPcCombatant({ name: 'Hero', sheet: casterSheet, weapon: { quality: 'common' }, kit: [glyph('burst', ['damage'], [], { id: 'pk', element })] }), 300 + i);
            const hexer = Object.values(created.state.combatants).find(c => c.name === 'Hexer') as Combatant;
            let state: CombatState = { ...created.state, combatants: { ...created.state.combatants, [hexer.id]: { ...hexer, kit } } };
            let refused = 0;
            for (let step = 0; step < 700 && !state.outcome; step++) {
                const id = state.order[state.turnIndex];
                const actor = state.combatants[id];
                if (actor.controller === 'player' && actor.status === 'up') {
                    const plan = planTurn(state, id);
                    const r = applyAction(state, plan.steps[0] ?? { type: 'end_turn', actorId: id });
                    if (r.events.some(e => e.type === 'rejected')) refused += 1;
                    state = r.events.some(e => e.type === 'rejected') ? end(state, id).state : r.state;
                    marksSeen += of(r.events, 'placed').filter(e => e.data.kind === 'mark').length;
                    harmSeen += of(r.events, 'mark_harm').length;
                    continue;
                }
                const plan = planTurn(state, id);
                const r = stepEngine(state);
                if (!r) break;
                marksSeen += of(r.events, 'placed').filter(e => e.data.kind === 'mark').length;
                harmSeen += of(r.events, 'mark_harm').length;
                if (plan.steps[0] && actor.status === 'up' && !actor.conditions.some(c => c.id === 'confused')) {
                    const direct = applyAction(state, plan.steps[0]);
                    if (direct.events.some(e => e.type === 'rejected')) refused += 1;
                }
                state = r.state;
            }
            expect(refused).toBe(0);
        }
        expect(marksSeen).toBeGreaterThan(8);
        expect(harmSeen).toBeGreaterThan(0);
    });
});

describe('undo and saved fights', () => {
    it('restores a deepened chill and ignores a reaction that changed nothing', () => {
        const a = glyph('touch', ['damage'], [], { id: 't-ice', element: 'ice' });
        const s = arena([caster([a], at(5, 5)), foe('f', at(6, 5), { ac: 0, hp: 99, maxHp: 99, conditions: [{ id: 'soaked', turns: 2 }] })], { rngCursor: clean() });
        const r = cast(s, a.id, at(6, 5));
        const combatants = JSON.parse(JSON.stringify(r.state.combatants)) as Record<string, Combatant>;
        const reaction = of(r.events, 'reaction')[0];
        expect(undoElementEvent(combatants, reaction)).toBe(true);
        expect(combatants.f.conditions.find(c => c.id === 'slowed')).toMatchObject({ turns: 1 });
        const mark = { ...reaction, data: { reaction: 'douse', tiles: [] } };
        expect(undoElementEvent(combatants, mark)).toBe(true);
    });

    it('returns the placed list through every record a reaction and a new mark made', () => {
        const water = fire('water', 'burst');
        const s = marked(arena([caster([water], at(5, 5)), foe('f', at(8, 5), { ac: 0, hp: 99, maxHp: 99 })], { rngCursor: clean() }), 'molten', [at(7, 5), at(8, 5), at(12, 5)]);
        const r = cast(s, water.id, at(8, 5));
        let placed = [...(r.state.placed ?? [])];
        for (const event of [...r.events].reverse()) {
            const back = undoPlacedEvent(placed, event);
            if (back) placed = back;
        }
        expect(placed.map(p => `${p.mark}:${p.tiles.map(key).sort().join('|')}`).sort()).toEqual((s.placed ?? []).map(p => `${p.mark}:${p.tiles.map(key).sort().join('|')}`).sort());
    });

    it('loads a saved fight with no placed list, or with placed records that have no mark', () => {
        const s = corridorDuel();
        expect(s.placed).toBeUndefined();
        expect(terrainOf(s)).toBe(s.grid);
        expect(marksOf(s)).toEqual([]);
        const old = sigilAt(s, at(8, 5));
        expect(terrainOf(old)).toBe(old.grid);
        expect(marksOf(old)).toEqual([]);
        expect(end(old, 'pc').events.some(e => e.type === 'rejected')).toBe(false);
    });

    it('keeps a fight with no elemental area ability exactly as it was', () => {
        const spec = {
            id: 'same', combatants: [{ name: 'A', side: 'enemy' as const, tier: 'grunt' as const }, { name: 'B', side: 'enemy' as const, tier: 'elite' as const, archetype: 'caster' as const }],
            map: { size: 'medium' as const, area: 'scattered' as const },
        };
        const pc = buildPcCombatant({ name: 'Hero', sheet: casterSheet, weapon: { quality: 'common' }, kit: [glyph('touch', ['damage'], [], { id: 'ft', element: 'fire' })] });
        const a = runEngineTurns(createCombat(spec, pc, 9).state);
        expect(a.state.placed).toBeUndefined();
        expect(a.events.some(e => MARK_EVENT_TYPES.includes(e.type))).toBe(false);
        expect(a.events.some(e => e.type === 'placed')).toBe(false);
    });
});
