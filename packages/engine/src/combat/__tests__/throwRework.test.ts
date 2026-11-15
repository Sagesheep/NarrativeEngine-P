import { describe, it, expect } from 'vitest';
import {
    applyAction, BUILTIN_THROW_ID, builtinThrow, checkAbility, chooseEngineTurn, COMBAT_EVENT_TYPES, createRng, describeAbility, EFFECT_IDS,
    ensureGrid, isGlyphAbilityShape, legalAims, legalLandings, nearestFree, payloadAt, payloadChoices, pickUpItems, previewThrow,
    surfaceOf, terrainOf, throwRangeOf, throwReason, validateAbility, coverBetween, tileAt,
} from '../index';
import type { CarriedItem, CombatEvent, CombatState, Combatant, Pos, ThrowPayload, Tile } from '../index';
import { stepCost } from '../grid';
import { arena, caster, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const SEED = 7;
const at = (x: number, y: number): Pos => ({ x, y });
const strong = { STR: 16, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 };
const weak = { STR: 6, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 };

const seeded = (state: CombatState, cursor: number): CombatState => ({ ...state, rngSeed: SEED, rngCursor: cursor });
const pc = (overrides: Partial<Combatant> = {}) => caster([], at(2, 2), { abilities: strong, ...overrides });
const gridWith = (tiles: Array<[Pos, Tile]>, walls: Pos[] = [], w = 16, h = 12) => openGrid(w, h, walls, tiles);
const kinds = (events: CombatEvent[]) => events.map(e => e.type);

function toss(state: CombatState, payload: ThrowPayload, aim: Pos, actorId = 'pc') {
    return applyAction(state, { type: 'use_ability', actorId, abilityId: BUILTIN_THROW_ID, aim, payload });
}

const creature = (id: string): ThrowPayload => ({ kind: 'creature', id });
const hand: ThrowPayload = { kind: 'hand' };

const nat = (n: number) => cursorFor(SEED, r => r[0] === n, 1);
const hitRoll = cursorFor(SEED, r => r[0] >= 15 && r[0] <= 19, 1);
const missRoll = nat(3);
const failSave = cursorFor(SEED, r => r[0] <= 5, 1);
const passSave = cursorFor(SEED, r => r[0] >= 18 && r[0] <= 19, 1);

const dagger: CarriedItem = { id: 'dagger', name: 'Iron dagger', count: 1, sides: 4 };
const glaive: CarriedItem = { id: 'glaive', name: 'Glaive of Ash', count: 1, sides: 10, equipped: true };

describe('Throw: what can be lifted', () => {
    it('lifts a minion or grunt, a fallen creature of any tier but a boss, and any standing ally', () => {
        const s = arena([
            pc(), foe('m', at(3, 2), { tier: 'minion' }), foe('g', at(3, 3)), foe('e', at(2, 3), { tier: 'elite' }),
            foe('body', at(1, 2), { tier: 'elite', status: 'down' }), foe('boss', at(1, 3), { tier: 'boss' }),
            foe('bossBody', at(1, 1), { tier: 'boss', status: 'down' }), foe('a', at(2, 1), { side: 'ally', tier: 'boss' }),
        ]);
        const lift = (id: string) => previewThrow(s, 'pc', creature(id), at(4, 2));
        expect(lift('m').ok).toBe(true);
        expect(lift('g').ok).toBe(true);
        expect(lift('body').ok).toBe(true);
        expect(lift('a').ok).toBe(true);
        for (const id of ['e', 'boss', 'bossBody']) expect(lift(id)).toEqual({ ok: false, reason: 'too heavy to lift' });
        expect(payloadAt(s, 'pc', at(2, 3))).toEqual({ ok: false, reason: 'too heavy to lift' });
        expect(payloadAt(s, 'pc', at(1, 3))).toEqual({ ok: false, reason: 'too heavy to lift' });
        expect(payloadAt(s, 'pc', at(3, 2))).toEqual({ ok: true, payload: creature('m') });
    });

    it('refuses a summon larger than a grunt, a far creature and an empty tile', () => {
        const s = arena([pc(), foe('s', at(3, 2), { side: 'ally', tier: 'elite', summonerId: 'pc' }), foe('far', at(6, 2))]);
        expect(previewThrow(s, 'pc', creature('s'), at(5, 2))).toEqual({ ok: false, reason: 'too heavy to lift' });
        expect(previewThrow(s, 'pc', creature('far'), at(5, 2))).toEqual({ ok: false, reason: 'nothing to throw there' });
        expect(payloadAt(s, 'pc', at(2, 3))).toEqual({ ok: false, reason: 'nothing to throw there' });
        expect(previewThrow(arena([pc(), foe('s', at(3, 2), { side: 'ally', tier: 'grunt', summonerId: 'pc' })]), 'pc', creature('s'), at(5, 2)).ok).toBe(true);
    });

    it('lifts a cover tile beside the thrower and nothing farther', () => {
        const s = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([[at(3, 2), 'cover'], [at(5, 5), 'cover']]) });
        expect(previewThrow(s, 'pc', { kind: 'cover', at: at(3, 2) }, at(6, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', { kind: 'cover', at: at(5, 5) }, at(6, 2))).toEqual({ ok: false, reason: 'nothing to throw there' });
        expect(payloadAt(s, 'pc', at(3, 2))).toEqual({ ok: true, payload: { kind: 'cover', at: at(3, 2) } });
    });

    it('lifts a carried item, the equipped weapon too, and always whatever is at hand', () => {
        const s = arena([pc({ carried: [dagger, glaive] }), foe('f', at(9, 9))]);
        expect(previewThrow(s, 'pc', { kind: 'item', itemId: 'dagger' }, at(5, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', { kind: 'item', itemId: 'glaive' }, at(5, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', { kind: 'item', itemId: 'ghost' }, at(5, 2))).toEqual({ ok: false, reason: 'that item is not carried' });
        expect(previewThrow(s, 'pc', hand, at(5, 2)).ok).toBe(true);
        expect(payloadChoices(s, 'pc').map(c => c.payload.kind)).toEqual(['item', 'item', 'hand']);
    });
});

describe('Throw: range, line of sight and refusals', () => {
    it('ranges by weight and STR, with minimums of 1, 2 and 2', () => {
        expect(['heavy', 'medium', 'light'].map(w => throwRangeOf({ abilities: strong }, w as 'heavy'))).toEqual([4, 5, 7]);
        expect(['heavy', 'medium', 'light'].map(w => throwRangeOf({ abilities: { ...strong, STR: 10 } }, w as 'heavy'))).toEqual([1, 2, 4]);
        expect(['heavy', 'medium', 'light'].map(w => throwRangeOf({ abilities: weak }, w as 'heavy'))).toEqual([1, 2, 2]);
    });

    it('stops a creature at 1 + STR, cover at 2 + STR and light things at 4 + STR', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('far', at(9, 9))], { grid: gridWith([[at(2, 3), 'cover']]) });
        expect(previewThrow(s, 'pc', creature('f'), at(6, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', creature('f'), at(7, 2))).toEqual({ ok: false, reason: 'out of range' });
        expect(previewThrow(s, 'pc', { kind: 'cover', at: at(2, 3) }, at(7, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', { kind: 'cover', at: at(2, 3) }, at(8, 2))).toEqual({ ok: false, reason: 'out of range' });
        expect(previewThrow(s, 'pc', hand, at(9, 2)).ok).toBe(true);
        expect(previewThrow(s, 'pc', hand, at(10, 2))).toEqual({ ok: false, reason: 'out of range' });
    });

    it('is stopped by a wall and by a barrier', () => {
        const walled = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([], [at(4, 2)]) });
        expect(previewThrow(walled, 'pc', hand, at(6, 2))).toEqual({ ok: false, reason: 'no line of sight' });
        expect(previewThrow(walled, 'pc', hand, at(4, 2))).toEqual({ ok: false, reason: 'the square is not open ground' });
        const barred = arena([pc(), foe('f', at(9, 9))], { barriers: [{ pos: at(4, 2), expiresRound: 5, sourceId: 'pc' }] });
        expect(previewThrow(barred, 'pc', hand, at(6, 2))).toEqual({ ok: false, reason: 'no line of sight' });
    });

    it('refuses with a reason at aim time and never spends the action', () => {
        const s = arena([pc({ conditions: [{ id: 'stunned', turns: 1 }] }), foe('f', at(3, 2))]);
        expect(checkAbility(s, 'pc', BUILTIN_THROW_ID).reason).toBe('the thrower is stunned');
        expect(checkAbility(s, 'pc', BUILTIN_THROW_ID, at(5, 2)).reason).toBe('the thrower is stunned');
        const boxed = arena([pc(), foe('e', at(5, 3))], { grid: gridWith([], [at(1, 1), at(2, 1), at(3, 1), at(1, 2), at(3, 2), at(1, 3), at(2, 3), at(3, 3)], 6, 5) });
        expect(throwReason(boxed, 'pc')).toBe('no square to throw it to');
        expect(checkAbility(boxed, 'pc', BUILTIN_THROW_ID).reason).toBe('no square to throw it to');
        const refused = toss(s, hand, at(5, 2));
        expect(refused.events[0].type).toBe('rejected');
        expect(refused.state.turn?.actionUsed).toBe(false);
        expect(checkAbility(arena([pc(), foe('f', at(3, 2))]), 'pc', BUILTIN_THROW_ID, at(2, 2)).reason).toBe('aim at another square');
    });

    it('refuses to throw a willing ally onto a hazard, and onto no square at all', () => {
        const s = arena([pc(), foe('a', at(3, 2), { side: 'ally' })], { grid: gridWith([[at(5, 2), 'hazard']]) });
        expect(previewThrow(s, 'pc', creature('a'), at(5, 2))).toEqual({ ok: false, reason: 'a willing ally cannot be thrown onto a hazard' });
        expect(previewThrow(s, 'pc', creature('a'), at(5, 3)).ok).toBe(true);
        expect(legalLandings(s, 'pc', creature('a')).some(p => p.x === 5 && p.y === 2)).toBe(false);
        expect(legalAims(s, 'pc', builtinThrow()).length).toBe(1);
    });
});

describe('Throw: the attack on the landing square', () => {
    it('hits for the payload damage and doubles the dice on a critical hit', () => {
        const base = arena([pc(), foe('f', at(6, 2)), foe('a', at(3, 2), { side: 'ally' })], { grid: gridWith([]) });
        const first = toss(seeded(base, hitRoll), creature('a'), at(6, 2));
        const hit = first.events.find(e => e.type === 'thrown') as CombatEvent;
        expect(hit.data).toMatchObject({ hit: true, crit: false, damageType: 'bludgeoning', cover: 0, ac: 10 });
        const damage = hit.data.damage as number;
        expect(damage).toBeGreaterThanOrEqual(2 + 3);
        expect(damage).toBeLessThanOrEqual(12 + 3);
        expect(hit.targetId).toBe('f');
        expect(first.state.combatants.f.hp).toBe(30 - damage);
        const crit = toss(seeded(base, nat(20)), creature('a'), at(6, 2));
        const crude = crit.events.find(e => e.type === 'thrown') as CombatEvent;
        expect(crude.data).toMatchObject({ hit: true, crit: true });
        expect(crit.state.rngCursor).toBe(nat(20) + 1 + 4);
        expect(first.state.rngCursor).toBe(hitRoll + 1 + 2);
    });

    it('misses on a low roll, and a natural 1 always misses', () => {
        const s = arena([pc(), foe('f', at(7, 2)), foe('m', at(3, 2), { tier: 'minion' })]);
        const miss = toss(seeded(s, missRoll), hand, at(7, 2));
        expect(miss.events.find(e => e.type === 'thrown')?.data).toMatchObject({ hit: false, natural: 3, fumble: false });
        expect(miss.state.combatants.f.hp).toBe(30);
        const easy = arena([pc(), foe('f', at(7, 2), { ac: 1 })]);
        const one = toss(seeded(easy, nat(1)), hand, at(7, 2));
        expect(one.events.find(e => e.type === 'thrown')?.data).toMatchObject({ hit: false, fumble: true, natural: 1 });
        expect(one.state.combatants.f.hp).toBe(30);
    });

    it('adds the cover penalty, takes disadvantage beside a hostile and ignores the thrown creature', () => {
        const covered = arena([pc(), foe('f', at(7, 2))], { grid: gridWith([[at(5, 2), 'cover']]) });
        const preview = previewThrow(covered, 'pc', hand, at(7, 2));
        expect(preview.ok && preview.plan.cover).toBe(2);
        const five = nat(5);
        expect(toss(seeded(covered, five), hand, at(7, 2)).events.find(e => e.type === 'thrown')?.data).toMatchObject({ hit: false, cover: 2, ac: 12, total: 10 });
        const open = arena([pc(), foe('f', at(7, 2))]);
        expect(toss(seeded(open, five), hand, at(7, 2)).events.find(e => e.type === 'thrown')?.data).toMatchObject({ hit: true, cover: 0, ac: 10, total: 10 });
        const crowded = arena([pc(), foe('f', at(7, 2)), foe('g', at(3, 2))]);
        expect(toss(seeded(crowded, five), hand, at(7, 2)).events.find(e => e.type === 'thrown')?.data).toMatchObject({ disadvantage: true });
        const lifted = arena([pc(), foe('f', at(6, 2)), foe('m', at(3, 2), { tier: 'minion' })]);
        expect(toss(seeded(lifted, passSave), creature('m'), at(6, 2)).events.find(e => e.type === 'thrown')).toBeUndefined();
        expect(toss(seeded(lifted, failSave), creature('m'), at(6, 2)).events.find(e => e.type === 'thrown')?.data.disadvantage).toBe(false);
    });

    it('strikes a friendly creature on the landing square too', () => {
        const s = arena([pc(), foe('a', at(6, 2), { side: 'ally' })]);
        const r = toss(seeded(s, hitRoll), hand, at(6, 2));
        expect(r.events.find(e => e.type === 'thrown')?.targetId).toBe('a');
    });

    it('uses 1d8 for cover, a weapon its own die plus STR, and 1d4 with no bonus for whatever is at hand', () => {
        const state = arena([pc({ carried: [dagger, glaive] }), foe('f', at(6, 2), { maxHp: 200, hp: 200 })], { grid: gridWith([[at(3, 2), 'cover']]) });
        const preview = (payload: ThrowPayload) => {
            const p = previewThrow(state, 'pc', payload, at(6, 2));
            return p.ok ? p.plan.damage : null;
        };
        expect(preview({ kind: 'cover', at: at(3, 2) })).toEqual({ count: 1, sides: 8, bonus: 3, type: 'bludgeoning' });
        expect(preview({ kind: 'item', itemId: 'glaive' })).toEqual({ count: 1, sides: 10, bonus: 3, type: 'bludgeoning' });
        expect(preview({ kind: 'item', itemId: 'dagger' })).toEqual({ count: 1, sides: 4, bonus: 3, type: 'bludgeoning' });
        expect(preview(hand)).toEqual({ count: 1, sides: 4, bonus: 0, type: 'bludgeoning' });
        expect(preview(creature('x'))).toBeNull();
        const crit = toss(seeded(state, nat(20)), hand, at(6, 2)).events.find(e => e.type === 'thrown');
        expect(crit?.data.damage).toBeGreaterThanOrEqual(2);
        expect(crit?.data.damage).toBeLessThanOrEqual(8);
    });
});

describe('Throw: a thrown creature', () => {
    const lifted = (extra: Partial<Combatant> = {}) => arena([pc(), foe('m', at(3, 2), { tier: 'minion', ...extra }), foe('f', at(9, 9))]);

    it('makes the better of STR or DEX against 8 + proficiency + STR; success spends the action and moves nothing', () => {
        const s = lifted();
        const ok = toss(seeded(s, passSave), creature('m'), at(5, 2));
        expect(kinds(ok.events)).toEqual(['ability', 'save']);
        expect(ok.events[1].data).toMatchObject({ dc: 13, success: true, builtin: 'throw' });
        expect(ok.state.combatants.m.position).toEqual(at(3, 2));
        expect(ok.state.turn?.actionUsed).toBe(true);
        const bad = toss(seeded(s, failSave), creature('m'), at(5, 2));
        expect(kinds(bad.events)).toEqual(['ability', 'save', 'thrown', 'ability_damage']);
        expect(bad.state.combatants.m.position).toEqual(at(5, 2));
        expect(bad.events[2].data).toMatchObject({ to: at(5, 2), moves: [{ id: 'm', from: at(3, 2), to: at(5, 2) }] });
        expect(bad.events[3].data).toMatchObject({ kind: 'landing', damageType: 'bludgeoning' });
        const dmg = bad.events[3].data.damage as number;
        expect(dmg).toBeGreaterThanOrEqual(1);
        expect(dmg).toBeLessThanOrEqual(6);
        expect(bad.state.combatants.m.hp).toBe(30 - dmg);
    });

    it('lifts the body of an elite with no save and no landing damage, and refuses a boss', () => {
        const s = arena([pc(), foe('body', at(3, 2), { tier: 'elite', status: 'down', hp: 0 }), foe('f', at(9, 9)), foe('boss', at(2, 3), { tier: 'boss', status: 'down', hp: 0 })]);
        const r = toss(s, creature('body'), at(5, 2));
        expect(kinds(r.events)).toEqual(['ability', 'thrown']);
        expect(r.state.combatants.body).toMatchObject({ position: at(5, 2), status: 'down', hp: 0 });
        expect(checkAbility(s, 'pc', BUILTIN_THROW_ID, at(5, 2), creature('boss')).reason).toBe('too heavy to lift');
        expect(toss(s, creature('boss'), at(5, 2)).events[0].type).toBe('rejected');
    });

    it('throws a willing ally with no save, no damage and no hazard', () => {
        const s = arena([pc(), foe('a', at(3, 2), { side: 'ally' }), foe('f', at(9, 9))]);
        const r = toss(s, creature('a'), at(6, 2));
        expect(kinds(r.events)).toEqual(['ability', 'thrown']);
        expect(r.state.combatants.a).toMatchObject({ position: at(6, 2), hp: 30 });
        expect(r.events[1].data.payload).toMatchObject({ kind: 'creature', willing: true });
    });

    it('lands on the nearest free square when the landing square is occupied, deterministically', () => {
        const s = arena([pc(), foe('m', at(3, 2), { tier: 'minion' }), foe('f', at(6, 2)), foe('g', at(6, 1))]);
        const preview = previewThrow(s, 'pc', creature('m'), at(6, 2));
        expect(preview.ok && preview.plan).toMatchObject({ struckId: 'f', displaced: true, endsAt: at(5, 2) });
        const run = () => toss(seeded(s, failSave), creature('m'), at(6, 2));
        const first = run();
        expect(first.state.combatants.m.position).toEqual(at(5, 2));
        expect(first.events.find(e => e.type === 'thrown')?.data.displaced).toBe(true);
        expect(JSON.stringify(run())).toBe(JSON.stringify(first));
        const grid = terrainOf(s) as NonNullable<ReturnType<typeof terrainOf>>;
        expect(nearestFree(s, grid, at(6, 2), ['m'], false)).toEqual(at(5, 2));
        const ally = arena([pc(), foe('a', at(3, 2), { side: 'ally' }), foe('f', at(6, 2))], { grid: gridWith([[at(5, 2), 'hazard'], [at(6, 1), 'hazard'], [at(7, 2), 'hazard'], [at(6, 3), 'hazard']]) });
        const away = previewThrow(ally, 'pc', creature('a'), at(6, 2));
        expect(away.ok && away.plan.endsAt).toEqual(at(5, 1));
    });

    it('takes the hazard on landing, like a shove', () => {
        const s = arena([pc(), foe('m', at(3, 2), { tier: 'minion' }), foe('f', at(9, 9))], { grid: gridWith([[at(5, 2), 'hazard']]) });
        const r = toss(seeded(s, failSave), creature('m'), at(5, 2));
        expect(kinds(r.events)).toEqual(['ability', 'save', 'thrown', 'ability_damage', 'hazard']);
        expect(r.events[2].data.hazard).toBe(true);
        const preview = previewThrow(s, 'pc', creature('m'), at(5, 2));
        expect(preview.ok && preview.plan.hazard).toBe(true);
    });
});

describe('Throw: cover objects and the terrain', () => {
    const base = () => arena([pc(), foe('f', at(7, 2))], { grid: gridWith([[at(3, 2), 'cover']]) });

    it('removes the cover, leaves rubble where it lands and changes cover and movement afterwards', () => {
        const s = base();
        expect(coverBetween(terrainOf(s) as NonNullable<ReturnType<typeof terrainOf>>, at(2, 2), at(7, 2))).toBe(2);
        const r = toss(s, { kind: 'cover', at: at(3, 2) }, at(5, 3));
        expect(kinds(r.events)).toEqual(['ability', 'thrown']);
        expect(r.events[1].data.terrain).toEqual([
            { pos: at(3, 2), from: 'cover', to: 'floor' },
            { pos: at(5, 3), from: 'floor', to: 'difficult' },
        ]);
        const after = r.state;
        const ground = terrainOf(after) as NonNullable<ReturnType<typeof terrainOf>>;
        expect(tileAt(ground, at(3, 2))).toBe('floor');
        expect(tileAt(ground, at(5, 3))).toBe('difficult');
        expect(stepCost(tileAt(ground, at(5, 3)))).toBe(2);
        expect(coverBetween(ground, at(2, 2), at(7, 2))).toBe(0);
        expect(tileAt(s.grid as NonNullable<CombatState['grid']>, at(3, 2))).toBe('cover');
        const next = previewThrow({ ...after, turn: { ...(after.turn as NonNullable<CombatState['turn']>), actionUsed: false } }, 'pc', hand, at(7, 2));
        expect(next.ok && next.plan.cover).toBe(0);
        expect(surfaceOf(after)).toBe(surfaceOf(after));
    });

    it('leaves no rubble on a hazard or on difficult ground and lets the square be walked afterwards', () => {
        const s = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([[at(3, 2), 'cover'], [at(5, 2), 'hazard'], [at(5, 3), 'difficult']]) });
        const onHazard = toss(s, { kind: 'cover', at: at(3, 2) }, at(5, 2));
        expect(onHazard.events[1].data.terrain).toEqual([{ pos: at(3, 2), from: 'cover', to: 'floor' }]);
        expect(tileAt(terrainOf(onHazard.state) as NonNullable<ReturnType<typeof terrainOf>>, at(5, 2))).toBe('hazard');
        const onRough = toss(s, { kind: 'cover', at: at(3, 2) }, at(5, 3));
        expect(onRough.events[1].data.terrain).toHaveLength(1);
        const moved = applyAction(onHazard.state, { type: 'move', actorId: 'pc', to: at(3, 2) });
        expect(moved.events[0].type).toBe('moved');
    });

    it('does not let the lifted cover shield its own throw, and a barrier still reads as a wall', () => {
        const s = arena([pc(), foe('f', at(7, 2))], { grid: gridWith([[at(3, 2), 'cover']]), barriers: [{ pos: at(5, 2), expiresRound: 4, sourceId: 'pc' }] });
        expect(previewThrow(s, 'pc', { kind: 'cover', at: at(3, 2) }, at(7, 2))).toEqual({ ok: false, reason: 'no line of sight' });
        const clear = arena([pc(), foe('f', at(7, 2))], { grid: gridWith([[at(3, 2), 'cover']]) });
        const plan = previewThrow(clear, 'pc', { kind: 'cover', at: at(3, 2) }, at(7, 2));
        expect(plan.ok && plan.plan.cover).toBe(0);
    });

    it('stacks edits in order, keeps the base grid untouched and caches by edit list', () => {
        const edits = [{ pos: at(3, 2), tile: 'floor' as Tile }, { pos: at(3, 2), tile: 'difficult' as Tile }];
        const s = base();
        const withEdits = { ...s, terrainEdits: edits };
        expect(tileAt(surfaceOf(withEdits) as NonNullable<ReturnType<typeof surfaceOf>>, at(3, 2))).toBe('difficult');
        expect(surfaceOf(withEdits)).toBe(surfaceOf({ ...withEdits }));
        expect(tileAt(s.grid as NonNullable<CombatState['grid']>, at(3, 2))).toBe('cover');
        const both = { ...withEdits, barriers: [{ pos: at(3, 2), expiresRound: 3, sourceId: 'pc' }] };
        expect(tileAt(terrainOf(both) as NonNullable<ReturnType<typeof terrainOf>>, at(3, 2))).toBe('wall');
        expect(tileAt(surfaceOf(both) as NonNullable<ReturnType<typeof surfaceOf>>, at(3, 2))).toBe('difficult');
    });
});

describe('Throw: carried items', () => {
    const state = () => arena([pc({ carried: [dagger, glaive] }), foe('f', at(9, 9))]);

    it('drops a thrown item where it lands and removes it from the thrower', () => {
        const r = toss(state(), { kind: 'item', itemId: 'dagger' }, at(5, 2));
        expect(kinds(r.events)).toEqual(['ability', 'thrown', 'item_dropped']);
        expect(r.state.fieldItems).toEqual([{ ...dagger, pos: at(5, 2), ownerId: 'pc' }]);
        expect(r.state.combatants.pc.carried).toEqual([glaive]);
        expect(r.events[2].data).toMatchObject({ itemId: 'dagger', at: at(5, 2), index: 0, disarmed: false });
        expect(r.state.combatants.pc.damage).toEqual(state().combatants.pc.damage);
    });

    it('leaves the thrower unarmed after throwing the equipped weapon, until it is picked up', () => {
        const start = state();
        const thrown = toss(start, { kind: 'item', itemId: 'glaive' }, at(4, 2));
        const bare = thrown.state.combatants.pc;
        expect(bare.damage).toMatchObject({ count: 1, sides: 4, type: 'bludgeoning', bonus: start.combatants.pc.damage.bonus });
        expect(bare.weaponName).toBeUndefined();
        expect(bare.range).toBe('close');
        const fresh = { ...thrown.state, turn: { ...(thrown.state.turn as NonNullable<CombatState['turn']>), moveLeft: 6 } };
        const walked = applyAction(fresh, { type: 'move', actorId: 'pc', to: at(4, 2) });
        expect(kinds(walked.events)).toEqual(['moved', 'item_recovered']);
        expect(walked.events[1].data).toMatchObject({ how: 'picked_up', rearmed: true });
        expect(walked.state.fieldItems).toEqual([]);
        expect(walked.state.combatants.pc.carried).toEqual([dagger, glaive]);
        expect(walked.state.combatants.pc.damage).toEqual(start.combatants.pc.damage);
        expect(walked.state.combatants.pc.range).toBe(start.combatants.pc.range);
    });

    it('picks an item up by walking through its square, and an ally picks it up for the party', () => {
        const start = arena([pc({ carried: [dagger] }), foe('a', at(2, 4), { side: 'ally' }), foe('f', at(9, 9))]);
        const dropped = toss(start, { kind: 'item', itemId: 'dagger' }, at(3, 4)).state;
        const through = applyAction({ ...dropped, turn: { ...(dropped.turn as NonNullable<CombatState['turn']>), moveLeft: 6 } }, { type: 'move', actorId: 'pc', to: at(3, 4) });
        expect(through.events.map(e => e.type)).toContain('item_recovered');
        const byAlly = arena([foe('a', at(2, 4), { side: 'ally' }), pc(), foe('f', at(9, 9))], { fieldItems: [{ ...dagger, pos: at(3, 4), ownerId: 'pc' }] });
        const picked = applyAction(byAlly, { type: 'move', actorId: 'a', to: at(3, 4) });
        expect(picked.events.map(e => e.type)).toEqual(['moved', 'item_recovered']);
        expect(picked.state.combatants.a.carried).toEqual([dagger]);
    });

    it('is never picked up by an enemy', () => {
        const items = [{ ...dagger, pos: at(4, 2), ownerId: 'pc' }];
        const s = arena([foe('f', at(2, 2)), pc({ position: at(9, 9) })], { fieldItems: items });
        const moved = applyAction(s, { type: 'move', actorId: 'f', to: at(4, 2) });
        expect(moved.events.map(e => e.type)).toEqual(['moved']);
        expect(moved.state.fieldItems).toEqual(items);
        const draft = { state: s, rng: createRng(1, 0), events: [] as CombatEvent[] };
        pickUpItems(draft, s.combatants.f, [at(4, 2)]);
        expect(draft.events).toEqual([]);
    });

    it('is recovered when the fight ends, and the engine AI never throws', () => {
        const start = arena([pc({ carried: [dagger] }), foe('f', at(6, 2), { hp: 1 })]);
        const r = toss(seeded(start, hitRoll), { kind: 'item', itemId: 'dagger' }, at(6, 2));
        expect(kinds(r.events)).toEqual(['ability', 'thrown', 'down', 'item_dropped', 'item_recovered', 'combat_ended']);
        expect(r.events[4].data).toMatchObject({ how: 'fight_end', itemId: 'dagger' });
        expect(r.state.fieldItems).toEqual([]);
        expect(r.state.outcome).toBe('victory');
        expect(COMBAT_EVENT_TYPES).toEqual(expect.arrayContaining(['thrown', 'item_dropped', 'item_recovered']));
        const engine = arena([foe('f', at(2, 2)), pc({ position: at(5, 2), carried: [dagger] })]);
        for (const action of chooseEngineTurn(engine, 'f').actions) expect((action as { abilityId?: string }).abilityId).not.toBe(BUILTIN_THROW_ID);
    });
});

describe('Throw: replay, saved fights and the preview', () => {
    it('keeps terrain edits and field items through a save and reload, and replays the same', () => {
        const start = arena([pc({ carried: [dagger, glaive] }), foe('f', at(9, 9)), foe('m', at(3, 2), { tier: 'minion' })], { grid: gridWith([[at(2, 3), 'cover']]) });
        let live = toss(start, { kind: 'cover', at: at(2, 3) }, at(5, 3)).state;
        live = { ...live, turn: { ...(live.turn as NonNullable<CombatState['turn']>), actionUsed: false } };
        live = toss(live, { kind: 'item', itemId: 'dagger' }, at(4, 2)).state;
        expect(live.terrainEdits).toHaveLength(2);
        expect(live.fieldItems).toHaveLength(1);
        const reloaded = ensureGrid(JSON.parse(JSON.stringify(live)) as CombatState);
        expect(reloaded.terrainEdits).toEqual(live.terrainEdits);
        expect(reloaded.fieldItems).toEqual(live.fieldItems);
        expect(reloaded.combatants).toEqual(JSON.parse(JSON.stringify(live.combatants)));
        expect(terrainOf(reloaded)?.tiles).toEqual(terrainOf(live)?.tiles);
        const walk = { type: 'move', actorId: 'pc', to: at(4, 2) } as const;
        const a = applyAction({ ...live, turn: { ...(live.turn as NonNullable<CombatState['turn']>), moveLeft: 6 } }, walk);
        const b = applyAction({ ...reloaded, turn: { ...(reloaded.turn as NonNullable<CombatState['turn']>), moveLeft: 6 } }, walk);
        expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
        expect(a.state.fieldItems).toEqual(b.state.fieldItems);
        const damaged = ensureGrid({ ...live, terrainEdits: [{ pos: at(99, 99), tile: 'floor' }, ...(live.terrainEdits ?? [])], fieldItems: [{ ...dagger, pos: at(-1, 0), ownerId: 'pc' }] });
        expect(damaged.terrainEdits).toEqual(live.terrainEdits);
        expect(damaged.fieldItems).toEqual([]);
    });

    it('matches the preview to the resolution for 200 seeded cases', () => {
        const rng = createRng(2026, 0);
        let checked = 0;
        for (let i = 0; checked < 200 && i < 4000; i++) {
            const tiles: Array<[Pos, Tile]> = [];
            const kindsOf: Tile[] = ['cover', 'wall', 'hazard', 'difficult', 'floor'];
            for (let n = 0; n < 14; n++) {
                const p = at(rng.int(0, 11), rng.int(0, 7));
                if ((p.x === 3 && p.y === 3) || (p.x <= 4 && p.x >= 2 && p.y <= 4 && p.y >= 2)) continue;
                tiles.push([p, kindsOf[rng.int(0, 4)]]);
            }
            const crowd = [
                foe('m', at(4, 3), { tier: 'minion' }), foe('a', at(2, 3), { side: 'ally' }), foe('b', at(3, 4), { tier: 'elite', status: 'down', hp: 0 }),
                foe('g1', at(rng.int(5, 10), rng.int(0, 7))), foe('g2', at(rng.int(5, 10), rng.int(0, 7)), { side: 'ally' }),
            ].filter((c, k, all) => all.findIndex(o => o.position?.x === c.position?.x && o.position?.y === c.position?.y) === k);
            const grid = gridWith(tiles, [], 12, 8);
            const base = arena([pc({ position: at(3, 3), carried: [dagger, glaive] }), ...crowd], { grid });
            const start = { ...base, rngSeed: 1000 + i, rngCursor: 0 };
            const choices = payloadChoices(start, 'pc');
            const choice = choices[rng.int(0, choices.length - 1)];
            const lands = legalLandings(start, 'pc', choice.payload);
            if (lands.length === 0) continue;
            const landing = lands[rng.int(0, lands.length - 1)];
            const preview = previewThrow(start, 'pc', choice.payload, landing);
            if (!preview.ok) throw new Error('a legal landing must preview');
            const plan = preview.plan;
            const r = toss(start, choice.payload, landing);
            expect(r.events[0].type).toBe('ability');
            const thrown = r.events.find(e => e.type === 'thrown');
            const saved = r.events.some(e => e.type === 'save' && e.data.success === true);
            if (saved) {
                expect(plan.save).toBeDefined();
                expect(thrown).toBeUndefined();
            } else {
                expect(thrown).toBeDefined();
                const data = (thrown as CombatEvent).data;
                expect((thrown as CombatEvent).targetId).toBe(plan.struckId);
                expect(data.to).toEqual(plan.landing);
                expect(data.terrain).toEqual(plan.terrain.map(c => ({ pos: c.pos, from: c.from, to: c.to })));
                expect(data.displaced).toBe(plan.displaced);
                expect(data.hazard).toBe(plan.hazard);
                if (plan.creatureId) expect(r.state.combatants[plan.creatureId].position).toEqual(plan.endsAt);
                if (typeof data.damage === 'number') {
                    const dice = data.crit === true ? plan.damage.count * 2 : plan.damage.count;
                    expect(data.damage).toBeGreaterThanOrEqual(Math.max(1, dice + plan.damage.bonus));
                    expect(data.damage).toBeLessThanOrEqual(Math.max(1, dice * plan.damage.sides + plan.damage.bonus));
                }
                expect(r.events.some(e => e.type === 'ability_damage' && e.data.kind === 'landing')).toBe(plan.hurtOnLanding && r.state.combatants[plan.creatureId as string]?.status !== 'gone');
                expect((r.state.terrainEdits ?? []).length).toBe(plan.terrain.length);
                expect((r.state.fieldItems ?? []).length).toBe(plan.item ? 1 : 0);
            }
            expect(r.state.turn?.actionUsed).toBe(true);
            checked++;
        }
        expect(checked).toBe(200);
    });
});

describe('Throw: the chain and its glyphs', () => {
    it('keeps Hurl out of the palette, the shape check and player chains', () => {
        expect(EFFECT_IDS).not.toContain('hurl');
        expect(validateAbility(glyph('touch', ['hurl']))).toContain('the hurl glyph is reserved for built-in actions');
        expect(isGlyphAbilityShape(glyph('touch', ['hurl']))).toBe(false);
        expect(validateAbility(builtinThrow()).length).toBeGreaterThan(0);
    });

    it('states the rules, with numbers when the thrower is known', () => {
        const p = pc();
        const text = describeAbility(builtinThrow(), { proficiency: 2, castingMod: 0 }, p);
        expect(text).toContain('Hurl it as a projectile');
        expect(text).toContain('within 7 squares for something light, 5 for a cover object and 4 for a creature');
        expect(text).toContain('nearest free one');
        expect(describeAbility(builtinThrow())).toContain('4 + STR modifier (at least 2)');
    });
});
