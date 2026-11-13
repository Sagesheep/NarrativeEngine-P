import { describe, it, expect } from 'vitest';
import {
    applyAction, buildPcCombatant, checkAbility, checkOutcome, chooseEngineTurn, createCombat, currentActorId, currentTurn,
    ensureGrid, enemyKit, HASTED, runEngineTurns, stepEngine, SHIELDED, SLOWED, STUNNED, STARTER_ABILITIES, TIER_TABLE,
} from '../index';
import type { CombatEvent, CombatState, Combatant, GlyphAbility, Pos } from '../index';
import { arena, caster, casterSheet, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const cast = (s: CombatState, abilityId: string, aim: Pos | null = null, actorId = 'pc') =>
    applyAction(s, { type: 'use_ability', actorId, abilityId, aim });
const endTurn = (s: CombatState) => applyAction(s, { type: 'end_turn', actorId: currentActorId(s) as string }).state;
const of = (events: CombatEvent[], type: string) => events.filter(e => e.type === type);
const noOne = (seed = 7) => cursorFor(seed, r => r[0] !== 1 && r[0] !== 20, 1);

function playOut(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let current = state;
    const events: CombatEvent[] = [];
    const engine = runEngineTurns(current);
    current = engine.state;
    events.push(...engine.events);
    for (let i = 0; i < 500 && !current.outcome; i++) {
        const actorId = currentActorId(current)!;
        const choice = chooseEngineTurn(current, actorId);
        let step = applyAction(choice.state, choice.actions[0]);
        if (step.events.some(e => e.type === 'rejected')) step = applyAction(choice.state, { type: 'end_turn', actorId });
        current = step.state;
        events.push(...step.events);
        const more = runEngineTurns(current);
        current = more.state;
        events.push(...more.events);
    }
    return { state: current, events };
}

describe('use_ability: cost, slots and refusals', () => {
    const bolt = glyph('projectile', ['damage'], [], { id: 'bolt' });

    it('spends MP and the action, and logs an ability event with engine text', () => {
        const s = arena([caster([bolt], { x: 1, y: 5 }), foe('f', { x: 6, y: 5 })], { rngCursor: noOne() });
        expect(s.combatants.pc.mp).toBe(16);
        const r = cast(s, 'bolt', { x: 6, y: 5 });
        expect(r.events[0]).toMatchObject({ type: 'ability', actorId: 'pc', data: { name: 'Test', cost: 2, slot: 'action', mpAfter: 14 } });
        expect(r.events[0].text).toBe('Kira uses Test (2 MP).');
        expect(r.state.combatants.pc.mp).toBe(14);
        expect(r.state.turn).toMatchObject({ actionUsed: true });
        expect(r.events.every(e => typeof e.text === 'string' && e.text.length > 0)).toBe(true);
    });

    it('refuses with a reason: unknown ability, not enough MP, action used, no legal aim', () => {
        const s = arena([caster([bolt], { x: 1, y: 5 }), foe('f', { x: 6, y: 5 })]);
        const reason = (r: { events: CombatEvent[] }) => r.events[0].type === 'rejected' ? r.events[0].data.reason : null;
        expect(reason(cast(s, 'nope', { x: 6, y: 5 }))).toBe('unknown ability');
        const poor = { ...s, combatants: { ...s.combatants, pc: { ...s.combatants.pc, mp: 1 } } };
        expect(reason(cast(poor, 'bolt', { x: 6, y: 5 }))).toBe('not enough MP');
        expect(checkAbility(poor, 'pc', 'bolt').reason).toBe('not enough MP');
        const spent = { ...s, turn: { ...s.turn!, actionUsed: true } };
        expect(reason(cast(spent, 'bolt', { x: 6, y: 5 }))).toBe('the action is already used');
        expect(reason(cast(s, 'bolt', { x: 3, y: 3 }))).toBe('no target there');
        const hidden = { ...s, grid: openGrid(16, 12, [{ x: 0, y: 4 }, { x: 0, y: 6 }, { x: 1, y: 4 }, { x: 1, y: 6 }, { x: 2, y: 4 }, { x: 2, y: 5 }, { x: 2, y: 6 }]) };
        expect(checkAbility(hidden, 'pc', 'bolt').reason).toBe('no target');
        expect(cast(s, 'bolt', { x: 3, y: 3 }).state).toBe(s);
    });
});

describe('attack-roll forms', () => {
    const touch = glyph('touch', ['damage'], [], { id: 't', damageType: 'fire' });

    it('a hit deals p d6 of the damage type; a miss applies nothing', () => {
        const hit = cast(arena([caster([touch], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 0 })], { rngCursor: noOne() }), 't', { x: 6, y: 5 });
        const dmg = of(hit.events, 'ability_damage')[0];
        expect(of(hit.events, 'ability_attack')[0].data).toMatchObject({ hit: true, total: expect.any(Number) });
        expect(dmg.data).toMatchObject({ damageType: 'fire', saved: false });
        expect(dmg.data.damage as number).toBeGreaterThanOrEqual(2);
        expect(dmg.data.damage as number).toBeLessThanOrEqual(12);
        expect(hit.state.combatants.f.hp).toBe(30 - (dmg.data.damage as number));
        const miss = cast(arena([caster([touch], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 99 })], { rngCursor: noOne() }), 't', { x: 6, y: 5 });
        expect(of(miss.events, 'ability_attack')[0].data.hit).toBe(false);
        expect(of(miss.events, 'ability_damage')).toHaveLength(0);
        expect(miss.state.combatants.f.hp).toBe(30);
    });

    it('a natural 20 doubles the dice and a natural 1 misses', () => {
        const crit = cast(arena([caster([touch], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 99, hp: 99, maxHp: 99 })], { rngCursor: cursorFor(7, r => r[0] === 20, 1) }), 't', { x: 6, y: 5 });
        expect(of(crit.events, 'ability_attack')[0].data).toMatchObject({ hit: true, crit: true });
        expect(of(crit.events, 'ability_damage')[0].data.damage as number).toBeGreaterThanOrEqual(4);
        const fumble = cast(arena([caster([touch], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: -99 })], { rngCursor: cursorFor(7, r => r[0] === 1, 1) }), 't', { x: 6, y: 5 });
        expect(of(fumble.events, 'ability_attack')[0].data.hit).toBe(false);
    });

    it('helpful effects on allies need no roll (R10)', () => {
        const mend = STARTER_ABILITIES.find(a => a.id === 'mend') as GlyphAbility;
        const ally = foe('ally', { x: 6, y: 5 }, { side: 'ally', hp: 5 });
        const r = cast(arena([caster([mend], { x: 5, y: 5 }), ally, foe('f', { x: 12, y: 5 })]), 'mend', { x: 6, y: 5 });
        expect(of(r.events, 'ability_attack')).toHaveLength(0);
        const heal = of(r.events, 'heal')[0];
        expect(heal.data.amount as number).toBeGreaterThanOrEqual(2 + 3);
        expect(r.state.combatants.ally.hp).toBe(5 + (heal.data.amount as number));
        const full = cast(arena([caster([mend], { x: 5, y: 5 }), { ...ally, hp: 29 }, foe('f', { x: 12, y: 5 })]), 'mend', { x: 6, y: 5 });
        expect(full.state.combatants.ally.hp).toBe(30);
    });

    it('weakness doubles, resistance halves, both cancel (R25)', () => {
        const run = (extra: Partial<Combatant>) => {
            const r = cast(arena([caster([touch], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 0, hp: 99, maxHp: 99, ...extra })], { rngCursor: noOne() }), 't', { x: 6, y: 5 });
            return of(r.events, 'ability_damage')[0].data;
        };
        const plain = run({}).damage as number;
        expect(run({ weaknesses: ['Fire'] })).toMatchObject({ damage: plain * 2, weakness: true });
        expect(run({ resistances: ['fire'] })).toMatchObject({ damage: Math.floor(plain / 2), resisted: true });
        expect(run({ weaknesses: ['fire'], resistances: ['fire'] }).damage).toBe(plain);
    });
});

