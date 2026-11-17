import { describe, it, expect } from 'vitest';
import {
    abilityCost, abilityDamageType, applyAction, checkAttack, checkElement, COMBAT_EVENT_TYPES, createCombat, currentActorId, describeAbility,
    DEFAULT_SPEED, ELEMENT_IDS, ELEMENT_PRESETS, ELEMENTS, elementMultiplier, elementsFor, filterElements, freshTurn, glyphCount, isGlyphAbilityShape,
    isMindless, planTurn, stepEngine, undoElementEvent, validateAbility,
} from '../index';
import type { CombatEvent, CombatState, Combatant, ElementId, GlyphAbility, Pos } from '../index';
import { arena, caster, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const cast = (s: CombatState, abilityId: string, aim: Pos | null = null, actorId = 'pc') =>
    applyAction(s, { type: 'use_ability', actorId, abilityId, aim });
const of = (events: CombatEvent[], type: string) => events.filter(e => e.type === type);
const noOne = (seed = 7) => cursorFor(seed, r => r[0] !== 1 && r[0] !== 20, 1);

function touch(element: ElementId, extra: Partial<GlyphAbility> = {}): GlyphAbility {
    return glyph('touch', ['damage'], [], { id: `t-${element}`, element, ...extra });
}

function duel(element: ElementId, target: Partial<Combatant> = {}, extra: Partial<CombatState> = {}, ability?: GlyphAbility): CombatState {
    return arena([
        caster([ability ?? touch(element)], { x: 5, y: 5 }),
        foe('f', { x: 6, y: 5 }, { ac: 0, hp: 99, maxHp: 99, ...target }),
    ], { rngCursor: noOne(), ...extra });
}

const hit = (element: ElementId, target: Partial<Combatant> = {}, extra: Partial<CombatState> = {}) =>
    cast(duel(element, target, extra), `t-${element}`, { x: 6, y: 5 });

const condition = (c: Combatant, id: string) => c.conditions.find(x => x.id === id);

describe('the element table', () => {
    it('holds the fourteen elements with tiers, costs, riders and mark data', () => {
        expect(ELEMENT_IDS).toHaveLength(14);
        expect(Object.keys(ELEMENTS).sort()).toEqual([...ELEMENT_IDS].sort());
        const tier = (n: number) => ELEMENT_IDS.filter(e => ELEMENTS[e].tier === n);
        expect(tier(1)).toEqual(['fire', 'water', 'earth', 'kinetic']);
        expect(tier(2)).toEqual(['lightning', 'ice', 'steel', 'light', 'darkness', 'slime', 'mental']);
        expect(tier(3)).toEqual(['lava', 'madness', 'almighty']);
        expect(ELEMENT_IDS.filter(e => ELEMENTS[e].cost === 1)).toHaveLength(12);
        expect(ELEMENTS.almighty.cost).toBe(2);
        expect(ELEMENTS.lava.cost).toBe(2);
        expect(ELEMENTS.fire.mark).toBe('flames');
        expect(ELEMENTS.earth.mark).toBe('rubble');
        expect(ELEMENTS.ice.mark).toBe('slick');
        expect(ELEMENTS.slime.mark).toBe('sticky');
        expect(ELEMENTS.lava.mark).toBe('molten');
        expect(ELEMENTS.darkness.mark).toBe('dim');
        expect(ELEMENTS.water.clears).toBe('flames');
        expect(ELEMENTS.light.clears).toBe('dim');
        expect(ELEMENTS.lava.riders).toEqual(['burning', 'staggered']);
        expect(ELEMENTS.almighty.riders).toEqual([]);
    });

    it('has presets and a validator', () => {
        expect(ELEMENT_PRESETS.all).toHaveLength(14);
        expect(ELEMENT_PRESETS.fantasy).toHaveLength(11);
        expect(ELEMENT_PRESETS.modern).toHaveLength(8);
        expect(elementsFor('fantasy')).not.toContain('kinetic');
        expect(elementsFor('modern')).not.toContain('lava');
        expect(elementsFor(undefined)).toHaveLength(14);
        expect(elementsFor('nonsense')).toHaveLength(14);
        expect(checkElement('modern', 'mental')).toEqual({ ok: true, element: 'mental' });
        expect(checkElement('fantasy', 'mental')).toEqual({ ok: false, reason: 'outside_preset' });
        expect(checkElement('all', 'acid')).toEqual({ ok: false, reason: 'unknown' });
        expect(checkElement('all', 'Frost')).toEqual({ ok: true, element: 'ice' });
        const filtered = filterElements('fantasy', ['fire', 'kinetic', 'bogus', 'fire', 'Cold']);
        expect(filtered.kept).toEqual(['fire', 'ice']);
        expect(filtered.dropped).toEqual([{ value: 'kinetic', reason: 'outside_preset' }, { value: 'bogus', reason: 'unknown' }]);
    });
});

describe('abilities with an element', () => {
    const plain = glyph('touch', ['damage'], [], { id: 'p' });

    it('costs the element on top of the chain and counts as one glyph', () => {
        const fire = touch('fire');
        expect(abilityCost(fire)).toBe(abilityCost(plain) + 1);
        expect(abilityCost(touch('almighty'))).toBe(abilityCost(plain) + ELEMENTS.almighty.cost);
        expect(glyphCount(fire)).toBe(glyphCount(plain) + 1);
        expect(validateAbility(fire)).toEqual([]);
        expect(validateAbility(fire, { maxChainLength: 2 })).toHaveLength(1);
        expect(validateAbility(plain, { maxChainLength: 2 })).toEqual([]);
    });

    it('is refused when unknown or outside the active preset, and stays usable in a fight', () => {
        expect(validateAbility({ ...touch('fire'), element: 'acid' as ElementId })).toEqual(['unknown element "acid"']);
        expect(validateAbility(touch('kinetic'), { maxChainLength: 6, elementPreset: 'fantasy' })).toEqual(['the kinetic element is not available in this setting']);
        expect(validateAbility(touch('fire'), { maxChainLength: 6, elementPreset: 'fantasy' })).toEqual([]);
        const s = arena([caster([touch('kinetic')], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 })], { elementPreset: 'fantasy' });
        expect(cast(s, 't-kinetic', { x: 6, y: 5 }).events[0].type).toBe('ability');
    });

    it('sets the damage type, shows in the description and keeps the saved shape loadable', () => {
        expect(abilityDamageType(touch('lava', { damageType: 'fire' }))).toBe('lava');
        expect(abilityDamageType(glyph('touch', ['damage'], [], { damageType: 'Fire ' }))).toBe('Fire');
        expect(abilityDamageType(plain)).toBe('force');
        expect(describeAbility(touch('fire'))).toContain('burns');
        expect(describeAbility(plain)).not.toContain('burns');
        expect(isGlyphAbilityShape(plain)).toBe(true);
        expect(isGlyphAbilityShape(touch('ice'))).toBe(true);
        expect(isGlyphAbilityShape({ ...touch('ice'), element: 'acid' })).toBe(false);
    });

    it('does not change an ability that carries none', () => {
        const r = cast(duel('fire', {}, {}, plain), 'p', { x: 6, y: 5 });
        expect(r.events.some(e => 'element' in e.data)).toBe(false);
        expect(of(r.events, 'element_rider')).toHaveLength(0);
        expect(of(r.events, 'ability_damage')[0].data).toMatchObject({ damageType: 'force' });
    });

    it('lists the new event types', () => {
        for (const type of ['element_rider', 'burn', 'confused']) expect(COMBAT_EVENT_TYPES).toContain(type);
    });
});

