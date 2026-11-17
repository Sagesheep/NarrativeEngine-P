import { describe, it, expect } from 'vitest';
import {
    abilityCost, abilityTargets, applyAction, AUGMENT_IDS, AUGMENT_TIERS, canTarget, chainCost, chainOf, COMBAT_EVENT_TYPES, createCombat, describeAbility,
    EFFECT_IDS, EFFECTS, FORM_IDS, FORMS, GLYPH_AI, GLYPH_EVENT_TYPES, glyphTier, isGlyphAbilityShape, pathTo, placementReason, planTurn, runEngineTurns,
    stepEngine, terrainOf, undoGlyphEvent, undoPlacedEvent, validateAbility, validateSignature,
} from '../index';
import type { CombatEvent, CombatState, Combatant, GlyphAbility, PlacedEffect, Pos } from '../index';
import { buildPcCombatant } from '../pc';
import { arena, caster, casterSheet, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const cast = (s: CombatState, abilityId: string, aim: Pos | null = null, actorId = 'pc') =>
    applyAction(s, { type: 'use_ability', actorId, abilityId, aim });
const end = (s: CombatState, actorId: string) => applyAction(s, { type: 'end_turn', actorId });
const of = (events: CombatEvent[], type: string) => events.filter(e => e.type === type);
const clean = (seed = 7, n = 8) => cursorFor(seed, r => r.every(x => x !== 1 && x !== 20), n);
const low = (seed = 7, n = 4) => cursorFor(seed, r => r.every(x => x >= 2 && x <= 5), n);
const has = (c: Combatant, id: string) => c.conditions.some(x => x.id === id);
const stand = (id: string, pos: Pos, extra: Partial<Combatant> = {}) => foe(id, pos, { ac: 0, hp: 60, maxHp: 60, ...extra });

describe('the registry (G1, G2)', () => {
    it('records the tier of every glyph as the order lists them', () => {
        const tiers = (n: number) => [
            ...FORM_IDS.filter(id => FORMS[id].tier === n),
            ...EFFECT_IDS.filter(id => EFFECTS[id].tier === n),
            ...AUGMENT_IDS.filter(id => AUGMENT_TIERS[id] === n),
        ].sort();
        expect(tiers(1)).toEqual(['amplify', 'damage', 'extend', 'heal', 'projectile', 'push', 'self', 'shield', 'slow', 'touch'].sort());
        expect(tiers(2)).toEqual([
            'line', 'cone', 'dash', 'pull', 'stun', 'haste', 'blink', 'barrier', 'drain', 'widen', 'pierce', 'quicken',
            'snare', 'dispel', 'leap', 'dampen', 'sustain',
        ].sort());
        expect(tiers(3)).toEqual([
            'burst', 'swap', 'summon', 'split', 'sigil', 'mantle', 'chain', 'wall', 'gravity', 'fear', 'decay', 'vanish', 'rewind', 'delay',
        ].sort());
        expect(glyphTier({ kind: 'augment', id: 'delay' })).toBe(3);
        expect(glyphTier({ kind: 'form', id: 'touch' })).toBe(1);
    });

    it('uses the project names and keeps the renamed draft names out', () => {
        for (const id of ['sigil', 'mantle', 'chain', 'wall']) expect(FORM_IDS).toContain(id);
        for (const id of ['snare', 'dispel', 'leap', 'gravity', 'fear', 'decay', 'vanish', 'rewind']) expect(EFFECT_IDS).toContain(id);
        for (const id of ['dampen', 'sustain', 'delay']) expect(AUGMENT_IDS).toContain(id);
        const all: string[] = [...FORM_IDS, ...EFFECT_IDS, ...AUGMENT_IDS];
        for (const old of ['rune', 'orbit', 'linger', 'wither', 'ignite']) expect(all).not.toContain(old);
        for (const type of GLYPH_EVENT_TYPES) expect(COMBAT_EVENT_TYPES).toContain(type);
    });

    it('prices dampen as cheaper, never below one', () => {
        const plain = glyph('projectile', ['damage']);
        const damped = glyph('projectile', [['damage', ['dampen']]]);
        expect(abilityCost(damped)).toBe(abilityCost(plain) - 1);
        expect(abilityCost(glyph('touch', [['damage', ['dampen']]]))).toBe(1);
        expect(chainCost(chainOf(glyph('touch', [['damage', ['dampen']]])))).toBe(1);
        expect(describeAbility(damped)).toContain('takes 1d6');
        expect(describeAbility(plain)).toContain('takes 2d6');
    });

    it('keeps saved abilities loadable', () => {
        expect(isGlyphAbilityShape(glyph('sigil', ['damage'], ['sustain']))).toBe(true);
        expect(isGlyphAbilityShape(glyph('self', ['rewind']))).toBe(true);
        expect(isGlyphAbilityShape({ ...glyph('touch', ['damage']), form: { id: 'rune', augments: [] } })).toBe(false);
    });
});

describe('legal and refused combinations', () => {
    it('accepts a representative chain for every new glyph', () => {
        const legal = [
            glyph('sigil', ['damage', 'snare'], ['extend', 'sustain']),
            glyph('mantle', ['heal', 'shield'], ['widen', 'sustain']),
            glyph('mantle', ['damage', 'gravity']),
            glyph('chain', ['damage', 'stun'], ['widen', 'delay']),
            glyph('wall', ['damage', 'slow'], ['widen', 'sustain']),
            glyph('touch', ['snare', 'dispel']),
            glyph('self', ['leap', 'shield']),
            glyph('burst', ['gravity', ['damage', ['dampen']]]),
            glyph('projectile', [['fear', ['sustain']]]),
            glyph('line', [['decay', ['amplify']]]),
            glyph('self', ['vanish']),
            glyph('self', ['rewind', 'heal']),
            glyph('burst', ['damage'], ['delay']),
        ];
        for (const a of legal) expect(validateAbility(a)).toEqual([]);
    });

    it('refuses the combinations it cannot resolve, with a reason', () => {
        expect(validateAbility(glyph('touch', ['summon'], ['delay']))).toContain('delay cannot hold summon');
        expect(validateAbility(glyph('line', ['barrier'], ['delay']))).toContain('delay cannot hold barrier');
        expect(validateAbility(glyph('touch', ['swap'], ['delay']))).toContain('delay cannot hold swap');
        expect(validateAbility(glyph('touch', [['damage', ['amplify', 'dampen']]]))).toContain('the damage effect cannot be both amplified and dampened');
        expect(validateAbility(glyph('self', ['blink', 'leap']))).toContain('an ability may hold only one of blink and leap');
        expect(validateAbility(glyph('mantle', ['damage', 'heal']))).toContain('a mantle carries either hostile or helpful effects, not both');
        expect(validateAbility(glyph('line', ['gravity']))).toContain('the line form cannot carry gravity');
        expect(validateAbility(glyph('touch', ['vanish']))).toContain('the touch form cannot carry vanish');
        expect(validateAbility(glyph('mantle', ['stun']))).toContain('the mantle form cannot carry stun');
        expect(validateAbility(glyph('sigil', ['heal']))).toContain('the sigil form cannot carry heal');
        expect(validateAbility(glyph('self', ['heal'], ['delay']))).toContain('the self form does not accept delay');
        expect(validateAbility(glyph('touch', [['snare', ['extend']]]))).toContain('the snare effect does not accept extend');
    });

    it('reports the same refusals in the builder', () => {
        const limits = { maxChainLength: 8 };
        const delayed = chainOf(glyph('touch', ['damage'], ['delay']));
        expect(placementReason(delayed, { kind: 'effect', index: 0 }, { kind: 'effect', id: 'summon' }, limits)).toEqual({ code: 'not-accepted', by: { kind: 'augment', id: 'delay' } });
        const amped = chainOf(glyph('touch', [['damage', ['amplify']]]));
        expect(placementReason(amped, { kind: 'augment', owner: 0, index: 1 }, { kind: 'augment', id: 'dampen' }, limits)).toEqual({ code: 'not-accepted', by: { kind: 'augment', id: 'amplify' } });
        const healer = chainOf(glyph('mantle', ['heal']));
        expect(placementReason(healer, { kind: 'effect', index: 1 }, { kind: 'effect', id: 'damage' }, limits)).toEqual({ code: 'not-accepted', by: { kind: 'effect', id: 'heal' } });
        const blink = chainOf(glyph('self', ['blink']));
        expect(placementReason(blink, { kind: 'effect', index: 1 }, { kind: 'effect', id: 'leap' }, limits)).toEqual({ code: 'not-accepted', by: { kind: 'effect', id: 'blink' } });
        expect(placementReason(chainOf(glyph('touch', ['damage'])), { kind: 'effect', index: 1 }, { kind: 'effect', id: 'gravity' }, limits)).toMatchObject({ code: 'form-cannot-carry' });
    });
});

describe('chain', () => {
    const bolt = glyph('chain', ['damage'], [], { id: 'arc' });

    it('jumps to the nearest foe within two squares of the last target at half strength', () => {
        const s = arena([
            caster([bolt], { x: 5, y: 5 }), stand('f', { x: 8, y: 5 }), stand('g', { x: 9, y: 6 }), stand('h', { x: 11, y: 6 }), stand('z', { x: 14, y: 9 }),
        ], { rngCursor: clean() });
        const aim = abilityTargets(s, 'pc', bolt, { x: 8, y: 5 });
        expect(aim.targetIds).toEqual(['f', 'g', 'h']);
        expect(aim.scales).toEqual({ f: 1, g: 0.5, h: 0.25 });
        const r = cast(s, 'arc', { x: 8, y: 5 });
        const hits = of(r.events, 'ability_damage');
        expect(hits.map(e => e.targetId)).toEqual(['f', 'g', 'h']);
        expect(hits[1].data.damage as number).toBeLessThanOrEqual(6);
        expect(hits[2].data.damage as number).toBeLessThanOrEqual(3);
    });

    it('never jumps from a foe to a friend, and widen adds a jump', () => {
        const s = arena([caster([glyph('chain', ['damage'], ['widen'], { id: 'arc2' })], { x: 5, y: 5 }), stand('f', { x: 8, y: 5 }),
            { ...caster([], { x: 9, y: 5 }), id: 'a', side: 'ally', controller: 'engine' }, stand('g', { x: 10, y: 5 })]);
        const aim = abilityTargets(s, 'pc', glyph('chain', ['damage'], ['widen']), { x: 8, y: 5 });
        expect(aim.targetIds).toEqual(['f', 'g']);
    });
});

describe('placed effects: sigil', () => {
    const trap = glyph('sigil', ['damage'], [], { id: 'trap' });
    const corridor = openGrid(16, 12, [{ x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 }, { x: 7, y: 6 }, { x: 8, y: 6 }, { x: 9, y: 6 }]);

    it('is laid on an empty square and goes off under the first foe to enter, stopping it there', () => {
        const s = arena([caster([trap], { x: 5, y: 5 }), stand('f', { x: 11, y: 5 })], { grid: corridor, rngCursor: low() });
        const laid = cast(s, 'trap', { x: 8, y: 5 });
        const placed = of(laid.events, 'placed')[0].data.placed as PlacedEffect;
        expect(placed).toMatchObject({ kind: 'sigil', trigger: 'enter', ownerId: 'pc', tiles: [{ x: 8, y: 5 }], expiresRound: 6 });
        expect(laid.state.placed).toHaveLength(1);
        expect(of(laid.events, 'ability_damage')).toHaveLength(0);
        const turn = end(laid.state, 'pc');
        const moved = applyAction(turn.state, { type: 'move', actorId: 'f', to: { x: 6, y: 5 } });
        expect(moved.state.combatants.f.position).toEqual({ x: 8, y: 5 });
        expect(of(moved.events, 'moved')[0].data).toMatchObject({ stoppedBy: 'sigil' });
        expect(of(moved.events, 'placed_ended')[0].data).toMatchObject({ why: 'spent' });
        expect(of(moved.events, 'placed_triggered')[0]).toMatchObject({ targetId: 'f', data: { kind: 'sigil' } });
        expect(of(moved.events, 'save')).toHaveLength(1);
        expect(of(moved.events, 'ability_damage')).toHaveLength(1);
        expect(moved.state.placed).toEqual([]);
        expect(moved.state.turn?.moveLeft).toBe(6 - 3);
    });

    it('lets friends pass, refuses a second sigil on the same square and keeps at most three per caster', () => {
        const s = arena([caster([trap], { x: 5, y: 5 }), { ...stand('a', { x: 11, y: 5 }), side: 'ally' }, stand('f', { x: 14, y: 10 })], { grid: corridor });
        const laid = cast(s, 'trap', { x: 8, y: 5 });
        expect(abilityTargets(laid.state, 'pc', trap, { x: 8, y: 5 }).reason).toBe('a sigil is already there');
        const turn = end(laid.state, 'pc');
        const walked = applyAction(turn.state, { type: 'move', actorId: 'a', to: { x: 6, y: 5 } });
        expect(walked.state.combatants.a.position).toEqual({ x: 6, y: 5 });
        expect(walked.state.placed).toHaveLength(1);
        let state: CombatState = { ...s, combatants: { ...s.combatants, pc: { ...s.combatants.pc, mp: 99 } } };
        for (const x of [2, 3, 4, 6]) {
            state = cast({ ...state, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false } }, 'trap', { x, y: 8 }).state;
        }
        expect((state.placed ?? []).map(p => p.tiles[0].x)).toEqual([3, 4, 6]);
    });

    it('is avoided by an engine unit that can see it, and fades when its rounds run out', () => {
        const s = arena([caster([trap], { x: 5, y: 5 }), stand('f', { x: 10, y: 5 })]);
        const laid = cast(s, 'trap', { x: 8, y: 5 });
        const route = pathTo({ ...laid.state, turnIndex: 1, turn: { actorId: 'f', moveLeft: 6, actionUsed: false } }, 'f', { x: 6, y: 5 });
        expect(route?.path.some(p => p.x === 8 && p.y === 5)).toBe(false);
        let state = laid.state;
        const events: CombatEvent[] = [];
        for (let i = 0; i < 20 && state.round <= 6; i++) {
            const actor = state.order[state.turnIndex];
            const r = end(state, actor);
            events.push(...r.events);
            state = r.state;
        }
        expect(of(events, 'placed_ended')[0].data).toMatchObject({ why: 'expired' });
        expect(state.placed).toEqual([]);
    });
});

