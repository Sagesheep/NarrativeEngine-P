import { describe, it, expect } from 'vitest';
import {
    applyAction, BUILTIN_STUNT_ID, checkStunt, COMBAT_EVENT_TYPES, STUNT_DC, stuntAvailable, stuntDifficulty, validateAbility,
} from '../index';
import type { CombatEvent, CombatState, Combatant, Pos, StuntPart, StuntSpec } from '../index';
import { arena, caster, cursorFor, foe } from './glyphFixtures';

const SEED = 7;

const at = (x: number, y: number): Pos => ({ x, y });

const seeded = (state: CombatState, cursor: number): CombatState => ({ ...state, rngSeed: SEED, rngCursor: cursor });

const spec = (ability: StuntSpec['ability'], ...parts: StuntPart[]): StuntSpec => ({ ability, parts });

const kinds = (events: CombatEvent[]) => events.map(e => e.type);

const natural = (n: number) => cursorFor(SEED, r => r[0] === n, 1);

const strong = { STR: 16, DEX: 14, CON: 10, INT: 10, WIS: 10, CHA: 10 };

const pc = (overrides: Partial<Combatant> = {}) => caster([], at(2, 2), { abilities: strong, ...overrides });

function stunt(state: CombatState, s: StuntSpec, roll = 15, actorId = 'pc') {
    return applyAction(seeded(state, natural(roll)), { type: 'stunt', actorId, spec: s });
}

function scene(extra: Combatant[] = []): CombatState {
    return arena([pc(), foe('f', at(3, 2)), foe('g', at(7, 2)), ...extra]);
}

function check(events: CombatEvent[]): CombatEvent {
    const e = events.find(x => x.type === 'stunt_check');
    if (!e) throw new Error(`no stunt_check in ${kinds(events).join(',')}`);
    return e;
}

function rejectedReason(r: { events: CombatEvent[] }): string {
    expect(r.events[0].type).toBe('rejected');
    return String(r.events[0].data.reason);
}

