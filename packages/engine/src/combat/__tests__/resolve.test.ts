import { describe, it, expect } from 'vitest';
import {
    applyAction, buildPcCombatant, buildTierBlock, checkOutcome, chooseEngineTurn, createCombat,
    createRng, currentActorId, hpBand, runEngineTurns, simulateFights, DEFEND_CONDITION, TIER_TABLE,
} from '../index';
import type { CombatEvent, CombatSheet, CombatState, Combatant, CombatantSpec, MapSpec, PcCombatantInput } from '../index';

const sheet: CombatSheet = {
    abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

const pcInput: PcCombatantInput = { name: 'Kira', sheet, weapon: { quality: 'common', scalingStat: 'STR', damageType: 'slashing' } };

const enemies = (tier: CombatantSpec['tier'], n: number): CombatantSpec[] =>
    Array.from({ length: n }, (_, i) => ({ name: `Bandit ${i + 1}`, side: 'enemy', tier }));

function cursorFor(seed: number, predicate: (rolls: number[]) => boolean, count = 2): number {
    for (let cursor = 0; cursor < 5000; cursor++) {
        const rng = createRng(seed, cursor);
        const rolls = Array.from({ length: count }, () => rng.roll(20));
        if (predicate(rolls)) return cursor;
    }
    throw new Error('no cursor found');
}

function duel(overrides: Partial<Combatant> = {}): CombatState {
    const pc = buildPcCombatant(pcInput);
    const foe: Combatant = {
        id: 'foe', name: 'Bandit', side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], ...overrides,
    };
    return {
        id: 'duel', round: 1, order: [pc.id, foe.id], turnIndex: 0,
        combatants: { [pc.id]: pc, [foe.id]: foe }, rngSeed: 42, rngCursor: 0, eventSeq: 0, outcome: null,
    };
}

function playOut(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let current = state;
    const events: CombatEvent[] = [];
    const engine = runEngineTurns(current);
    current = engine.state;
    events.push(...engine.events);
    for (let i = 0; i < 500 && !current.outcome; i++) {
        const actorId = currentActorId(current)!;
        const choice = chooseEngineTurn(current, actorId);
        const step = applyAction(choice.state, choice.actions[0]);
        current = step.state;
        events.push(...step.events);
        const more = runEngineTurns(current);
        current = more.state;
        events.push(...more.events);
    }
    return { state: current, events };
}

describe('tier blocks', () => {
    it('reads the tier table without archetype or jitter', () => {
        const block = buildTierBlock('elite', undefined, 0, createRng(1));
        expect(block.maxHp).toBe(TIER_TABLE.elite.hp);
        expect(block.ac).toBe(TIER_TABLE.elite.ac);
        expect(block.attackBonus).toBe(TIER_TABLE.elite.attack);
        expect(block.damage).toMatchObject(TIER_TABLE.elite.damage);
    });

    it('applies archetype shaping', () => {
        const rng = createRng(1);
        const base = buildTierBlock('boss', undefined, 0, rng);
        const bulwark = buildTierBlock('boss', 'bulwark', 0, rng);
        expect(bulwark.ac).toBe(base.ac + 2);
        expect(bulwark.attackBonus).toBe(base.attackBonus - 1);
        expect(bulwark.maxHp).toBe(Math.round(base.maxHp * 1.25));
        expect(buildTierBlock('boss', 'assassin', 0, rng).attackBonus).toBe(base.attackBonus + 2);
        expect(buildTierBlock('boss', 'brute', 0, rng).ac).toBe(base.ac - 1);
        expect(buildTierBlock('boss', 'skirmisher', 0, rng).ac).toBe(base.ac + 1);
        expect(buildTierBlock('boss', 'caster', 0, rng, 'a fire witch').damage.type).toBe('fire');
        expect(buildTierBlock('boss', 'caster', 0, rng).damage.type).toBe('arcane');
    });

    it('jitters HP for minion and grunt only', () => {
        const hps = new Set<number>();
        const rng = createRng(9);
        for (let i = 0; i < 50; i++) hps.add(buildTierBlock('grunt', 'bulwark', 30, rng).maxHp);
        expect(hps.size).toBeGreaterThan(1);
        const elite = new Set<number>();
        for (let i = 0; i < 20; i++) elite.add(buildTierBlock('elite', undefined, 30, rng).maxHp);
        expect(elite.size).toBe(1);
    });
});

