import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, COMBAT_EVENT_TYPES, freshTurn } from '@narrative/engine';
import type { CombatEvent, CombatState, Combatant, ElementId, GlyphAbility } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, narrationLine, stateAtSeq } from '../combatEvents';

const SHEET = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };

function bolt(element: ElementId): GlyphAbility {
    return { id: `t-${element}`, name: `${element} touch`, element, form: { id: 'touch', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' };
}

function foe(id: string, x: number, overrides: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 99, hp: 99, ac: 0, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], position: { x, y: 5 }, range: 'close', ...overrides,
    };
}

function world(element: ElementId, target: Partial<Combatant> = {}): CombatState {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet: SHEET, kit: [bolt(element)] }), position: { x: 5, y: 5 }, hp: 99, maxHp: 99 };
    const base: CombatState = {
        id: 'w', round: 1, order: ['pc', 'f'], turnIndex: 0, combatants: { pc, f: foe('f', 6, target) },
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 16, height: 12, tiles: new Array(16 * 12).fill('floor') },
    };
    return { ...base, turn: freshTurn(base, 'pc') };
}

function run(state: CombatState, element: ElementId): { before: CombatState; after: CombatState; events: CombatEvent[] } {
    let cursor = 0;
    for (; cursor < 200; cursor++) {
        const probe = applyAction({ ...state, rngCursor: cursor }, { type: 'use_ability', actorId: 'pc', abilityId: `t-${element}`, aim: { x: 6, y: 5 } });
        if (probe.events.some(e => e.type === 'ability_damage' || e.type === 'element_rider')) break;
    }
    const start = { ...state, rngCursor: cursor };
    const r = applyAction(start, { type: 'use_ability', actorId: 'pc', abilityId: `t-${element}`, aim: { x: 6, y: 5 } });
    return { before: start, after: r.state, events: r.events };
}

describe('element events in the host log', () => {
    it('are narrated types, and the lists still match', () => {
        for (const type of ['element_rider', 'burn', 'confused']) expect(NARRATED_EVENT_TYPES).toContain(type);
        expect([...NARRATED_EVENT_TYPES].sort()).toEqual([...COMBAT_EVENT_TYPES].sort());
    });

    it('stateAtSeq undoes a fire hit: hit points and the burning rider', () => {
        const { before, after, events } = run(world('fire'), 'fire');
        expect(after.combatants.f.conditions.some(c => c.id === 'burning')).toBe(true);
        const rewound = stateAtSeq(after, events, before.eventSeq);
        expect(rewound.combatants.f.hp).toBe(99);
        expect(rewound.combatants.f.conditions.some(c => c.id === 'burning')).toBe(false);
        const mid = stateAtSeq(after, events, events.find(e => e.type === 'ability_damage')?.seq as number);
        expect(mid.combatants.f.hp).toBe(after.combatants.f.hp);
        expect(mid.combatants.f.conditions.some(c => c.id === 'burning')).toBe(false);
    });

    it('stateAtSeq undoes a water hit: the push, the damage and soaked', () => {
        const { before, after, events } = run(world('water'), 'water');
        expect(after.combatants.f.position).toEqual({ x: 7, y: 5 });
        const rewound = stateAtSeq(after, events, before.eventSeq);
        expect(rewound.combatants.f.position).toEqual({ x: 6, y: 5 });
        expect(rewound.combatants.f.hp).toBe(99);
        expect(rewound.combatants.f.conditions).toEqual([]);
    });

    it('stateAtSeq undoes an arc and a burn tick', () => {
        const s = world('lightning');
        const withNear: CombatState = { ...s, order: ['pc', 'f', 'near'], combatants: { ...s.combatants, near: foe('near', 7, { position: { x: 7, y: 6 } }) } };
        const { before, after, events } = run(withNear, 'lightning');
        expect(after.combatants.near.hp).toBeLessThan(99);
        const rewound = stateAtSeq(after, events, before.eventSeq);
        expect(rewound.combatants.near.hp).toBe(99);
        expect(rewound.combatants.f.hp).toBe(99);
        const burning: CombatState = { ...before, combatants: { ...before.combatants, f: { ...before.combatants.f, conditions: [{ id: 'burning', turns: 2 }] } } };
        const tick = applyAction(burning, { type: 'end_turn', actorId: 'pc' });
        const burn = tick.events.find(e => e.type === 'burn') as CombatEvent;
        expect(burn).toBeDefined();
        expect(tick.state.combatants.f.hp).toBeLessThan(99);
        const back = stateAtSeq(tick.state, tick.events, burn.seq - 1);
        expect(back.combatants.f.hp).toBe(99);
    });

    it('stateAtSeq gives a spent coating and a spent confusion back', () => {
        const s = world('fire');
        const coated: CombatState = { ...s, order: ['f', 'pc'], turnIndex: 0, combatants: { ...s.combatants, f: { ...s.combatants.f, conditions: [{ id: 'coated', turns: 2 }] }, pc: { ...s.combatants.pc, ac: 0 } } };
        const state = { ...coated, turn: freshTurn(coated, 'f') };
        const hit = applyAction(state, { type: 'attack', actorId: 'f', targetId: 'pc' });
        expect(hit.state.combatants.f.conditions.some(c => c.id === 'coated')).toBe(false);
        const back = stateAtSeq(hit.state, hit.events, state.eventSeq);
        expect(back.combatants.f.conditions.some(c => c.id === 'coated')).toBe(true);
        const mad: CombatState = { ...state, combatants: { ...state.combatants, f: { ...state.combatants.f, conditions: [{ id: 'confused', turns: 1 }] } } };
        const swing = applyAction(mad, { type: 'attack', actorId: 'f', targetId: 'pc' });
        expect(swing.events.some(e => e.type === 'confused')).toBe(true);
        const undone = stateAtSeq(swing.state, swing.events, mad.eventSeq);
        expect(undone.combatants.f.conditions.some(c => c.id === 'confused')).toBe(true);
        const confusedEvent = swing.events.find(e => e.type === 'confused');
        expect(confusedEvent).toBeDefined();
        expect(narrationLine(confusedEvent as typeof swing.events[number], swing.state)).toMatch(/is confused and turns on/);
    });
});
