import { describe, it, expect } from 'vitest';
import { applyAction, applyOrders, createCombat, buildPcCombatant } from '@narrative/engine';
import type { CombatEvent, CombatState } from '@narrative/engine';
import { NARRATED_EVENT_TYPES, narrationLine, stateAtSeq } from '../combatEvents';

const SIG = { name: 'Crushing Blow', form: 'touch' as const, effects: [{ id: 'damage' as const, augments: ['amplify' as const] }] };

function start(): { state: CombatState; log: CombatEvent[]; id: string } {
    const pc = buildPcCombatant({ name: 'Kira', sheet: { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
    const made = createCombat({ id: 'r', mapSeed: 5, combatants: [{ name: 'Vey', side: 'enemy', tier: 'elite', tactic: 'hunter', signature: SIG }] }, pc, 8);
    const id = Object.values(made.state.combatants).find(c => c.name === 'Vey')?.id as string;
    return { state: made.state, log: [...made.events], id };
}

describe('order_given in the host log', () => {
    it('is a narrated event type', () => {
        expect(NARRATED_EVENT_TYPES).toContain('order_given');
    });

    it('stateAtSeq undoes orders and a tactic switch, newest first', () => {
        const { state, log, id } = start();
        const one = applyOrders(state, [{ unitId: id, kind: 'focus', targetId: 'pc', line: 'Get her!' }]);
        const two = applyOrders({ ...one.state, round: 2 }, [{ unitId: id, kind: 'switch_tactic', tactic: 'coward' }]);
        const all = [...log, ...one.events, ...two.events];
        const final = two.state;
        expect(final.combatants[id].tactic).toBe('coward');
        const mid = stateAtSeq(final, all, one.events[0].seq);
        expect(mid.combatants[id].tactic).toBe('hunter');
        expect(mid.combatants[id].order).toMatchObject({ kind: 'focus', targetId: 'pc' });
        const early = stateAtSeq(final, all, 0);
        expect(early.combatants[id].order).toBeUndefined();
        expect(early.combatants[id].tactic).toBe('hunter');
        expect(final.combatants[id].order?.kind).toBe('switch_tactic');
    });

    it('stateAtSeq gives a used signature move back its use', () => {
        const { state, id } = start();
        const vey = state.combatants[id];
        const s: CombatState = {
            ...state, order: [id, 'pc'], turnIndex: 0,
            combatants: { ...state.combatants, [id]: { ...vey, position: { x: 5, y: 5 } }, pc: { ...state.combatants.pc, position: { x: 6, y: 5 }, hp: 80, maxHp: 80 } },
            turn: { actorId: id, moveLeft: 6, actionUsed: false },
        };
        const used = applyAction(s, { type: 'use_ability', actorId: id, abilityId: `sig-${id}`, aim: { x: 6, y: 5 } });
        expect(used.state.combatants[id].signature?.usesLeft).toBe(0);
        const before = stateAtSeq(used.state, used.events, s.eventSeq);
        expect(before.combatants[id].signature?.usesLeft).toBe(1);
    });

    it('has a narration line with no numbers, quoting the spoken line', () => {
        const { state, id } = start();
        const r = applyOrders(state, [{ unitId: id, kind: 'hold' }]);
        expect(narrationLine(r.events[0], r.state)).toBe('Vey means to hold their ground.');
        const spoken = applyOrders(state, [{ unitId: id, kind: 'focus', targetId: 'pc', line: 'You are "mine"!' }]);
        expect(narrationLine(spoken.events[0], spoken.state)).toBe('Vey marks Kira as the one to bring down. Vey calls out: "You are \'mine\'!"');
    });
});
