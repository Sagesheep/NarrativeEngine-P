import { describe, it, expect } from 'vitest';
import {
    ORDER_KINDS, ORDER_PROFILES, SIGNATURE_BUDGET, SIGNATURE_SURCHARGE, signatureCost, abilityCost, glyphCount, activeOrder, applyAction, applyOrders, buildPcCombatant, cleanLine, createCombat,
    currentActorId, directorBrief, isDirected, normalizeOrderKind, normalizeSignatureRequest, planTurn, runEngineTurns, signatureReady, stepEngine,
    tacticOf, undoDirectorEvent, validateSignature, yetToAct, ORDER_LIMITS, COMBAT_EVENT_TYPES,
} from '../index';
import type {
    CombatAction, CombatEvent, CombatState, Combatant, DirectorOrder, GlyphAbility, OrderRejectReason, Pos, SignatureSpec, Tile, TurnPlan,
} from '../index';
import { arena, foe, glyph, openGrid, caster } from './glyphFixtures';

const at = (x: number, y: number): Pos => ({ x, y });

function officer(id: string, pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return foe(id, pos, { tier: 'elite', ac: 12, maxHp: 30, hp: 30, attackBonus: 5, damage: { count: 1, sides: 8, bonus: 2, type: 'slashing' }, ...extra });
}

function hero(pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return caster([], pos, { maxHp: 30, hp: 30, ...extra });
}

function friend(id: string, pos: Pos, extra: Partial<Combatant> = {}): Combatant {
    return foe(id, pos, { side: 'ally', ac: 12, ...extra });
}

const first = (plan: TurnPlan): CombatAction | undefined => plan.steps.find(s => s.type !== 'move' && s.type !== 'end_turn');

function finalTile(state: CombatState, plan: TurnPlan): Pos {
    let p = state.combatants[plan.actorId].position as Pos;
    for (const s of plan.steps) if (s.type === 'move') p = s.to;
    return p;
}

function ordered(state: CombatState, order: DirectorOrder): CombatState {
    const r = applyOrders(state, [order]);
    expect(r.rejected).toEqual([]);
    return r.state;
}

const SPEC: SignatureSpec = { name: 'Crushing Blow', form: 'touch', augments: [], effects: [{ id: 'damage', augments: ['amplify'] }] };

describe('directed units', () => {
    it('is the flag, or elite and above when the flag is absent', () => {
        expect(isDirected(officer('a', at(1, 1)))).toBe(true);
        expect(isDirected(foe('g', at(1, 1)))).toBe(false);
        expect(isDirected(foe('g', at(1, 1), { directed: true }))).toBe(true);
        expect(isDirected(officer('a', at(1, 1), { directed: false }))).toBe(false);
        expect(isDirected(foe('b', at(1, 1), { tier: 'boss' }))).toBe(true);
        expect(isDirected(foe('l', at(1, 1), { tier: 'legendary' }))).toBe(true);
    });

    it('is never a unit the player controls, the player character, a neutral or a summon', () => {
        expect(isDirected(officer('a', at(1, 1), { controller: 'player' }))).toBe(false);
        expect(isDirected(hero(at(1, 1), { directed: true }))).toBe(false);
        expect(isDirected(officer('n', at(1, 1), { side: 'neutral', directed: true }))).toBe(false);
        expect(isDirected(officer('s', at(1, 1), { summonerId: 'x', directed: true }))).toBe(false);
        expect(isDirected(friend('f', at(1, 1), { tier: 'elite' }))).toBe(true);
    });
});