describe('riders', () => {
    it('fire: burning for two turns, a burn tick at the start of each, no stacking', () => {
        const r = hit('fire');
        expect(of(r.events, 'ability_damage')[0].data).toMatchObject({ element: 'fire', damageType: 'fire' });
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ element: 'fire', rider: 'burning', condition: 'burning', turns: 2, before: null });
        expect(condition(r.state.combatants.f, 'burning')?.turns).toBe(2);
        const again = cast({ ...r.state, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false }, combatants: { ...r.state.combatants, f: { ...r.state.combatants.f, conditions: [{ id: 'burning', turns: 1 }] } } }, 't-fire', { x: 6, y: 5 });
        expect(again.state.combatants.f.conditions.filter(c => c.id === 'burning')).toHaveLength(1);
        expect(condition(again.state.combatants.f, 'burning')?.turns).toBe(2);
        const t1 = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
        const burn1 = of(t1.events, 'burn');
        expect(burn1).toHaveLength(1);
        expect(burn1[0].data).toMatchObject({ element: 'fire', damageType: 'fire', hpBefore: r.state.combatants.f.hp });
        expect(burn1[0].data.damage).toBe(1);
        expect(t1.state.combatants.f.hp).toBe(r.state.combatants.f.hp - (burn1[0].data.damage as number));
        const t2 = applyAction(t1.state, { type: 'end_turn', actorId: 'f' });
        const t3 = applyAction(t2.state, { type: 'end_turn', actorId: 'pc' });
        expect(of(t3.events, 'burn')).toHaveLength(1);
        const t4 = applyAction(t3.state, { type: 'end_turn', actorId: 'f' });
        expect(condition(t4.state.combatants.f, 'burning')).toBeUndefined();
        expect(of(t4.events, 'condition_ended')[0].data.condition).toBe('burning');
    });

    it('fire: a burning unit that falls to the burn passes the turn on', () => {
        const s = arena([
            caster([touch('fire')], { x: 5, y: 5 }),
            foe('f', { x: 6, y: 5 }, { hp: 1, conditions: [{ id: 'burning', turns: 2 }] }),
            foe('g', { x: 9, y: 9 }),
        ]);
        const r = applyAction(s, { type: 'end_turn', actorId: 'pc' });
        expect(of(r.events, 'burn')).toHaveLength(1);
        expect(r.state.combatants.f.status).toBe('down');
        expect(currentActorId(r.state)).toBe('g');
        expect(r.state.outcome).toBeNull();
    });

    it('water: soaked for two turns and pushed one square; soaked is weak to lightning and ice', () => {
        const r = hit('water');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'soaked', condition: 'soaked', turns: 2 });
        const pushed = of(r.events, 'pushed')[0];
        expect(pushed.data).toMatchObject({ rider: true, squares: 1, element: 'water' });
        expect(r.state.combatants.f.position).toEqual({ x: 7, y: 5 });
        for (const element of ['lightning', 'ice'] as const) {
            const plain = of(hit(element).events, 'ability_damage')[0].data;
            const soaked = of(hit(element, { conditions: [{ id: 'soaked', turns: 2 }] }).events, 'ability_damage')[0].data;
            expect(soaked.damage).toBe(Math.floor((plain.damage as number) * 1.5));
            expect(soaked.weakness).toBe(true);
        }
        const fire = of(hit('fire', { conditions: [{ id: 'soaked', turns: 2 }] }).events, 'ability_damage')[0].data;
        expect(fire.weakness).toBe(false);
    });

    it('earth: staggered costs two squares of movement on its next turn only', () => {
        const r = hit('earth');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'staggered', turns: 1 });
        const next = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
        expect(next.state.turn?.actorId).toBe('f');
        expect(next.state.turn?.moveLeft).toBe(DEFAULT_SPEED - 2);
        const after = applyAction(next.state, { type: 'end_turn', actorId: 'f' });
        const back = applyAction(after.state, { type: 'end_turn', actorId: 'pc' });
        expect(back.state.turn?.moveLeft).toBe(DEFAULT_SPEED);
    });

    it('kinetic: one more square; a wall or unit in the way adds impact damage', () => {
        const open = hit('kinetic');
        expect(open.state.combatants.f.position).toEqual({ x: 7, y: 5 });
        expect(of(open.events, 'ability_damage').some(e => e.data.kind === 'impact')).toBe(false);
        const walled = cast(duel('kinetic', {}, { grid: openGrid(16, 12, [{ x: 7, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 6 }]) }), 't-kinetic', { x: 6, y: 5 });
        const impact = of(walled.events, 'ability_damage').filter(e => e.data.kind === 'impact');
        expect(impact).toHaveLength(1);
        expect(impact[0].data).toMatchObject({ element: 'kinetic', impact: true });
        expect(impact[0].data.damage as number).toBeLessThanOrEqual(4);
        const blocked = cast(arena([
            caster([touch('kinetic')], { x: 5, y: 5 }),
            foe('f', { x: 6, y: 5 }, { ac: 0, hp: 99, maxHp: 99 }),
            foe('g', { x: 7, y: 5 }, { hp: 99, maxHp: 99 }),
            foe('h', { x: 7, y: 4 }, { hp: 99, maxHp: 99 }),
            foe('i', { x: 7, y: 6 }, { hp: 99, maxHp: 99 }),
        ], { rngCursor: noOne() }), 't-kinetic', { x: 6, y: 5 });
        expect(of(blocked.events, 'ability_damage').some(e => e.data.kind === 'impact')).toBe(true);
    });

    it('lightning: arcs to one adjacent foe of the target for half damage, never an ally', () => {
        const s = arena([
            caster([touch('lightning')], { x: 5, y: 5 }),
            foe('f', { x: 6, y: 5 }, { ac: 0, hp: 99, maxHp: 99 }),
            foe('near', { x: 7, y: 6 }, { hp: 99, maxHp: 99 }),
            foe('far', { x: 12, y: 9 }, { hp: 99, maxHp: 99 }),
        ], { rngCursor: noOne() });
        const r = cast(s, 't-lightning', { x: 6, y: 5 });
        const damages = of(r.events, 'ability_damage');
        const main = damages.find(e => e.targetId === 'f') as CombatEvent;
        const arc = damages.find(e => e.data.arc === true) as CombatEvent;
        expect(arc.targetId).toBe('near');
        expect(arc.data).toMatchObject({ kind: 'arc', fromId: 'f', element: 'lightning' });
        expect(arc.data.damage).toBe(Math.floor((main.data.damage as number) / 2));
        expect(r.state.combatants.near.hp).toBe(99 - (arc.data.damage as number));
        expect(r.state.combatants.far.hp).toBe(99);
        const friendly = arena([
            caster([touch('lightning')], { x: 5, y: 5 }),
            foe('f', { x: 6, y: 5 }, { ac: 0, hp: 99, maxHp: 99 }),
            foe('buddy', { x: 7, y: 6 }, { side: 'ally', hp: 99, maxHp: 99 }),
        ], { rngCursor: noOne() });
        expect(of(cast(friendly, 't-lightning', { x: 6, y: 5 }).events, 'ability_damage').some(e => e.data.arc === true)).toBe(false);
    });

    it('ice: chilled, which is the slowed condition tagged with its element', () => {
        const r = hit('ice');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'chilled', condition: 'slowed', turns: 1 });
        expect(condition(r.state.combatants.f, 'slowed')).toMatchObject({ turns: 1, element: 'ice' });
    });

    it('steel: ignores two points of armour on the attack roll', () => {
        const probe = cast(duel('fire', { ac: 99 }), 't-fire', { x: 6, y: 5 });
        const total = of(probe.events, 'ability_attack')[0].data.total as number;
        const wall = { ac: total + 1 };
        const missed = cast(duel('fire', wall), 't-fire', { x: 6, y: 5 });
        expect(of(missed.events, 'ability_attack')[0].data.hit).toBe(false);
        const steel = cast(duel('steel', wall), 't-steel', { x: 6, y: 5 });
        expect(of(steel.events, 'ability_attack')[0].data).toMatchObject({ hit: true, ac: total - 1 });
        expect(of(steel.events, 'element_rider')).toHaveLength(0);
    });

    it('light: revealed, so cover counts for half against the unit', () => {
        const r = hit('light');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'revealed', condition: 'revealed', turns: 2 });
        const base = (conditions: Combatant['conditions']) => {
            const a = foe('a', { x: 1, y: 5 }, { range: 'ranged' });
            const t = foe('t', { x: 7, y: 5 }, { side: 'player', conditions });
            const s = arena([a, t], { grid: openGrid(16, 12, [], [[{ x: 4, y: 5 }, 'cover']]) });
            return checkAttack(s, 'a', 't').cover;
        };
        const open = base([]);
        expect(open).toBeGreaterThan(1);
        expect(base([{ id: 'revealed', turns: 1 }])).toBe(Math.floor(open / 2));
    });

    it('darkness: blinded, so its attack rolls are two lower', () => {
        const r = hit('darkness');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'blinded', condition: 'blinded', turns: 2 });
        const swing = (conditions: Combatant['conditions']) => {
            const s = arena([foe('f', { x: 6, y: 5 }, { conditions }), caster([], { x: 5, y: 5 })], { rngCursor: noOne() });
            return of(applyAction(s, { type: 'attack', actorId: 'f', targetId: 'pc' }).events, 'attack')[0].data.total as number;
        };
        expect(swing([{ id: 'blinded', turns: 1 }])).toBe(swing([]) - 2);
    });

    it('slime: slowed and coated; the coating weakens the next damaging action and is then spent', () => {
        const r = hit('slime');
        const riders = of(r.events, 'element_rider').map(e => e.data.rider);
        expect(riders).toEqual(['sticky', 'coated']);
        expect(condition(r.state.combatants.f, 'slowed')).toMatchObject({ element: 'slime', turns: 1 });
        expect(condition(r.state.combatants.f, 'coated')).toBeDefined();
        const swing = (conditions: Combatant['conditions']) => {
            const s = arena([foe('f', { x: 6, y: 5 }, { conditions, damage: { count: 3, sides: 6, bonus: 2, type: 'slashing' } }), caster([], { x: 5, y: 5 }, { hp: 99, maxHp: 99, ac: 0 })], { rngCursor: noOne() });
            return applyAction(s, { type: 'attack', actorId: 'f', targetId: 'pc' });
        };
        const clean = swing([]);
        const coated = swing([{ id: 'coated', turns: 2 }]);
        const dirty = of(clean.events, 'attack')[0].data;
        const weak = of(coated.events, 'attack')[0].data;
        expect(weak.damage).toBe(Math.max(1, (dirty.damage as number) - 1));
        expect(condition(coated.state.combatants.f, 'coated')).toBeUndefined();
        expect(of(coated.events, 'condition_ended')[0].data).toMatchObject({ condition: 'coated', consumed: true });
    });

    it('mental: a WIS save instead of an attack roll, dazed on a failure, no bonus action next turn', () => {
        const failing = cursorFor(7, r => r[0] <= 2, 1);
        const r = cast(duel('mental', {}, { rngCursor: failing }), 't-mental', { x: 6, y: 5 });
        expect(of(r.events, 'ability_attack')).toHaveLength(0);
        expect(of(r.events, 'save')[0].data).toMatchObject({ save: 'WIS', success: false });
        expect(of(r.events, 'ability_damage')[0].data).toMatchObject({ element: 'mental' });
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'dazed', condition: 'dazed', turns: 1 });
        const next = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
        expect(next.state.turn).toMatchObject({ actorId: 'f', bonusUsed: true });
        const held = applyAction(next.state, { type: 'end_turn', actorId: 'f' });
        expect(of(held.events, 'end_turn')[0].data.acted).toBe(false);
        const succeeding = cursorFor(7, r2 => r2[0] >= 19, 1);
        const saved = cast(duel('mental', {}, { rngCursor: succeeding }), 't-mental', { x: 6, y: 5 });
        expect(of(saved.events, 'ability_damage')).toHaveLength(0);
        expect(of(saved.events, 'element_rider')).toHaveLength(0);
    });

    it('lava: burning and staggered together', () => {
        const r = hit('lava');
        expect(of(r.events, 'element_rider').map(e => e.data.condition)).toEqual(['burning', 'staggered']);
        expect(condition(r.state.combatants.f, 'burning')).toBeDefined();
        expect(condition(r.state.combatants.f, 'staggered')).toBeDefined();
    });

    it('madness: confused, and its next action goes to the nearest unit, friend or foe', () => {
        const r = hit('madness');
        expect(of(r.events, 'element_rider')[0].data).toMatchObject({ rider: 'confused', condition: 'confused', turns: 1 });
        const s = arena([
            foe('mad', { x: 5, y: 5 }, { conditions: [{ id: 'confused', turns: 1 }] }),
            foe('mate', { x: 6, y: 5 }, { hp: 99, maxHp: 99, ac: 0 }),
            caster([], { x: 8, y: 5 }),
        ], { rngCursor: noOne() });
        const step = stepEngine(s) as { state: CombatState; events: CombatEvent[] };
        expect(step.events[0]).toMatchObject({ type: 'confused', actorId: 'mad', targetId: 'mate' });
        expect(of(step.events, 'attack')[0].targetId).toBe('mate');
        expect(condition(step.state.combatants.mad, 'confused')).toBeUndefined();
        expect(of(step.events, 'condition_ended')[0].data).toMatchObject({ condition: 'confused', consumed: true });
    });

    it('madness: a confused player-controlled unit has its attack or ability turned on the nearest unit', () => {
        const pcState = arena([
            caster([touch('fire')], { x: 5, y: 5 }, { conditions: [{ id: 'confused', turns: 1 }], hp: 99, maxHp: 99 }),
            foe('buddy', { x: 4, y: 5 }, { side: 'ally', hp: 99, maxHp: 99, ac: 0 }),
            foe('f', { x: 6, y: 5 }),
        ], { rngCursor: noOne() });
        const swing = applyAction(pcState, { type: 'attack', actorId: 'pc', targetId: 'f' });
        expect(swing.events[0]).toMatchObject({ type: 'confused', targetId: 'buddy', data: { intendedId: 'f' } });
        expect(of(swing.events, 'attack')[0].targetId).toBe('buddy');
        expect(swing.state.combatants.pc.conditions.some(c => c.id === 'confused')).toBe(false);
        const spell = cast(pcState, 't-fire', { x: 6, y: 5 });
        expect(spell.events[0]).toMatchObject({ type: 'confused', targetId: 'buddy' });
        expect(of(spell.events, 'ability_damage')[0].targetId).toBe('buddy');
        expect(spell.state.combatants.f.hp).toBe(30);
        const away = glyph('self', ['heal'], [], { id: 'heal-self' });
        const selfCast = cast({ ...pcState, combatants: { ...pcState.combatants, pc: { ...pcState.combatants.pc, kit: [away], hp: 50 } } }, 'heal-self', null);
        expect(selfCast.events[0].type).toBe('ability');
        const stunt = applyAction(pcState, { type: 'stunt', actorId: 'pc', spec: { ability: 'STR', parts: [] } });
        expect(stunt.events[0]).toMatchObject({ type: 'rejected', data: { reason: 'too confused to aim' } });
    });

    it('almighty: no rider, nothing resists it, nothing is weak to it, nothing is immune', () => {
        const plain = of(hit('almighty').events, 'ability_damage')[0].data.damage as number;
        const tricked = hit('almighty', { weak: ['almighty'], resist: ['almighty'], immune: ['almighty'], weaknesses: ['almighty'] });
        const data = of(tricked.events, 'ability_damage')[0].data;
        expect(data.damage).toBe(plain);
        expect(data).toMatchObject({ weakness: false, resisted: false });
        expect(of(tricked.events, 'element_rider')).toHaveLength(0);
        const resisted = of(hit('almighty', { resist: ['almighty'] }).events, 'ability_damage')[0].data.damage;
        expect(resisted).toBe(plain);
    });

    it('an element with no hostile effect only colours the ability', () => {
        const heal = glyph('touch', ['heal'], [], { id: 'h', element: 'fire' });
        const s = arena([caster([heal], { x: 5, y: 5 }), foe('ally', { x: 6, y: 5 }, { side: 'ally', hp: 5 })]);
        const r = cast(s, 'h', { x: 6, y: 5 });
        expect(of(r.events, 'heal')).toHaveLength(1);
        expect(of(r.events, 'element_rider')).toHaveLength(0);
        expect(r.events[0].data).toMatchObject({ damageType: 'fire', element: 'fire' });
    });

    it('a miss, or an immune target, takes no rider', () => {
        const miss = cast(duel('fire', { ac: 99 }), 't-fire', { x: 6, y: 5 });
        expect(of(miss.events, 'element_rider')).toHaveLength(0);
        const immune = hit('fire', { immune: ['fire'] });
        expect(of(immune.events, 'element_rider')).toHaveLength(0);
        expect(condition(immune.state.combatants.f, 'burning')).toBeUndefined();
    });

    it('a saved area attack still burns (damage dealt), and a non-damaging push needs the roll to land', () => {
        const burst = glyph('burst', ['damage'], [], { id: 'b', element: 'fire' });
        const s = arena([caster([burst], { x: 5, y: 5 }), foe('f', { x: 9, y: 5 }, { hp: 99, maxHp: 99 })], { rngCursor: cursorFor(7, r => r[0] >= 19, 1) });
        const r = cast(s, 'b', { x: 9, y: 5 });
        expect(of(r.events, 'ability_damage')[0].data.saved).toBe(true);
        expect(condition(r.state.combatants.f, 'burning')).toBeDefined();
        const push = glyph('touch', ['push'], [], { id: 'p', element: 'water' });
        const miss = cast(arena([caster([push], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 99 })], { rngCursor: noOne() }), 'p', { x: 6, y: 5 });
        expect(of(miss.events, 'element_rider')).toHaveLength(0);
    });
});

