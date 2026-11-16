import { describe, it, expect } from 'vitest';
import {
    applyAction, buildPcCombatant, createCombat, currentActorId, currentTurn, planTurn, runEngineTurns, stepEngine, STARTER_ABILITIES,
} from '../index';
import type {
    CombatAction, CombatEvent, CombatSheet, CombatState, CombatantSpec, Combatant, MapSpec, PcCombatantInput, Tactic,
} from '../index';
import { legacyEngineTurn } from './legacyPlanner';
import { arena, foe, openGrid } from './glyphFixtures';

const fighter: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const archer: CombatSheet = { abilities: { STR: 10, DEX: 16, CON: 14, INT: 10, WIS: 12, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const mage: CombatSheet = { abilities: { STR: 8, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

const PCS: PcCombatantInput[] = [
    { name: 'PC', sheet: fighter, weapon: { quality: 'common', scalingStat: 'STR' } },
    { name: 'PC', sheet: archer, weapon: { quality: 'uncommon', scalingStat: 'DEX', range: 'ranged' } },
    { name: 'PC', sheet: mage, weapon: { quality: 'common', scalingStat: 'DEX' }, kit: STARTER_ABILITIES.filter(a => a.id !== 'aqua-elemental') },
];

const TACTICS: Tactic[] = ['aggressive', 'skirmisher', 'guard', 'hunter', 'coward', 'berserker', 'support'];
const AREAS: NonNullable<MapSpec['area']>[] = ['open', 'scattered', 'ruins', 'cavern', 'wetland', 'street'];

function roster(i: number): CombatantSpec[] {
    const tiers: CombatantSpec['tier'][] = ['minion', 'grunt', 'elite', 'boss'];
    const arch: Array<CombatantSpec['archetype']> = [undefined, 'brute', 'caster', 'assassin', 'bulwark', 'skirmisher'];
    const n = 1 + (i % 4);
    const out: CombatantSpec[] = [];
    for (let k = 0; k < n; k++) {
        const a = arch[(i + k) % arch.length];
        out.push({
            name: `Foe ${k}`, side: 'enemy', tier: tiers[(i + 2 * k) % (k === 0 ? 4 : 3)],
            ...(a ? { archetype: a } : {}),
            ...((i + k) % 3 === 0 ? { tactic: TACTICS[(i + k) % TACTICS.length] } : {}),
            ...((i + k) % 5 === 1 ? { range: 'ranged' as const } : {}),
        });
    }
    if (i % 2 === 0) out.push({ name: 'Ally', side: 'ally', tier: i % 4 === 0 ? 'elite' : 'grunt', ...(i % 8 === 0 ? { archetype: 'caster' as const } : {}) });
    return out;
}

function start(i: number, size: MapSpec['size'] = 'small'): CombatState {
    const seed = 11 + i * 104729;
    const map: MapSpec = { size, area: AREAS[i % AREAS.length], density: 'normal', hazard: i % 3 === 0 ? 'fire' : 'none' };
    return createCombat({ id: `p${i}`, combatants: roster(i), map, mapSeed: seed * 31 + 7, partyControl: 'engine', defeatMode: 'knockout' }, buildPcCombatant(PCS[i % PCS.length]), seed).state;
}

function playOut(state: CombatState, onAction: (s: CombatState, a: CombatAction, events: CombatEvent[]) => void, limit = 600): CombatState {
    let s = state;
    for (let n = 0; n < limit && !s.outcome; n++) {
        const id = currentActorId(s) as string;
        const actor = s.combatants[id];
        if (!actor || actor.status !== 'up') {
            s = (stepEngine(s) ?? applyAction(s, { type: 'end_turn', actorId: id })).state;
            continue;
        }
        const plan = planTurn(s, id);
        const action = plan.steps[0];
        const r = applyAction(s, action, { driven: plan.steps.slice(1).some(x => x.type === 'use_ability' && (x.abilityId === 'builtin:shove' || x.abilityId === 'builtin:jump')) });
        onAction(s, action, r.events);
        s = r.state;
    }
    return s;
}

describe('the resolver executes the plan', () => {
    it('for 300 seeded engine turns: every engine step is the plan\'s first step, and the deterministic prefix matches the turn plan', () => {
        let turns = 0;
        let whole = 0;
        for (let i = 0; turns < 300 && i < 400; i++) {
            let s = start(i);
            for (let guard = 0; guard < 40 && !s.outcome && turns < 300; guard++) {
                const id = currentActorId(s) as string;
                const actor = s.combatants[id];
                if (actor?.controller !== 'engine' || actor.status !== 'up') {
                    const plan = planTurn(s, id);
                    s = applyAction(s, plan.steps[0]).state;
                    continue;
                }
                const plan = planTurn(s, id);
                const count = s.turnCount;
                const done: CombatAction[] = [];
                let cur = s;
                let random = false;
                let prefixOk = true;
                while (!cur.outcome && currentActorId(cur) === id && cur.turnCount === count) {
                    const next = planTurn(cur, id).steps[0];
                    const viaEngine = stepEngine(cur)!;
                    const driven = planTurn(cur, id).steps.slice(1).some(x => x.type === 'use_ability' && (x.abilityId === 'builtin:shove' || x.abilityId === 'builtin:jump'));
                    expect(viaEngine).toEqual(applyAction(cur, next, { driven }));
                    if (!random) prefixOk = prefixOk && JSON.stringify(plan.steps[done.length]) === JSON.stringify(next);
                    done.push(next);
                    if (next.type !== 'move' && next.type !== 'end_turn') random = true;
                    cur = viaEngine.state;
                }
                expect(prefixOk).toBe(true);
                const planned = plan.steps.slice(0, done.length);
                if (JSON.stringify(planned) === JSON.stringify(done) || (done.length === plan.steps.length - 1 && JSON.stringify(plan.steps.slice(0, -1)) === JSON.stringify(done))) whole++;
                turns++;
                s = cur;
            }
        }
        expect(turns).toBe(300);
        expect(whole / turns).toBeGreaterThan(0.85);
    }, 120000);
});

describe('determinism', () => {
    it('same state, same plan; a fight replays identically and survives a save and reload mid-fight', () => {
        for (let i = 0; i < 12; i++) {
            const s = start(i, 'medium');
            const logA: string[] = [];
            const logB: string[] = [];
            const endA = playOut(s, (_, a, ev) => logA.push(JSON.stringify(a), ...ev.map(e => JSON.stringify(e))));
            const endB = playOut(JSON.parse(JSON.stringify(s)) as CombatState, (_, a, ev) => logB.push(JSON.stringify(a), ...ev.map(e => JSON.stringify(e))));
            expect(logB).toEqual(logA);
            expect(endB).toEqual(endA);
            const mid = runEngineTurns(s).state;
            if (!mid.outcome) {
                const id = currentActorId(mid) as string;
                expect(planTurn(JSON.parse(JSON.stringify(mid)) as CombatState, id)).toEqual(planTurn(mid, id));
            }
        }
    });
});

describe('no plan is illegal', () => {
    it('2000 seeded fights with every planned action validated: none rejected', () => {
        let actions = 0;
        let kinds = new Set<string>();
        for (let i = 0; i < 2000; i++) {
            playOut(start(i), (_, a, events) => {
                actions++;
                if (a.type === 'use_ability') kinds.add(a.abilityId);
                else kinds.add(a.type);
                const rejected = events.find(e => e.type === 'rejected');
                if (rejected) throw new Error(`fight ${i}: ${JSON.stringify(a)} rejected: ${rejected.text}`);
            });
        }
        expect(actions).toBeGreaterThan(20000);
        kinds = new Set([...kinds].filter(k => k.startsWith('builtin:') || k === 'flee' || k === 'defend'));
        expect([...kinds]).toEqual(expect.arrayContaining(['builtin:shove', 'builtin:throw', 'builtin:help', 'defend']));
    }, 600000);
});

describe('never worse than before', () => {
    function mirror(newSide: 'enemy' | 'ally', seed: number): 'new' | 'old' | null {
        const grid = openGrid(12, 9, [{ x: 5, y: 2 }, { x: 6, y: 6 }], [[{ x: 4, y: 4 }, 'cover'], [{ x: 7, y: 4 }, 'cover']]);
        const team = (side: 'enemy' | 'ally', x: number): Combatant[] => [0, 1, 2].map(k => foe(`${side}${k}`, { x, y: 2 + 2 * k }, {
            side, tier: k === 1 ? 'elite' : 'grunt', hp: k === 1 ? 24 : 10, maxHp: k === 1 ? 24 : 10, ac: k === 1 ? 13 : 11,
            attackBonus: k === 1 ? 5 : 3, damage: k === 1 ? { count: 1, sides: 8, bonus: 2, type: 'slashing' } : { count: 1, sides: 6, bonus: 0, type: 'slashing' },
            ...(k === 2 ? { range: 'ranged' as const } : {}), initiative: 10 - k,
        }));
        const units = [...team('enemy', 1), ...team('ally', 10)];
        const order = seed % 2 === 0 ? units.map(u => u.id) : [...units.slice(3), ...units.slice(0, 3)].map(u => u.id);
        let s: CombatState = { ...arena(units, { grid, rngSeed: seed }), order, turnIndex: 0 };
        s = { ...s, turn: currentTurn({ ...s, turn: undefined }) ?? undefined };
        for (let n = 0; n < 800 && !s.outcome; n++) {
            const id = currentActorId(s) as string;
            const actor = s.combatants[id];
            if (actor.status !== 'up') {
                s = stepEngine(s)!.state;
                continue;
            }
            const useNew = actor.side === newSide;
            const action = useNew ? planTurn(s, id).steps[0] : legacyEngineTurn(s, id).actions[0];
            const from = useNew ? s : legacyEngineTurn(s, id).state;
            const r = applyAction(from, action);
            s = r.events.some(e => e.type === 'rejected') ? applyAction(from, { type: 'end_turn', actorId: id }).state : r.state;
        }
        if (s.outcome === 'victory') return newSide === 'ally' ? 'new' : 'old';
        if (s.outcome === 'defeat') return newSide === 'enemy' ? 'new' : 'old';
        return null;
    }

    it('the new planner wins at least as often as the old one in a mirror match-up', () => {
        let wins = 0;
        let losses = 0;
        for (let seed = 1; seed <= 200; seed++) {
            for (const side of ['enemy', 'ally'] as const) {
                const r = mirror(side, seed);
                if (r === 'new') wins++;
                if (r === 'old') losses++;
            }
        }
        console.log(`[ai-mirror] new ${wins} : old ${losses}`);
        expect(wins).toBeGreaterThanOrEqual(losses);
    }, 300000);
});

describe('budget', () => {
    it('a decision on the largest map with the largest roster stays under 25 ms', () => {
        const big: CombatantSpec[] = [
            ...Array.from({ length: 4 }, (_, k) => ({ name: `G${k}`, side: 'enemy' as const, tier: 'grunt' as const })),
            { name: 'R1', side: 'enemy', tier: 'grunt', range: 'ranged' }, { name: 'R2', side: 'enemy', tier: 'elite', archetype: 'caster' },
            { name: 'B', side: 'enemy', tier: 'boss', archetype: 'brute' }, { name: 'L', side: 'enemy', tier: 'legendary', archetype: 'caster' },
            { name: 'M1', side: 'enemy', tier: 'minion' }, { name: 'M2', side: 'enemy', tier: 'minion' },
            { name: 'A1', side: 'ally', tier: 'elite', archetype: 'bulwark' }, { name: 'A2', side: 'ally', tier: 'elite', archetype: 'caster' },
        ];
        let worst = 0;
        for (let f = 0; f < 3; f++) {
            let s = createCombat({ id: `big${f}`, combatants: big, map: { size: 'large', area: 'ruins', density: 'dense', hazard: 'fire' }, partyControl: 'engine' }, buildPcCombatant(PCS[2]), 900 + f).state;
            for (let n = 0; n < 120 && !s.outcome; n++) {
                const id = currentActorId(s) as string;
                planTurn(s, id);
                const t0 = performance.now();
                const plan = planTurn(s, id);
                worst = Math.max(worst, performance.now() - t0);
                s = applyAction(s, plan.steps[0]).state;
            }
        }
        console.log(`[ai-budget] worst decision ${worst.toFixed(2)} ms`);
        expect(worst).toBeLessThan(25);
    }, 120000);
});
