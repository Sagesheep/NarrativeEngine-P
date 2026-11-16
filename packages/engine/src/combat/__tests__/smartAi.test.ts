import { describe, it, expect } from 'vitest';
import {
    BUILTIN_DASH_ID, BUILTIN_SHOVE_ID, BUILTIN_THROW_ID, STARTER_ABILITIES, coverBetween, createCombat, buildPcCombatant, deriveTactic, distance,
    enemyKit, normalizeTactic, planTurn, tacticOf, termsFor, TIER_DEPTH, TIER_TABLE,
} from '../index';
import type { CombatAction, CombatState, Combatant, Grid, Pos, Tactic, Tile, TurnPlan } from '../index';
import { arena, caster, casterSheet, foe } from './glyphFixtures';

const at = (x: number, y: number): Pos => ({ x, y });

const TILE: Record<string, Tile> = { '.': 'floor', '#': 'wall', o: 'cover', '~': 'difficult', '^': 'hazard' };

function gridOf(rows: string[]): Grid {
    return { width: rows[0].length, height: rows.length, tiles: rows.join('').split('').map(ch => TILE[ch] ?? 'floor') };
}

function enemy(id: string, pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return foe(id, pos, { ac: 12, ...extra });
}

function hero(pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return caster([], pos, { maxHp: 30, hp: 30, ...extra });
}

function ally(id: string, pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return foe(id, pos, { side: 'ally', ac: 12, ...extra });
}

function board(rows: string[] | null, units: Combatant[], extra: Partial<CombatState> = {}): CombatState {
    return arena(units, rows ? { grid: gridOf(rows), ...extra } : extra);
}

function finalTile(state: CombatState, plan: TurnPlan): Pos {
    let p = state.combatants[plan.actorId].position as Pos;
    for (const s of plan.steps) {
        if (s.type === 'move') p = s.to;
        if (s.type === 'use_ability' && s.abilityId === 'builtin:jump' && s.aim) p = s.aim;
    }
    return p;
}

const actionOf = (plan: TurnPlan): CombatAction | undefined => plan.steps.find(s => s.type !== 'move' && s.type !== 'end_turn');

const open = (w = 16, h = 12) => Array.from({ length: h }, () => '.'.repeat(w));

describe('choosing a target', () => {
    it('takes the kill, at every tier', () => {
        for (const tier of ['minion', 'grunt', 'elite'] as const) {
            const s = board(null, [
                enemy('e', at(5, 5), { tier, attackBonus: 6, damage: { count: 1, sides: 8, bonus: 2, type: 'slashing' } }),
                hero(at(6, 5)),
                ally('a', at(4, 5), { hp: 2 }),
            ]);
            expect(actionOf(planTurn(s, 'e'))).toEqual({ type: 'attack', actorId: 'e', targetId: 'a' });
        }
    });

    it('prefers the healer', () => {
        const mend = STARTER_ABILITIES.find(a => a.id === 'mend')!;
        const s = board(null, [
            enemy('e', at(5, 5), { tier: 'elite' }),
            ally('b', at(6, 5)),
            ally('h', at(4, 5), { kit: [mend] }),
            hero(at(12, 10)),
        ]);
        expect(actionOf(planTurn(s, 'e'))).toEqual({ type: 'attack', actorId: 'e', targetId: 'h' });
        const plain = board(null, [enemy('e', at(5, 5), { tier: 'elite' }), ally('b', at(6, 5)), ally('h', at(4, 5)), hero(at(12, 10))]);
        expect(actionOf(planTurn(plain, 'e'))).not.toEqual({ type: 'attack', actorId: 'e', targetId: 'h' });
    });

    it('finishes the wounded with the cheap attack, not the recharging bolt', () => {
        const kit = enemyKit('elite', 'caster', 'fire');
        const s = board(null, [
            enemy('e', at(5, 5), {
                tier: 'elite', archetype: 'caster', range: 'ranged', kit, proficiency: 3, castingAbility: 'INT', abilityDamage: { ...TIER_TABLE.elite.damage }, attackBonus: 9,
                damage: { count: 1, sides: 8, bonus: 2, type: 'piercing' },
            }),
            hero(at(9, 5), { hp: 2 }),
        ]);
        expect(actionOf(planTurn(s, 'e'))).toEqual({ type: 'attack', actorId: 'e', targetId: 'pc' });
    });

    it('ignores a nearer target for a much better one only above minion depth', () => {
        const units = (tier: Combatant['tier']) => [
            enemy('e', at(5, 5), { tier }),
            ally('near', at(6, 5)),
            ally('far', at(9, 5), { hp: 12, kit: [STARTER_ABILITIES.find(a => a.id === 'mend')!] }),
            hero(at(15, 11)),
        ];
        expect(actionOf(planTurn(board(null, units('minion')), 'e'))).toMatchObject({ targetId: 'near' });
        expect(actionOf(planTurn(board(null, units('elite')), 'e'))).toMatchObject({ targetId: 'far' });
    });
});