describe('weak, resist, immune, mindless', () => {
    it('weak is x1.5, resist x0.5, immune 0 with an event and no rider', () => {
        const plain = of(hit('fire').events, 'ability_damage')[0].data.damage as number;
        const weak = of(hit('fire', { weak: ['fire'] }).events, 'ability_damage')[0].data;
        expect(weak).toMatchObject({ damage: Math.floor(plain * 1.5), weakness: true, element: 'fire' });
        const resist = of(hit('fire', { resist: ['fire'] }).events, 'ability_damage')[0].data;
        expect(resist).toMatchObject({ damage: Math.floor(plain / 2), resisted: true });
        const both = of(hit('fire', { weak: ['fire'], resist: ['fire'] }).events, 'ability_damage')[0].data;
        expect(both.damage).toBe(plain);
        const immune = hit('fire', { immune: ['fire'] });
        const event = of(immune.events, 'ability_damage')[0];
        expect(event.data).toMatchObject({ damage: 0, immune: true, element: 'fire', hpBefore: 99, hpAfter: 99 });
        expect(event.text).toContain('immune');
        expect(immune.state.combatants.f.hp).toBe(99);
    });

    it('maps the free-text lists onto elements and leaves unknown words alone', () => {
        const plain = of(hit('ice').events, 'ability_damage')[0].data.damage as number;
        expect(of(hit('ice', { weaknesses: ['Frost'] }).events, 'ability_damage')[0].data.damage).toBe(Math.floor(plain * 1.5));
        expect(of(hit('ice', { resistances: ['cold'] }).events, 'ability_damage')[0].data.damage).toBe(Math.floor(plain / 2));
        expect(of(hit('ice', { resistances: ['whimsy'] }).events, 'ability_damage')[0].data.damage).toBe(plain);
        const old = of(cast(duel('fire', { weaknesses: ['Fire'] }, {}, glyph('touch', ['damage'], [], { id: 'old', damageType: 'fire' })), 'old', { x: 6, y: 5 }).events, 'ability_damage')[0].data;
        const oldPlain = of(cast(duel('fire', {}, {}, glyph('touch', ['damage'], [], { id: 'old', damageType: 'fire' })), 'old', { x: 6, y: 5 }).events, 'ability_damage')[0].data;
        expect(old.damage).toBe((oldPlain.damage as number) * 2);
    });

    it('mindless defaults by creature kind, can be overridden, and shrugs off mental and madness only', () => {
        expect(isMindless({ species: 'Clockwork construct' })).toBe(true);
        expect(isMindless({ species: 'skeletons' })).toBe(true);
        expect(isMindless({ species: 'goblin' })).toBe(false);
        expect(isMindless({})).toBe(false);
        expect(isMindless({ species: 'goblin', mindless: true })).toBe(true);
        expect(isMindless({ species: 'golem', mindless: false })).toBe(false);
        const golem = { conditions: [], species: 'golem' };
        expect(elementMultiplier(golem, 'mental').immune).toBe(true);
        expect(elementMultiplier(golem, 'madness').immune).toBe(true);
        expect(elementMultiplier(golem, 'fire').immune).toBe(false);
        expect(elementMultiplier({ ...golem, mindless: false }, 'mental').immune).toBe(false);
        const r = cast(duel('mental', { species: 'zombie' }), 't-mental', { x: 6, y: 5 });
        expect(of(r.events, 'save')).toHaveLength(0);
        expect(of(r.events, 'ability_damage')[0].data).toMatchObject({ damage: 0, immune: true });
        expect(of(r.events, 'element_rider')).toHaveLength(0);
        const mad = cast(duel('madness', { mindless: true }), 't-madness', { x: 6, y: 5 });
        expect(of(mad.events, 'ability_damage')[0].data.immune).toBe(true);
    });

    it('soaked adds lightning and ice to the weak list while it lasts', () => {
        const soaked = { conditions: [{ id: 'soaked', turns: 1 }] };
        expect(elementMultiplier(soaked, 'lightning')).toMatchObject({ factor: 1.5, weak: true });
        expect(elementMultiplier(soaked, 'ice')).toMatchObject({ factor: 1.5 });
        expect(elementMultiplier(soaked, 'fire').factor).toBe(1);
        expect(elementMultiplier({ conditions: [] }, 'lightning').factor).toBe(1);
        expect(elementMultiplier({ ...soaked, resist: ['ice'] as ElementId[] }, 'ice').factor).toBe(1);
    });
});