describe('PC combatant', () => {
    it('derives attack and damage from the sheet and weapon', () => {
        const pc = buildPcCombatant(pcInput);
        expect(pc).toMatchObject({ id: 'pc', side: 'player', controller: 'player', maxHp: 28, hp: 28, ac: 12, attackBonus: 4 });
        expect(pc.damage).toEqual({ count: 1, sides: 6, bonus: 2, type: 'slashing' });
    });

    it('uses the quality die, the default die and the unarmed die', () => {
        expect(buildPcCombatant({ ...pcInput, weapon: { quality: 'legendary' } }).damage).toMatchObject({ count: 2, sides: 8 });
        expect(buildPcCombatant({ ...pcInput, weapon: {}, defaultWeaponDie: 10 }).damage).toMatchObject({ count: 1, sides: 10 });
        expect(buildPcCombatant({ ...pcInput, weapon: null }).damage).toMatchObject({ count: 1, sides: 4, bonus: 2 });
        expect(buildPcCombatant({ ...pcInput, weapon: { scalingStat: 'DEX' } }).attackBonus).toBe(4);
        expect(buildPcCombatant({ ...pcInput, weapon: { scalingStat: 'INT' } }).attackBonus).toBe(1);
    });

    it('takes current HP from the profile and never starts below 1', () => {
        expect(buildPcCombatant({ ...pcInput, hpCurrent: 9 }).hp).toBe(9);
        expect(buildPcCombatant({ ...pcInput, hpCurrent: 0 }).hp).toBe(1);
        expect(buildPcCombatant({ ...pcInput, hpCurrent: 99 }).hp).toBe(28);
    });
});

describe('createCombat', () => {
    it('orders by initiative, then DEX, then rng', () => {
        const { state, events } = createCombat({ id: 'f1', combatants: enemies('grunt', 4) }, buildPcCombatant(pcInput), 7);
        const sorted = state.order.map(id => state.combatants[id]);
        for (let i = 1; i < sorted.length; i++) {
            const a = sorted[i - 1];
            const b = sorted[i];
            expect(a.initiative > b.initiative || (a.initiative === b.initiative && a.abilities.DEX >= b.abilities.DEX)).toBe(true);
        }
        expect(events.map(e => e.type)).toEqual(['combat_started', 'initiative']);
        expect(events.map(e => e.seq)).toEqual([1, 2]);
        expect(state.rngCursor).toBeGreaterThan(0);
    });

    it('breaks full ties with the rng, deterministically per seed', () => {
        const spec = { id: 't', combatants: enemies('minion', 6) };
        const pc = buildPcCombatant(pcInput);
        for (let seed = 1; seed < 200; seed++) {
            const { state } = createCombat(spec, pc, seed);
            const enemyInits = state.order.filter(id => id !== 'pc').map(id => state.combatants[id].initiative);
            if (new Set(enemyInits).size < enemyInits.length) {
                expect(createCombat(spec, pc, seed).state.order).toEqual(state.order);
                return;
            }
        }
        throw new Error('no tie found');
    });
});