describe('placed effects: mantle and wall', () => {
    it('a mantle touches each foe that starts a turn inside it and nobody outside', () => {
        const aura = glyph('mantle', ['damage'], [], { id: 'aura' });
        const s = arena([caster([aura], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 }), stand('g', { x: 9, y: 5 })]);
        const r = cast(s, 'aura', null);
        expect(of(r.events, 'placed')[0].data.placed).toMatchObject({ kind: 'mantle', radius: 1, tiles: [], expiresRound: 3 });
        const f = end(r.state, 'pc');
        expect(of(f.events, 'placed_triggered')[0]).toMatchObject({ targetId: 'f', data: { kind: 'mantle' } });
        expect(of(f.events, 'ability_damage')).toHaveLength(1);
        const g = end(f.state, 'f');
        expect(of(g.events, 'placed_triggered')).toHaveLength(0);
        const again = cast({ ...r.state, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false } }, 'aura', null);
        expect(of(again.events, 'placed_ended')[0].data).toMatchObject({ why: 'replaced' });
        expect(again.state.placed).toHaveLength(1);
    });

    it('a helpful mantle touches friends, the caster included', () => {
        const aura = glyph('mantle', ['heal'], [], { id: 'mend' });
        const s = arena([caster([aura], { x: 5, y: 5 }, { hp: 5 }), stand('f', { x: 6, y: 5 })]);
        const r = cast(s, 'mend', null);
        const back = end(end(r.state, 'pc').state, 'f');
        expect(of(back.events, 'placed_triggered')[0].targetId).toBe('pc');
        expect(back.state.combatants.pc.hp).toBeGreaterThan(5);
    });

    it('ends with its maker', () => {
        const mantle: PlacedEffect = {
            id: 'placed1', kind: 'mantle', ownerId: 'g', side: 'enemy', name: 'Aura', trigger: 'turn_start', tiles: [], radius: 1,
            payload: glyph('mantle', ['damage']), placedRound: 1, expiresRound: 4,
        };
        const s = arena([caster([], { x: 5, y: 5 }), stand('f', { x: 9, y: 9 }), stand('g', { x: 6, y: 5 }, { status: 'down', hp: 0 })], { placed: [mantle] });
        const r = end(s, 'pc');
        expect(of(r.events, 'placed_ended')[0].data).toMatchObject({ why: 'owner_gone' });
        expect(r.state.placed).toEqual([]);
    });

    it('a wall raises barrier squares across the aim and lashes foes that start a turn beside it', () => {
        const fence = glyph('wall', ['damage'], [], { id: 'fence' });
        const s = arena([caster([fence], { x: 5, y: 5 }), stand('f', { x: 9, y: 5 })]);
        const r = cast(s, 'fence', { x: 8, y: 5 });
        expect(of(r.events, 'barrier')[0].data.tiles).toEqual([{ x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 }]);
        expect(terrainOf(r.state)?.tiles[5 * 16 + 8]).toBe('wall');
        expect(of(r.events, 'placed')[0].data.placed).toMatchObject({ kind: 'wall', expiresRound: 3 });
        const t = end(r.state, 'pc');
        expect(of(t.events, 'placed_triggered')[0]).toMatchObject({ targetId: 'f', data: { kind: 'wall' } });
        let state = t.state;
        const events: CombatEvent[] = [];
        for (let i = 0; i < 8 && state.round <= 2; i++) {
            const step = end(state, state.order[state.turnIndex]);
            events.push(...step.events);
            state = step.state;
        }
        expect(of(events, 'barrier_ended')).toHaveLength(1);
        expect(of(events, 'placed_ended')[0].data).toMatchObject({ why: 'expired' });
    });
});