describe('saving-throw forms', () => {
    const fireball = glyph('burst', ['damage'], [], { id: 'fb', damageType: 'fire' });

    it('fail takes full damage, success takes half, and area hits friend and foe', () => {
        const strong = caster([fireball], { x: 1, y: 1 }, { abilities: { ...casterSheet.abilities, INT: 30 } });
        const s = arena([strong, foe('weak', { x: 6, y: 6 }, { abilities: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 }, tier: 'minion' }),
            foe('nimble', { x: 7, y: 6 }, { abilities: { STR: 10, DEX: 99, CON: 10, INT: 10, WIS: 10, CHA: 10 } }),
            foe('pal', { x: 6, y: 7 }, { side: 'ally', abilities: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 }, tier: 'minion' })]);
        const r = cast(s, 'fb', { x: 6, y: 6 });
        const saves = Object.fromEntries(of(r.events, 'save').map(e => [e.targetId, e.data.success]));
        expect(saves).toEqual({ weak: false, nimble: true, pal: false });
        const dmg = Object.fromEntries(of(r.events, 'ability_damage').map(e => [e.targetId, e.data]));
        expect(dmg.weak.saved).toBe(false);
        expect(dmg.nimble?.saved ?? true).toBe(true);
        expect(r.state.combatants.pal.hp).toBeLessThan(30);
        expect(of(r.events, 'save')[0].data.dc).toBe(8 + 2 + 10);
    });

    it('a failed CON save stuns, a success negates (R9: one roll per save ability)', () => {
        const a = glyph('burst', ['damage', 'stun'], [], { id: 'storm' });
        const strong = caster([a], { x: 1, y: 1 }, { abilities: { ...casterSheet.abilities, INT: 30 } });
        const r = cast(arena([strong, foe('weak', { x: 6, y: 6 }, { abilities: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 }, tier: 'minion' })]), 'storm', { x: 6, y: 6 });
        expect(of(r.events, 'save').map(e => e.data.save)).toEqual(['DEX', 'CON']);
        expect(r.state.combatants.weak.conditions.some(c => c.id === STUNNED)).toBe(true);
        const tough = cast(arena([caster([a], { x: 1, y: 1 }), foe('t', { x: 6, y: 6 }, { abilities: { STR: 1, DEX: 99, CON: 99, INT: 1, WIS: 1, CHA: 1 } })]), 'storm', { x: 6, y: 6 });
        expect(tough.state.combatants.t.conditions).toEqual([]);
    });

    it('applies the tier save bonus to engine combatants and proficiency to the PC (C5)', async () => {
        const { saveModifier } = await import('../index');
        const boss = foe('b', { x: 0, y: 0 }, { tier: 'boss' });
        expect(saveModifier(boss, 'DEX')).toBe(0 + TIER_TABLE.boss.save);
        const pc = caster([], { x: 0, y: 0 });
        expect(saveModifier(pc, 'CON')).toBe(2 + 2);
        expect(saveModifier(pc, 'INT')).toBe(3 + 2);
        expect(saveModifier(pc, 'DEX')).toBe(2);
    });
});

