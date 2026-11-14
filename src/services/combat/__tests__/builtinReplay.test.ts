import { describe, it, expect } from 'vitest';
import {
    applyAction, buildPcCombatant, chooseEngineTurn, createCombat, currentActorId, currentTurn, STARTER_ABILITIES, stepEngine,
} from '@narrative/engine';
import type { CombatAction, CombatEvent, CombatState } from '@narrative/engine';
import { stateAtSeq } from '../combatEvents';

function fnv(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function start(): CombatState {
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

function step(state: CombatState): { state: CombatState; events: CombatEvent[] } {
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

describe('an attack and defend log recorded before 5B-1 (5B-1)', () => {
    it('is the same log today, and every stateAtSeq replay matches the pre-change fingerprint', () => {
        let state = start();
        const log: CombatEvent[] = [];
        let tail: CombatEvent[] = [];
        for (let i = 0; i < 3000 && !state.outcome; i++) {
            if (i === 21) tail = [];
            const next = step(state);
            log.push(...next.events);
            tail.push(...next.events);
            state = next.state;
        }
        expect(fnv(JSON.stringify(tail) + JSON.stringify(state))).toBe('c25822bf');
        expect(log.some(e => e.type === 'attack')).toBe(true);
        expect(log.some(e => e.type === 'defend')).toBe(true);
        expect(log).toHaveLength(66);
        const replays = Array.from({ length: state.eventSeq + 1 }, (_, seq) => stateAtSeq(state, log, seq));
        expect(fnv(JSON.stringify(replays))).toBe('b4614028');
    });
});