describe('delay', () => {
    const later = glyph('projectile', ['damage'], ['delay'], { id: 'later' });

    it('goes off at the start of the caster\'s next turn on whoever is in the square, one die stronger', () => {
        const s = arena([caster([later], { x: 5, y: 5 }), stand('f', { x: 8, y: 5 })], { rngCursor: clean() });
        const r = cast(s, 'later', { x: 8, y: 5 });
        expect(of(r.events, 'ability_damage')).toHaveLength(0);
        const placed = of(r.events, 'placed')[0].data.placed as PlacedEffect;
        expect(placed).toMatchObject({ kind: 'delay', trigger: 'owner_turn_start', tiles: [{ x: 8, y: 5 }] });
        expect(placed.payload?.form.augments).toEqual([]);
        expect(placed.payload?.effects[0]).toEqual({ id: 'damage', augments: ['amplify'] });
        const back = end(end(r.state, 'pc').state, 'f');
        expect(of(back.events, 'placed_triggered')[0]).toMatchObject({ targetId: 'f', data: { kind: 'delay' } });
        expect(of(back.events, 'ability_attack')).toHaveLength(1);
        expect(back.state.placed).toEqual([]);
    });

    it('misses when the target has moved away', () => {
        const s = arena([caster([later], { x: 5, y: 5 }), stand('f', { x: 8, y: 5 })], { rngCursor: clean() });
        const r = cast(s, 'later', { x: 8, y: 5 });
        const moved = applyAction(end(r.state, 'pc').state, { type: 'move', actorId: 'f', to: { x: 10, y: 8 } });
        const back = end(moved.state, 'f');
        expect(of(back.events, 'placed_triggered')[0].data).toMatchObject({ missed: true });
        expect(of(back.events, 'ability_attack')).toHaveLength(0);
    });
});