describe('choosing where to stand', () => {
    it('steps into cover against a ranged opponent', () => {
        const rows = ['............', '.......o....', '.......o....', '.......o....', '............'];
        const s = board(rows, [
            enemy('e', at(10, 2), { range: 'ranged', tier: 'grunt' }),
            hero(at(1, 2), { range: 'ranged', damage: { count: 1, sides: 8, bonus: 3, type: 'piercing' }, attackBonus: 5 }),
        ]);
        const plan = planTurn(s, 'e');
        const dest = finalTile(s, plan);
        expect(coverBetween(s.grid!, at(1, 2), dest)).toBeGreaterThan(0);
        expect(actionOf(plan)).toMatchObject({ type: 'attack', targetId: 'pc' });
    });

    it('a ranged unit backs off from an adjacent melee opponent before shooting', () => {
        const s = board(null, [enemy('e', at(5, 5), { range: 'ranged' }), hero(at(4, 5))]);
        const plan = planTurn(s, 'e');
        expect(distance(finalTile(s, plan), at(4, 5))).toBeGreaterThanOrEqual(2);
        expect(plan.steps.some(a => a.type === 'attack')).toBe(true);
    });

    it('avoids standing in the hazard, at minion depth too', () => {
        const rows = ['....^..', '....^..', '....^..'];
        for (const tier of ['minion', 'elite'] as const) {
            const s = board(rows, [enemy('e', at(0, 1), { tier }), hero(at(5, 1), { hp: 99, maxHp: 99 })]);
            const plan = planTurn(s, 'e');
            expect(s.grid!.tiles[finalTile(s, plan).y * 7 + finalTile(s, plan).x]).not.toBe('hazard');
        }
    });

    it('does not clump beside an ally when the opponent has an area ability', () => {
        const fireball = STARTER_ABILITIES.find(a => a.id === 'fireball')!;
        const make = (kit: typeof fireball[]) => board(null, [
            enemy('e', at(3, 6), { tier: 'elite' }),
            enemy('m', at(4, 5), { tier: 'grunt' }),
            hero(at(6, 5), { kit, hp: 99, maxHp: 99 }),
        ]);
        const wary = make([fireball]);
        const plan = planTurn(wary, 'e');
        expect(distance(finalTile(wary, plan), at(4, 5))).toBeGreaterThan(2);
        expect(actionOf(plan)).toMatchObject({ type: 'attack', targetId: 'pc' });
    });
});