describe('effects', () => {
    it('shield absorbs first, the higher value replaces the lower (R24), and expires after 3 of the target\'s turns', () => {
        const shield = glyph('self', ['shield'], [], { id: 'sh' });
        let s = arena([caster([shield], { x: 2, y: 2 }), foe('f', { x: 12, y: 8 })]);
        const r = cast(s, 'sh');
        expect(r.state.combatants.pc.tempHp).toBe(2 * 2 + 3);
        expect(r.state.combatants.pc.conditions.find(c => c.id === SHIELDED)).toMatchObject({ turns: 3 });
        s = r.state;
        for (let i = 0; i < 3; i++) {
            s = endTurn(s);
            s = endTurn(s);
            expect(s.combatants.pc.tempHp).toBe(7);
        }
        s = endTurn(s);
        expect(s.combatants.pc.tempHp).toBeUndefined();
    });

    it('absorbs weapon damage before HP', () => {
        const s = arena([foe('f', { x: 3, y: 2 }, { attackBonus: 50, damage: { count: 1, sides: 1, bonus: 9, type: 'slashing' } }), caster([], { x: 2, y: 2 }, { tempHp: 7, conditions: [{ id: SHIELDED, turns: 3 }] })], { rngCursor: noOne() });
        const r = applyAction(s, { type: 'attack', actorId: 'f', targetId: 'pc' });
        expect(r.events[0].data).toMatchObject({ damage: 10, absorbed: 7 });
        expect(r.state.combatants.pc.hp).toBe(s.combatants.pc.hp - 3);
        expect(r.state.combatants.pc.tempHp).toBeUndefined();
    });

    it('push moves 2 squares directly away and stops at walls; pull moves toward the user (R5)', () => {
        const push = glyph('touch', ['push'], [], { id: 'p' });
        const pull = glyph('projectile', ['pull'], [], { id: 'q' });
        const pushed = cast(arena([caster([push], { x: 5, y: 5 }), foe('f', { x: 6, y: 6 }, { ac: 0 })], { rngCursor: noOne() }), 'p', { x: 6, y: 6 });
        expect(pushed.state.combatants.f.position).toEqual({ x: 8, y: 8 });
        expect(of(pushed.events, 'pushed')[0].data.moves).toEqual([{ id: 'f', from: { x: 6, y: 6 }, to: { x: 8, y: 8 } }]);
        const walled = cast(arena([caster([push], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 0 })], { rngCursor: noOne(), grid: openGrid(16, 12, [{ x: 8, y: 5 }]) }), 'p', { x: 6, y: 5 });
        expect(walled.state.combatants.f.position).toEqual({ x: 7, y: 5 });
        const pulled = cast(arena([caster([pull], { x: 2, y: 5 }), foe('f', { x: 8, y: 5 }, { ac: 0 })], { rngCursor: noOne() }), 'q', { x: 8, y: 5 });
        expect(pulled.state.combatants.f.position).toEqual({ x: 6, y: 5 });
        const amp = cast(arena([caster([glyph('touch', [['push', ['amplify']]], [], { id: 'p' })], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: 0 })], { rngCursor: noOne() }), 'p', { x: 6, y: 5 });
        expect(amp.state.combatants.f.position).toEqual({ x: 9, y: 5 });
    });

    it('stun loses the next turn, counts as its turn and cannot be reapplied until it acts (R23)', () => {
        const stun = glyph('touch', ['stun'], [], { id: 'st' });
        let s = arena([caster([stun], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: -99 })], { rngCursor: noOne() });
        let r = cast(s, 'st', { x: 6, y: 5 });
        expect(r.state.combatants.f.conditions).toMatchObject([{ id: STUNNED, turns: 1 }]);
        const before = r.state.turnCount as number;
        r = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
        expect(r.events.map(e => e.type)).toEqual(['end_turn', 'turn_lost', 'condition_ended', 'round']);
        expect(r.state.turnCount).toBe(before + 2);
        expect(currentActorId(r.state)).toBe('pc');
        expect(r.state.combatants.f.stunGuard).toBe(true);
        s = { ...r.state, rngCursor: noOne(r.state.rngSeed) };
        r = cast(s, 'st', { x: 6, y: 5 });
        expect(of(r.events, 'unaffected')).toHaveLength(1);
        expect(r.state.combatants.f.conditions).toEqual([]);
        s = endTurn(r.state);
        expect(currentActorId(s)).toBe('f');
        s = endTurn(s);
        expect(s.combatants.f.stunGuard).toBeUndefined();
    });

    it('bosses and legendaries are slowed instead of stunned', () => {
        const stun = glyph('touch', [['stun', ['extend']]], [], { id: 'st' });
        const r = cast(arena([caster([stun], { x: 5, y: 5 }), foe('b', { x: 6, y: 5 }, { ac: -99, tier: 'boss' })], { rngCursor: noOne() }), 'st', { x: 6, y: 5 });
        expect(r.state.combatants.b.conditions).toMatchObject([{ id: SLOWED, turns: 2 }]);
    });

    it('slow halves speed and gives disadvantage on attacks for 2 of the target\'s turns', () => {
        const slow = glyph('touch', ['slow'], [], { id: 'sl' });
        const r = cast(arena([caster([slow], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: -99 })], { rngCursor: noOne() }), 'sl', { x: 6, y: 5 });
        let s = endTurn(r.state);
        expect(currentTurn(s)).toMatchObject({ actorId: 'f', moveLeft: 3 });
        const attack = applyAction(s, { type: 'attack', actorId: 'f', targetId: 'pc' });
        expect(attack.events[0].data.disadvantage).toBe(true);
        s = endTurn(s);
        s = endTurn(s);
        expect(s.combatants.f.conditions.find(c => c.id === SLOWED)?.turns).toBe(1);
        s = endTurn(s);
        expect(s.combatants.f.conditions).toEqual([]);
    });

    it('self haste takes effect at once and lasts 2 more of the user\'s turns; its extra action only attacks or defends (C3, R11, R12)', () => {
        const haste = STARTER_ABILITIES.find(a => a.id === 'haste') as GlyphAbility;
        const bolt = glyph('projectile', ['damage'], [], { id: 'bolt' });
        let s = arena([caster([haste, bolt], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { hp: 99, maxHp: 99 })]);
        let r = cast(s, 'haste');
        expect(r.state.turn).toMatchObject({ actionUsed: true, extraActions: 1, moveLeft: 12 });
        expect(cast(r.state, 'bolt', { x: 6, y: 5 }).events[0].data.reason).toBe('the action is already used');
        r = applyAction(r.state, { type: 'attack', actorId: 'pc', targetId: 'f' });
        expect(r.events[0].type).toBe('attack');
        expect(r.state.turn?.extraActions).toBe(0);
        s = endTurn(r.state);
        s = endTurn(s);
        expect(currentTurn(s)).toMatchObject({ actorId: 'pc', moveLeft: 12, extraActions: 1 });
        s = endTurn(endTurn(s));
        expect(s.combatants.pc.conditions.some(c => c.id === HASTED)).toBe(true);
        s = endTurn(s);
        expect(s.combatants.pc.conditions.some(c => c.id === HASTED)).toBe(false);
    });

    it('blink teleports the user and swap trades places', () => {
        const blink = glyph('self', ['blink', 'shield'], [], { id: 'bl' });
        const r = cast(arena([caster([blink], { x: 2, y: 2 }), foe('f', { x: 12, y: 8 })]), 'bl', { x: 7, y: 3 });
        expect(r.state.combatants.pc.position).toEqual({ x: 7, y: 3 });
        expect(r.state.combatants.pc.tempHp).toBe(7);
        const swap = glyph('projectile', ['swap'], [], { id: 'sw' });
        const ally = foe('a', { x: 9, y: 2 }, { side: 'ally' });
        const sw = cast(arena([caster([swap], { x: 2, y: 2 }), ally, foe('f', { x: 12, y: 8 })]), 'sw', { x: 9, y: 2 });
        expect(sw.state.combatants.pc.position).toEqual({ x: 9, y: 2 });
        expect(sw.state.combatants.a.position).toEqual({ x: 2, y: 2 });
        expect(of(sw.events, 'save')).toHaveLength(0);
    });

    it('drain heals the user half the damage dealt, up to max HP (R18)', () => {
        const drain = glyph('touch', ['drain'], [], { id: 'dr' });
        const r = cast(arena([caster([drain], { x: 5, y: 5 }, { hp: 1 }), foe('f', { x: 6, y: 5 }, { ac: -99 })], { rngCursor: noOne() }), 'dr', { x: 6, y: 5 });
        const dealt = of(r.events, 'ability_damage')[0].data.damage as number;
        expect(r.state.combatants.pc.hp).toBe(1 + Math.floor(dealt / 2));
    });

    it('a barrier blocks for 3 rounds and then fades', () => {
        const wall = glyph('line', ['barrier'], [], { id: 'w' });
        let s = arena([caster([wall], { x: 2, y: 5 }), foe('f', { x: 12, y: 5 })]);
        const r = cast(s, 'w', { x: 9, y: 5 });
        expect(r.state.barriers).toHaveLength(4);
        expect(r.state.barriers![0]).toMatchObject({ expiresRound: 4 });
        s = r.state;
        while (s.round < 4) s = endTurn(s);
        expect(s.barriers).toEqual([]);
        expect(s.grid!.tiles.every(t => t === 'floor')).toBe(true);
    });
});