describe('the new effects', () => {
    it('snare: the target cannot move on its next turn but can still act', () => {
        const s = arena([caster([glyph('touch', ['snare'], [], { id: 'hold' })], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 })], { rngCursor: clean() });
        const r = cast(s, 'hold', { x: 6, y: 5 });
        expect(of(r.events, 'condition_added')[0].data).toMatchObject({ condition: 'snared', turns: 1, glyph: true, before: null });
        const t = end(r.state, 'pc');
        expect(t.state.turn?.moveLeft).toBe(0);
        expect(applyAction(t.state, { type: 'move', actorId: 'f', to: { x: 7, y: 5 } }).events[0].type).toBe('rejected');
        expect(applyAction(t.state, { type: 'attack', actorId: 'f', targetId: 'pc' }).events[0].type).not.toBe('rejected');
        const free = end(t.state, 'f');
        expect(has(free.state.combatants.f, 'snared')).toBe(false);
    });

    it('dispel: strips harmful conditions from a friend and helpful ones from a foe', () => {
        const wipe = glyph('touch', ['dispel'], [], { id: 'wipe' });
        const ally = { ...caster([], { x: 5, y: 6 }), id: 'a', side: 'ally' as const, controller: 'engine' as const, conditions: [{ id: 'slowed', turns: 2 }, { id: 'hasted', turns: 1 }] };
        const s = arena([caster([wipe], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 }, { tempHp: 5, conditions: [{ id: 'hasted', turns: 2 }, { id: 'shielded', turns: 2 }, { id: 'slowed', turns: 1 }] }), ally], { rngCursor: clean() });
        const friend = cast(s, 'wipe', { x: 5, y: 6 });
        expect(friend.state.combatants.a.conditions.map(c => c.id)).toEqual(['hasted']);
        expect(of(friend.events, 'dispelled')[0].data).toMatchObject({ removed: ['slowed'], friend: true });
        const enemy = cast(s, 'wipe', { x: 6, y: 5 });
        expect(enemy.state.combatants.f.conditions.map(c => c.id)).toEqual(['slowed']);
        expect(enemy.state.combatants.f.tempHp).toBeUndefined();
    });

    it('leap: the caster jumps over a wall without spending movement; a snared caster cannot', () => {
        const walls = Array.from({ length: 12 }, (_, y) => ({ x: 6, y }));
        const hop = glyph('self', ['leap'], [], { id: 'hop' });
        const s = arena([caster([hop], { x: 5, y: 5 }), stand('f', { x: 12, y: 9 })], { grid: openGrid(16, 12, walls) });
        const r = cast(s, 'hop', { x: 7, y: 5 });
        expect(r.state.combatants.pc.position).toEqual({ x: 7, y: 5 });
        expect(of(r.events, 'teleported')[0].data).toMatchObject({ kind: 'leap', over: ['wall'] });
        expect(r.state.turn?.moveLeft).toBe(6);
        expect(abilityTargets(s, 'pc', hop, { x: 10, y: 5 }).reason).toBe('out of range');
        const snared = { ...s, combatants: { ...s.combatants, pc: { ...s.combatants.pc, conditions: [{ id: 'snared', turns: 1 }] } } };
        expect(abilityTargets(snared, 'pc', hop, { x: 7, y: 5 }).reason).toBe('snared');
    });

    it('gravity: drags every unit in the area toward the centre, nearest first', () => {
        const pull = glyph('burst', ['gravity'], ['widen'], { id: 'well' });
        const s = arena([caster([pull], { x: 3, y: 5 }), stand('g', { x: 10, y: 5 }), stand('h', { x: 8, y: 7 })], { rngCursor: low() });
        const r = cast(s, 'well', { x: 8, y: 5 });
        expect(of(r.events, 'gravity')[0].data).toMatchObject({ centre: { x: 8, y: 5 } });
        expect(r.state.combatants.g.position).toEqual({ x: 8, y: 5 });
        expect(r.state.combatants.h.position).toEqual({ x: 8, y: 6 });
        expect(of(r.events, 'pushed').every(e => e.data.gravity === true)).toBe(true);
    });

    it('fear: the target may not approach the caster on its next turn, and the planner moves it away', () => {
        const scare = glyph('projectile', ['fear'], [], { id: 'scare' });
        const s = arena([caster([scare], { x: 5, y: 5 }), stand('f', { x: 8, y: 5 }, { range: 'ranged' })], { rngCursor: clean() });
        const r = cast(s, 'scare', { x: 8, y: 5 });
        expect(of(r.events, 'condition_added')[0].data).toMatchObject({ condition: 'feared', glyph: true });
        const t = end(r.state, 'pc');
        expect(applyAction(t.state, { type: 'move', actorId: 'f', to: { x: 6, y: 5 } }).events[0].data.reason).toBe('too frightened to approach');
        expect(applyAction(t.state, { type: 'attack', actorId: 'f', targetId: 'pc' }).events[0].type).not.toBe('rejected');
        expect(applyAction(t.state, { type: 'move', actorId: 'f', to: { x: 10, y: 5 } }).events[0].type).toBe('moved');
        const plan = planTurn(t.state, 'f');
        const move = plan.steps.find(a => a.type === 'move');
        expect(move && move.type === 'move' ? Math.max(Math.abs(move.to.x - 5), Math.abs(move.to.y - 5)) : 0).toBeGreaterThan(3);
    });

    it('decay: lowers maximum HP and HP together, never below half the original', () => {
        const rot = glyph('touch', ['decay'], [], { id: 'rot' });
        const s = arena([caster([rot], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 }, { hp: 30, maxHp: 30 })], { rngCursor: clean() });
        const r = cast(s, 'rot', { x: 6, y: 5 });
        const d = of(r.events, 'decayed')[0].data;
        const amount = d.amount as number;
        expect(amount).toBeGreaterThanOrEqual(1);
        expect(amount).toBeLessThanOrEqual(4);
        expect(r.state.combatants.f).toMatchObject({ maxHp: 30 - amount, hp: 30 - amount, decayed: amount });
        const near = arena([caster([rot], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 }, { hp: 16, maxHp: 16, decayed: 14 })], { rngCursor: clean() });
        expect(cast(near, 'rot', { x: 6, y: 5 }).state.combatants.f.maxHp).toBe(15);
    });

    it('vanish: no one can target the caster until its next turn, areas still reach it', () => {
        const hide = glyph('self', ['vanish'], [], { id: 'hide' });
        const s = arena([caster([hide], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 })]);
        const r = cast(s, 'hide', null);
        expect(of(r.events, 'condition_added')[0].data).toMatchObject({ condition: 'vanished', glyph: true });
        const t = end(r.state, 'pc');
        expect(canTarget(t.state.combatants.f, t.state.combatants.pc)).toBe(false);
        expect(applyAction(t.state, { type: 'attack', actorId: 'f', targetId: 'pc' }).events[0].type).toBe('rejected');
        expect(planTurn(t.state, 'f').steps.some(a => a.type === 'attack')).toBe(false);
        const back = end(t.state, 'f');
        expect(of(back.events, 'condition_ended')[0].data).toMatchObject({ condition: 'vanished', consumed: true });
        const hidden = arena([caster([glyph('touch', ['damage'], [], { id: 'jab' }), glyph('burst', ['damage'], [], { id: 'boom' })], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 }, { conditions: [{ id: 'vanished', turns: 1 }] })]);
        expect(abilityTargets(hidden, 'pc', hidden.combatants.pc.kit?.[0] as GlyphAbility, { x: 6, y: 5 }).reason).toBe('cannot be targeted');
        expect(abilityTargets(hidden, 'pc', hidden.combatants.pc.kit?.[1] as GlyphAbility, { x: 7, y: 5 }).targetIds).toContain('f');
    });

    it('rewind: back to the square, HP and conditions at the start of the last turn, and nothing else', () => {
        const back = glyph('self', ['rewind'], [], { id: 'back' });
        const s = arena([caster([back], { x: 5, y: 5 }), stand('f', { x: 12, y: 9 }, { hp: 20 })]);
        const t2 = end(end(s, 'pc').state, 'f').state;
        expect(t2.combatants.pc.rewindNext).toMatchObject({ pos: { x: 5, y: 5 }, hp: t2.combatants.pc.hp });
        expect(abilityTargets(t2, 'pc', back, null).reason).toBe('nothing to rewind to');
        const walked = applyAction(t2, { type: 'move', actorId: 'pc', to: { x: 7, y: 7 } }).state;
        const enemyTurn = end(walked, 'pc').state;
        const hurt: CombatState = {
            ...enemyTurn,
            combatants: {
                ...enemyTurn.combatants,
                pc: { ...enemyTurn.combatants.pc, hp: 3, conditions: [{ id: 'slowed', turns: 2 }] },
                f: { ...enemyTurn.combatants.f, hp: 4 },
            },
        };
        const t3 = end(hurt, 'f').state;
        const startHp = s.combatants.pc.hp;
        const r = cast(t3, 'back', null);
        const pc = r.state.combatants.pc;
        expect(pc.position).toEqual({ x: 5, y: 5 });
        expect(pc.hp).toBe(startHp);
        expect(pc.conditions).toEqual([]);
        expect(r.state.combatants.f.hp).toBe(4);
        const event = of(r.events, 'rewound')[0];
        expect(event.data).toMatchObject({ hpBefore: 3, before: { pos: { x: 7, y: 7 }, hp: 3 } });
        const undone = { ...r.state.combatants, pc: { ...pc } };
        expect(undoGlyphEvent(undone, event)).toBe(true);
        expect(undone.pc).toMatchObject({ position: { x: 7, y: 7 }, hp: 3, conditions: [{ id: 'slowed', turns: 2 }] });
        expect(applyAction({ ...t3, combatants: { ...t3.combatants, pc: { ...t3.combatants.pc, status: 'down' } } }, { type: 'use_ability', actorId: 'pc', abilityId: 'back', aim: null }).events[0].type).toBe('rejected');
    });

    it('sustain lengthens and dampen weakens', () => {
        const long = glyph('touch', [['snare', ['sustain']]], [], { id: 'long' });
        const s = arena([caster([long], { x: 5, y: 5 }), stand('f', { x: 6, y: 5 })], { rngCursor: clean() });
        expect(of(cast(s, 'long', { x: 6, y: 5 }).events, 'condition_added')[0].data.turns).toBe(2);
        expect(describeAbility(glyph('sigil', ['damage'], ['sustain']))).toContain('for 7 rounds');
        expect(describeAbility(glyph('mantle', ['damage'], ['sustain']))).toContain('for 3 rounds');
        expect(describeAbility(glyph('projectile', [['push', ['dampen']]]))).toContain('pushed 1 square');
    });
});