describe('choosing an action', () => {
    it('shoves into the hazard (elite), a minion does not', () => {
        const rows = ['..........', '..........', '......^^..', '......^^..', '......^^..', '..........'];
        const units = (tier: Combatant['tier']) => [enemy('e', at(4, 3), { tier }), hero(at(5, 3), { hp: 99, maxHp: 99 })];
        const elite = planTurn(board(rows, units('elite')), 'e');
        expect(elite.steps).toContainEqual({ type: 'use_ability', actorId: 'e', abilityId: BUILTIN_SHOVE_ID, aim: at(5, 3) });
        const minion = planTurn(board(rows, units('minion')), 'e');
        expect(minion.steps.some(s => s.type === 'use_ability' && s.abilityId === BUILTIN_SHOVE_ID)).toBe(false);
        expect(termsFor(units('minion')[0])).toEqual(expect.arrayContaining([...TIER_DEPTH.minion]));
    });

    it('throws the crate when the target is out of reach', () => {
        const rows = ['.......', '...o...', '...o...', '...o...', '.......'];
        const rowsWalled = ['...o...', '...o...', '...o...', '...o...', '...o...'];
        const s = board(rowsWalled, [enemy('e', at(2, 2), { tier: 'elite' }), hero(at(4, 2))]);
        const plan = planTurn(s, 'e');
        expect(actionOf(plan)).toMatchObject({ type: 'use_ability', abilityId: BUILTIN_THROW_ID, aim: at(4, 2), payload: { kind: 'cover' } });
        const reachable = board(rows, [enemy('e', at(2, 2), { tier: 'elite' }), hero(at(4, 2))]);
        expect(actionOf(planTurn(reachable, 'e'))).toMatchObject({ type: 'attack' });
    });

    it('dashes only to close a gap it could not otherwise close in two turns', () => {
        const rows = ['..............................', '..............................', '..............................'];
        const far = board(rows, [enemy('e', at(0, 1)), hero(at(27, 1))]);
        const farPlan = planTurn(far, 'e');
        expect(farPlan.steps[0]).toEqual({ type: 'use_ability', actorId: 'e', abilityId: BUILTIN_DASH_ID, aim: null });
        expect(finalTile(far, farPlan).x).toBe(12);
        const near = board(rows, [enemy('e', at(0, 1)), hero(at(11, 1))]);
        expect(planTurn(near, 'e').steps.some(s => s.type === 'use_ability' && s.abilityId === BUILTIN_DASH_ID)).toBe(false);
        const minion = board(rows, [enemy('e', at(0, 1), { tier: 'minion' }), hero(at(27, 1))]);
        expect(planTurn(minion, 'e').steps.some(s => s.type === 'use_ability' && s.abilityId === BUILTIN_DASH_ID)).toBe(false);
    });

    it('a support unit heals a hurt ally before attacking', () => {
        const mend = STARTER_ABILITIES.find(a => a.id === 'mend')!;
        const healer = (tactic: Tactic) => board(null, [
            enemy('e', at(5, 5), { kit: [mend], tactic }),
            enemy('w', at(5, 6), { hp: 8, maxHp: 30 }),
            hero(at(6, 5)),
        ]);
        expect(actionOf(planTurn(healer('support'), 'e'))).toMatchObject({ type: 'use_ability', abilityId: 'mend', aim: at(5, 6) });
        expect(planTurn(healer('support'), 'e').intent).toMatchObject({ kind: 'support', targetId: 'w' });
    });
});

describe('tactics differ from aggressive', () => {
    it('skirmisher keeps its distance where aggressive closes in', () => {
        const make = (tactic: Tactic) => board(null, [enemy('e', at(5, 5), { range: 'ranged', tactic }), hero(at(8, 5))]);
        const kite = make('skirmisher');
        const press = make('aggressive');
        expect(distance(finalTile(kite, planTurn(kite, 'e')), at(8, 5))).toBeGreaterThan(distance(finalTile(press, planTurn(press, 'e')), at(8, 5)));
    });

    it('a guard returns to its leader; aggressive chases', () => {
        const make = (tactic: Tactic) => board(null, [
            enemy('e', at(10, 5), { tactic }),
            enemy('boss', at(2, 5), { tier: 'boss' }),
            hero(at(15, 11)),
        ], { morale: { startHp: { party: 30, enemy: 60 }, leaders: { enemy: 'boss' } } });
        const guard = make('guard');
        const plan = planTurn(guard, 'e');
        expect(distance(finalTile(guard, plan), at(2, 5))).toBeLessThan(8);
        const chase = make('aggressive');
        expect(distance(finalTile(chase, planTurn(chase, 'e')), at(2, 5))).toBeGreaterThan(8);
    });

    it('hunter goes for the weakest even when a healthier one is nearer', () => {
        const make = (tactic: Tactic) => board(null, [
            enemy('e', at(5, 5), { tactic }),
            ally('near', at(6, 5)),
            ally('weak', at(10, 5), { hp: 8 }),
            hero(at(15, 11)),
        ]);
        expect(actionOf(planTurn(make('hunter'), 'e'))).toMatchObject({ targetId: 'weak' });
        expect(actionOf(planTurn(make('aggressive'), 'e'))).toMatchObject({ targetId: 'near' });
    });

    it('a coward retreats when hurt; a berserker and aggressive do not', () => {
        const make = (tactic: Tactic) => board(null, [enemy('e', at(5, 5), { tactic, hp: 4 }), hero(at(6, 5))], { round: 2 });
        expect(planTurn(make('coward'), 'e').intent.kind).toBe('retreat');
        expect(planTurn(make('berserker'), 'e').intent.kind).toBe('attack');
        expect(planTurn(make('aggressive'), 'e').intent.kind).toBe('attack');
    });

    it('a berserker throws a minion ally at an enemy out of reach', () => {
        const rows = ['...o...', '...o...', '...o...', '...o...', '...o...'];
        const make = (tactic: Tactic) => board(rows, [
            enemy('e', at(1, 2), { tactic, abilities: { STR: 16, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 } }),
            enemy('imp', at(2, 2), { tier: 'minion' }),
            hero(at(5, 2)),
        ]);
        const wild = actionOf(planTurn(make('berserker'), 'e'));
        expect(wild).toMatchObject({ abilityId: BUILTIN_THROW_ID, payload: { kind: 'creature', id: 'imp' } });
        const calm = actionOf(planTurn(make('aggressive'), 'e'));
        expect((calm as { payload?: unknown } | undefined)?.payload).not.toEqual({ kind: 'creature', id: 'imp' });
    });

    it('support heals where aggressive attacks', () => {
        const mend = STARTER_ABILITIES.find(a => a.id === 'mend')!;
        const make = (tactic: Tactic) => board(null, [
            enemy('e', at(5, 5), { kit: [mend], tactic }),
            enemy('w', at(5, 6), { hp: 26, maxHp: 30 }),
            hero(at(6, 5), { hp: 3 }),
        ]);
        expect(actionOf(planTurn(make('support'), 'e'))).toMatchObject({ abilityId: 'mend' });
        expect(actionOf(planTurn(make('aggressive'), 'e'))).toMatchObject({ type: 'attack' });
    });
});

