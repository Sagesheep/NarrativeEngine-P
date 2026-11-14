import { describe, it, expect } from 'vitest';
import {
    AI_DASH, allGlyphs, applyAction, availableAbilities, BUILTIN_DASH_ID, chooseEngineTurn, BUILTIN_EFFECT_IDS, BUILTIN_HELP_ID, BUILTIN_JUMP_ID, BUILTIN_SHOVE_ID,
    BUILTIN_THROW_ID, builtinDash, builtinHelp, builtinJump, builtinShove, builtinThrow, casterStats, checkAbility, currentActorId,
    describeAbility, EFFECT_IDS, isGlyphAbilityShape, leapRange, legalAims, THROWN_WEAPON_NAME, throwProfile, validateAbility,
} from '../index';
import type { CombatEvent, CombatState, Combatant, DefeatMode, Pos, Tile } from '../index';
import { arena, caster, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const SEED = 7;

const at = (x: number, y: number): Pos => ({ x, y });

function seeded(state: CombatState, cursor: number): CombatState {
    return { ...state, rngSeed: SEED, rngCursor: cursor };
}

function act(state: CombatState, abilityId: string, aim: Pos | null = null, actorId = 'pc') {
    return applyAction(state, { type: 'use_ability', actorId, abilityId, aim });
}

const kinds = (events: CombatEvent[]) => events.map(e => e.type);

const strong = { STR: 16, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 };

const withTurn = (state: CombatState, patch: Partial<NonNullable<CombatState['turn']>>): CombatState => ({
    ...state,
    turn: { ...(state.turn as NonNullable<CombatState['turn']>), ...patch },
});

const gridWith = (tiles: Array<[Pos, Tile]>, walls: Pos[] = []) => openGrid(16, 12, walls, tiles);

const pc = (overrides: Partial<Combatant> = {}) => caster([], at(2, 2), overrides);

const failSave = cursorFor(SEED, r => r[0] <= 5, 1);
const passSave = cursorFor(SEED, r => r[0] >= 12, 1);

describe('built-in actions are chains through the one pipeline (5B-2)', () => {
    it('lists seven built-ins before the kit, all free, none stored, none valid as a player chain', () => {
        const s = arena([pc(), foe('f', at(9, 9))]);
        const ids = availableAbilities(s, 'pc').map(a => a.id);
        expect(ids.slice(0, 7)).toEqual(['builtin:attack', 'builtin:defend', BUILTIN_DASH_ID, BUILTIN_SHOVE_ID, BUILTIN_JUMP_ID, BUILTIN_THROW_ID, BUILTIN_HELP_ID]);
        for (const a of [builtinDash(), builtinShove(), builtinJump(), builtinThrow(), builtinHelp()]) {
            expect(validateAbility(a).length).toBeGreaterThan(0);
            expect(a.source).toBe('preset');
        }
        expect(s.combatants.pc.kit?.some(a => a.id.startsWith('builtin:'))).toBe(false);
    });

    it('defines each chain as a form and effects, with the slot in the profile', () => {
        const chain = (a: ReturnType<typeof builtinDash>) => `${a.form.id}+${a.effects.map(e => e.id).join('+')}`;
        expect(chain(builtinDash())).toBe('self+sprint');
        expect(chain(builtinShove())).toBe('touch+push');
        expect(chain(builtinJump())).toBe('self+leap');
        expect(chain(builtinThrow())).toBe('projectile+weapon');
        expect(chain(builtinHelp())).toBe('touch+rally');
        expect([builtinDash(), builtinShove(), builtinJump(), builtinThrow(), builtinHelp()].map(a => a.builtin?.slot)).toEqual(['action', 'bonus', 'bonus', 'action', 'action']);
        for (const a of [builtinDash(), builtinShove(), builtinJump(), builtinThrow(), builtinHelp()]) expect(a.builtin?.events).toBeUndefined();
    });

    it('keeps sprint, leap and rally out of the palette, the shape check and player chains', () => {
        for (const id of ['sprint', 'leap', 'rally'] as const) {
            expect(BUILTIN_EFFECT_IDS).toContain(id);
            expect(EFFECT_IDS).not.toContain(id);
            expect(allGlyphs('effect').map(g => g.id)).not.toContain(id);
            const form = id === 'rally' ? 'touch' : 'self';
            expect(validateAbility(glyph(form, [id]))).toContain(`the ${id} glyph is reserved for built-in actions`);
            expect(isGlyphAbilityShape(glyph(form, [id]))).toBe(false);
        }
        expect(validateAbility(glyph('touch', ['damage'], [], { id: BUILTIN_SHOVE_ID }))).toContain('built-in actions cannot be built, changed or stored');
    });

    it('describes the rules of each action', () => {
        const p = pc({ abilities: strong }) as Combatant;
        const stats = casterStats(p);
        expect(describeAbility(builtinDash())).toBe('Self. The user gains one more full allowance of movement this turn. No MP.');
        const shove = describeAbility(builtinShove(), stats, p);
        expect(shove).toContain('bonus action');
        expect(shove).toContain('STR or DEX save (its better one) against DC 13');
        expect(describeAbility(builtinJump(), stats, p)).toContain('within 5 squares');
        expect(describeAbility(builtinJump())).toContain('2 + its STR modifier squares (at least 2)');
        const thrown = describeAbility(builtinThrow(), stats, p);
        expect(thrown).toContain('within 6 squares');
        expect(thrown).toContain('Attack roll +5');
        expect(thrown).toContain('1d4+3 bludgeoning');
        expect(describeAbility(builtinHelp())).toContain('stands a downed ally up with 1 HP');
    });
});

describe('Dash', () => {
    it('adds one more full allowance, costs the action and no MP, and logs the ability header', () => {
        const s = arena([pc(), foe('f', at(9, 9))]);
        const r = act(s, BUILTIN_DASH_ID);
        expect(kinds(r.events)).toEqual(['ability']);
        expect(r.events[0].data).toMatchObject({ abilityId: BUILTIN_DASH_ID, name: 'Dash', slot: 'action', cost: 0, form: 'self', effects: ['sprint'] });
        expect(r.state.turn).toMatchObject({ moveLeft: 12, actionUsed: true, dashed: true });
        expect(r.state.combatants.pc.mp).toBe(s.combatants.pc.mp);
        expect(r.state.rngCursor).toBe(s.rngCursor);
        const moved = applyAction(withTurn(s, { moveLeft: 1 }), { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_DASH_ID, aim: null });
        expect(moved.state.turn?.moveLeft).toBe(7);
    });

    it('adds the allowance after Slow and Haste are applied', () => {
        const slowed = arena([pc({ conditions: [{ id: 'slowed', turns: 2 }] }), foe('f', at(9, 9))]);
        expect(slowed.turn?.moveLeft).toBe(3);
        expect(act(slowed, BUILTIN_DASH_ID).state.turn?.moveLeft).toBe(6);
        const hasted = arena([pc({ conditions: [{ id: 'hasted', turns: 2 }] }), foe('f', at(9, 9))]);
        expect(hasted.turn).toMatchObject({ moveLeft: 12, extraActions: 1 });
        const r = act(withTurn(hasted, { actionUsed: true }), BUILTIN_DASH_ID);
        expect(r.state.turn).toMatchObject({ moveLeft: 24, extraActions: 0, actionUsed: true });
    });

    it('is refused once the action is spent, with no speed, or off turn', () => {
        const s = arena([pc(), foe('f', at(9, 9))]);
        expect(checkAbility(withTurn(s, { actionUsed: true }), 'pc', BUILTIN_DASH_ID).reason).toBe('the action is already used');
        expect(act(withTurn(s, { actionUsed: true }), BUILTIN_DASH_ID).events[0].type).toBe('rejected');
        expect(checkAbility(arena([pc({ speed: 0 }), foe('f', at(9, 9))]), 'pc', BUILTIN_DASH_ID).reason).toBe('no movement to add');
        expect(checkAbility(s, 'f', BUILTIN_DASH_ID).reason).toBe('not this combatant\'s turn');
        const after = act(s, BUILTIN_DASH_ID).state;
        expect(checkAbility(after, 'pc', 'builtin:attack').reason).toBe('the action is already used');
    });

    it('needs no aim and lets the move action use the extra squares', () => {
        const s = arena([pc(), foe('f', at(15, 11))]);
        expect(legalAims(s, 'pc', builtinDash())).toEqual([at(2, 2)]);
        const dashed = act(s, BUILTIN_DASH_ID).state;
        const far = applyAction(dashed, { type: 'move', actorId: 'pc', to: at(2, 10) });
        expect(far.events[0].type).toBe('moved');
        const farther = applyAction(dashed, { type: 'move', actorId: 'pc', to: at(12, 2) });
        expect(farther.events[0].type).toBe('moved');
        expect(applyAction(s, { type: 'move', actorId: 'pc', to: at(12, 2) }).events[0].type).toBe('rejected');
    });
});

describe('Shove', () => {
    it('pushes a target that fails its better save two squares and costs the bonus action', () => {
        const s = seeded(arena([pc(), foe('f', at(3, 2))]), failSave);
        const r = act(s, BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['ability', 'save', 'pushed']);
        expect(r.events[0].data).toMatchObject({ abilityId: BUILTIN_SHOVE_ID, slot: 'bonus', cost: 0 });
        expect(r.events[1].data).toMatchObject({ dc: 10, success: false, builtin: 'shove', ability: 'Shove' });
        expect(r.events[2].data).toMatchObject({ kind: 'push', squares: 2, builtin: 'shove' });
        expect(r.state.combatants.f.position).toEqual(at(5, 2));
        expect(r.state.turn).toMatchObject({ bonusUsed: true, actionUsed: false });
        expect(r.state.combatants.pc.mp).toBe(s.combatants.pc.mp);
        expect(applyAction(r.state, { type: 'attack', actorId: 'pc', targetId: 'f' }).events[0].type).toBe('rejected');
        expect(act(r.state, BUILTIN_SHOVE_ID, at(5, 2)).events[0].type).toBe('rejected');
    });

    it('leaves a target that passes its save where it is', () => {
        const s = seeded(arena([pc(), foe('f', at(3, 2))]), passSave);
        const r = act(s, BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['ability', 'save']);
        expect(r.events[1].data.success).toBe(true);
        expect(r.state.combatants.f.position).toEqual(at(3, 2));
        expect(r.state.turn?.bonusUsed).toBe(true);
    });

    it('rolls the better of the target STR and DEX against 8 + proficiency + STR modifier', () => {
        const dex = seeded(arena([pc({ abilities: strong }), foe('f', at(3, 2), { abilities: { ...strong, STR: 8, DEX: 18 } })]), failSave);
        const d = act(dex, BUILTIN_SHOVE_ID, at(3, 2));
        expect(d.events[1].data).toMatchObject({ save: 'DEX', dc: 13 });
        const str = seeded(arena([pc(), foe('f', at(3, 2), { abilities: { ...strong, STR: 18, DEX: 8 } })]), failSave);
        expect(act(str, BUILTIN_SHOVE_ID, at(3, 2)).events[1].data).toMatchObject({ save: 'STR', dc: 10 });
    });

    it('is blocked by a wall, a cover square or a creature, and says so', () => {
        for (const blocker of ['wall', 'cover'] as const) {
            const grid = gridWith([[at(4, 2), blocker]]);
            const r = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
            expect(kinds(r.events)).toEqual(['ability', 'save', 'pushed']);
            expect(r.events[2].data).toMatchObject({ squares: 0, moves: [], builtin: 'shove' });
            expect(r.state.combatants.f.position).toEqual(at(3, 2));
        }
        const wall = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(5, 2), 'wall']]) }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(wall.events[2].data.squares).toBe(1);
        expect(wall.state.combatants.f.position).toEqual(at(4, 2));
        const crowd = act(seeded(arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2))]), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(crowd.events[2].data.squares).toBe(0);
    });

    it('applies a hazard entered on the way, and again on landing in it', () => {
        const through = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(4, 2), 'hazard']]) }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(through.events)).toEqual(['ability', 'save', 'pushed', 'hazard']);
        expect(through.events[3]).toMatchObject({ targetId: 'f', data: { damageType: 'fire' } });
        expect(through.state.combatants.f.hp).toBe(30 - (through.events[3].data.damage as number));
        const both = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(4, 2), 'hazard'], [at(5, 2), 'hazard']]) }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(both.events)).toEqual(['ability', 'save', 'pushed', 'hazard', 'hazard']);
        const landing = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(5, 2), 'hazard']]) }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(landing.events)).toEqual(['ability', 'save', 'pushed', 'hazard']);
        const clear = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(6, 2), 'hazard']]) }), failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(clear.events)).toEqual(['ability', 'save', 'pushed']);
        const passed = act(seeded(arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(4, 2), 'hazard']]) }), passSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(passed.events)).toEqual(['ability', 'save']);
    });

    it('can drop a target to 0 HP in a hazard', () => {
        const s = seeded(arena([pc(), foe('f', at(3, 2), { hp: 1, maxHp: 1 }), foe('g', at(9, 9))], { grid: gridWith([[at(4, 2), 'hazard']]) }), failSave);
        const r = act(s, BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['ability', 'save', 'pushed', 'hazard', 'down']);
        expect(r.state.combatants.f.status).toBe('down');
    });

    it('refuses a boss, an ally, a far target and an empty square, each with a reason', () => {
        const base = (f: Combatant) => arena([pc(), f]);
        expect(checkAbility(base(foe('f', at(3, 2), { tier: 'boss' })), 'pc', BUILTIN_SHOVE_ID, at(3, 2)).reason).toBe('too large to shove');
        expect(checkAbility(base(foe('f', at(3, 2), { tier: 'legendary' })), 'pc', BUILTIN_SHOVE_ID, at(3, 2)).reason).toBe('too large to shove');
        expect(checkAbility(base(foe('f', at(3, 2), { side: 'ally' })), 'pc', BUILTIN_SHOVE_ID, at(3, 2)).reason).toBe('no target there');
        expect(checkAbility(base(foe('f', at(4, 2))), 'pc', BUILTIN_SHOVE_ID, at(4, 2)).reason).toBe('out of reach');
        expect(checkAbility(base(foe('f', at(3, 2))), 'pc', BUILTIN_SHOVE_ID, at(1, 2)).reason).toBe('no target there');
        expect(checkAbility(base(foe('f', at(9, 9))), 'pc', BUILTIN_SHOVE_ID).reason).toBe('no target');
        expect(legalAims(base(foe('f', at(3, 2), { tier: 'boss' })), 'pc', builtinShove())).toEqual([]);
        expect(legalAims(base(foe('f', at(3, 2))), 'pc', builtinShove())).toEqual([at(3, 2)]);
    });

    it('needs the bonus action, not the action', () => {
        const s = arena([pc(), foe('f', at(3, 2))]);
        expect(checkAbility(withTurn(s, { bonusUsed: true }), 'pc', BUILTIN_SHOVE_ID).reason).toBe('the bonus action is already used');
        expect(checkAbility(withTurn(s, { actionUsed: true }), 'pc', BUILTIN_SHOVE_ID).ok).toBe(true);
        expect(act(withTurn(s, { bonusUsed: true }), BUILTIN_SHOVE_ID, at(3, 2)).events[0].type).toBe('rejected');
    });
});