describe('applyOrders', () => {
    const base = () => arena([officer('e', at(5, 5)), hero(at(8, 5)), friend('f', at(4, 5)), officer('e2', at(6, 8))]);

    it('records an accepted order and emits one order_given event', () => {
        const s = base();
        const r = applyOrders(s, [{ unitId: 'e', kind: 'focus', targetId: 'pc', line: '  Take   her down!  ' }]);
        expect(r.rejected).toEqual([]);
        expect(r.events).toHaveLength(1);
        const ev = r.events[0];
        expect(ev.type).toBe('order_given');
        expect(ev.actorId).toBe('e');
        expect(ev.targetId).toBe('pc');
        expect(ev.seq).toBe(s.eventSeq + 1);
        expect(ev.data).toMatchObject({ kind: 'focus', targetId: 'pc', line: 'Take her down!', round: 1, previous: null });
        expect(ev.text).toBe('e orders: focus Kira.');
        expect(r.state.combatants.e.order).toEqual({ kind: 'focus', targetId: 'pc', round: 1 });
        expect(r.state.eventSeq).toBe(s.eventSeq + 1);
        expect(s.combatants.e.order).toBeUndefined();
        expect(COMBAT_EVENT_TYPES).toContain('order_given');
    });

    it('caps the spoken line and drops an empty one', () => {
        const long = 'x'.repeat(ORDER_LIMITS.lineMax + 50);
        expect(cleanLine(long)).toHaveLength(ORDER_LIMITS.lineMax);
        expect(cleanLine('   ')).toBeUndefined();
        expect(cleanLine(7)).toBeUndefined();
        const r = applyOrders(base(), [{ unitId: 'e', kind: 'hold', line: ' ' }]);
        expect('line' in r.events[0].data).toBe(false);
    });

    it('returns the same state when nothing is accepted', () => {
        const s = base();
        const r = applyOrders(s, [{ unitId: 'nobody', kind: 'hold' }]);
        expect(r.state).toBe(s);
        expect(r.events).toEqual([]);
    });

    it('accepts names for units and targets', () => {
        const r = applyOrders(base(), [{ unitId: 'E2', kind: 'focus', targetId: 'kira' }]);
        expect(r.rejected).toEqual([]);
        expect(r.state.combatants.e2.order).toMatchObject({ kind: 'focus', targetId: 'pc' });
    });

    const rejections: Array<[OrderRejectReason, (s: CombatState) => { state: CombatState; order: DirectorOrder }]> = [
        ['unknown_unit', s => ({ state: s, order: { unitId: 'ghost', kind: 'hold' } })],
        ['not_standing', s => ({ state: { ...s, combatants: { ...s.combatants, e: { ...s.combatants.e, status: 'down' } } }, order: { unitId: 'e', kind: 'hold' } })],
        ['not_directed', s => ({ state: s, order: { unitId: 'f', kind: 'hold' } })],
        ['not_directed', s => ({ state: s, order: { unitId: 'pc', kind: 'hold' } })],
        ['unknown_kind', s => ({ state: s, order: { unitId: 'e', kind: 'dance' } })],
        ['missing_target', s => ({ state: s, order: { unitId: 'e', kind: 'focus' } })],
        ['missing_target', s => ({ state: s, order: { unitId: 'e', kind: 'protect' } })],
        ['unknown_target', s => ({ state: s, order: { unitId: 'e', kind: 'focus', targetId: 'ghost' } })],
        ['target_not_standing', s => ({ state: { ...s, combatants: { ...s.combatants, pc: { ...s.combatants.pc, status: 'down' } } }, order: { unitId: 'e', kind: 'focus', targetId: 'pc' } })],
        ['target_not_opponent', s => ({ state: s, order: { unitId: 'e', kind: 'focus', targetId: 'e2' } })],
        ['target_not_opponent', s => ({ state: s, order: { unitId: 'e', kind: 'focus', targetId: 'e' } })],
        ['target_is_self', s => ({ state: s, order: { unitId: 'e', kind: 'protect', targetId: 'e' } })],
        ['target_not_ally', s => ({ state: s, order: { unitId: 'e', kind: 'protect', targetId: 'pc' } })],
        ['target_not_standing', s => ({ state: { ...s, combatants: { ...s.combatants, e2: { ...s.combatants.e2, status: 'fled' } } }, order: { unitId: 'e', kind: 'protect', targetId: 'e2' } })],
        ['no_signature', s => ({ state: s, order: { unitId: 'e', kind: 'signature' } })],
        ['no_uses_left', s => ({ state: { ...s, combatants: { ...s.combatants, e: { ...s.combatants.e, signature: { abilityId: 'sig-e', usesLeft: 0 } } } }, order: { unitId: 'e', kind: 'signature' } })],
        ['unknown_tactic', s => ({ state: s, order: { unitId: 'e', kind: 'switch_tactic', tactic: 'dreamy' } })],
        ['unknown_tactic', s => ({ state: s, order: { unitId: 'e', kind: 'switch_tactic' } })],
        ['fight_over', s => ({ state: { ...s, outcome: 'victory' as const }, order: { unitId: 'e', kind: 'hold' } })],
    ];

    for (const [reason, build] of rejections) {
        it(`rejects with ${reason}`, () => {
            const { state, order } = build(base());
            const r = applyOrders(state, [order]);
            expect(r.rejected).toHaveLength(1);
            expect(r.rejected[0].reason).toBe(reason);
            expect(r.rejected[0].text.length).toBeGreaterThan(0);
            expect(r.events).toEqual([]);
            expect(r.state).toBe(state);
        });
    }

    it('rejects a second order for the same unit this call, and keeps the first', () => {
        const r = applyOrders(base(), [{ unitId: 'e', kind: 'hold' }, { unitId: 'e', kind: 'press' }, { unitId: 'e2', kind: 'press' }]);
        expect(r.rejected.map(x => x.reason)).toEqual(['duplicate']);
        expect(r.state.combatants.e.order?.kind).toBe('hold');
        expect(r.events).toHaveLength(2);
        expect(r.events[1].seq).toBe(r.events[0].seq + 1);
    });

    it('rejects a unit that has already acted when asked to', () => {
        const s = base();
        const acted = { ...s, turn: { ...(s.turn as NonNullable<CombatState['turn']>), actionUsed: true } };
        expect(yetToAct(acted, 'e')).toBe(false);
        expect(yetToAct(s, 'e')).toBe(true);
        expect(yetToAct(s, 'e2')).toBe(true);
        const r = applyOrders(acted, [{ unitId: 'e', kind: 'hold' }, { unitId: 'e2', kind: 'hold' }], { onlyUnacted: true });
        expect(r.rejected.map(x => x.reason)).toEqual(['already_acted']);
        expect(r.state.combatants.e2.order?.kind).toBe('hold');
        const later = applyOrders(acted, [{ unitId: 'e', kind: 'hold' }]);
        expect(later.rejected).toEqual([]);
    });

    it('accepts an order for a stunned unit, which still loses the turn', () => {
        const s = arena([hero(at(8, 5)), officer('e', at(5, 5), { conditions: [{ id: 'stunned', turns: 1 }] })]);
        const r = applyOrders(s, [{ unitId: 'e', kind: 'press' }]);
        expect(r.rejected).toEqual([]);
        const done = applyAction(r.state, { type: 'end_turn', actorId: 'pc' });
        expect(done.events.some(e => e.type === 'turn_lost' && e.actorId === 'e')).toBe(true);
    });

    it('never reads the rng and never moves the cursor', () => {
        const s = { ...base(), rngCursor: 41 };
        const r = applyOrders(s, [{ unitId: 'e', kind: 'focus', targetId: 'pc' }, { unitId: 'e2', kind: 'switch_tactic', tactic: 'coward' }]);
        expect(r.state.rngCursor).toBe(41);
        expect(r.state.rngSeed).toBe(s.rngSeed);
    });

    it('normalizes order kinds', () => {
        expect(normalizeOrderKind(' Fall Back ')).toBe('fall_back');
        expect(normalizeOrderKind('switch-tactic')).toBe('switch_tactic');
        expect(normalizeOrderKind('retreat')).toBeUndefined();
        expect(normalizeOrderKind(3)).toBeUndefined();
        expect([...ORDER_KINDS].sort()).toEqual(Object.keys(ORDER_PROFILES).sort());
    });
});