describe('stunt menu outcomes resolve through the one pipeline', () => {
    it('hurt, adjacent: one check, then a touch ability with 1d6 + the chosen modifier of the named type', () => {
        const r = stunt(scene(), spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy', damageType: 'Fire!' }));
        expect(kinds(r.events).slice(0, 3)).toEqual(['stunt_check', 'ability', 'ability_damage']);
        const head = r.events[1];
        expect(head.data).toMatchObject({ abilityId: BUILTIN_STUNT_ID, form: 'touch', effects: ['weapon'], cost: 0, damageType: 'fire' });
        const dmg = r.events[2];
        expect(dmg.data.damageType).toBe('fire');
        expect(dmg.data.damage).toBeGreaterThanOrEqual(4);
        expect(dmg.data.damage).toBeLessThanOrEqual(9);
        expect(r.state.turn?.actionUsed).toBe(true);
        expect(r.state.combatants.pc.mp).toBe(r.state.combatants.pc.maxMp);
    });

    it('hurt, at range: a projectile up to 6 squares in sight', () => {
        const r = stunt(scene(), spec('DEX', { outcome: 'hurt', targetId: 'g', difficulty: 'moderate' }));
        expect(r.events[1].data.form).toBe('projectile');
        expect(r.events[2].targetId).toBe('g');
        expect(r.events[2].data.damageType).toBe('bludgeoning');
    });

    it('push and pull move a target 2 squares', () => {
        const pushed = stunt(scene(), spec('STR', { outcome: 'push', targetId: 'f', difficulty: 'easy' }));
        expect(pushed.state.combatants.f.position).toEqual(at(5, 2));
        expect(pushed.events.find(e => e.type === 'pushed')?.data).toMatchObject({ kind: 'push', squares: 2, builtin: 'stunt' });
        const pulled = stunt(scene(), spec('STR', { outcome: 'pull', targetId: 'g', difficulty: 'easy' }));
        expect(pulled.state.combatants.g.position).toEqual(at(5, 2));
    });

    it('slow knocks a target off balance for one round; stun at hard stuns', () => {
        const slowed = stunt(scene(), spec('DEX', { outcome: 'slow', targetId: 'g', difficulty: 'moderate' }));
        expect(slowed.state.combatants.g.conditions).toEqual([expect.objectContaining({ id: 'slowed', turns: 1 })]);
        const stunned = stunt(scene(), spec('STR', { outcome: 'stun', targetId: 'f', difficulty: 'hard' }), 18);
        expect(stunned.state.combatants.f.conditions.some(c => c.id === 'stunned')).toBe(true);
    });

    it('move takes the actor to an empty square within 4 in sight', () => {
        const r = stunt(scene(), spec('DEX', { outcome: 'move', at: at(5, 5), difficulty: 'moderate' }));
        expect(r.state.combatants.pc.position).toEqual(at(5, 5));
        expect(r.events.find(e => e.type === 'teleported')?.data).toMatchObject({ kind: 'blink', builtin: 'stunt' });
    });

    it('cover raises up to two barrier squares within 2', () => {
        const r = stunt(scene(), spec('STR', { outcome: 'cover', tiles: [at(2, 4), at(3, 4)], difficulty: 'easy' }));
        expect(r.state.barriers?.map(b => b.pos)).toEqual([at(2, 4), at(3, 4)]);
        expect(r.events.find(e => e.type === 'barrier')?.data.builtin).toBe('stunt');
    });

    it('hurt area hits everyone within 1 of the centre with 1d4 + modifier, DEX save for half, at hard', () => {
        const s = arena([pc(), foe('a', at(6, 6)), foe('b', at(7, 6))]);
        const r = stunt(s, spec('DEX', { outcome: 'hurt_area', at: at(6, 5), difficulty: 'hard', damageType: 'fire' }), 18);
        expect(r.events[1].data).toMatchObject({ form: 'burst', targets: ['a', 'b'] });
        const saves = r.events.filter(e => e.type === 'save');
        expect(saves.map(e => e.targetId)).toEqual(['a', 'b']);
        expect(saves.every(e => e.data.save === 'DEX' && e.data.dc === 12)).toBe(true);
        for (const d of r.events.filter(e => e.type === 'ability_damage')) {
            expect(d.data.damageType).toBe('fire');
            expect(d.data.damage).toBeLessThanOrEqual(6);
        }
    });

    it('a two-outcome stunt resolves in order, the second part from where the first left the actor', () => {
        const r = stunt(scene(), spec('DEX',
            { outcome: 'move', at: at(6, 3), difficulty: 'easy' },
            { outcome: 'hurt', targetId: 'g', difficulty: 'moderate' },
        ), 19);
        expect(check(r.events).data).toMatchObject({ difficulty: 'hard', dc: 16, outcomes: ['move', 'hurt'] });
        const heads = r.events.filter(e => e.type === 'ability');
        expect(heads.map(e => e.data.form)).toEqual(['self', 'touch']);
        expect(r.state.combatants.pc.position).toEqual(at(6, 3));
    });

    it('is deterministic for a seed and a spec, and the stunt ability is never a valid stored chain', () => {
        const s = spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy' });
        expect(stunt(scene(), s).events).toEqual(stunt(scene(), s).events);
        const plan = checkStunt(scene(), 'pc', s);
        expect(plan.ok).toBe(true);
        if (plan.ok) expect(validateAbility(plan.plan.steps[0].ability).length).toBeGreaterThan(0);
        expect(COMBAT_EVENT_TYPES).toContain('stunt_check');
    });
});

describe('the stunt check', () => {
    it('rolls d20 + the ability modifier + proficiency against the DC, emitted first', () => {
        const r = stunt(scene(), spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'moderate' }), 10);
        const e = check(r.events);
        expect(r.events[0]).toBe(e);
        expect(e.data).toMatchObject({ ability: 'STR', natural: 10, modifier: 5, total: 15, dc: 12, success: true, fumble: false, critical: false });
        expect(STUNT_DC).toEqual({ easy: 8, moderate: 12, hard: 16, very_hard: 20 });
    });

    it('a failure spends the action and does nothing else', () => {
        const r = stunt(scene(), spec('STR', { outcome: 'push', targetId: 'f', difficulty: 'very_hard' }), 5);
        expect(kinds(r.events)).toEqual(['stunt_check']);
        expect(check(r.events).data.success).toBe(false);
        expect(r.state.combatants.f.position).toEqual(at(3, 2));
        expect(r.state.turn?.actionUsed).toBe(true);
        expect(r.state.combatants.pc.conditions).toEqual([]);
    });

    it('a natural 1 spends the action and slows the actor for one round', () => {
        const r = stunt(scene(), spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy' }), 1);
        expect(kinds(r.events)).toEqual(['stunt_check', 'condition_added']);
        expect(check(r.events).data).toMatchObject({ success: false, fumble: true });
        expect(r.state.combatants.pc.conditions).toEqual([expect.objectContaining({ id: 'slowed', turns: 1 })]);
        expect(r.state.combatants.f.hp).toBe(30);
    });

    it('a natural 20 succeeds even when the total misses, and maximises the damage dice', () => {
        const weak = arena([pc({ abilities: { ...strong, STR: 3 } }), foe('f', at(3, 2))]);
        const r = stunt(weak, spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'very_hard' }), 20);
        const e = check(r.events);
        expect(e.data).toMatchObject({ natural: 20, total: 18, dc: 20, success: true, critical: true });
        expect(r.events.find(x => x.type === 'ability_damage')?.data.damage).toBe(2);
        const strongHit = stunt(scene(), spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy' }), 20);
        expect(strongHit.events.find(x => x.type === 'ability_damage')?.data.damage).toBe(9);
    });

    it('an impossible stunt is refused before any roll and costs nothing', () => {
        const s = seeded(scene(), natural(15));
        const r = applyAction(s, { type: 'stunt', actorId: 'pc', spec: spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'impossible' }) });
        expect(rejectedReason(r)).toContain('impossible');
        expect(r.state).toBe(s);
        expect(checkStunt(s, 'pc', spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'impossible' }))).toMatchObject({ ok: false, impossible: true });
    });
});

