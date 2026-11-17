import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, COMBAT_EVENT_TYPES, freshTurn, MARK_EVENT_TYPES, marksOf } from '@narrative/engine';
import type { CombatEvent, CombatState, Combatant, ElementId, GlyphAbility, PlacedEffect, TileMarkId } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, narrationLine, stateAtSeq } from '../combatEvents';

const SHEET = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };

function ability(element: ElementId, form: 'burst' | 'touch'): GlyphAbility {
    return { id: `a-${element}`, name: `${element} ${form}`, element, form: { id: form, augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' };
}

function foe(id: string, x: number, y: number, overrides: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 99, hp: 99, ac: 0, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], position: { x, y }, range: 'close', ...overrides,
    };
}

function world(element: ElementId, form: 'burst' | 'touch', target: Partial<Combatant> = {}, fx = 8): CombatState {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet: SHEET, kit: [ability(element, form)] }), position: { x: 5, y: 5 }, hp: 99, maxHp: 99 };
    const base: CombatState = {
        id: 'w', round: 1, order: ['pc', 'f'], turnIndex: 0, combatants: { pc, f: foe('f', fx, 5, target) },
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 16, height: 12, tiles: new Array(16 * 12).fill('floor') },
    };
    return { ...base, turn: freshTurn(base, 'pc') };
}

function withMark(state: CombatState, mark: TileMarkId, tiles: Array<{ x: number; y: number }>): CombatState {
    const n = (state.nextPlaced ?? 89) + 1;
    const record: PlacedEffect = {
        id: `placed${n}`, kind: 'mark', mark, ownerId: 'pc', side: 'player', name: 'Old', trigger: 'enter', tiles, element: 'fire', placedRound: 1, expiresRound: 5,
    };
    return { ...state, placed: [...(state.placed ?? []), record], nextPlaced: n };
}

function land(state: CombatState, element: ElementId, aim: { x: number; y: number }, wanted: (e: CombatEvent) => boolean): { before: CombatState; after: CombatState; events: CombatEvent[] } {
    let cursor = 0;
    for (; cursor < 300; cursor++) {
        const probe = applyAction({ ...state, rngCursor: cursor }, { type: 'use_ability', actorId: 'pc', abilityId: `a-${element}`, aim });
        if (probe.events.some(wanted)) break;
    }
    const before = { ...state, rngCursor: cursor };
    const r = applyAction(before, { type: 'use_ability', actorId: 'pc', abilityId: `a-${element}`, aim });
    return { before, after: r.state, events: r.events };
}

const flat = (list: readonly PlacedEffect[] | undefined) => (list ?? []).map(p => `${p.id}:${p.mark}:${p.tiles.map(t => `${t.x},${t.y}`).sort().join('|')}`).sort();

describe('tile mark events in the host log', () => {
    it('are narrated types, and the lists still match', () => {
        for (const type of MARK_EVENT_TYPES) expect(NARRATED_EVENT_TYPES).toContain(type);
        expect([...NARRATED_EVENT_TYPES].sort()).toEqual([...COMBAT_EVENT_TYPES].sort());
    });

    it('stateAtSeq undoes a fire burst leaving flames', () => {
        const { before, after, events } = land(world('fire', 'burst'), 'fire', { x: 8, y: 5 }, e => e.type === 'ability_damage');
        expect(marksOf(after)).toHaveLength(1);
        const undone = stateAtSeq(after, events, before.eventSeq);
        expect(marksOf(undone)).toHaveLength(0);
        expect(undone.combatants.f.hp).toBe(99);
        for (const e of events.filter(x => MARK_EVENT_TYPES.includes(x.type) || x.type === 'placed')) expect(typeof narrationLine(e, after)).toBe('string');
    });

    it('stateAtSeq undoes a water burst dousing and cooling marks', () => {
        const start = withMark(withMark(world('water', 'burst'), 'flames', [{ x: 7, y: 5 }, { x: 8, y: 5 }, { x: 12, y: 5 }]), 'molten', [{ x: 9, y: 5 }]);
        const placedBefore = flat(start.placed);
        const { before, after, events } = land(start, 'water', { x: 8, y: 5 }, e => e.type === 'reaction');
        expect(events.filter(e => e.type === 'reaction').map(e => e.data.reaction).sort()).toEqual(['cool', 'douse']);
        expect(flat(after.placed)).not.toEqual(placedBefore);
        expect(flat(stateAtSeq(after, events, before.eventSeq).placed)).toEqual(placedBefore);
        for (const e of events.filter(x => x.type === 'reaction')) expect(typeof narrationLine(e, after)).toBe('string');
    });

    it('stateAtSeq undoes a walk through flames and a slide on slick ground', () => {
        const column = (x: number) => [2, 3, 4, 5, 6, 7, 8].map(y => ({ x, y }));
        const start = withMark(withMark({ ...world('fire', 'burst', { controller: 'player' }, 11), turn: { actorId: 'f', moveLeft: 6, actionUsed: false }, turnIndex: 1 }, 'flames', column(9)), 'slick', column(7));
        const r = applyAction(start, { type: 'move', actorId: 'f', to: { x: 6, y: 5 } });
        expect(r.events.some(e => e.type === 'mark_harm')).toBe(true);
        expect(r.events.some(e => e.type === 'pushed' && e.data.kind === 'slide')).toBe(true);
        expect(r.state.combatants.f.hp).toBeLessThan(99);
        const undone = stateAtSeq(r.state, r.events, start.eventSeq);
        expect(undone.combatants.f.hp).toBe(99);
        expect(undone.combatants.f.position).toEqual({ x: 11, y: 5 });
        for (const e of r.events.filter(x => x.type === 'mark_harm')) expect(typeof narrationLine(e, r.state)).toBe('string');
    });

    it('stateAtSeq undoes a start-of-turn burn from the ground', () => {
        const start = withMark(world('fire', 'burst', {}, 11), 'flames', [{ x: 11, y: 5 }]);
        const r = applyAction(start, { type: 'end_turn', actorId: 'pc' });
        expect(r.state.combatants.f.hp).toBe(98);
        expect(stateAtSeq(r.state, r.events, start.eventSeq).combatants.f.hp).toBe(99);
    });

    it('stateAtSeq undoes ice deepening the chill of a soaked unit', () => {
        const { before, after, events } = land(
            world('ice', 'touch', { conditions: [{ id: 'soaked', turns: 2 }] }, 6), 'ice', { x: 6, y: 5 }, e => e.type === 'reaction',
        );
        expect(after.combatants.f.conditions.find(c => c.id === 'slowed')?.turns).toBe(2);
        const undone = stateAtSeq(after, events, before.eventSeq).combatants.f;
        expect(undone.conditions.some(c => c.id === 'slowed')).toBe(false);
        expect(undone.conditions.some(c => c.id === 'soaked')).toBe(true);
    });
});