describe('each order changes the plan as stated', () => {
    it('focus: attacks the named target instead of the natural one', () => {
        const mk = () => arena([officer('e', at(5, 5)), hero(at(6, 5)), friend('a', at(4, 5))]);
        const natural = first(planTurn(mk(), 'e')) as { targetId: string };
        const other = natural.targetId === 'pc' ? 'a' : 'pc';
        const plan = planTurn(ordered(mk(), { unitId: 'e', kind: 'focus', targetId: other }), 'e');
        expect(first(plan)).toMatchObject({ type: 'attack', targetId: other });
        expect(natural.targetId).not.toBe(other);
    });

    it('focus: closes on a distant target rather than the nearer one', () => {
        const mk = () => arena([officer('e', at(2, 5)), friend('near', at(4, 5)), friend('far', at(12, 5)), hero(at(14, 9))]);
        const plan = planTurn(ordered(mk(), { unitId: 'e', kind: 'focus', targetId: 'far' }), 'e');
        const s = mk();
        const dest = finalTile(s, plan);
        const natural = finalTile(s, planTurn(s, 'e'));
        expect(Math.abs(dest.x - 12)).toBeLessThan(Math.abs(natural.x - 12) + 1);
        expect(dest.x).toBeGreaterThan(natural.x);
    });

    it('protect: stays near the protected ally instead of chasing', () => {
        const mk = () => arena([officer('e', at(3, 5)), foe('v', at(2, 8), { tier: 'grunt' }), hero(at(13, 5))]);
        const s = mk();
        const free = finalTile(s, planTurn(s, 'e'));
        const guarded = ordered(mk(), { unitId: 'e', kind: 'protect', targetId: 'v' });
        const dest = finalTile(guarded, planTurn(guarded, 'e'));
        expect(dest.x).toBeLessThan(free.x);
        expect(Math.max(Math.abs(dest.x - 2), Math.abs(dest.y - 8))).toBeLessThanOrEqual(3);
    });

    it('hold: does not advance', () => {
        const mk = () => arena([officer('e', at(2, 5)), hero(at(12, 5), { range: 'close' })]);
        const s = mk();
        expect(finalTile(s, planTurn(s, 'e')).x).toBeGreaterThan(2);
        const held = ordered(mk(), { unitId: 'e', kind: 'hold' });
        expect(finalTile(held, planTurn(held, 'e'))).toEqual(at(2, 5));
    });

    it('hold: still strikes a foe that is already adjacent', () => {
        const held = ordered(arena([officer('e', at(5, 5)), hero(at(6, 5))]), { unitId: 'e', kind: 'hold' });
        const plan = planTurn(held, 'e');
        expect(finalTile(held, plan)).toEqual(at(5, 5));
        expect(first(plan)).toMatchObject({ type: 'attack', targetId: 'pc' });
    });

    it('fall_back: breaks contact toward allies instead of standing and fighting', () => {
        const mk = () => arena([officer('e', at(8, 5)), hero(at(9, 5)), friend('f', at(3, 5))]);
        const s = mk();
        expect(finalTile(s, planTurn(s, 'e'))).toEqual(at(8, 5));
        const back = ordered(mk(), { unitId: 'e', kind: 'fall_back' });
        const dest = finalTile(back, planTurn(back, 'e'));
        expect(dest.x).toBeLessThan(8);
        expect(Math.abs(dest.x - 9)).toBeGreaterThan(1);
    });

    it('press: keeps fighting where an elite coward would retreat, and ignores a weak position', () => {
        const mk = (extra: Partial<Combatant>) => arena([officer('e', at(6, 5), { tactic: 'coward', hp: 6, ...extra }), hero(at(7, 5)), friend('a', at(1, 1))]);
        expect(planTurn(mk({}), 'e').intent.kind).toBe('retreat');
        const pressed = ordered(mk({}), { unitId: 'e', kind: 'press' });
        const plan = planTurn(pressed, 'e');
        expect(plan.intent.kind).toBe('attack');
        expect(first(plan)).toMatchObject({ type: 'attack', targetId: 'pc' });
    });

    it('signature: uses the signature move this turn where the unit would otherwise swing its weapon', () => {
        const mk = () => {
            const spec = createCombat({ id: 's', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', signature: { name: 'Stunning Grasp', form: 'touch', effects: [{ id: 'slow' }] } }] }, buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } }), 9);
            const state = spec.state;
            const vey = Object.values(state.combatants).find(c => c.name === 'Vey') as Combatant;
            const pc = state.combatants.pc;
            return arena([{ ...vey, position: at(5, 5) }, { ...pc, position: at(6, 5), hp: 30, maxHp: 30 }]);
        };
        const s = mk();
        const id = Object.values(s.combatants).find(c => c.name === 'Vey')?.id as string;
        expect(first(planTurn(s, id))).toMatchObject({ type: 'attack' });
        const plan = planTurn(ordered(s, { unitId: id, kind: 'signature' }), id);
        expect(first(plan)).toMatchObject({ type: 'use_ability', abilityId: `sig-${id}` });
    });

    it('signature: with no legal use the order is the same as no order', () => {
        const s = arena([officer('e', at(2, 5), { kit: [], signature: { abilityId: 'sig-e', usesLeft: 1 } }), hero(at(12, 5))]);
        const plain = planTurn(s, 'e');
        const orderedPlan = planTurn(ordered(s, { unitId: 'e', kind: 'signature' }), 'e');
        expect(orderedPlan).toEqual(plain);
    });

    it('switch_tactic: sets the tactic and keeps it after the round', () => {
        const s = arena([officer('e', at(5, 5)), hero(at(8, 5))]);
        expect(tacticOf(s.combatants.e)).toBe('aggressive');
        const r = applyOrders(s, [{ unitId: 'e', kind: 'switch_tactic', tactic: 'Coward' }]);
        expect(tacticOf(r.state.combatants.e)).toBe('coward');
        expect(r.state.combatants.e.order).toEqual({ kind: 'switch_tactic', tactic: 'coward', round: 1 });
        const later = { ...r.state, round: 2 };
        expect(activeOrder(later, later.combatants.e)).toBeNull();
        expect(tacticOf(later.combatants.e)).toBe('coward');
        expect(r.events[0].data).toMatchObject({ tactic: 'coward', tacticBefore: null });
    });
});

describe('orders lapse and never override', () => {
    it('lapses after the round it names', () => {
        const s = arena([officer('e', at(2, 5)), hero(at(12, 5))]);
        const held = ordered(s, { unitId: 'e', kind: 'hold' });
        expect(activeOrder(held, held.combatants.e)).toMatchObject({ kind: 'hold' });
        const next = { ...held, round: 2 };
        expect(activeOrder(next, next.combatants.e)).toBeNull();
        const noOrder = { ...s, round: 2 };
        expect(planTurn(next, 'e')).toEqual(planTurn(noOrder, 'e'));
        expect(planTurn(held, 'e')).not.toEqual(planTurn(s, 'e'));
    });

    it('lapses when the focus target is no longer standing', () => {
        const s = arena([officer('e', at(5, 5)), hero(at(6, 5)), friend('a', at(4, 5))]);
        const focused = ordered(s, { unitId: 'e', kind: 'focus', targetId: 'a' });
        const gone = { ...focused, combatants: { ...focused.combatants, a: { ...focused.combatants.a, status: 'down' as const } } };
        const plain = { ...s, combatants: { ...s.combatants, a: { ...s.combatants.a, status: 'down' as const } } };
        expect(planTurn(gone, 'e')).toEqual(planTurn(plain, 'e'));
    });

    it('a routed unit still flees under press', () => {
        const s = arena([officer('e', at(6, 5), { routed: true }), hero(at(7, 5)), friend('a', at(1, 1))]);
        const pressed = ordered(s, { unitId: 'e', kind: 'press' });
        expect(planTurn(pressed, 'e').intent.kind).toBe('retreat');
    });

    it('a stunned or fallen unit does not act; a yielded unit takes no order', () => {
        const s = arena([officer('e', at(6, 5), { status: 'surrendered' }), hero(at(7, 5))]);
        expect(applyOrders(s, [{ unitId: 'e', kind: 'press' }]).rejected[0].reason).toBe('not_standing');
        const planned = planTurn({ ...s, combatants: { ...s.combatants, e: { ...s.combatants.e, order: { kind: 'press', round: 1 } } } }, 'e');
        expect(planned.steps).toEqual([{ type: 'end_turn', actorId: 'e' }]);
    });

    it('every planned step under every order is legal', () => {
        let steps = 0;
        for (let i = 0; i < 30; i++) {
            const kinds = ORDER_KINDS.filter(k => k !== 'signature');
            const kind = kinds[i % kinds.length];
            const started = createCombat(
                { id: `o${i}`, combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', signature: SPEC }, { name: 'Pawn', side: 'enemy', tier: 'grunt' }], map: { size: 'small', area: i % 2 ? 'scattered' : 'ruins', density: 'normal' } },
                buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false }, weapon: { quality: 'common' } }),
                100 + i,
            );
            let s = started.state;
            const vey = Object.values(s.combatants).find(c => c.name === 'Vey') as Combatant;
            for (let n = 0; n < 200 && !s.outcome; n++) {
                const id = currentActorId(s) as string;
                const actor = s.combatants[id];
                if (actor.controller === 'player') {
                    const plan = planTurn(s, id);
                    s = applyAction(s, plan.steps[0]).state;
                    continue;
                }
                if (id === vey.id) {
                    const target = Object.values(s.combatants).find(c => c.side === 'player' && c.status === 'up');
                    const order: DirectorOrder = { unitId: id, kind: n % 7 === 0 ? 'signature' : kind, ...(kind === 'focus' && target ? { targetId: target.id } : {}), ...(kind === 'switch_tactic' ? { tactic: 'hunter' } : {}) };
                    s = applyOrders(s, [order]).state;
                }
                const plan = planTurn(s, id);
                const res = applyAction(s, plan.steps[0]);
                steps++;
                expect(res.events.some(e => e.type === 'rejected')).toBe(false);
                s = res.state;
            }
        }
        expect(steps).toBeGreaterThan(100);
    });

    it('planning under orders never moves the rng cursor', () => {
        const s = { ...arena([officer('e', at(5, 5)), hero(at(8, 5)), friend('a', at(4, 4))]), rngCursor: 17 };
        for (const kind of ORDER_KINDS) {
            const order: DirectorOrder = { unitId: 'e', kind, targetId: kind === 'focus' ? 'pc' : 'a', tactic: 'hunter' };
            const r = applyOrders(s, [order]);
            const state = r.state;
            const plan = planTurn(state, 'e');
            expect(state.rngCursor).toBe(17);
            expect(planTurn(state, 'e')).toEqual(plan);
        }
    });

    it('a fight with an objective still ends by its rules while orders are given', () => {
        const started = createCombat(
            { id: 'ob', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite' }], map: { size: 'small', area: 'open', density: 'sparse' }, objective: { win: 'survive', rounds: 3 } },
            buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false }, weapon: { quality: 'common' } }),
            5,
        );
        let s = started.state;
        for (let n = 0; n < 400 && !s.outcome; n++) {
            const id = currentActorId(s) as string;
            if (s.combatants[id].controller === 'player') s = applyAction(s, planTurn(s, id).steps[0]).state;
            else {
                s = applyOrders(s, [{ unitId: id, kind: 'press' }]).state;
                s = (stepEngine(s) as { state: CombatState }).state;
            }
        }
        expect(s.outcome).not.toBeNull();
        expect(s.objective?.result).toBeDefined();
    });
});