describe('Jump', () => {
    it('moves to an empty square in line of sight within 2 squares and spends that movement', () => {
        const s = arena([pc(), foe('f', at(9, 9))]);
        const r = act(s, BUILTIN_JUMP_ID, at(4, 2));
        expect(kinds(r.events)).toEqual(['ability', 'teleported']);
        expect(r.events[0].data).toMatchObject({ abilityId: BUILTIN_JUMP_ID, slot: 'bonus', cost: 0 });
        expect(r.events[1].data).toMatchObject({ kind: 'leap', squares: 2, builtin: 'jump', over: [] });
        expect(r.state.combatants.pc.position).toEqual(at(4, 2));
        expect(r.state.turn).toMatchObject({ moveLeft: 4, bonusUsed: true, actionUsed: false });
        expect(r.state.rngCursor).toBe(s.rngCursor);
        const diagonal = act(s, BUILTIN_JUMP_ID, at(4, 4));
        expect(diagonal.state.turn?.moveLeft).toBe(4);
        expect(checkAbility(s, 'pc', BUILTIN_JUMP_ID, at(5, 2)).reason).toBe('out of range');
        expect(checkAbility(s, 'pc', BUILTIN_JUMP_ID, at(2, 2)).reason).toBe('aim at another square');
        expect(checkAbility(s, 'pc', BUILTIN_JUMP_ID).ok).toBe(true);
    });

    it('reaches 2 plus the STR modifier squares, never fewer than 2', () => {
        const mighty = arena([pc({ abilities: strong }), foe('f', at(9, 9))]);
        expect(leapRange(mighty.combatants.pc)).toBe(5);
        expect(checkAbility(mighty, 'pc', BUILTIN_JUMP_ID, at(7, 2)).ok).toBe(true);
        expect(checkAbility(mighty, 'pc', BUILTIN_JUMP_ID, at(8, 2)).reason).toBe('out of range');
        const weak = arena([pc({ abilities: { ...strong, STR: 6 } }), foe('f', at(9, 9))]);
        expect(leapRange(weak.combatants.pc)).toBe(2);
        expect(checkAbility(weak, 'pc', BUILTIN_JUMP_ID, at(4, 2)).ok).toBe(true);
        expect(checkAbility(weak, 'pc', BUILTIN_JUMP_ID, at(5, 2)).reason).toBe('out of range');
    });

    it('ignores difficult ground, hazards and low cover between, and says what it crossed', () => {
        const grid = gridWith([[at(3, 2), 'difficult'], [at(4, 2), 'hazard']]);
        const s = arena([pc({ abilities: strong }), foe('f', at(9, 9))], { grid });
        const r = act(s, BUILTIN_JUMP_ID, at(6, 2));
        expect(kinds(r.events)).toEqual(['ability', 'teleported']);
        expect(r.events[1].data.over).toEqual(['hazard', 'difficult']);
        expect(r.state.turn?.moveLeft).toBe(2);
        expect(r.state.combatants.pc.position).toEqual(at(6, 2));
        expect(r.state.combatants.pc.hp).toBe(s.combatants.pc.hp);
        const cover = act(arena([pc(), foe('f', at(9, 9))], { grid: gridWith([[at(3, 2), 'cover']]) }), BUILTIN_JUMP_ID, at(4, 2));
        expect(cover.events[1].data.over).toEqual(['cover']);
    });

    it('lands on a hazard without being hurt until the round ends', () => {
        const s = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([[at(4, 2), 'hazard']]) });
        const r = act(s, BUILTIN_JUMP_ID, at(4, 2));
        expect(kinds(r.events)).toEqual(['ability', 'teleported']);
        expect(r.state.combatants.pc.hp).toBe(s.combatants.pc.hp);
    });

    it('is blocked by a wall in the way, a hostile in the way, or a landing square that is not empty', () => {
        const wall = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([], [at(3, 2)]) });
        expect(checkAbility(wall, 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('no line of sight');
        const landing = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([], [at(4, 2)]) });
        expect(checkAbility(landing, 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('the square is not empty');
        const cover = arena([pc(), foe('f', at(9, 9))], { grid: gridWith([[at(4, 2), 'cover']]) });
        expect(checkAbility(cover, 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('the square is not empty');
        const hostile = arena([pc(), foe('f', at(3, 2))]);
        expect(checkAbility(hostile, 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('a creature is in the way');
        const occupied = arena([pc(), foe('f', at(4, 2))]);
        expect(checkAbility(occupied, 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('the square is not empty');
        const friend = arena([pc(), foe('f', at(3, 2), { side: 'ally' })]);
        expect(checkAbility(friend, 'pc', BUILTIN_JUMP_ID, at(4, 2)).ok).toBe(true);
        expect(legalAims(wall, 'pc', builtinJump()).some(p => p.x === 4 && p.y === 2)).toBe(false);
    });

    it('is not allowed when the allowance is short, and needs the bonus action', () => {
        const s = arena([pc(), foe('f', at(9, 9))]);
        expect(checkAbility(withTurn(s, { moveLeft: 1 }), 'pc', BUILTIN_JUMP_ID, at(4, 2)).reason).toBe('not enough movement');
        expect(checkAbility(withTurn(s, { moveLeft: 1 }), 'pc', BUILTIN_JUMP_ID, at(3, 2)).ok).toBe(true);
        expect(checkAbility(withTurn(s, { moveLeft: 2 }), 'pc', BUILTIN_JUMP_ID, at(4, 2)).ok).toBe(true);
        expect(checkAbility(withTurn(s, { moveLeft: 0 }), 'pc', BUILTIN_JUMP_ID).reason).toBe('not enough movement');
        expect(act(withTurn(s, { moveLeft: 1 }), BUILTIN_JUMP_ID, at(4, 2)).events[0].type).toBe('rejected');
        expect(checkAbility(withTurn(s, { bonusUsed: true }), 'pc', BUILTIN_JUMP_ID).reason).toBe('the bonus action is already used');
        expect(checkAbility(withTurn(s, { actionUsed: true }), 'pc', BUILTIN_JUMP_ID).ok).toBe(true);
    });
});

describe('Throw', () => {
    const hit = cursorFor(SEED, r => r[0] >= 15 && r[0] <= 19, 1);

    it('is an attack with whatever is at hand: 1d4 + STR bludgeoning, range 6, costing the action', () => {
        const s = seeded(arena([pc({ abilities: strong, weaponName: 'Glaive', range: 'reach' }), foe('f', at(7, 2))]), hit);
        const r = act(s, BUILTIN_THROW_ID, at(7, 2));
        expect(kinds(r.events)).toEqual(['ability', 'attack']);
        expect(r.events[0].data).toMatchObject({ abilityId: BUILTIN_THROW_ID, slot: 'action', cost: 0, form: 'projectile', effects: ['weapon'] });
        expect(r.events[1].data).toMatchObject({ hit: true, range: 'ranged', weapon: THROWN_WEAPON_NAME, damageType: 'bludgeoning' });
        const damage = r.events[1].data.damage as number;
        expect(damage).toBeGreaterThanOrEqual(4);
        expect(damage).toBeLessThanOrEqual(7);
        expect(r.events[1].data.total).toBe((r.events[1].data.natural as number) + throwProfile(s.combatants.pc).attackBonus);
        expect(throwProfile(s.combatants.pc).attackBonus).toBe(5);
        expect(r.state.combatants.f.hp).toBe(30 - damage);
        expect(r.state.turn).toMatchObject({ actionUsed: true });
        expect(r.state.turn?.bonusUsed).toBeUndefined();
        expect(r.state.combatants.pc.mp).toBe(s.combatants.pc.mp);
    });

    it('stops at 6 squares and at a wall', () => {
        const near = arena([pc(), foe('f', at(8, 2))]);
        expect(checkAbility(near, 'pc', BUILTIN_THROW_ID, at(8, 2)).ok).toBe(true);
        const far = arena([pc(), foe('f', at(9, 2))]);
        expect(checkAbility(far, 'pc', BUILTIN_THROW_ID, at(9, 2)).reason).toBe('out of range');
        expect(legalAims(far, 'pc', builtinThrow())).toEqual([]);
        const walled = arena([pc(), foe('f', at(6, 2))], { grid: gridWith([], [at(4, 2)]) });
        expect(checkAbility(walled, 'pc', BUILTIN_THROW_ID, at(6, 2)).reason).toBe('no line of sight');
        expect(checkAbility(arena([pc(), foe('f', at(3, 2), { side: 'ally' })]), 'pc', BUILTIN_THROW_ID, at(3, 2)).reason).toBe('no target there');
    });

    it('is harder to land behind cover, and the attack reports the cover', () => {
        const nine = cursorFor(SEED, r => r[0] === 9, 1);
        const open = act(seeded(arena([pc(), foe('f', at(7, 2))]), nine), BUILTIN_THROW_ID, at(7, 2));
        expect(open.events[1].data).toMatchObject({ hit: true, cover: 0 });
        const covered = act(seeded(arena([pc(), foe('f', at(7, 2))], { grid: gridWith([[at(5, 2), 'cover']]) }), nine), BUILTIN_THROW_ID, at(7, 2));
        expect(covered.events[1].data).toMatchObject({ hit: false, cover: 2, ac: 12, weapon: THROWN_WEAPON_NAME });
        expect(covered.state.combatants.f.hp).toBe(30);
    });

    it('takes disadvantage with a hostile beside the thrower, and a critical doubles the dice', () => {
        const crowded = seeded(arena([pc(), foe('f', at(7, 2)), foe('g', at(3, 2))]), cursorFor(SEED, r => r[0] >= 10 && r[1] >= 10, 2));
        const r = act(crowded, BUILTIN_THROW_ID, at(7, 2));
        expect(r.events[1].data).toMatchObject({ adjacentShot: true, disadvantage: true });
        const crit = act(seeded(arena([pc(), foe('f', at(7, 2))]), cursorFor(SEED, x => x[0] === 20, 1)), BUILTIN_THROW_ID, at(7, 2));
        expect(crit.events[1].data).toMatchObject({ hit: true, crit: true });
        expect(crit.events[1].data.damage).toBeGreaterThanOrEqual(2);
    });

    it('is refused once the action is spent', () => {
        const s = arena([pc(), foe('f', at(5, 2))]);
        expect(checkAbility(withTurn(s, { actionUsed: true }), 'pc', BUILTIN_THROW_ID).reason).toBe('the action is already used');
        expect(checkAbility(withTurn(s, { bonusUsed: true }), 'pc', BUILTIN_THROW_ID).ok).toBe(true);
    });
});

describe('Help', () => {
    const ally = (overrides: Partial<Combatant> = {}) => foe('a', at(3, 2), { side: 'ally', ...overrides });

    it('ends Stunned and Slowed on an adjacent ally and costs the action', () => {
        const s = arena([pc(), ally({ conditions: [{ id: 'stunned', turns: 1 }, { id: 'slowed', turns: 2 }, { id: 'hasted', turns: 2 }] }), foe('f', at(9, 9))]);
        const r = act(s, BUILTIN_HELP_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['ability', 'rallied']);
        expect(r.events[0].data).toMatchObject({ abilityId: BUILTIN_HELP_ID, slot: 'action', cost: 0 });
        expect(r.events[1]).toMatchObject({ actorId: 'pc', targetId: 'a', data: { kind: 'shake', removed: ['stunned', 'slowed'], builtin: 'help' } });
        expect(r.state.combatants.a.conditions.map(c => c.id)).toEqual(['hasted']);
        expect(r.state.turn?.actionUsed).toBe(true);
        expect(r.state.rngCursor).toBe(s.rngCursor);
    });

    it('lets a stunned ally keep its turn', () => {
        const s = arena([pc(), ally({ conditions: [{ id: 'stunned', turns: 1 }] }), foe('f', at(9, 9))]);
        const helped = act(s, BUILTIN_HELP_ID, at(3, 2)).state;
        const ended = applyAction(helped, { type: 'end_turn', actorId: 'pc' });
        expect(currentActorId(ended.state)).toBe('a');
        expect(kinds(ended.events)).not.toContain('turn_lost');
    });

    it('refuses a healthy ally, an enemy, a far ally, a gone ally and an empty square', () => {
        const base = (extra: Combatant[]) => arena([pc(), ...extra, foe('f', at(9, 9))]);
        expect(checkAbility(base([ally()]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('nothing to shake off');
        expect(checkAbility(base([foe('e', at(3, 2), { conditions: [{ id: 'stunned', turns: 1 }] })]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('only an ally can be helped');
        expect(checkAbility(base([foe('e', at(3, 2), { status: 'down', hp: 0 })]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('only an ally can be helped');
        expect(checkAbility(base([ally({ position: at(4, 2), conditions: [{ id: 'slowed', turns: 1 }] })]), 'pc', BUILTIN_HELP_ID, at(4, 2)).reason).toBe('out of reach');
        expect(checkAbility(base([ally({ status: 'gone' })]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('no target there');
        expect(checkAbility(base([ally({ status: 'fled' })]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('no target there');
        expect(checkAbility(base([ally({ status: 'down', hp: 0, summonerId: 'pc' })]), 'pc', BUILTIN_HELP_ID, at(3, 2)).reason).toBe('cannot be brought back');
        expect(checkAbility(base([ally()]), 'pc', BUILTIN_HELP_ID, at(2, 2)).reason).toBe('out of reach');
        expect(checkAbility(base([ally()]), 'pc', BUILTIN_HELP_ID, at(1, 2)).reason).toBe('no target there');
        expect(checkAbility(base([]), 'pc', BUILTIN_HELP_ID).reason).toBe('no target');
    });

    for (const mode of ['knockout', 'hardcore', 'ironman'] as DefeatMode[]) {
        it(`stands a downed ally up with 1 HP in ${mode}`, () => {
            const s = arena([pc(), ally({ status: 'down', hp: 0, conditions: [{ id: 'stunned', turns: 1 }] }), foe('f', at(9, 9))], { defeatMode: mode });
            const r = act(s, BUILTIN_HELP_ID, at(3, 2));
            expect(kinds(r.events)).toEqual(['ability', 'rallied']);
            expect(r.events[1].data).toMatchObject({ kind: 'revive', hpBefore: 0, hpAfter: 1, removed: ['stunned'] });
            expect(r.state.combatants.a).toMatchObject({ status: 'up', hp: 1, conditions: [] });
            expect(r.state.outcome).toBeNull();
            const next = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
            expect(currentActorId(next.state)).toBe('a');
        });
    }

    it('lets a downed player character be recovered in knockout and hardcore but not in ironman', () => {
        const rescuer = foe('a', at(2, 2), { side: 'ally', controller: 'player' });
        const fallen = foe('p', at(3, 2), { side: 'player', controller: 'player', status: 'down', hp: 0 });
        for (const mode of ['knockout', 'hardcore', 'ironman'] as DefeatMode[]) {
            const s = arena([rescuer, fallen, foe('f', at(9, 9))], { defeatMode: mode });
            const check = checkAbility(s, 'a', BUILTIN_HELP_ID, at(3, 2));
            if (mode === 'ironman') expect(check.reason).toBe('cannot be brought back');
            else expect(check.ok).toBe(true);
        }
        const ironman = arena([rescuer, fallen, foe('f', at(9, 9))], { defeatMode: 'ironman' });
        expect(act(ironman, BUILTIN_HELP_ID, at(3, 2), 'a').events[0].type).toBe('rejected');
        const knockout = arena([rescuer, fallen, foe('f', at(9, 9))], { defeatMode: 'knockout' });
        expect(act(knockout, BUILTIN_HELP_ID, at(3, 2), 'a').state.combatants.p).toMatchObject({ status: 'up', hp: 1 });
    });

    it('needs the action', () => {
        const s = arena([pc(), ally({ status: 'down', hp: 0 }), foe('f', at(9, 9))]);
        expect(checkAbility(withTurn(s, { actionUsed: true }), 'pc', BUILTIN_HELP_ID).reason).toBe('the action is already used');
        expect(checkAbility(withTurn(s, { bonusUsed: true }), 'pc', BUILTIN_HELP_ID).ok).toBe(true);
    });
});

describe('engine Dash (A2)', () => {
    const hunter = (grid = openGrid(), x = 1) => arena([foe('e', at(x, 5)), caster([], at(14, 5), { id: 'pc' })], { grid });

    function turnOf(state: CombatState, options: { dash?: boolean }) {
        const log: string[] = [];
        let s = state;
        for (let i = 0; i < 8 && currentActorId(s) === 'e' && !s.outcome; i++) {
            const choice = chooseEngineTurn(s, 'e', options);
            const first = choice.actions[0];
            log.push(first.type === 'use_ability' ? first.abilityId : first.type);
            s = applyAction(choice.state, first).state;
        }
        return { log, state: s };
    }

    it('moves, dashes and moves again when it would otherwise end its turn out of reach', () => {
        const r = turnOf(hunter(), { dash: true });
        expect(r.log).toEqual(['move', BUILTIN_DASH_ID, 'move']);
        expect(r.state.combatants.e.position?.x).toBe(13);
        expect(currentActorId(r.state)).toBe('pc');
    });

    it('does nothing of the kind when dashing is not allowed', () => {
        const r = turnOf(hunter(), { dash: false });
        expect(r.log).toEqual(['move', 'end_turn']);
        expect(r.state.combatants.e.position?.x).toBe(7);
        expect(turnOf(hunter(), {}).log).toEqual(AI_DASH ? ['move', BUILTIN_DASH_ID, 'move'] : ['move', 'end_turn']);
    });

    it('never dashes when it can attack this turn, or when the extra movement gets it nowhere', () => {
        expect(turnOf(hunter(openGrid(), 8), { dash: true }).log).toEqual(['move', 'attack', 'end_turn']);
        const walls = Array.from({ length: 12 }, (_, y) => at(7, y));
        expect(turnOf(hunter(openGrid(16, 12, walls)), { dash: true }).log).toEqual(['end_turn']);
    });
});

describe('a driven turn waits for a usable built-in bonus action', () => {
    const spent = (f: Combatant) => withTurn(arena([pc(), f]), { moveLeft: 0 });
    const hit = (s: CombatState, driven?: boolean) => applyAction(s, { type: 'attack', actorId: 'pc', targetId: 'f' }, driven ? { driven: true } : {});
    const defend = (s: CombatState, driven?: boolean) => applyAction(s, { type: 'defend', actorId: 'pc' }, driven ? { driven: true } : {});

    it('stays open after move-and-attack with an adjacent hostile, lets Shove happen, then ends', () => {
        const s = seeded(spent(foe('f', at(3, 2))), failSave);
        const attacked = hit(s, true);
        expect(attacked.events.some(e => e.type === 'rejected')).toBe(false);
        expect(currentActorId(attacked.state)).toBe('pc');
        const shoved = applyAction(attacked.state, { type: 'use_ability', actorId: 'pc', abilityId: BUILTIN_SHOVE_ID, aim: at(3, 2) }, { driven: true });
        expect(shoved.events[0].type).toBe('ability');
        expect(currentActorId(shoved.state)).not.toBe('pc');
    });

    it('can still be ended manually while waiting', () => {
        const attacked = hit(seeded(spent(foe('f', at(3, 2))), failSave), true);
        const ended = applyAction(attacked.state, { type: 'end_turn', actorId: 'pc' });
        expect(currentActorId(ended.state)).not.toBe('pc');
    });

    it('auto-ends as before with no adjacent hostile and no movement', () => {
        const r = defend(spent(foe('f', at(9, 9))), true);
        expect(currentActorId(r.state)).not.toBe('pc');
    });

    it('auto-ends as before on an engine-driven turn in the same position', () => {
        const attacked = hit(seeded(spent(foe('f', at(3, 2))), failSave));
        expect(currentActorId(attacked.state)).not.toBe('pc');
    });

    it('auto-ends when the only adjacent hostile is immune to a shove', () => {
        const attacked = hit(seeded(spent(foe('f', at(3, 2), { tier: 'boss' })), failSave), true);
        expect(currentActorId(attacked.state)).not.toBe('pc');
    });
});

describe('action economy across the new actions', () => {
    it('lets a bonus Shove or Jump and an action Throw or Dash share a turn, one of each', () => {
        const s = seeded(arena([pc(), foe('f', at(3, 2))]), failSave);
        const shoved = act(s, BUILTIN_SHOVE_ID, at(3, 2)).state;
        expect(checkAbility(shoved, 'pc', BUILTIN_JUMP_ID).reason).toBe('the bonus action is already used');
        expect(checkAbility(shoved, 'pc', BUILTIN_DASH_ID).ok).toBe(true);
        const dashed = act(shoved, BUILTIN_DASH_ID).state;
        expect(dashed.turn).toMatchObject({ actionUsed: true, bonusUsed: true, moveLeft: 12 });
        expect(checkAbility(dashed, 'pc', BUILTIN_THROW_ID).reason).toBe('the action is already used');
    });

    it('is deterministic: the same seed and actions give the same log', () => {
        const run = () => {
            const start = seeded(arena([pc({ abilities: strong }), foe('f', at(3, 2)), foe('g', at(8, 3))], { grid: gridWith([[at(4, 2), 'hazard']]) }), failSave);
            const out: string[] = [];
            const scripts: Array<Array<[string, Pos | null]>> = [
                [[BUILTIN_SHOVE_ID, at(3, 2)], [BUILTIN_THROW_ID, at(8, 3)], [BUILTIN_SHOVE_ID, at(3, 2)]],
                [[BUILTIN_JUMP_ID, at(2, 4)], [BUILTIN_DASH_ID, null]],
            ];
            for (const script of scripts) {
                let state = start;
                const log: CombatEvent[] = [];
                for (const [id, aim] of script) {
                    const r = act(state, id, aim);
                    log.push(...r.events.filter(e => e.type !== 'rejected'));
                    state = r.state;
                }
                out.push(JSON.stringify({ log, state }));
            }
            return out.join('|');
        };
        const first = run();
        expect(first).toBe(run());
        expect(first).toContain('"type":"hazard"');
        expect(first).toContain('"kind":"leap"');
        expect(first).toContain('"type":"attack"');
    });
});
