import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, COMBAT_EVENT_TYPES, freshTurn, GLYPH_EVENT_TYPES } from '@narrative/engine';
import type { CombatEvent, CombatState, Combatant, GlyphAbility } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, narrationLine, stateAtSeq } from '../combatEvents';

const SHEET = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL' as const, level: 3, needsAllocation: false };

function ability(id: string, form: GlyphAbility['form']['id'], effects: GlyphAbility['effects'][number]['id'][], augments: GlyphAbility['form']['augments'] = []): GlyphAbility {
    return { id, name: id, form: { id: form, augments }, effects: effects.map(e => ({ id: e, augments: [] })), source: 'player' };
}

function foe(id: string, x: number, overrides: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 40, hp: 40, ac: 0, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], position: { x, y: 5 }, range: 'close', ...overrides,
    };
}

function world(kit: GlyphAbility[], target: Partial<Combatant> = {}, fx = 6): CombatState {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet: SHEET, kit }), position: { x: 5, y: 5 }, hp: 30, maxHp: 30 };
    const base: CombatState = {
        id: 'w', round: 1, order: ['pc', 'f'], turnIndex: 0, combatants: { pc, f: foe('f', fx, target) },
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 16, height: 12, tiles: new Array(16 * 12).fill('floor') },
    };
    return { ...base, turn: freshTurn(base, 'pc') };
}

function landed(state: CombatState, abilityId: string, aim: { x: number; y: number } | null, wanted: string): { before: CombatState; after: CombatState; events: CombatEvent[] } {
    let cursor = 0;
    for (; cursor < 300; cursor++) {
        const probe = applyAction({ ...state, rngCursor: cursor }, { type: 'use_ability', actorId: 'pc', abilityId, aim });
        if (probe.events.some(e => e.type === wanted)) break;
    }
    const before = { ...state, rngCursor: cursor };
    const r = applyAction(before, { type: 'use_ability', actorId: 'pc', abilityId, aim });
    return { before, after: r.state, events: r.events };
}

describe('new glyph events in the host log', () => {
    it('are narrated types and the lists still match', () => {
        for (const type of GLYPH_EVENT_TYPES) expect(NARRATED_EVENT_TYPES).toContain(type);
        expect([...NARRATED_EVENT_TYPES].sort()).toEqual([...COMBAT_EVENT_TYPES].sort());
    });

    it('stateAtSeq undoes a sigil being laid, then sprung and spent', () => {
        const s = world([ability('trap', 'sigil', ['damage'])], {}, 11);
        const laid = applyAction(s, { type: 'use_ability', actorId: 'pc', abilityId: 'trap', aim: { x: 8, y: 5 } });
        const turn = applyAction(laid.state, { type: 'end_turn', actorId: 'pc' });
        const sprung = applyAction(turn.state, { type: 'move', actorId: 'f', to: { x: 8, y: 5 } });
        const log = [...laid.events, ...turn.events, ...sprung.events];
        expect(sprung.state.placed).toEqual([]);
        expect(sprung.events.some(e => e.type === 'placed_triggered')).toBe(true);
        const beforeMove = stateAtSeq(sprung.state, log, turn.state.eventSeq);
        expect(beforeMove.placed).toHaveLength(1);
        expect(beforeMove.combatants.f.position).toEqual({ x: 11, y: 5 });
        expect(beforeMove.combatants.f.hp).toBe(40);
        const beforeAll = stateAtSeq(sprung.state, log, 0);
        expect(beforeAll.placed).toEqual([]);
        for (const e of log.filter(x => GLYPH_EVENT_TYPES.includes(x.type))) expect(typeof narrationLine(e, sprung.state)).toBe('string');
    });

    it('stateAtSeq undoes snare, decay and dispel', () => {
        const snare = landed(world([ability('hold', 'touch', ['snare'])]), 'hold', { x: 6, y: 5 }, 'condition_added');
        expect(snare.after.combatants.f.conditions.some(c => c.id === 'snared')).toBe(true);
        expect(stateAtSeq(snare.after, snare.events, snare.before.eventSeq).combatants.f.conditions).toEqual([]);
        const rot = landed(world([ability('rot', 'touch', ['decay'])]), 'rot', { x: 6, y: 5 }, 'decayed');
        expect(rot.after.combatants.f.maxHp).toBeLessThan(40);
        const healed = stateAtSeq(rot.after, rot.events, rot.before.eventSeq).combatants.f;
        expect(healed.maxHp).toBe(40);
        expect(healed.hp).toBe(40);
        const wipe = landed(world([ability('wipe', 'touch', ['dispel'])], { tempHp: 6, conditions: [{ id: 'hasted', turns: 2 }, { id: 'shielded', turns: 2 }] }), 'wipe', { x: 6, y: 5 }, 'dispelled');
        expect(wipe.after.combatants.f.conditions).toEqual([]);
        const back = stateAtSeq(wipe.after, wipe.events, wipe.before.eventSeq).combatants.f;
        expect(back.conditions.map(c => c.id)).toEqual(['hasted', 'shielded']);
        expect(back.tempHp).toBe(6);
    });

    it('stateAtSeq undoes a rewind and a vanish that ran out', () => {
        const s = world([ability('back', 'self', ['rewind']), ability('hide', 'self', ['vanish'])], {}, 12);
        let state = applyAction(applyAction(s, { type: 'end_turn', actorId: 'pc' }).state, { type: 'end_turn', actorId: 'f' }).state;
        state = applyAction(state, { type: 'move', actorId: 'pc', to: { x: 7, y: 7 } }).state;
        state = applyAction(state, { type: 'end_turn', actorId: 'pc' }).state;
        state = { ...state, combatants: { ...state.combatants, pc: { ...state.combatants.pc, hp: 4 } } };
        state = applyAction(state, { type: 'end_turn', actorId: 'f' }).state;
        const r = applyAction(state, { type: 'use_ability', actorId: 'pc', abilityId: 'back', aim: null });
        expect(r.state.combatants.pc.position).toEqual({ x: 5, y: 5 });
        expect(r.state.combatants.pc.hp).toBe(30);
        const undone = stateAtSeq(r.state, r.events, state.eventSeq);
        expect(undone.combatants.pc.position).toEqual({ x: 7, y: 7 });
        expect(undone.combatants.pc.hp).toBe(4);
        const hidden = applyAction(s, { type: 'use_ability', actorId: 'pc', abilityId: 'hide', aim: null });
        const round = applyAction(applyAction(hidden.state, { type: 'end_turn', actorId: 'pc' }).state, { type: 'end_turn', actorId: 'f' });
        const log = [...hidden.events, ...round.events];
        expect(round.state.combatants.pc.conditions.some(c => c.id === 'vanished')).toBe(false);
        expect(stateAtSeq(round.state, log, hidden.state.eventSeq).combatants.pc.conditions.some(c => c.id === 'vanished')).toBe(true);
        expect(stateAtSeq(round.state, log, 0).combatants.pc.conditions.some(c => c.id === 'vanished')).toBe(false);
    });
});
