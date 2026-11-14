import { describe, it, expect } from 'vitest';
import {
    abilityCost, allGlyphs, applyAction, availableAbilities, BUILTIN_ATTACK_ID, BUILTIN_DEFEND_ID, BUILTIN_EFFECT_IDS, buildPcCombatant,
    builtinAttack, builtinDefend, checkAbility, chooseEngineTurn, createCombat, currentActorId, currentTurn, describeAbility, EFFECT_IDS,
    isGlyphAbilityShape, legalAims, STARTER_ABILITIES, stepEngine, validateAbility,
} from '../index';
import type { CombatAction, CombatEvent, CombatState, Combatant, Pos } from '../index';
import { arena, caster, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const SEED = 7;

function at(state: CombatState, cursor: number): CombatState {
    return { ...state, rngSeed: SEED, rngCursor: cursor };
}

function attackBoth(state: CombatState, actorId: string, targetId: string) {
    const wrapper = applyAction(state, { type: 'attack', actorId, targetId });
    const aim = state.combatants[targetId].position as Pos;
    const explicit = applyAction(state, { type: 'use_ability', actorId, abilityId: BUILTIN_ATTACK_ID, aim: { ...aim } });
    return { wrapper, explicit };
}

function defendBoth(state: CombatState, actorId: string) {
    const wrapper = applyAction(state, { type: 'defend', actorId });
    const explicit = applyAction(state, { type: 'use_ability', actorId, abilityId: BUILTIN_DEFEND_ID, aim: null });
    return { wrapper, explicit };
}

function attackEvent(events: CombatEvent[]): CombatEvent {
    const found = events.find(e => e.type === 'attack');
    if (!found) throw new Error(`no attack event in ${events.map(e => e.type).join(',')}`);
    return found;
}

function same(pair: ReturnType<typeof attackBoth>): CombatEvent {
    expect(pair.wrapper.events.some(e => e.type === 'rejected')).toBe(false);
    expect(pair.explicit.events).toEqual(pair.wrapper.events);
    expect(pair.explicit.state).toEqual(pair.wrapper.state);
    expect(pair.wrapper.events.some(e => e.type === 'ability' || e.type === 'ability_attack' || e.type === 'ability_damage')).toBe(false);
    return attackEvent(pair.wrapper.events);
}

const melee = (overrides: Partial<Combatant> = {}) => caster([STARTER_ABILITIES[0]], { x: 2, y: 2 }, overrides);

describe('built-in attack and defend (5B-1)', () => {
    it('a melee attack resolves identically as the wrapper and as builtin:attack, and costs no MP', () => {
        const s = at(arena([melee(), foe('f', { x: 3, y: 2 })]), cursorFor(SEED, r => r[0] >= 12 && r[0] < 20, 1));
        const ev = same(attackBoth(s, 'pc', 'f'));
        expect(ev.data).toMatchObject({ hit: true, crit: false, range: 'close', cover: 0, disadvantage: false });
        expect(attackBoth(s, 'pc', 'f').wrapper.state.combatants.pc.mp).toBe(s.combatants.pc.mp);
        expect(attackBoth(s, 'pc', 'f').wrapper.state.combatants.pc.cooldowns).toBeUndefined();
    });

    it('a ranged attack, a miss, a critical hit, a reach weapon and an attack into cover match', () => {
        const ranged = (extra: Partial<Combatant> = {}) => melee({ range: 'ranged', ...extra });
        const far = arena([ranged(), foe('f', { x: 8, y: 2 })]);
        const r = same(attackBoth(at(far, cursorFor(SEED, x => x[0] >= 10 && x[0] < 20, 1)), 'pc', 'f'));
        expect(r.data.range).toBe('ranged');

        const miss = same(attackBoth(at(far, cursorFor(SEED, x => x[0] === 1, 1)), 'pc', 'f'));
        expect(miss.data).toMatchObject({ hit: false, fumble: true });

        const crit = same(attackBoth(at(far, cursorFor(SEED, x => x[0] === 20, 1)), 'pc', 'f'));
        expect(crit.data).toMatchObject({ hit: true, crit: true });

        const reach = arena([melee({ range: 'reach', weaponName: 'Glaive' }), foe('f', { x: 4, y: 2 })]);
        const glaive = same(attackBoth(at(reach, cursorFor(SEED, x => x[0] >= 15, 1)), 'pc', 'f'));
        expect(glaive.data).toMatchObject({ range: 'reach', weapon: 'Glaive' });

        const covered = arena([ranged(), foe('f', { x: 8, y: 2 })], { grid: openGrid(16, 12, [], [[{ x: 5, y: 2 }, 'cover']]) });
        const behind = same(attackBoth(at(covered, cursorFor(SEED, x => x[0] >= 10, 1)), 'pc', 'f'));
        expect(behind.data.cover).toBeGreaterThan(0);

        const crowded = arena([ranged(), foe('f', { x: 8, y: 2 }), foe('g', { x: 3, y: 2 })]);
        const point = same(attackBoth(at(crowded, cursorFor(SEED, x => x[0] >= 10, 2)), 'pc', 'f'));
        expect(point.data).toMatchObject({ adjacentShot: true, disadvantage: true });
    });

    it('an attack against a defending target and a killing blow match', () => {
        const guarded = arena([melee(), foe('f', { x: 3, y: 2 }, { conditions: [{ id: 'defending', rounds: 1 }] })]);
        const d = same(attackBoth(at(guarded, cursorFor(SEED, x => x[0] >= 10 && x[1] >= 10, 2)), 'pc', 'f'));
        expect(d.data).toMatchObject({ defending: true, disadvantage: true });

        const frail = arena([melee(), foe('f', { x: 3, y: 2 }, { hp: 1 })]);
        const pair = attackBoth(at(frail, cursorFor(SEED, x => x[0] >= 15, 1)), 'pc', 'f');
        same(pair);
        expect(pair.wrapper.events.map(e => e.type)).toEqual(['attack', 'down', 'combat_ended']);
        expect(pair.wrapper.state.outcome).toBe('victory');
    });

    it('an enemy without MP attacks through the pipeline without gaining a cooldown', () => {
        const s = at(arena([foe('f', { x: 3, y: 2 }), melee()]), cursorFor(SEED, x => x[0] >= 5, 1));
        const ev = same(attackBoth(s, 'f', 'pc'));
        expect(ev.actorId).toBe('f');
        expect(attackBoth(s, 'f', 'pc').wrapper.state.combatants.f.cooldowns).toBeUndefined();
    });

    it('the attack spends a haste extra action exactly as before', () => {
        const base = arena([melee(), foe('f', { x: 3, y: 2 })]);
        const s = { ...base, turn: { ...(base.turn as NonNullable<CombatState['turn']>), actionUsed: true, extraActions: 1 } };
        const pair = attackBoth(at(s, 0), 'pc', 'f');
        same(pair);
        expect(pair.wrapper.state.turn).toMatchObject({ actionUsed: true, extraActions: 0 });
    });

    it('defend resolves identically as the wrapper and as builtin:defend', () => {
        const s = arena([melee(), foe('f', { x: 9, y: 2 })]);
        const { wrapper, explicit } = defendBoth(s, 'pc');
        expect(explicit.events).toEqual(wrapper.events);
        expect(explicit.state).toEqual(wrapper.state);
        expect(wrapper.events[0]).toMatchObject({ type: 'defend', actorId: 'pc', data: {}, text: 'Kira takes a defensive stance.' });
        expect(wrapper.state.combatants.pc.conditions).toEqual([{ id: 'defending', rounds: 1 }]);
        expect(wrapper.state.rngCursor).toBe(s.rngCursor);
    });

    it('built-ins come first, follow the weapon, cost nothing and are never in a kit', () => {
        const s = arena([melee(), foe('f', { x: 3, y: 2 })]);
        expect(availableAbilities(s, 'pc').map(a => a.id)).toEqual([
            BUILTIN_ATTACK_ID, BUILTIN_DEFEND_ID, 'builtin:dash', 'builtin:shove', 'builtin:jump', 'builtin:throw', 'builtin:help', STARTER_ABILITIES[0].id,
        ]);
        expect(builtinAttack({ range: 'ranged' }).form.id).toBe('projectile');
        expect(builtinAttack({ range: 'reach' }).form.id).toBe('touch');
        expect(builtinAttack({}).form.id).toBe('touch');
        expect(abilityCost(builtinAttack({ range: 'ranged' }))).toBe(0);
        expect(abilityCost(builtinDefend())).toBe(0);
        expect(s.combatants.pc.kit?.some(a => a.id.startsWith('builtin:'))).toBe(false);
        const pc = s.combatants.pc;
        expect(describeAbility(builtinAttack(pc), { proficiency: 2, castingMod: 3 }, pc)).toBe(
            `Touch, one target at 1 square. Attack roll +${pc.attackBonus}; on a hit the target takes 1d6 ${pc.damage.type} damage, doubled dice on a critical hit. No MP.`,
        );
        expect(describeAbility(builtinDefend())).toContain('The user takes a defensive stance');
    });

    it('checkAbility and legalAims treat built-ins like any ability', () => {
        const s = arena([melee(), foe('f', { x: 3, y: 2 }), foe('g', { x: 9, y: 9 })]);
        expect(checkAbility(s, 'pc', BUILTIN_ATTACK_ID).ok).toBe(true);
        expect(legalAims(s, 'pc', builtinAttack(s.combatants.pc))).toEqual([{ x: 3, y: 2 }]);
        expect(checkAbility(s, 'pc', BUILTIN_ATTACK_ID, { x: 9, y: 9 }).reason).toBe('out of range');
        const used = { ...s, turn: { ...(s.turn as NonNullable<CombatState['turn']>), actionUsed: true } };
        expect(checkAbility(used, 'pc', BUILTIN_DEFEND_ID).reason).toBe('the action is already used');
        expect(applyAction(used, { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_DEFEND_ID }).events[0].type).toBe('rejected');
    });

    it('built-in-only glyphs and ids fail validation, stay out of the palette and out of the ability shape', () => {
        expect(validateAbility(glyph('touch', ['weapon']))).toContain('the weapon glyph is reserved for built-in actions');
        expect(validateAbility(glyph('self', ['guard']))).toContain('the guard glyph is reserved for built-in actions');
        expect(validateAbility(glyph('touch', ['damage', 'weapon'])).length).toBeGreaterThan(0);
        expect(validateAbility(glyph('touch', ['damage'], [], { id: BUILTIN_ATTACK_ID }))).toContain('built-in actions cannot be built, changed or stored');
        expect(validateAbility(builtinAttack({})).length).toBeGreaterThan(0);
        expect(validateAbility(builtinDefend()).length).toBeGreaterThan(0);
        for (const id of BUILTIN_EFFECT_IDS) {
            expect(EFFECT_IDS).not.toContain(id);
            expect(allGlyphs('effect').map(g => g.id)).not.toContain(id);
        }
        expect(isGlyphAbilityShape(glyph('touch', ['weapon']))).toBe(false);
        const kitted = arena([melee({ kit: [glyph('touch', ['weapon'], [], { id: 'sneaky' })] }), foe('f', { x: 3, y: 2 })]);
        expect(checkAbility(kitted, 'pc', 'sneaky').reason).toBe('the ability is not valid');
    });
});

function fnv(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function fixtureStart(): CombatState {
    const sheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };
    const pc = buildPcCombatant({
        name: 'Kira', sheet,
        weapon: { name: 'Glaive', quality: 'uncommon', scalingStat: 'STR', damageType: 'slashing', range: 'reach' },
        kit: STARTER_ABILITIES.filter(a => a.id === 'fire-bolt'),
    });
    return createCombat({
        id: 'fixture',
        combatants: [
            { name: 'Hexer', side: 'enemy', tier: 'grunt', archetype: 'caster' },
            { name: 'Thug', side: 'enemy', tier: 'elite' },
            { name: 'Brute', side: 'enemy', tier: 'grunt', range: 'ranged' },
            { name: 'Bram', side: 'ally', tier: 'grunt' },
        ],
        map: { size: 'small', area: 'scattered', density: 'normal' },
        partyControl: 'player',
    }, pc, 4242).state;
}

function fixtureStep(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    const id = currentActorId(state) as string;
    const actor = state.combatants[id];
    if (actor.controller === 'engine' || actor.status !== 'up') return stepEngine(state) ?? applyAction(state, { type: 'end_turn', actorId: id });
    const turn = currentTurn(state) as NonNullable<ReturnType<typeof currentTurn>>;
    const choice = chooseEngineTurn(state, id);
    let action: CombatAction = choice.actions[0] ?? { type: 'end_turn', actorId: id };
    if (!turn.actionUsed && actor.hp * 2 < actor.maxHp && action.type !== 'move') action = { type: 'defend', actorId: id };
    const r = applyAction(choice.state, action);
    return r.events.some(e => e.type === 'rejected') ? applyAction(choice.state, { type: 'end_turn', actorId: id }) : r;
}

describe('a fight saved before 5B-1 (5B-1)', () => {
    it('loads mid-fight and continues exactly as the pre-change engine did', () => {
        let state = fixtureStart();
        let step = 0;
        for (; step < 3000 && !state.outcome && state.round < 3; step++) state = fixtureStep(state).state;
        expect(step).toBe(21);
        expect(fnv(JSON.stringify(state))).toBe('3a8b1edc');
        let loaded = JSON.parse(JSON.stringify(state)) as CombatState;
        const events: CombatEvent[] = [];
        for (let i = 0; i < 3000 && !loaded.outcome; i++) {
            const next = fixtureStep(loaded);
            events.push(...next.events);
            loaded = next.state;
        }
        expect(events.some(e => e.type === 'defend')).toBe(true);
        expect(events.some(e => e.type === 'attack')).toBe(true);
        expect(fnv(JSON.stringify(events) + JSON.stringify(loaded))).toBe('c25822bf');
    });
});