describe('starting a fight with elements', () => {
    const pc = caster([], { x: 0, y: 0 });

    it('normalises the lists, drops what the preset refuses and reports it', () => {
        const made = createCombat({
            id: 'e', mapSeed: 3, elementPreset: 'modern',
            combatants: [
                { name: 'Bolter', side: 'enemy', tier: 'grunt', archetype: 'caster', element: 'water', weak: ['fire', 'lava', 'junk'], resist: ['Cold'], immune: ['mental'], mindless: true },
                { name: 'Sparker', side: 'enemy', tier: 'grunt', archetype: 'caster', element: 'lightning' },
            ],
        }, pc, 11);
        const bolter = Object.values(made.state.combatants).find(c => c.name === 'Bolter') as Combatant;
        expect(made.state.elementPreset).toBe('modern');
        expect(bolter.weak).toEqual(['fire']);
        expect(bolter.resist).toEqual(['ice']);
        expect(bolter.immune).toEqual(['mental']);
        expect(bolter.mindless).toBe(true);
        expect(bolter.kit?.[0].element).toBeUndefined();
        expect(made.elementDrops).toEqual([
            { unitId: bolter.id, unitName: 'Bolter', field: 'weak', value: 'lava', reason: 'outside_preset' },
            { unitId: bolter.id, unitName: 'Bolter', field: 'weak', value: 'junk', reason: 'unknown' },
            { unitId: bolter.id, unitName: 'Bolter', field: 'element', value: 'water', reason: 'outside_preset' },
        ]);
        const sparker = Object.values(made.state.combatants).find(c => c.name === 'Sparker') as Combatant;
        expect(sparker.kit?.[0]).toMatchObject({ element: 'lightning', name: 'Lightning bolt', damageType: 'lightning' });
    });

    it('with none of it, the state and result look as before', () => {
        const made = createCombat({ id: 'e', mapSeed: 3, combatants: [{ name: 'Grub', side: 'enemy', tier: 'grunt', archetype: 'caster' }] }, pc, 11);
        expect('elementPreset' in made.state).toBe(false);
        expect('elementDrops' in made).toBe(false);
        const grub = Object.values(made.state.combatants).find(c => c.name === 'Grub') as Combatant;
        expect(grub.weak).toBeUndefined();
        expect(grub.mindless).toBeUndefined();
        expect(grub.kit?.[0].element).toBeUndefined();
    });
});