describe('difficulty floors and the combination rule', () => {
    it('stun and hurt area are never easier than hard', () => {
        const s = scene();
        expect(rejectedReason(stunt(s, spec('STR', { outcome: 'stun', targetId: 'f', difficulty: 'moderate' })))).toContain('never easier than hard');
        const area = arena([pc(), foe('a', at(6, 6))]);
        expect(rejectedReason(stunt(area, spec('STR', { outcome: 'hurt_area', at: at(6, 5), difficulty: 'easy' })))).toContain('never easier than hard');
        expect(stunt(area, spec('STR', { outcome: 'hurt_area', at: at(6, 5), difficulty: 'very_hard' })).events[0].type).toBe('stunt_check');
    });

    it('a combined stunt is one step harder than its harder part; past very hard it is impossible', () => {
        expect(stuntDifficulty([{ difficulty: 'easy' }])).toBe('easy');
        expect(stuntDifficulty([{ difficulty: 'easy' }, { difficulty: 'moderate' }])).toBe('hard');
        expect(stuntDifficulty([{ difficulty: 'hard' }, { difficulty: 'easy' }])).toBe('very_hard');
        expect(stuntDifficulty([{ difficulty: 'very_hard' }, { difficulty: 'easy' }])).toBe('impossible');
        const s = scene();
        const combo = stunt(s, spec('STR', { outcome: 'stun', targetId: 'f', difficulty: 'hard' }, { outcome: 'push', targetId: 'f', difficulty: 'easy' }), 20);
        expect(check(combo.events).data.dc).toBe(20);
        const tooMuch = checkStunt(s, 'pc', spec('STR', { outcome: 'stun', targetId: 'f', difficulty: 'very_hard' }, { outcome: 'push', targetId: 'f', difficulty: 'easy' }));
        expect(tooMuch).toMatchObject({ ok: false, impossible: true });
    });
});