describe('signature moves', () => {
    const unit = { id: 'v', name: 'Vey' };

    it('builds an ability within budget and reports no repair', () => {
        const slow: SignatureSpec = { name: 'Crushing Blow', form: 'touch', effects: [{ id: 'damage' }, { id: 'slow' }] };
        const r = validateSignature({ ...unit, tier: 'elite' }, slow);
        expect(r.repairs).toEqual([]);
        expect(r.ability).toMatchObject({ id: 'sig-v', name: 'Crushing Blow', source: 'ai' });
        expect(r.signature).toEqual({ abilityId: 'sig-v', usesLeft: SIGNATURE_BUDGET.elite?.uses });
        expect(signatureCost(r.ability as GlyphAbility)).toBeLessThanOrEqual(SIGNATURE_BUDGET.elite?.cost as number);
        expect(abilityCost(r.ability as GlyphAbility)).toBe(2);
    });

    it('has uses per tier: elite 1, boss 2, legendary 2', () => {
        const uses = (tier: 'elite' | 'boss' | 'legendary') => validateSignature({ ...unit, tier }, SPEC).signature?.usesLeft;
        expect([uses('elite'), uses('boss'), uses('legendary')]).toEqual([1, 2, 2]);
    });

    it('trims a chain over budget from the end until it fits, and says so', () => {
        const big: SignatureSpec = {
            name: 'Ruin', form: 'touch', augments: ['quicken'],
            effects: [{ id: 'damage', augments: ['amplify'] }, { id: 'slow', augments: ['extend'] }, { id: 'push' }],
        };
        const r = validateSignature({ ...unit, tier: 'elite' }, big);
        expect(r.ability).not.toBeNull();
        expect(r.repairs.map(x => x.code)).toEqual(['trimmed']);
        expect(signatureCost(r.ability as GlyphAbility)).toBeLessThanOrEqual(SIGNATURE_BUDGET.elite?.cost as number);
        const kept = r.ability as GlyphAbility;
        expect(kept.form).toEqual({ id: 'touch', augments: [] });
        expect(kept.effects).toEqual([{ id: 'damage', augments: [] }]);
        expect(r.repairs[0].text).toContain('trimmed');
        const roomier = validateSignature({ ...unit, tier: 'legendary' }, big);
        expect(roomier.repairs.map(x => x.code)).toEqual(['trimmed']);
        expect(glyphCount(roomier.ability as GlyphAbility)).toBeGreaterThan(glyphCount(kept));
        expect(glyphCount(roomier.ability as GlyphAbility)).toBeLessThanOrEqual(SIGNATURE_BUDGET.legendary?.glyphs as number);
        expect(signatureCost(roomier.ability as GlyphAbility)).toBeLessThanOrEqual(SIGNATURE_BUDGET.legendary?.cost as number);
        const fits = validateSignature({ ...unit, tier: 'legendary' }, { name: 'Roar', form: 'cone', effects: [{ id: 'damage' }] });
        expect(fits.repairs).toEqual([]);
        expect(fits.ability?.effects.map(e => e.id)).toEqual(['damage']);
    });

    it('prices survival effects higher so a self-heal does not fit a low tier', () => {
        const heal: SignatureSpec = { name: 'Second Wind', form: 'self', effects: [{ id: 'heal' }] };
        expect(signatureCost(glyph('self', ['heal']))).toBe(abilityCost(glyph('self', ['heal'])) + SIGNATURE_SURCHARGE.heal!);
        expect(validateSignature({ ...unit, tier: 'elite' }, heal).repairs.map(x => x.code)).toEqual(['over_budget_dropped']);
        expect(validateSignature({ ...unit, tier: 'legendary' }, heal).ability).not.toBeNull();
    });

    it('lets a grunt carry only a one-effect signature', () => {
        expect(validateSignature({ ...unit, tier: 'grunt' }, { name: 'Jab', form: 'touch', effects: [{ id: 'slow' }] }).repairs).toEqual([]);
        expect(validateSignature({ ...unit, tier: 'grunt' }, { name: 'Jab', form: 'touch', effects: [{ id: 'damage' }, { id: 'slow' }] }).repairs.map(x => x.code)).toEqual(['trimmed']);
    });

    it('drops a chain that cannot fit even when trimmed to its core', () => {
        const r = validateSignature({ ...unit, tier: 'elite' }, { name: 'Overkill', form: 'burst', augments: ['widen', 'widen'], effects: [{ id: 'stun' }] });
        expect(r.ability).toBeNull();
        expect(r.signature).toBeNull();
        expect(r.repairs[r.repairs.length - 1].code).toBe('over_budget_dropped');
    });

    it('drops an invalid chain and removes unknown or unusable glyphs', () => {
        expect(validateSignature({ ...unit, tier: 'elite' }, { name: 'X', form: 'wave' as 'touch', effects: [{ id: 'damage' }] }).repairs[0].code).toBe('invalid_dropped');
        expect(validateSignature({ ...unit, tier: 'elite' }, { name: 'X', form: 'touch', effects: [] }).repairs[0].code).toBe('invalid_dropped');
        const mixed = validateSignature({ ...unit, tier: 'boss' }, {
            name: 'Odd', form: 'touch', augments: ['pierce', 'bogus' as 'split'],
            effects: [{ id: 'fireball' as 'damage' }, { id: 'blink' }, { id: 'weapon' as 'damage' }, { id: 'damage' }, { id: 'damage' }],
        });
        const codes = mixed.repairs.map(x => x.code);
        expect(codes).toContain('unknown_glyph');
        expect(codes).toContain('unusable_effect');
        expect(mixed.ability?.effects.map(e => e.id)).toEqual(['damage']);
        expect(mixed.ability?.form.augments).toEqual([]);
    });

    it('gives a default name and drops tiers with no budget', () => {
        const unnamed = validateSignature({ ...unit, tier: 'elite' }, { name: '  ', form: 'touch', effects: [{ id: 'damage' }] });
        expect(unnamed.ability?.name).toBe('Signature move');
        expect(unnamed.repairs.map(x => x.code)).toEqual(['name_defaulted']);
        const minion = validateSignature({ ...unit, tier: 'minion' }, SPEC);
        expect(minion.ability).toBeNull();
        expect(minion.repairs[0]).toMatchObject({ code: 'no_budget', unitId: 'v', unitName: 'Vey' });
    });

    it('normalizes a loose request', () => {
        expect(normalizeSignatureRequest(null)).toBeNull();
        expect(normalizeSignatureRequest({})).toBeNull();
        expect(normalizeSignatureRequest({ name: 'Rend', form: 'Touch', effects: ['Damage', { id: 'slow', augments: 'extend' }] })).toEqual({
            name: 'Rend', form: 'touch', augments: [], effects: [{ id: 'damage', augments: [] }, { id: 'slow', augments: ['extend'] }],
        });
    });

    it('createCombat adds the ability to the kit, sets the uses, reports repairs and keeps a plain fight unchanged', () => {
        const pc = buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
        const plain = createCombat({ id: 'p', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite' }, { name: 'Pawn', side: 'enemy', tier: 'minion' }], mapSeed: 3 }, pc, 4);
        expect(plain.signatureRepairs).toBeUndefined();
        const both = createCombat({
            id: 'p', mapSeed: 3,
            combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', signature: SPEC }, { name: 'Pawn', side: 'enemy', tier: 'minion', signature: SPEC }],
        }, pc, 4);
        expect(both.state.rngCursor).toBe(plain.state.rngCursor);
        expect(both.state.order).toEqual(plain.state.order);
        const vey = Object.values(both.state.combatants).find(c => c.name === 'Vey') as Combatant;
        const pawn = Object.values(both.state.combatants).find(c => c.name === 'Pawn') as Combatant;
        expect(vey.signature).toEqual({ abilityId: `sig-${vey.id}`, usesLeft: 1 });
        expect(vey.kit?.map(a => a.id)).toContain(`sig-${vey.id}`);
        expect(pawn.signature).toBeUndefined();
        expect(both.signatureRepairs?.map(r => r.code)).toEqual(['trimmed', 'no_budget']);
        const strip = (s: CombatState) => ({ ...s.combatants[Object.keys(s.combatants).find(k => s.combatants[k].name === 'Vey') as string] });
        const a = strip(plain.state);
        const b = strip(both.state);
        expect({ ...b, kit: undefined, signature: undefined, proficiency: undefined, castingAbility: undefined, abilityDamage: undefined, id: undefined })
            .toEqual({ ...a, kit: undefined, signature: undefined, proficiency: undefined, castingAbility: undefined, abilityDamage: undefined, id: undefined });
    });

    it('is used up: uses fall, the ability stops being legal and the order is rejected', () => {
        const pc = buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
        const made = createCombat({ id: 'u', mapSeed: 3, combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', signature: SPEC }] }, pc, 4);
        const vey = Object.values(made.state.combatants).find(c => c.name === 'Vey') as Combatant;
        let s: CombatState = arena([
            { ...vey, position: at(5, 5) },
            { ...made.state.combatants.pc, position: at(6, 5), hp: 80, maxHp: 80 },
        ]);
        const id = vey.id;
        expect(signatureReady(s, s.combatants[id])).toBe(true);
        const used = applyAction(s, { type: 'use_ability', actorId: id, abilityId: `sig-${id}`, aim: at(6, 5) });
        expect(used.events.some(e => e.type === 'rejected')).toBe(false);
        expect(used.state.combatants[id].signature?.usesLeft).toBe(0);
        const ability = used.events.find(e => e.type === 'ability');
        expect(ability?.data).toMatchObject({ signature: true, usesLeft: 0 });
        s = { ...used.state, combatants: { ...used.state.combatants, [id]: { ...used.state.combatants[id], cooldowns: {} } }, turn: { actorId: id, moveLeft: 6, actionUsed: false } };
        expect(signatureReady(s, s.combatants[id])).toBe(false);
        const again = applyAction(s, { type: 'use_ability', actorId: id, abilityId: `sig-${id}`, aim: at(6, 5) });
        expect(again.events[0]).toMatchObject({ type: 'rejected' });
        expect(applyOrders(s, [{ unitId: id, kind: 'signature' }]).rejected[0].reason).toBe('no_uses_left');
        const undone = { ...used.state.combatants };
        undoDirectorEvent(undone, ability as CombatEvent);
        expect(undone[id].signature?.usesLeft).toBe(1);
    });

    it('the order bonus is decisive but never aims a signature at friends', () => {
        const burst: SignatureSpec = { name: 'Sunder', form: 'burst', effects: [{ id: 'damage' }] };
        const pc = buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
        const made = createCombat({ id: 'u', mapSeed: 3, combatants: [{ name: 'Vey', side: 'enemy', tier: 'legendary', signature: burst }, { name: 'Pawn', side: 'enemy', tier: 'minion' }] }, pc, 4);
        const vey = Object.values(made.state.combatants).find(c => c.name === 'Vey') as Combatant;
        const pawn = Object.values(made.state.combatants).find(c => c.name === 'Pawn') as Combatant;
        const s = arena([
            { ...vey, position: at(5, 5) },
            { ...made.state.combatants.pc, position: at(7, 5), hp: 80, maxHp: 80 },
            { ...pawn, position: at(8, 5) },
        ]);
        const plan = planTurn(ordered(s, { unitId: vey.id, kind: 'signature' }), vey.id);
        const act = first(plan);
        if (act?.type === 'use_ability' && act.abilityId === `sig-${vey.id}`) {
            const aim = act.aim as Pos;
            expect(Math.max(Math.abs(aim.x - 8), Math.abs(aim.y - 5))).toBeGreaterThan(1);
        } else {
            expect(act).toBeDefined();
        }
    });
});

describe('directorBrief', () => {
    const build = () => {
        const dead = officer('dead', at(9, 9), { status: 'down' });
        const summon = foe('imp', at(10, 9), { summonerId: 'e', status: 'gone' });
        return arena([
            officer('e', at(5, 5), { hp: 12, signature: { abilityId: 'sig-e', usesLeft: 1 }, kit: [glyph('touch', ['damage'], [], { id: 'sig-e', name: 'Rend' })] }),
            hero(at(6, 5), { hp: 30 }),
            friend('f', at(2, 2), { tier: 'elite', hp: 29, maxHp: 30, conditions: [{ id: 'slowed', turns: 1 }] }),
            foe('grunt', at(12, 5), { tier: 'grunt', hp: 4, maxHp: 30 }),
            dead,
            summon,
        ], { grid: openGrid(16, 12, [], [[at(3, 3), 'wall' as Tile]]) });
    };

    it('lists standing units with bands, positions and conditions', () => {
        const b = directorBrief(build());
        expect(b.round).toBe(1);
        expect(b.units.map(u => u.id)).toEqual(['e', 'pc', 'f', 'grunt']);
        const byId = Object.fromEntries(b.units.map(u => [u.id, u]));
        expect(byId.e).toMatchObject({ hp: 'bloodied', at: { x: 5, y: 5 }, side: 'enemy', tier: 'elite', directed: true, tactic: 'aggressive' });
        expect(byId.pc.hp).toBe('full');
        expect(byId.f).toMatchObject({ hp: 'hurt', conditions: ['slowed'], directed: true });
        expect(byId.grunt.hp).toBe('near_death');
        expect(byId.grunt.directed).toBe(false);
        expect(byId.pc.tactic).toBeUndefined();
        expect(b.adjacent).toEqual([['e', 'pc']]);
        expect(b.objective).toBeNull();
    });

    it('gives each directed unit its legal orders, targets, reach and signature', () => {
        const b = directorBrief(build());
        expect(b.directed.map(d => d.id)).toEqual(['e', 'f']);
        const e = b.directed[0];
        expect(e.kinds).toEqual(['focus', 'protect', 'hold', 'fall_back', 'press', 'signature', 'switch_tactic']);
        expect(e.focus).toEqual(['pc', 'f']);
        expect(e.protect).toEqual(['grunt']);
        expect(e.tactics).not.toContain('aggressive');
        expect(e.tactics).toHaveLength(6);
        expect(e.signature).toEqual({ name: 'Rend', usesLeft: 1, ready: true });
        expect(e.foes).toEqual([{ id: 'pc', distance: 1, canHit: true }, { id: 'f', distance: 3, canHit: true }]);
        expect(e.allies).toEqual([{ id: 'grunt', distance: 7 }]);
        expect(e.order).toBeNull();
        const f = b.directed[1];
        expect(f.signature).toBeNull();
        expect(f.foes.map(x => x.id)).toEqual(['e', 'grunt']);
        expect(f.protect).toEqual(['pc']);
        expect(f.kinds).not.toContain('signature');
    });

    it('reports who can reach whom this turn', () => {
        const s = arena([officer('e', at(1, 1), { speed: 6 }), hero(at(14, 10)), foe('near', at(5, 1), { side: 'enemy' }), friend('f', at(4, 1))]);
        const e = directorBrief(s).directed[0];
        const far = e.foes.find(x => x.id === 'pc');
        expect(far).toMatchObject({ canHit: false });
        const close = directorBrief(arena([officer('e', at(1, 1), { speed: 6 }), hero(at(5, 1))])).directed[0];
        expect(close.foes[0]).toMatchObject({ id: 'pc', distance: 4, canHit: true });
    });

    it('shows the active order and nothing from a lapsed one', () => {
        const held = ordered(build(), { unitId: 'e', kind: 'focus', targetId: 'pc' });
        expect(directorBrief(held).directed[0].order).toEqual({ kind: 'focus', targetId: 'pc' });
        const next = { ...held, round: 2 };
        expect(directorBrief(next).directed[0].order).toBeNull();
    });

    it('carries the objective and clock compactly', () => {
        const started = createCombat(
            { id: 'b', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite' }], map: { size: 'small', area: 'open', density: 'sparse' }, objective: { win: 'survive', rounds: 4 }, reinforcements: 'some' },
            buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } }),
            3,
        );
        const b = directorBrief(started.state);
        expect(b.objective).toMatchObject({ win: 'survive', clock: { kind: 'survive', left: 4 } });
    });

    it('leaks nothing hidden', () => {
        const started = createCombat(
            { id: 'h', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', signature: SPEC }], map: { size: 'small', area: 'open', density: 'sparse' }, objective: { win: 'survive', rounds: 4 }, reinforcements: { waves: [{ round: 3, combatants: [{ name: 'Secret Reserve', side: 'enemy', tier: 'elite' }] }] } },
            buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } }),
            3,
        );
        const text = JSON.stringify(directorBrief(started.state));
        for (const word of ['Secret Reserve', 'maxHp', 'mp', 'cooldowns', 'kit', 'rng', 'abilities', 'damage', 'attackBonus', 'initiative', 'reinforcements', 'waves']) {
            expect(text).not.toContain(`"${word}"`);
        }
        expect(text).not.toContain('Secret Reserve');
        const s = build();
        const t = JSON.stringify(directorBrief(s));
        expect(t).not.toMatch(/"hp":\d/);
        expect(t).not.toContain('dead');
        expect(t).not.toContain('imp');
        const other = JSON.parse(JSON.stringify(directorBrief({ ...s, combatants: { ...s.combatants, grunt: { ...s.combatants.grunt, hp: 3, signature: { abilityId: 'x', usesLeft: 2 }, order: { kind: 'press', round: 1 } } } })));
        const grunt = other.units.find((u: { id: string }) => u.id === 'grunt');
        expect(grunt.hp).toBe('near_death');
        expect(Object.keys(grunt).sort()).toEqual(['at', 'conditions', 'controller', 'directed', 'hp', 'id', 'name', 'side', 'tactic', 'tier']);
        expect(other.directed.some((d: { id: string }) => d.id === 'grunt')).toBe(false);
    });

    it('is empty of directed units once the fight is over', () => {
        expect(directorBrief({ ...build(), outcome: 'victory' }).directed).toEqual([]);
    });
});