describe('applyAction', () => {
    it('rejects actions out of turn or against invalid targets without changing state', () => {
        const state = duel();
        const outOfTurn = applyAction(state, { type: 'attack', actorId: 'foe', targetId: 'pc' });
        expect(outOfTurn.state).toBe(state);
        expect(outOfTurn.events[0].type).toBe('rejected');
        const self = applyAction(state, { type: 'attack', actorId: 'pc', targetId: 'pc' });
        expect(self.state).toBe(state);
        expect(self.events[0].type).toBe('rejected');
        const missing = applyAction(state, { type: 'attack', actorId: 'pc', targetId: 'nobody' });
        expect(missing.events[0].type).toBe('rejected');
        const done = applyAction({ ...state, outcome: 'victory' }, { type: 'end_turn', actorId: 'pc' });
        expect(done.events[0].type).toBe('rejected');
    });

    it('a natural 20 always hits and doubles the damage dice', () => {
        const cursor = cursorFor(42, r => r[0] === 20);
        const { state, events } = applyAction({ ...duel({ ac: 40 }), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        const attack = events.find(e => e.type === 'attack')!;
        expect(attack.data).toMatchObject({ hit: true, crit: true, natural: 20 });
        const damage = attack.data.damage as number;
        expect(damage).toBeGreaterThanOrEqual(2 + 2);
        expect(damage).toBeLessThanOrEqual(12 + 2);
        expect(state.combatants.foe.hp).toBe(20 - damage);
    });

    it('a natural 1 always misses', () => {
        const cursor = cursorFor(42, r => r[0] === 1);
        const { state, events } = applyAction({ ...duel({ ac: 0 }), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        expect(events[0].data).toMatchObject({ hit: false, natural: 1, fumble: true });
        expect(state.combatants.foe.hp).toBe(20);
    });

    it('defend gives attackers disadvantage until the defender acts again', () => {
        const defended = applyAction(duel(), { type: 'defend', actorId: 'pc' });
        expect(defended.state.combatants.pc.conditions).toEqual([{ id: DEFEND_CONDITION, rounds: 1 }]);
        expect(currentActorId(defended.state)).toBe('foe');
        const cursor = cursorFor(42, r => r[0] === 20 && r[1] === 2);
        const attacked = applyAction({ ...defended.state, rngCursor: cursor }, { type: 'attack', actorId: 'foe', targetId: 'pc' });
        const attack = attacked.events.find(e => e.type === 'attack')!;
        expect(attack.data).toMatchObject({ natural: 2, disadvantage: true, crit: false });
        expect(currentActorId(attacked.state)).toBe('pc');
        expect(attacked.state.combatants.pc.conditions).toEqual([]);
        expect(attacked.state.round).toBe(2);
        expect(attacked.events.some(e => e.type === 'round')).toBe(true);
    });

    it('marks a combatant down at 0 HP and ends the fight', () => {
        const cursor = cursorFor(42, r => r[0] === 20);
        const { state, events } = applyAction({ ...duel({ hp: 1 }), rngCursor: cursor }, { type: 'attack', actorId: 'pc', targetId: 'foe' });
        expect(state.combatants.foe.status).toBe('down');
        expect(state.outcome).toBe('victory');
        expect(events.map(e => e.type)).toEqual(['attack', 'down', 'combat_ended']);
        expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    });
});

describe('checkOutcome', () => {
    it('detects victory, defeat and an ongoing fight', () => {
        const state = duel();
        expect(checkOutcome(state)).toBeNull();
        expect(checkOutcome({ ...state, combatants: { ...state.combatants, foe: { ...state.combatants.foe, status: 'down' } } })).toBe('victory');
        expect(checkOutcome({ ...state, combatants: { ...state.combatants, pc: { ...state.combatants.pc, status: 'down' } } })).toBe('defeat');
    });

    it('keeps fighting while an ally is up after the PC falls', () => {
        const state = duel();
        const ally: Combatant = { ...state.combatants.foe, id: 'ally', name: 'Ally', side: 'ally' };
        const withAlly = { ...state, order: [...state.order, 'ally'], combatants: { ...state.combatants, ally, pc: { ...state.combatants.pc, status: 'down' as const } } };
        expect(checkOutcome(withAlly)).toBeNull();
    });
});

describe('engine policy', () => {
    it('attacks the hostile combatant with the lowest current HP', () => {
        const state = duel();
        const ally: Combatant = { ...state.combatants.pc, id: 'ally', name: 'Ally', side: 'ally', controller: 'engine', hp: 3 };
        const neutral: Combatant = { ...state.combatants.foe, id: 'n', name: 'Bystander', side: 'neutral', hp: 1 };
        const s: CombatState = { ...state, order: ['foe', 'pc', 'ally', 'n'], combatants: { ...state.combatants, ally, n: neutral } };
        expect(chooseEngineTurn(s, 'foe').actions[0]).toEqual({ type: 'attack', actorId: 'foe', targetId: 'ally' });
        expect(chooseEngineTurn(s, 'n').actions[0]).toEqual({ type: 'end_turn', actorId: 'n' });
    });

    it('breaks HP ties with the rng and advances the cursor', () => {
        const state = duel();
        const ally: Combatant = { ...state.combatants.pc, id: 'ally', name: 'Ally', side: 'ally', controller: 'engine' };
        const s: CombatState = { ...state, order: ['foe', 'pc', 'ally'], combatants: { ...state.combatants, ally } };
        const choice = chooseEngineTurn(s, 'foe');
        expect(['pc', 'ally']).toContain((choice.actions[0] as { targetId: string }).targetId);
        expect(choice.state.rngCursor).toBe(s.rngCursor + 1);
    });

    it('runs engine turns until a player-controlled combatant is up', () => {
        const state = { ...duel(), turnIndex: 1 };
        const { state: after } = runEngineTurns(state);
        expect(currentActorId(after) === 'pc' || after.outcome !== null).toBe(true);
    });
});

describe('determinism', () => {
    it('plays a seeded golden fight', () => {
        const start = createCombat({ id: 'gold', combatants: enemies('grunt', 2) }, buildPcCombatant(pcInput), 1234);
        const { state, events } = playOut(start.state);
        const log = [...start.events, ...events].map(e => `${e.seq}|${e.round}|${e.text}`);
        expect(state.outcome).not.toBeNull();
        expect(log).toMatchInlineSnapshot(`
          [
            "1|1|Combat begins. Kira against Bandit 2, Bandit 1.",
            "2|1|Initiative: Kira 21, Bandit 2 5, Bandit 1 2.",
            "3|1|Kira moves 6 squares toward Bandit 2.",
            "4|1|Kira ends the turn.",
            "5|1|Bandit 2 moves 6 squares toward Kira.",
            "6|1|Bandit 2 attacks Kira and misses.",
            "7|1|Bandit 1 moves 6 squares toward Kira.",
            "8|1|Bandit 1 attacks Kira and misses.",
            "9|2|Round 2 begins.",
            "10|2|Kira hits Bandit 1 for 4 slashing.",
            "11|2|Kira ends the turn.",
            "12|2|Bandit 2 lands a critical hit on Kira for 6 physical.",
            "13|2|Bandit 2 ends the turn.",
            "14|2|Bandit 1 hits Kira for 3 physical.",
            "15|2|Bandit 1 ends the turn.",
            "16|3|Round 3 begins.",
            "17|3|Kira attacks Bandit 1 and misses.",
            "18|3|Kira ends the turn.",
            "19|3|Bandit 2 lands a critical hit on Kira for 10 physical.",
            "20|3|Bandit 2 ends the turn.",
            "21|3|Bandit 1 lands a critical hit on Kira for 8 physical.",
            "22|3|Bandit 1 ends the turn.",
            "23|4|Round 4 begins.",
            "24|4|Kira hits Bandit 1 for 4 slashing.",
            "25|4|Bandit 1 is down.",
            "26|4|Kira ends the turn.",
            "27|4|Bandit 2 hits Kira for 4 physical.",
            "28|4|Kira falls unconscious.",
            "29|4|The fight is lost.",
          ]
        `);
    });

    it('replays identically after a save and restore of rngCursor', () => {
        const start = createCombat({ id: 'det', combatants: enemies('grunt', 3) }, buildPcCombatant(pcInput), 99);
        const mid = runEngineTurns(start.state).state;
        const saved = JSON.parse(JSON.stringify(mid)) as CombatState;
        const a = playOut(mid);
        const b = playOut(saved);
        expect(b.events).toEqual(a.events);
        expect(b.state).toEqual(a.state);
    });

    it('produces a different fight for a different seed', () => {
        const pc = buildPcCombatant(pcInput);
        const a = playOut(createCombat({ id: 'x', combatants: enemies('grunt', 3) }, pc, 1).state);
        const b = playOut(createCombat({ id: 'x', combatants: enemies('grunt', 3) }, pc, 2).state);
        expect(a.events.map(e => e.text)).not.toEqual(b.events.map(e => e.text));
    });
});

describe('hp bands', () => {
    it('maps HP to unhurt, hurt, badly hurt and down', () => {
        expect(hpBand({ hp: 10, maxHp: 10, status: 'up' })).toBe('unhurt');
        expect(hpBand({ hp: 6, maxHp: 10, status: 'up' })).toBe('hurt');
        expect(hpBand({ hp: 5, maxHp: 10, status: 'up' })).toBe('badly_hurt');
        expect(hpBand({ hp: 0, maxHp: 10, status: 'down' })).toBe('down');
    });
});

describe('tier tuning on the grid (1,000 seeded fights each)', () => {
    const tuningPc: PcCombatantInput = { name: 'PC', sheet, weapon: { quality: 'common', scalingStat: 'STR' } };
    const ranged = (n: number): CombatantSpec[] => enemies('grunt', n).map(e => ({ ...e, range: 'ranged' as const }));
    const maps: Array<[string, MapSpec]> = [
        ['open arena', { size: 'medium', area: 'open', density: 'sparse' }],
        ['scattered cover', { size: 'medium', area: 'scattered', density: 'normal' }],
    ];
    const cases: Array<[string, CombatantSpec[], number, number]> = [
        ['2 minions', enemies('minion', 2), 0.9, 1],
        ['1 grunt', enemies('grunt', 1), 0.8, 1],
        ['3 grunts', enemies('grunt', 3), 0.35, 0.6],
        ['1 elite', enemies('elite', 1), 0, 0.25],
    ];
    for (const [mapLabel, map] of maps) {
        for (const [label, foes, min, max] of cases) {
            it(`${label} on the ${mapLabel} stays within its win-rate target`, () => {
                const result = simulateFights(tuningPc, foes, 1000, { baseSeed: 1, map });
                console.log(`[combat-sim] ${mapLabel} | ${label}: win ${(result.winRate * 100).toFixed(1)}%, mean rounds ${result.meanRounds.toFixed(2)}`);
                expect(result.winRate).toBeGreaterThanOrEqual(min);
                expect(result.winRate).toBeLessThanOrEqual(max);
            });
        }
        it(`records 2 ranged grunts on the ${mapLabel} and keeps them beatable but not trivial`, () => {
            const result = simulateFights(tuningPc, ranged(2), 1000, { baseSeed: 1, map });
            console.log(`[combat-sim] ${mapLabel} | 2 ranged grunts (recorded): win ${(result.winRate * 100).toFixed(1)}%, mean rounds ${result.meanRounds.toFixed(2)}`);
            expect(result.winRate).toBeLessThanOrEqual(0.9);
        });
    }
});