describe('undo of every new event', () => {
    it('restores conditions, dispels, decay and placed lists', () => {
        const unit = stand('f', { x: 6, y: 5 }, { maxHp: 22, hp: 18, decayed: 8, conditions: [{ id: 'snared', turns: 1 }] });
        const combatants: Record<string, Combatant> = { f: { ...unit } };
        const ev = (type: string, data: Record<string, unknown>): CombatEvent => ({ seq: 1, round: 1, type, targetId: 'f', data, text: '' });
        expect(undoGlyphEvent(combatants, ev('condition_added', { condition: 'snared', glyph: true, before: null }))).toBe(true);
        expect(combatants.f.conditions).toEqual([]);
        expect(undoGlyphEvent(combatants, ev('decayed', { maxBefore: 30, hpBefore: 26, tempBefore: 0, decayedBefore: 0 }))).toBe(true);
        expect(combatants.f).toMatchObject({ maxHp: 30, hp: 26 });
        expect(combatants.f.decayed).toBeUndefined();
        expect(undoGlyphEvent(combatants, ev('dispelled', { before: [{ id: 'hasted', turns: 1 }], tempBefore: 4 }))).toBe(true);
        expect(combatants.f).toMatchObject({ conditions: [{ id: 'hasted', turns: 1 }], tempHp: 4 });
        expect(undoGlyphEvent(combatants, ev('condition_added', { condition: 'slowed' }))).toBe(false);
        const p: PlacedEffect = { id: 'placed1', kind: 'sigil', ownerId: 'pc', side: 'player', name: 'Trap', trigger: 'enter', tiles: [{ x: 1, y: 1 }], placedRound: 1, expiresRound: 6 };
        expect(undoPlacedEvent([p], ev('placed', { placed: p }))).toEqual([]);
        expect(undoPlacedEvent([], ev('placed_ended', { placed: p, why: 'spent' }))).toEqual([p]);
        expect(undoPlacedEvent([p], ev('placed_triggered', {}))).toEqual([p]);
        expect(undoPlacedEvent([p], ev('heal', {}))).toBeNull();
    });
});