describe('summons', () => {
    const aqua = STARTER_ABILITIES.find(a => a.id === 'aqua-elemental') as GlyphAbility;

    it('join the order after the summoner, act under the engine, and vanish when their time ends', () => {
        let s = arena([caster([aqua], { x: 5, y: 5 }), foe('f', { x: 14, y: 10 })]);
        const r = cast(s, 'aqua-elemental', { x: 6, y: 5 });
        const summon = of(r.events, 'summoned')[0];
        const id = summon.targetId as string;
        expect(r.state.order).toEqual(['pc', id, 'f']);
        expect(r.state.combatants[id]).toMatchObject({ name: 'Aqua elemental', side: 'ally', controller: 'engine', tier: 'minion', summonerId: 'pc', expiresRound: 5, damage: { type: 'water' } });
        s = endTurn(r.state);
        expect(currentActorId(s)).toBe(id);
        s = runEngineTurns(s).state;
        while (s.round < 5 && !s.outcome) s = runEngineTurns(endTurn(s)).state;
        expect(s.combatants[id].status).toBe('gone');
        expect(s.order).toContain(id);
    });

    it('numbers same-named summons and dismisses the oldest above the cap', () => {
        let s = arena([caster([aqua], { x: 5, y: 5 }), foe('f', { x: 14, y: 10 })], { maxSummons: 1 });
        s = cast(s, 'aqua-elemental', { x: 6, y: 5 }).state;
        s = endTurn(endTurn(endTurn(s)));
        const r = cast(s, 'aqua-elemental', { x: 4, y: 5 });
        const names = Object.values(r.state.combatants).filter(c => c.summonerId).map(c => [c.name, c.status]);
        expect(names).toEqual([['Aqua elemental', 'gone'], ['Aqua elemental 2', 'up']]);
        expect(of(r.events, 'dismissed')[0].data.cause).toBe('replaced');
    });

    it('vanish when the summoner goes down and never decide the fight (C7)', () => {
        let s = arena([caster([aqua], { x: 5, y: 5 }, { hp: 1 }), foe('f', { x: 6, y: 5 }, { attackBonus: 99, damage: { count: 1, sides: 1, bonus: 5, type: 'x' } })], { rngCursor: noOne() });
        s = cast(s, 'aqua-elemental', { x: 5, y: 4 }).state;
        s = endTurn(endTurn(s));
        expect(currentActorId(s)).toBe('f');
        const r = applyAction({ ...s, rngCursor: noOne(s.rngSeed) }, { type: 'attack', actorId: 'f', targetId: 'pc' });
        expect(r.events.map(e => e.type)).toEqual(['attack', 'down', 'dismissed', 'combat_ended']);
        expect(r.state.outcome).toBe('defeat');
        const enemySummon = { ...s.combatants.f, id: 'es', summonerId: 'f', side: 'enemy' as const };
        const won = { ...s, combatants: { ...s.combatants, es: enemySummon, f: { ...s.combatants.f, status: 'down' as const } } };
        expect(checkOutcome(won)).toBe('victory');
    });
});