describe('stateAtSeq support', () => {
    it('undoes order_given events newest first, returning every unit to its earlier order and tactic', () => {
        const s0 = arena([officer('e', at(5, 5), { tactic: 'hunter' }), hero(at(8, 5)), friend('a', at(4, 5))]);
        const r1 = applyOrders(s0, [{ unitId: 'e', kind: 'focus', targetId: 'pc', line: 'Now!' }]);
        const r2 = applyOrders({ ...r1.state, round: 2 }, [{ unitId: 'e', kind: 'switch_tactic', tactic: 'coward' }]);
        const r3 = applyOrders(r2.state, [{ unitId: 'e', kind: 'hold' }]);
        const log = [...r1.events, ...r2.events, ...r3.events];
        const combatants: Record<string, Combatant> = {};
        for (const [id, c] of Object.entries(r3.state.combatants)) combatants[id] = { ...c };
        expect(tacticOf(combatants.e)).toBe('coward');
        for (const ev of [...log].sort((x, y) => y.seq - x.seq)) {
            expect(undoDirectorEvent(combatants, ev)).toBe(true);
            if (ev.seq === r3.events[0].seq) expect(combatants.e.order).toMatchObject({ kind: 'switch_tactic' });
        }
        expect(combatants.e.order).toBeUndefined();
        expect(combatants.e.tactic).toBe('hunter');
        expect(undoDirectorEvent(combatants, { seq: 99, round: 1, type: 'attack', data: {}, text: '' })).toBe(false);
    });

    it('undoing a switch from a derived tactic removes the stored one', () => {
        const s0 = arena([officer('e', at(5, 5)), hero(at(8, 5))]);
        const r = applyOrders(s0, [{ unitId: 'e', kind: 'switch_tactic', tactic: 'berserker' }]);
        const combatants = { ...r.state.combatants, e: { ...r.state.combatants.e } };
        undoDirectorEvent(combatants, r.events[0]);
        expect('tactic' in combatants.e).toBe(false);
        expect(combatants.e.order).toBeUndefined();
    });
});

