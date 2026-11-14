import { describe, it, expect } from 'vitest';
import { applyAction, buildPcCombatant, createCombat, createRng } from '../index';
import type { CombatSheet, CombatState, Combatant } from '../index';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function cursorFor(seed: number, predicate: (roll: number) => boolean): number {
    for (let cursor = 0; cursor < 5000; cursor++) {
        if (predicate(createRng(seed, cursor).roll(20))) return cursor;
    }
    throw new Error('no cursor found');
}

function duel(weaponName: string | undefined, foe: Partial<Combatant> = {}): CombatState {
    const pc = buildPcCombatant({ name: 'Kira', sheet, weapon: { ...(weaponName ? { name: weaponName } : {}), quality: 'common', scalingStat: 'STR' } });
    const target: Combatant = {
        id: 'foe', name: 'Bandit', side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], ...foe,
    };
    return {
        id: 'duel', round: 1, order: [pc.id, target.id], turnIndex: 0,
        combatants: { [pc.id]: pc, [target.id]: target }, rngSeed: 42, rngCursor: 0, eventSeq: 0, outcome: null,
    };
}

describe('narration data on events (Phase 5A)', () => {
    it('keeps the PC weapon name on the combatant and puts it on attack events without changing the roll', () => {
        expect(buildPcCombatant({ name: 'Kira', sheet, weapon: { name: '  hand-axe ' } }).weaponName).toBe('hand-axe');
        expect(buildPcCombatant({ name: 'Kira', sheet }).weaponName).toBeUndefined();
        const cursor = cursorFor(42, r => r > 1 && r < 20);
        const named = applyAction({ ...duel('hand-axe'), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        const plain = applyAction({ ...duel(undefined), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        const a = named.events.find(e => e.type === 'attack')!;
        const b = plain.events.find(e => e.type === 'attack')!;
        expect(a.data.weapon).toBe('hand-axe');
        expect('weapon' in b.data).toBe(false);
        expect({ ...a.data, weapon: undefined }).toEqual(b.data);
        expect(named.state.rngCursor).toBe(plain.state.rngCursor);
        expect(a.text).toBe(b.text);
    });

    it('records a shielded target on a miss, and nothing extra when there is no shield', () => {
        const cursor = cursorFor(42, r => r === 2);
        const shielded = applyAction({ ...duel(undefined, { ac: 40, tempHp: 5 }), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        const bare = applyAction({ ...duel(undefined, { ac: 40 }), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        expect(shielded.events[0].data).toMatchObject({ hit: false, shielded: true });
        expect('shielded' in bare.events[0].data).toBe(false);
    });

    it('copies an optional manner from the spec onto the combatant only', () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const a = createCombat({ id: 'm', combatants: [{ name: 'Thug', side: 'enemy', tier: 'grunt', manner: 'grim, silent' }] }, pc, 3);
        const b = createCombat({ id: 'm', combatants: [{ name: 'Thug', side: 'enemy', tier: 'grunt' }] }, pc, 3);
        expect(a.state.combatants.c1.manner).toBe('grim, silent');
        expect({ ...a.state.combatants.c1, manner: undefined }).toEqual({ ...b.state.combatants.c1, manner: undefined });
        expect(a.events).toEqual(b.events);
    });
});