describe('bonus action (C4)', () => {
    it('the turn does not auto-end while a quickened ability is usable', () => {
        const quick = glyph('touch', ['damage'], ['quicken'], { id: 'qk' });
        const s = arena([caster([quick], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: -99, hp: 99, maxHp: 99 })], { rngCursor: noOne() });
        const still = { ...s, turn: { ...s.turn!, moveLeft: 0 } };
        const attacked = applyAction(still, { type: 'attack', actorId: 'pc', targetId: 'f' });
        expect(currentActorId(attacked.state)).toBe('pc');
        const bonus = cast({ ...attacked.state, rngCursor: noOne(attacked.state.rngSeed) }, 'qk', { x: 6, y: 5 });
        expect(bonus.events[0].data.slot).toBe('bonus');
        expect(currentActorId(bonus.state)).toBe('f');
        const plain = arena([caster([], { x: 5, y: 5 }), foe('f', { x: 6, y: 5 }, { ac: -99, hp: 99, maxHp: 99 })], { rngCursor: noOne() });
        expect(currentActorId(applyAction({ ...plain, turn: { ...plain.turn!, moveLeft: 0 } }, { type: 'attack', actorId: 'pc', targetId: 'f' }).state)).toBe('f');
    });
});

describe('enemy casters (D5, C6)', () => {
    function casterFoe(id: string, pos: Pos, tier: Combatant['tier']): Combatant {
        return foe(id, pos, {
            tier, archetype: 'caster', range: 'ranged', kit: enemyKit(tier, 'caster', 'fire'),
            proficiency: 3, castingAbility: 'INT', abilityDamage: { ...TIER_TABLE[tier].damage },
        });
    }

    it('createCombat gives caster enemies their kit and tier dice', () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet: casterSheet });
        const { state } = createCombat({ id: 'k', combatants: [{ name: 'Witch', side: 'enemy', tier: 'elite', archetype: 'caster', look: 'fire witch' }, { name: 'Thug', side: 'enemy', tier: 'grunt' }] }, pc, 3);
        const witch = Object.values(state.combatants).find(c => c.name === 'Witch')!;
        expect(witch.kit!.map(a => a.name)).toEqual(['Fire bolt', 'Fire burst']);
        expect(witch.abilityDamage).toEqual(TIER_TABLE.elite.damage);
        expect(Object.values(state.combatants).find(c => c.name === 'Thug')!.kit).toBeUndefined();
    });

    it('bursts two hostiles with no allies caught, otherwise bolts, otherwise attacks; each ability recharges for 2 rounds', () => {
        const pc = caster([], { x: 10, y: 5 });
        const ally = foe('a', { x: 11, y: 5 }, { side: 'ally' });
        const s = arena([casterFoe('w', { x: 2, y: 5 }, 'elite'), pc, ally]);
        const burst = chooseEngineTurn(s, 'w').actions[0];
        expect(burst).toMatchObject({ type: 'use_ability', abilityId: 'kit-burst' });
        const lone = arena([casterFoe('w', { x: 2, y: 5 }, 'grunt'), caster([], { x: 10, y: 5 })]);
        const bolt = chooseEngineTurn(lone, 'w').actions[0];
        expect(bolt).toMatchObject({ type: 'use_ability', abilityId: 'kit-bolt', aim: { x: 10, y: 5 } });
        const after = applyAction(lone, bolt);
        const dmg = of(after.events, 'ability_damage')[0];
        if (dmg) expect(dmg.data.damage as number).toBeLessThanOrEqual(6);
        expect(after.state.combatants.w.cooldowns).toEqual({ 'kit-bolt': 3 });
        const later = { ...after.state, turnIndex: 0, turn: { actorId: 'w', moveLeft: 6, actionUsed: false } };
        expect(chooseEngineTurn(later, 'w').actions.some(a => a.type === 'use_ability')).toBe(false);
        expect(chooseEngineTurn({ ...later, round: 3 }, 'w').actions[0]).toMatchObject({ type: 'use_ability' });
    });
});