describe('without orders and signatures nothing changes', () => {
    it('a fight with directed flags but no orders plays exactly like one without', () => {
        const run = (directed: boolean | undefined) => {
            const pc = buildPcCombatant({ name: 'PC', sheet: { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false }, weapon: { quality: 'common' } });
            const started = createCombat({ id: 'i', combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', ...(directed === undefined ? {} : { directed }) }, { name: 'Pawn', side: 'enemy', tier: 'grunt' }], map: { size: 'medium', area: 'scattered', density: 'normal' }, mapSeed: 77 }, pc, 12);
            let s = started.state;
            const log: CombatEvent[] = [...started.events];
            for (let n = 0; n < 300 && !s.outcome; n++) {
                const id = currentActorId(s) as string;
                const actor = s.combatants[id];
                if (actor.controller === 'player') {
                    const r = applyAction(s, planTurn(s, id).steps[0]);
                    log.push(...r.events);
                    s = r.state;
                    continue;
                }
                const step = runEngineTurns(s);
                log.push(...step.events);
                s = step.state;
            }
            return JSON.stringify({ log, s });
        };
        const plain = run(undefined);
        expect(run(true).replace(/"directed":true,?/g, '')).toBe(plain.replace(/"directed":true,?/g, ''));
        expect(run(false).replace(/"directed":false,?/g, '')).toBe(plain);
        expect(plain).not.toContain('"order":{');
        expect(plain).not.toContain('order_given');
    });

    it('does not mutate its input', () => {
        const s = arena([officer('e', at(5, 5)), hero(at(8, 5))]);
        const before = JSON.stringify(s);
        applyOrders(s, [{ unitId: 'e', kind: 'switch_tactic', tactic: 'coward' }]);
        expect(JSON.stringify(s)).toBe(before);
    });
});