describe('the planner and the new glyphs (G3)', () => {
    const wizard = (kit: GlyphAbility[], pos: Pos, extra: Partial<Combatant> = {}): Combatant => foe('w', pos, {
        tier: 'elite', archetype: 'caster', kit, proficiency: 3, castingAbility: 'INT', abilityDamage: { count: 2, sides: 6, bonus: 2 },
        abilities: { STR: 10, DEX: 12, CON: 12, INT: 16, WIS: 12, CHA: 10 }, damage: { count: 1, sides: 2, bonus: 0, type: 'bludgeoning' }, range: 'close', ...extra,
    });
    const pcAt = (pos: Pos, extra: Partial<Combatant> = {}) => ({ ...buildPcCombatant({ name: 'Hero', sheet: casterSheet, weapon: { quality: 'common' } }), position: pos, ...extra });
    const enemyTurn = (combatants: Combatant[], extra: Partial<CombatState> = {}) => arena(combatants, { turnIndex: 0, ...extra });

    it('lists every new glyph as planned or not-for-AI with a reason', () => {
        const listed = GLYPH_AI.map(g => g.glyph.id);
        for (const id of ['sigil', 'mantle', 'chain', 'wall', 'snare', 'dispel', 'leap', 'gravity', 'fear', 'decay', 'vanish', 'rewind', 'dampen', 'sustain', 'delay']) {
            expect(listed).toContain(id);
        }
        for (const g of GLYPH_AI) expect(g.reason.length).toBeGreaterThan(10);
        expect(GLYPH_AI.filter(g => !g.plan).map(g => g.glyph.id).sort()).toEqual(['barrier', 'blink', 'leap', 'sigil', 'swap', 'wall']);
    });

    it('never plans a not-for-AI glyph', () => {
        const kit = [glyph('sigil', ['damage'], [], { id: 's' }), glyph('wall', ['damage'], [], { id: 'wl' }), glyph('self', ['leap'], [], { id: 'lp' })];
        const s = enemyTurn([wizard(kit, { x: 5, y: 5 }), pcAt({ x: 9, y: 5 })]);
        expect(planTurn(s, 'w').steps.some(a => a.type === 'use_ability' && ['s', 'wl', 'lp'].includes(a.abilityId))).toBe(false);
    });

    it('uses a chain on a group, a mantle among foes, and decay', () => {
        const pcs = [pcAt({ x: 8, y: 5 }), { ...pcAt({ x: 9, y: 6 }), id: 'a1', side: 'ally' as const, controller: 'engine' as const }, { ...pcAt({ x: 10, y: 5 }), id: 'a2', side: 'ally' as const, controller: 'engine' as const }];
        const chainKit = [glyph('chain', ['damage'], [], { id: 'arc' })];
        expect(planTurn(enemyTurn([wizard(chainKit, { x: 3, y: 5 }), ...pcs]), 'w').steps.some(a => a.type === 'use_ability' && a.abilityId === 'arc')).toBe(true);
        const mantleKit = [glyph('mantle', ['damage'], [], { id: 'aura' })];
        const close = [pcAt({ x: 6, y: 5 }), { ...pcAt({ x: 6, y: 6 }), id: 'a1', side: 'ally' as const, controller: 'engine' as const }];
        expect(planTurn(enemyTurn([wizard(mantleKit, { x: 5, y: 5 }), ...close]), 'w').steps.some(a => a.type === 'use_ability' && a.abilityId === 'aura')).toBe(true);
        const rotKit = [glyph('projectile', ['decay'], [], { id: 'rot' })];
        expect(planTurn(enemyTurn([wizard(rotKit, { x: 3, y: 5 }), pcAt({ x: 8, y: 5 })]), 'w').steps.some(a => a.type === 'use_ability' && a.abilityId === 'rot')).toBe(true);
    });

    it('respects snare and leaves the generator alone', () => {
        const kit = [glyph('chain', ['damage'], ['delay'], { id: 'later' }), glyph('mantle', ['damage'], [], { id: 'aura' }), glyph('self', ['vanish'], [], { id: 'hide' })];
        const s = enemyTurn([wizard(kit, { x: 5, y: 5 }, { conditions: [{ id: 'snared', turns: 1 }] }), pcAt({ x: 9, y: 5 })], { rngCursor: 41 });
        const snapshot = JSON.stringify(s);
        const plan = planTurn(s, 'w');
        expect(plan.steps.some(a => a.type === 'move')).toBe(false);
        expect(JSON.stringify(s)).toBe(snapshot);
        expect(s.rngCursor).toBe(41);
    });

    it('plays whole fights with every plannable glyph and never has a planned step refused', () => {
        const kits: GlyphAbility[][] = [
            [glyph('chain', ['damage'], [], { id: 'k1' })],
            [glyph('mantle', ['damage', 'slow'], [], { id: 'k2' })],
            [glyph('projectile', ['snare'], [], { id: 'k3' }), glyph('projectile', ['damage'], ['delay'], { id: 'k4' })],
            [glyph('projectile', ['fear'], [], { id: 'k5' }), glyph('self', ['vanish'], [], { id: 'k6' })],
            [glyph('burst', ['gravity', 'damage'], [], { id: 'k7' }), glyph('self', ['rewind'], [], { id: 'k8' })],
            [glyph('projectile', ['decay'], [], { id: 'k9' }), glyph('touch', ['dispel'], [], { id: 'k10' })],
        ];
        const used = new Set<string>();
        for (let i = 0; i < kits.length; i++) {
            const created = createCombat({
                id: `g${i}`, combatants: [{ name: 'Hexer', side: 'enemy', tier: 'elite', archetype: 'caster' }, { name: 'Brute', side: 'enemy', tier: 'grunt' }],
                map: { size: 'medium', area: 'scattered' },
            }, buildPcCombatant({ name: 'Hero', sheet: casterSheet, weapon: { quality: 'common' }, kit: [glyph('mantle', ['damage'], [], { id: 'pk' })] }), 100 + i);
            const hexer = Object.values(created.state.combatants).find(c => c.name === 'Hexer') as Combatant;
            let state: CombatState = { ...created.state, combatants: { ...created.state.combatants, [hexer.id]: { ...hexer, kit: kits[i], damage: { count: 1, sides: 2, bonus: 0, type: 'bludgeoning' } } } };
            let refused = 0;
            for (let step = 0; step < 600 && !state.outcome; step++) {
                const id = state.order[state.turnIndex];
                const actor = state.combatants[id];
                if (actor.controller === 'player' && actor.status === 'up') {
                    const plan = planTurn(state, id);
                    const r = applyAction(state, plan.steps[0] ?? { type: 'end_turn', actorId: id });
                    if (r.events.some(e => e.type === 'rejected')) refused += 1;
                    state = r.events.some(e => e.type === 'rejected') ? end(state, id).state : r.state;
                    continue;
                }
                const plan = planTurn(state, id);
                const r = stepEngine(state);
                if (!r) break;
                for (const e of r.events) if (e.type === 'ability' && typeof e.data.abilityId === 'string' && /^k\d+$/.test(e.data.abilityId)) used.add(e.data.abilityId);
                if (plan.steps[0] && actor.status === 'up' && !actor.conditions.some(c => c.id === 'confused')) {
                    const direct = applyAction(state, plan.steps[0]);
                    if (direct.events.some(e => e.type === 'rejected')) refused += 1;
                }
                state = r.state;
            }
            expect(refused).toBe(0);
        }
        expect([...used].sort()).toEqual(expect.arrayContaining(['k1', 'k2', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']));
    });

    it('a fight with none of the new glyphs is unchanged by them', () => {
        const spec = { id: 'same', combatants: [{ name: 'A', side: 'enemy' as const, tier: 'grunt' as const }], map: { size: 'small' as const, area: 'open' as const } };
        const pc = buildPcCombatant({ name: 'Hero', sheet: casterSheet, weapon: { quality: 'common' } });
        const a = runEngineTurns(createCombat(spec, pc, 5).state);
        expect(a.state.placed).toBeUndefined();
        expect(Object.values(a.state.combatants).some(c => c.rewind || c.rewindNext || c.decayed)).toBe(false);
        expect(a.events.some(e => GLYPH_EVENT_TYPES.includes(e.type))).toBe(false);
    });

    it('drops a signature built on a form the planner cannot use, and leap from one', () => {
        const unit = { id: 'w', name: 'W', tier: 'boss' as const };
        expect(validateSignature(unit, { name: 'Trap', form: 'sigil', effects: [{ id: 'damage' }] }).ability).toBeNull();
        const leap = validateSignature(unit, { name: 'Hop', form: 'self', effects: [{ id: 'leap' }, { id: 'shield' }] });
        expect(leap.ability?.effects.map(e => e.id)).toEqual(['shield']);
    });
});