describe('reload safety', () => {
    it('ensureGrid never relocates a token sharing a square with a downed body (C9)', () => {
        const s = arena([caster([], { x: 3, y: 3 }), foe('dead', { x: 3, y: 3 }, { status: 'down', hp: 0 }), foe('f', { x: 9, y: 3 })]);
        const fixed = ensureGrid(s);
        expect(fixed.combatants.pc.position).toEqual({ x: 3, y: 3 });
        expect(fixed.combatants.dead.position).toEqual({ x: 3, y: 3 });
        const swapped = ensureGrid({ ...s, order: ['dead', 'pc', 'f'] });
        expect(swapped.combatants.pc.position).toEqual({ x: 3, y: 3 });
    });

    it('drops barriers outside the grid', () => {
        const s = arena([caster([], { x: 3, y: 3 }), foe('f', { x: 9, y: 3 })], { barriers: [{ pos: { x: 99, y: 0 }, expiresRound: 3, sourceId: 'pc' }, { pos: { x: 5, y: 5 }, expiresRound: 3, sourceId: 'pc' }] });
        expect(ensureGrid(s).barriers).toEqual([{ pos: { x: 5, y: 5 }, expiresRound: 3, sourceId: 'pc' }]);
    });

    it('a fight with haste, a barrier, a living summon and a stunned PC replays identically after save and restore (C16)', () => {
        const barrier = glyph('line', ['barrier'], ['quicken'], { id: 'wall' });
        const aqua = STARTER_ABILITIES.find(a => a.id === 'aqua-elemental') as GlyphAbility;
        const hasteSelf = glyph('self', ['haste'], [], { id: 'haste' });
        const stunQuick = glyph('touch', ['stun'], ['quicken'], { id: 'stun' });
        const witch = foe('w', { x: 6, y: 5 }, { kit: [hasteSelf, stunQuick], proficiency: 4, castingAbility: 'INT', abilities: { STR: 10, DEX: 10, CON: 10, INT: 18, WIS: 10, CHA: 10 } });
        let s = arena([caster([barrier, aqua], { x: 5, y: 5 }, { ac: -99 }), witch, foe('g', { x: 13, y: 9 })]);
        s = cast(s, 'wall', { x: 5, y: 1 }).state;
        s = cast(s, 'aqua-elemental', { x: 4, y: 5 }).state;
        s = endTurn(s);
        const summonId = s.order[1];
        for (let i = 0; i < 10 && currentActorId(s) === summonId; i++) s = stepEngine(s)!.state;
        expect(currentActorId(s)).toBe('w');
        s = cast(s, 'haste', null, 'w').state;
        s = cast(s, 'stun', { x: 5, y: 5 }, 'w').state;
        expect(s.combatants.pc.conditions.some(c => c.id === STUNNED)).toBe(true);
        expect(s.combatants.w.conditions.some(c => c.id === HASTED)).toBe(true);
        expect(s.barriers!.length).toBeGreaterThan(0);
        expect(s.combatants[summonId].status).toBe('up');
        const saved = JSON.parse(JSON.stringify(s)) as CombatState;
        const a = playOut(s);
        const b = playOut(saved);
        expect(b.events).toEqual(a.events);
        expect(b.state).toEqual(a.state);
        expect(a.events.some(e => e.type === 'turn_lost' && e.actorId === 'pc')).toBe(true);
        expect(a.state.outcome).not.toBeNull();
    });

    it('a stunned last-standing PC whose skipped turn ends the fight still settles the outcome (C16)', () => {
        const s = arena([foe('f', { x: 9, y: 3 }), caster([], { x: 3, y: 3 }, { hp: 1, conditions: [{ id: STUNNED, turns: 1 }] })], {
            grid: openGrid(16, 12, [], [[{ x: 3, y: 3 }, 'hazard']]),
        });
        const r = applyAction(s, { type: 'end_turn', actorId: 'f' });
        expect(r.events.map(e => e.type)).toEqual(['end_turn', 'turn_lost', 'condition_ended', 'hazard', 'down', 'combat_ended']);
        expect(r.state.outcome).toBe('defeat');
    });
});