describe('where the tactic comes from', () => {
    it('normalises, derives from the kit, range and archetype, and prefers the supplied value', () => {
        expect(normalizeTactic(' Hunter ')).toBe('hunter');
        expect(normalizeTactic('sneaky')).toBeUndefined();
        const mend = STARTER_ABILITIES.find(a => a.id === 'mend')!;
        expect(deriveTactic({ kit: [mend] })).toBe('support');
        expect(deriveTactic({ range: 'ranged' })).toBe('skirmisher');
        expect(deriveTactic({ archetype: 'caster' })).toBe('skirmisher');
        expect(deriveTactic({ archetype: 'assassin' })).toBe('hunter');
        expect(deriveTactic({ archetype: 'bulwark' })).toBe('guard');
        expect(deriveTactic({ archetype: 'brute' })).toBe('aggressive');
        expect(deriveTactic({})).toBe('aggressive');
        expect(tacticOf({ archetype: 'assassin', tactic: 'coward' })).toBe('coward');
        expect(tacticOf({ archetype: 'assassin', tactic: 'nonsense' as Tactic })).toBe('hunter');
    });

    it('createCombat stores a valid supplied tactic only; old states without it derive at read time', () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet: casterSheet });
        const { state } = createCombat({
            id: 't', combatants: [
                { name: 'A', side: 'enemy', tier: 'grunt', tactic: 'coward' },
                { name: 'B', side: 'enemy', tier: 'grunt', tactic: 'bogus' as Tactic },
                { name: 'C', side: 'enemy', tier: 'grunt', archetype: 'assassin' },
            ],
        }, pc, 3);
        const by = (name: string) => Object.values(state.combatants).find(c => c.name === name)!;
        expect(by('A').tactic).toBe('coward');
        expect('tactic' in by('B')).toBe(false);
        expect('tactic' in by('C')).toBe(false);
        expect(planTurn(state, by('C').id).tactic).toBe('hunter');
        const reloaded = JSON.parse(JSON.stringify(state)) as CombatState;
        expect(planTurn(reloaded, by('A').id)).toEqual(planTurn(state, by('A').id));
    });
});

describe('plan shape', () => {
    it('is pure and repeatable, does not touch the rng, and always ends the turn', () => {
        const s = board(open(), [enemy('e', at(2, 2), { tier: 'elite' }), hero(at(9, 7)), ally('a', at(8, 8))]);
        const a = planTurn(s, 'e');
        const b = planTurn(JSON.parse(JSON.stringify(s)) as CombatState, 'e');
        expect(a).toEqual(b);
        expect(a.steps[a.steps.length - 1]).toEqual({ type: 'end_turn', actorId: 'e' });
        expect(s.rngCursor).toBe(0);
    });
});