describe('the planner and elements', () => {
    function kitFoe(kit: GlyphAbility[]): Combatant {
        return foe('mage', { x: 4, y: 5 }, {
            kit, proficiency: 2, castingAbility: 'INT', abilityDamage: { count: 2, sides: 6, bonus: 0 }, damage: { count: 1, sides: 1, bonus: 0, type: 'slashing' },
            abilities: { STR: 10, DEX: 10, CON: 10, INT: 14, WIS: 10, CHA: 10 },
        });
    }
    const bolt = (element: ElementId): GlyphAbility => glyph('projectile', ['damage'], [], { id: `b-${element}`, element });
    const used = (s: CombatState): string | undefined => planTurn(s, 'mage').steps.find(st => st.type === 'use_ability')?.abilityId;
    const world = (target: Partial<Combatant>, kit: GlyphAbility[]) => arena([kitFoe(kit), caster([], { x: 8, y: 5 }, { hp: 60, maxHp: 60, ...target })]);

    it('prefers an ability the target is weak to and avoids one it is immune to', () => {
        const kit = [bolt('fire'), bolt('ice')];
        expect(used(world({ weak: ['ice'] }, kit))).toBe('b-ice');
        expect(used(world({ weak: ['fire'] }, kit))).toBe('b-fire');
        expect(used(world({ immune: ['fire'] }, kit))).toBe('b-ice');
        expect(used(world({ resist: ['ice'] }, kit))).toBe('b-fire');
        expect(used(world({ immune: ['fire'] }, [bolt('fire')]))).not.toBe('b-fire');
    });

    it('values a rider a little: the same bolt with fire beats a plain one on a clean target', () => {
        const plain = glyph('projectile', ['damage'], [], { id: 'plain' });
        expect(used(world({}, [plain, bolt('fire')]))).toBe('b-fire');
    });

    it('never reads the random generator or changes the state', () => {
        const s = world({ weak: ['ice'] }, [bolt('fire'), bolt('ice'), bolt('mental'), bolt('lightning')]);
        const before = JSON.stringify(s);
        const a = planTurn(s, 'mage');
        const b = planTurn(s, 'mage');
        expect(JSON.stringify(s)).toBe(before);
        expect(s.rngCursor).toBe(0);
        expect(a).toEqual(b);
    });
});

describe('undo', () => {
    it('gives back conditions the new events set or spent', () => {
        const burn = hit('fire');
        const applied = of(burn.events, 'element_rider')[0];
        const live = { ...burn.state.combatants };
        const undone = { ...live, f: { ...live.f } };
        expect(undoElementEvent(undone, applied)).toBe(true);
        expect(undone.f.conditions.some(c => c.id === 'burning')).toBe(false);
        expect(live.f.conditions.some(c => c.id === 'burning')).toBe(true);
        const refreshed = { ...burn.state, combatants: { ...burn.state.combatants, f: { ...burn.state.combatants.f, conditions: [{ id: 'burning', turns: 1 }] } } };
        const again = cast({ ...refreshed, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false } }, 't-fire', { x: 6, y: 5 });
        const back = { f: { ...again.state.combatants.f } } as Record<string, Combatant>;
        undoElementEvent(back, of(again.events, 'element_rider')[0]);
        expect(back.f.conditions.find(c => c.id === 'burning')?.turns).toBe(1);
        expect(undoElementEvent({}, { seq: 1, round: 1, type: 'attack', data: {}, text: '' })).toBe(false);
        expect(freshTurn(again.state, 'f').moveLeft).toBeGreaterThan(0);
    });
});