describe('a golden fight with abilities', () => {
    it('plays a seeded caster fight deterministically and uses both spells', () => {
        const kit = STARTER_ABILITIES.filter(a => a.id === 'fire-bolt' || a.id === 'fireball');
        const pc = buildPcCombatant({ name: 'Kira', sheet: casterSheet, weapon: { quality: 'common' }, kit });
        const foes = [
            { name: 'Bandit 1', side: 'enemy' as const, tier: 'grunt' as const },
            { name: 'Bandit 2', side: 'enemy' as const, tier: 'grunt' as const },
            { name: 'Hexer', side: 'enemy' as const, tier: 'elite' as const, archetype: 'caster' as const, look: 'a frost hexer' },
        ];
        const start = createCombat({ id: 'gold', combatants: foes, mapSeed: 5 }, pc, 4321);
        const a = playOut(start.state);
        const b = playOut(JSON.parse(JSON.stringify(start.state)) as CombatState);
        expect(b.events).toEqual(a.events);
        expect(a.state.outcome).not.toBeNull();
        const used = new Set(a.events.filter(e => e.type === 'ability').map(e => e.data.name));
        expect(used.has('Fire bolt') || used.has('Fireball')).toBe(true);
        expect([...used].some(n => String(n).startsWith('Frost'))).toBe(true);
        expect(a.events.every(e => e.text.length > 0)).toBe(true);
    });
});