describe('the engine validates everything the AI returns', () => {
    const boss = foe('boss', at(2, 3), { tier: 'boss' });
    const friend: Combatant = { ...foe('ally', at(1, 2)), side: 'ally' };
    const cases: Array<[string, StuntSpec, string, Combatant[]?]> = [
        ['unknown target', spec('STR', { outcome: 'hurt', targetId: 'nobody', difficulty: 'easy' }), 'no such target'],
        ['an ally as target', spec('STR', { outcome: 'hurt', targetId: 'ally', difficulty: 'easy' }), 'not a legal target', [friend]],
        ['out of reach', spec('STR', { outcome: 'hurt', targetId: 'far', difficulty: 'easy' }), 'the limit is 6', [foe('far', at(10, 2))]],
        ['out of sight', spec('STR', { outcome: 'slow', targetId: 'hid', difficulty: 'easy' }), 'out of sight', [foe('hid', at(6, 6))]],
        ['stun not adjacent', spec('STR', { outcome: 'stun', targetId: 'g', difficulty: 'hard' }), 'not adjacent'],
        ['a boss cannot be moved', spec('STR', { outcome: 'push', targetId: 'boss', difficulty: 'easy' }), 'too large to move', [boss]],
        ['move too far', spec('DEX', { outcome: 'move', at: at(8, 8), difficulty: 'easy' }), 'the limit is 4'],
        ['move onto a creature', spec('DEX', { outcome: 'move', at: at(3, 2), difficulty: 'easy' }), 'not empty'],
        ['move off the map', spec('DEX', { outcome: 'move', at: at(-1, 2), difficulty: 'easy' }), 'not on the map'],
        ['three cover squares', spec('STR', { outcome: 'cover', tiles: [at(2, 3), at(2, 4), at(1, 3)], difficulty: 'easy' }), 'choose 1 or 2'],
        ['cover too far', spec('STR', { outcome: 'cover', tiles: [at(2, 5)], difficulty: 'easy' }), 'it must be 1 to 2'],
        ['area catching the actor', spec('STR', { outcome: 'hurt_area', at: at(3, 3), difficulty: 'hard' }), 'catch the actor'],
        ['area with nobody in it', spec('STR', { outcome: 'hurt_area', at: at(2, 5), difficulty: 'hard' }), 'nobody is in that area'],
        ['an outcome off the menu', { ability: 'STR', parts: [{ outcome: 'teleport' as never, difficulty: 'easy' }] }, 'not on the menu'],
        ['the same outcome twice', spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy' }, { outcome: 'hurt', targetId: 'g', difficulty: 'easy' }), 'listed twice'],
        ['three outcomes', spec('STR', { outcome: 'hurt', targetId: 'f', difficulty: 'easy' }, { outcome: 'slow', targetId: 'g', difficulty: 'easy' }, { outcome: 'move', at: at(2, 5), difficulty: 'easy' }), 'at most 2'],
        ['a bad ability', { ability: 'LUCK' as never, parts: [{ outcome: 'hurt', targetId: 'f', difficulty: 'easy' }] }, 'one of STR'],
        ['a bad difficulty', { ability: 'STR', parts: [{ outcome: 'hurt', targetId: 'f', difficulty: 'trivial' as never }] }, 'needs a difficulty'],
    ];

    it.each(cases)('rejects %s, spending nothing', (_label, s, reason, extra = []) => {
        const walls = { ...scene(extra) };
        const state: CombatState = _label === 'out of sight'
            ? { ...walls, grid: { ...(walls.grid as NonNullable<CombatState['grid']>), tiles: walls.grid!.tiles.map((t, i) => (i === 5 * 16 + 5 || i === 4 * 16 + 4 ? 'wall' : t)) } }
            : walls;
        const seededState = seeded(state, natural(15));
        const r = applyAction(seededState, { type: 'stunt', actorId: 'pc', spec: s });
        expect(rejectedReason(r)).toContain(reason);
        expect(r.state).toBe(seededState);
    });

    it('allows a stunt only to a player-controlled combatant with its action unspent', () => {
        const s = scene();
        const spent = { ...s, turn: { ...(s.turn as NonNullable<CombatState['turn']>), actionUsed: true } };
        expect(stuntAvailable(spent, 'pc')).toEqual({ ok: false, reason: 'the action is already used' });
        const engineFirst = arena([foe('f', at(3, 2)), pc()]);
        expect(stuntAvailable(engineFirst, 'f').ok).toBe(false);
        const r = applyAction(engineFirst, { type: 'stunt', actorId: 'f', spec: spec('STR', { outcome: 'hurt', targetId: 'pc', difficulty: 'easy' }) });
        expect(rejectedReason(r)).toContain('only a player-controlled combatant');
        const once = stunt(s, spec('STR', { outcome: 'hurt', targetId: 'g', difficulty: 'easy' }));
        const again = applyAction(once.state, { type: 'stunt', actorId: 'pc', spec: spec('STR', { outcome: 'slow', targetId: 'g', difficulty: 'easy' }) });
        expect(again.events.some(e => e.type === 'stunt_check')).toBe(false);
    });

    it('lets a player-controlled ally try a stunt', () => {
        const ally: Combatant = { ...foe('al', at(5, 5)), side: 'ally', controller: 'player' };
        const s = arena([ally, pc(), foe('f', at(6, 5))]);
        const r = applyAction(seeded(s, natural(15)), { type: 'stunt', actorId: 'al', spec: spec('STR', { outcome: 'push', targetId: 'f', difficulty: 'easy' }) });
        expect(r.events[0].type).toBe('stunt_check');
        expect(r.state.combatants.f.position).toEqual(at(8, 5));
    });
});