describe('the six starter presets in a fight (acceptance 3)', () => {
    const preset = (id: string) => STARTER_ABILITIES.find(a => a.id === id) as GlyphAbility;
    const setup = (id: string) => arena([
        caster([preset(id)], { x: 2, y: 5 }, { hp: 10 }),
        foe('a', { x: 3, y: 5 }, { ac: -99, hp: 60, maxHp: 60 }),
        foe('b', { x: 9, y: 5 }, { ac: -99, hp: 60, maxHp: 60, abilities: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 } }),
        foe('c', { x: 9, y: 6 }, { ac: -99, hp: 60, maxHp: 60, abilities: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 } }),
        foe('pal', { x: 2, y: 6 }, { side: 'ally', hp: 5 }),
    ], { rngCursor: noOne() });

    it('Fire bolt hits one target at range for fire damage', () => {
        const r = cast(setup('fire-bolt'), 'fire-bolt', { x: 9, y: 5 });
        expect(of(r.events, 'ability_damage').map(e => [e.targetId, e.data.damageType])).toEqual([['b', 'fire']]);
        expect(r.state.combatants.pc.mp).toBe(14);
    });

    it('Mend heals an adjacent ally', () => {
        const r = cast(setup('mend'), 'mend', { x: 2, y: 6 });
        expect(r.state.combatants.pal.hp).toBeGreaterThan(5);
    });

    it('Fireball catches everyone in the 3×3 area with a DEX save', () => {
        const r = cast(setup('fireball'), 'fireball', { x: 9, y: 5 });
        expect(of(r.events, 'save').map(e => e.targetId).sort()).toEqual(['b', 'c']);
        expect(of(r.events, 'ability_damage').every(e => e.data.damageType === 'fire')).toBe(true);
        expect(r.state.combatants.pc.mp).toBe(12);
    });

    it('Flash step dashes next to the target and strikes it', () => {
        const base = setup('flash-step');
        const s = { ...base, combatants: { ...base.combatants, pc: { ...base.combatants.pc, position: { x: 4, y: 5 } } } };
        const r = cast(s, 'flash-step', { x: 9, y: 5 });
        expect(r.events.map(e => e.type).slice(0, 3)).toEqual(['ability', 'teleported', 'ability_attack']);
        expect(r.state.combatants.pc.position).toEqual({ x: 8, y: 5 });
        expect(of(r.events, 'ability_damage')[0].targetId).toBe('b');
    });

    it('Haste speeds the user at once', () => {
        const r = cast(setup('haste'), 'haste');
        expect(r.state.turn).toMatchObject({ extraActions: 1, moveLeft: 12 });
    });

    it('Aqua elemental summons an allied minion for 4 rounds', () => {
        const r = cast(setup('aqua-elemental'), 'aqua-elemental', { x: 1, y: 5 });
        const summon = r.state.combatants[of(r.events, 'summoned')[0].targetId as string];
        expect(summon).toMatchObject({ side: 'ally', tier: 'minion', expiresRound: 5, position: { x: 1, y: 5 } });
    });
});
