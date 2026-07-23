import { describe, it, expect } from 'vitest';
import type { NPCEntry, Goal } from '../../../types';
import {
    GOAL_BASE_DC,
    HEARTBEAT_DC,
    BASE_HEAT,
    AMBITIOUS_HEAT_BONUS,
    QUOTA_BY_HORIZON,
} from './agencyConstants';
import { driveMult, contextAllow, goalScore, chooseTick } from './agencySelection';
import { karmaBonus, bandFromMargin, nextFailStreak, rollGoal } from './agencyDice';
import { progressDelta, applyBandToGoal, canCrossTier, consumeTierCross } from './agencyProgress';
import { ticksForDuration, allocateTicks } from './agencyTimeskip';
import { rollHeartbeat, buildProximityRoster } from './agencyHeartbeat';
import { buildGoalsFromWants, upgradeWantsToGoals } from './agencyGoals';
import { detectTimeskip, runTimeskip } from './agencyTimeskipRun';

// ── helpers ────────────────────────────────────────────────────────────────
function goal(overrides: Partial<Goal> = {}): Goal {
    return {
        text: 'master the blade',
        horizon: 'med',
        tier: 'default',
        base_heat: 2,
        lastAdvancedTick: 0,
        failStreak: 0,
        progress: 0,
        quota: 10,
        state: 'active',
        ...overrides,
    };
}
function npc(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return { id: 'n1', name: 'Alden', condition: 'healthy', ...overrides } as NPCEntry;
}
/** rng that yields a fixed d20 natural: Math.floor(rng*20)+1 === n */
const fixedNat = (n: number) => () => (n - 0.5) / 20;
/** rng that always returns v */
const constRng = (v: number) => () => v;

// ── Piece A — selection (§9.5) ──────────────────────────────────────────────
describe('Piece A — selection', () => {
    it('driveMult endpoints + clamp + round', () => {
        expect(driveMult(-3)).toBe(0.6);
        expect(driveMult(3)).toBe(1.5);
        expect(driveMult(0)).toBe(1.0);
        expect(driveMult(9)).toBe(1.5);   // clamp high
        expect(driveMult(-9)).toBe(0.6);  // clamp low
        expect(driveMult(2.4)).toBe(1.3); // round → 2
    });

    it('contextAllow: dangerous blocks long, allows medium; calm allows all', () => {
        expect(contextAllow(goal({ horizon: 'long' }), 'dangerous')).toBe(0);
        expect(contextAllow(goal({ horizon: 'med' }), 'dangerous')).toBe(1);
        expect(contextAllow(goal({ horizon: 'long' }), 'calm')).toBe(1);
        expect(contextAllow(goal({ horizon: 'long' }), 'tense')).toBe(1);
    });

    it('goalScore = base_heat + neglect * driveMult * contextAllow', () => {
        // drive 0 → mult 1; neglect = 5 − 0 = 5; calm → allow 1
        expect(goalScore(goal({ base_heat: 2, lastAdvancedTick: 0 }), 5, 0, 'calm')).toBe(7);
        // blocked tier → neglect term zeroed, only base_heat remains
        expect(goalScore(goal({ horizon: 'long', base_heat: 4, lastAdvancedTick: 0 }), 5, 0, 'dangerous')).toBe(4);
    });

    it('chooseTick: color roll fires when rng below threshold', () => {
        const c = chooseTick(npc({ goalRecords: [goal()] }), 1, 'calm', constRng(0));
        expect(c.kind).toBe('color');
    });

    it('chooseTick: picks highest-score active goal (no color)', () => {
        const cold = goal({ text: 'cold', lastAdvancedTick: 5 }); // low neglect
        const hot = goal({ text: 'hot', lastAdvancedTick: 0 });   // high neglect → hotter
        const c = chooseTick(npc({ goalRecords: [cold, hot] }), 5, 'calm', constRng(0.99));
        expect(c.kind).toBe('goal');
        if (c.kind === 'goal') expect(c.goal.text).toBe('hot');
    });

    it('chooseTick: all goals blocked → need (never idle from absence)', () => {
        const c = chooseTick(npc({ goalRecords: [goal({ horizon: 'long' })] }), 1, 'dangerous', constRng(0.99));
        expect(c.kind).toBe('need');
    });

    it('chooseTick: no goals at all → idle', () => {
        const c = chooseTick(npc({ goalRecords: [] }), 1, 'calm', constRng(0.99));
        expect(c.kind).toBe('idle');
    });
});

// ── Piece B — karma dice + degrees (§9.6) ────────────────────────────────────
describe('Piece B — karma dice', () => {
    it('karmaBonus = min(failStreak*2, 6)', () => {
        expect(karmaBonus(0)).toBe(0);
        expect(karmaBonus(1)).toBe(2);
        expect(karmaBonus(3)).toBe(6);
        expect(karmaBonus(4)).toBe(6); // cap
        expect(karmaBonus(99)).toBe(6);
    });

    it('bandFromMargin: nat overrides win', () => {
        expect(bandFromMargin(20, -50)).toBe('critSuccess');
        expect(bandFromMargin(1, 50)).toBe('critFail');
    });

    it('bandFromMargin: 6 bands by margin boundaries', () => {
        expect(bandFromMargin(5, 10)).toBe('critSuccess');
        expect(bandFromMargin(5, 9)).toBe('success');
        expect(bandFromMargin(5, 3)).toBe('success');
        expect(bandFromMargin(5, 2)).toBe('successBut');
        expect(bandFromMargin(5, 0)).toBe('successBut');
        expect(bandFromMargin(5, -1)).toBe('failBut');
        expect(bandFromMargin(5, -3)).toBe('failBut');
        expect(bandFromMargin(5, -4)).toBe('fail');
        expect(bandFromMargin(5, -9)).toBe('fail');
        expect(bandFromMargin(5, -10)).toBe('critFail');
    });

    it('nextFailStreak: success-tier resets, fail-tier increments', () => {
        expect(nextFailStreak(3, 'critSuccess')).toBe(0);
        expect(nextFailStreak(3, 'success')).toBe(0);
        expect(nextFailStreak(3, 'successBut')).toBe(0);
        expect(nextFailStreak(3, 'failBut')).toBe(4);
        expect(nextFailStreak(3, 'fail')).toBe(4);
        expect(nextFailStreak(3, 'critFail')).toBe(4);
    });

    it('rollGoal: adds karma to the roll (anti-deadlock)', () => {
        // nat 10, failStreak 3 → karma +6; roll = 16 vs DC 10 → margin +6 → success
        const r = rollGoal(goal({ failStreak: 3 }), GOAL_BASE_DC, 0, fixedNat(10));
        expect(r.nat).toBe(10);
        expect(r.roll).toBe(16);
        expect(r.margin).toBe(6);
        expect(r.band).toBe('success');
    });
});

// ── Piece C — progress-quota (§9.7) ──────────────────────────────────────────
describe('Piece C — progress-quota', () => {
    it('progressDelta band table (+2/+1/+1/0/0/-1)', () => {
        expect(progressDelta('critSuccess')).toBe(2);
        expect(progressDelta('success')).toBe(1);
        expect(progressDelta('successBut')).toBe(1);
        expect(progressDelta('failBut')).toBe(0);
        expect(progressDelta('fail')).toBe(0);
        expect(progressDelta('critFail')).toBe(-1);
    });

    it('applyBandToGoal: advances progress + stamps lastAdvancedTick', () => {
        const g = applyBandToGoal(goal({ progress: 0 }), 'success', 7);
        expect(g.progress).toBe(1);
        expect(g.lastAdvancedTick).toBe(7);
        expect(g.state).toBe('active');
    });

    it('applyBandToGoal: critSuccess sets justifiedEventFlag', () => {
        const g = applyBandToGoal(goal(), 'critSuccess', 1);
        expect(g.justifiedEventFlag).toBe(true);
        expect(g.progress).toBe(2);
    });

    it('applyBandToGoal: critFail may go negative; achieved when progress>=quota', () => {
        expect(applyBandToGoal(goal({ progress: 0 }), 'critFail', 1).progress).toBe(-1);
        expect(applyBandToGoal(goal({ progress: 9, quota: 10 }), 'success', 1).state).toBe('achieved');
    });

    it('tier-cross needs BOTH progress>=quota AND justifiedEventFlag', () => {
        expect(canCrossTier(goal({ progress: 10, quota: 10 }))).toBe(false);                       // no flag
        expect(canCrossTier(goal({ progress: 5, quota: 10, justifiedEventFlag: true }))).toBe(false); // short
        expect(canCrossTier(goal({ progress: 10, quota: 10, justifiedEventFlag: true }))).toBe(true);
    });

    it('consumeTierCross clears flag and resets progress', () => {
        const g = consumeTierCross(goal({ progress: 12, quota: 10, justifiedEventFlag: true }));
        expect(g.progress).toBe(0);
        expect(g.justifiedEventFlag).toBe(false);
    });
});

// ── Piece D — timeskip curve (§9.7) ──────────────────────────────────────────
describe('Piece D — timeskip curve', () => {
    it('ticksForDuration matches the spec curve rows', () => {
        expect(ticksForDuration(0)).toBe(0);
        expect(ticksForDuration(1)).toBe(2);    // 1 wk
        expect(ticksForDuration(3)).toBe(3);    // 3 wk forge
        expect(ticksForDuration(4)).toBe(3);    // ~1 mo
        expect(ticksForDuration(13)).toBe(6);   // ~3 mo
        expect(ticksForDuration(26)).toBe(7);   // ~6 mo
        expect(ticksForDuration(52)).toBe(9);   // ~1 yr
        expect(ticksForDuration(104)).toBe(10); // 2 yr → cap
        expect(ticksForDuration(100000)).toBe(10); // bounded
    });

    it('allocateTicks: hottest-first, respects budget, deterministic ties', () => {
        const cold = goal({ text: 'cold', lastAdvancedTick: 5 });
        const hot = goal({ text: 'hot', lastAdvancedTick: 0 });
        const alloc = allocateTicks([cold, hot], 2, 5, 0, 'calm');
        expect(alloc.length).toBe(2);
        expect(alloc[0]).toBe(1); // hot goal (index 1) first
    });

    it('allocateTicks: skips context-blocked goals', () => {
        const longGoal = goal({ horizon: 'long', lastAdvancedTick: 0 });
        const alloc = allocateTicks([longGoal], 3, 5, 0, 'dangerous');
        expect(alloc).toEqual([]); // long blocked in danger
    });
});

// ── Heartbeat pity timer (§5/§9.3#1) ─────────────────────────────────────────
describe('heartbeat', () => {
    it('miss reduces DC by reduction', () => {
        const r = rollHeartbeat({ dc: 20 }, constRng(0)); // roll 1 < 20 → miss
        expect(r.fired).toBe(false);
        expect(r.nextDc).toBe(HEARTBEAT_DC.initial - HEARTBEAT_DC.reduction);
    });

    it('fire resets DC to initial', () => {
        const r = rollHeartbeat({ dc: 20 }, constRng(0.99)); // roll 100 >= 20 → fire
        expect(r.fired).toBe(true);
        expect(r.nextDc).toBe(HEARTBEAT_DC.initial);
    });

    it('DC never drops below the floor', () => {
        const r = rollHeartbeat({ dc: 3 }, constRng(0)); // 3 - 5 → clamps to floor 0
        expect(r.nextDc).toBe(HEARTBEAT_DC.floor);
    });

    it('buildProximityRoster excludes PC/walkon/ineligible; includes region/faction/edge', () => {
        const pc = npc({ id: 'pc', isPC: true, region: 'academy', faction: 'school' });
        // WO-04: proximity roster also requires populated:true (the background sweep was dropped;
        // an NPC only ticks off-screen after on-stage fill). Add populated:true to the three NPCs
        // the test expects to be included so they pass the new guard; the excluded ones (d/w/x)
        // are filtered by other rules and don't need it.
        const byRegion = npc({ id: 'a', region: 'academy', faction: 'other', populated: true });
        const byFaction = npc({ id: 'b', region: 'far', faction: 'school', populated: true });
        const byEdge = npc({ id: 'c', region: 'far', faction: 'other', relations: { pc: 2 }, populated: true });
        const distant = npc({ id: 'd', region: 'far', faction: 'other' });
        const walkon = npc({ id: 'w', region: 'academy', tier: 'walkon' });
        const dead = npc({ id: 'x', region: 'academy', condition: 'dead' });

        const roster = buildProximityRoster([pc, byRegion, byFaction, byEdge, distant, walkon, dead], pc);
        const ids = roster.map(n => n.id).sort();
        expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('buildProximityRoster matches multi-faction strings on shared factions', () => {
        const pc = npc({ id: 'pc', isPC: true, faction: 'Ironspire Knights, Mages Guild' });
        const sharedFactionNpc = npc({ id: 'a', region: 'far', faction: 'Mages Guild / Thieves Guild', populated: true });
        const nonMatchingNpc = npc({ id: 'b', region: 'far', faction: 'Shadow Hand', populated: true });

        const roster = buildProximityRoster([pc, sharedFactionNpc, nonMatchingNpc], pc);
        expect(roster.map(n => n.id)).toEqual(['a']);
    });
});

// ── Migration idempotency (§9.6 seam) ────────────────────────────────────────
describe('wants → goals migration', () => {
    it('buildGoalsFromWants: medium→med, long→long, ambitious raises long base_heat', () => {
        const goals = buildGoalsFromWants(['win a duel'], 'become the strongest', ['ambitious'], 0);
        expect(goals).toHaveLength(2);
        const med = goals.find(g => g.horizon === 'med')!;
        const long = goals.find(g => g.horizon === 'long')!;
        expect(med.base_heat).toBe(BASE_HEAT.med);
        expect(long.base_heat).toBe(BASE_HEAT.long + AMBITIOUS_HEAT_BONUS);
        expect(long.quota).toBe(QUOTA_BY_HORIZON.long);
    });

    it('buildGoalsFromWants skips blank strings', () => {
        expect(buildGoalsFromWants(['', '  '], '', [], 0)).toEqual([]);
    });

    it('upgradeWantsToGoals: idempotent — existing records untouched', () => {
        const existing = [goal({ text: 'existing' })];
        const n = npc({ goalRecords: existing, wants: { short: [], medium: ['x'], long: 'y' } });
        expect(upgradeWantsToGoals(n, 1)).toBe(existing);
    });

    it('upgradeWantsToGoals: skips the PC', () => {
        const n = npc({ isPC: true, wants: { short: [], medium: ['x'], long: 'y' } });
        expect(upgradeWantsToGoals(n, 1)).toEqual([]);
    });

    it('upgradeWantsToGoals: seeds from wants when empty', () => {
        const n = npc({ wants: { short: ['eat'], medium: ['win a duel'], long: 'rule' } });
        const goals = upgradeWantsToGoals(n, 3);
        expect(goals.map(g => g.horizon).sort()).toEqual(['long', 'med']);
        expect(goals.every(g => g.lastAdvancedTick === 3)).toBe(true);
    });
});

// ── Timeskip detect + narration (WO 08) ──────────────────────────────────────
describe('timeskip detect', () => {
    it('parses weeks / months / none', () => {
        const w = detectTimeskip('3 weeks later, the forge cooled');
        expect(w && 'weeks' in w && w.weeks).toBe(3);
        const m = detectTimeskip('a month later');
        expect(m && 'weeks' in m && Math.round((m as { weeks: number }).weeks)).toBe(4);
        expect(detectTimeskip('nothing happened here')).toBeNull();
    });

    it('flags ambiguous "season"', () => {
        const r = detectTimeskip('a season later');
        expect(r && 'ambiguous' in r).toBe(true);
    });
});

describe('timeskip narration (return beat)', () => {
    it('grounds the beat in NAMES + word-bands, never engine numbers or ids', () => {
        const roster = [
            npc({
                id: 'a1',
                name: 'Alden',
                personalityHex: { drive: 0 } as NPCEntry['personalityHex'],
                goalRecords: [goal({ text: 'master the blade', horizon: 'long', quota: 20 })],
            }),
        ];
        let consumed = 0;
        const result = runTimeskip({
            provider: null,
            roster,
            weeks: 3,
            now: 0,
            sceneStakes: 'calm',
            advanceTick: (by) => { consumed += by; return consumed; },
            rng: constRng(0.99), // tempo passes (100) + nat 20 → critSuccess every tick
        });

        expect(result.ticksConsumed).toBe(3);
        expect(result.narration).toContain('Alden');
        expect(result.narration).toContain('master the blade');
        expect(result.narration).not.toContain('a1');   // internal id never leaks
        expect(result.narration).not.toMatch(/\d/);      // no engine numbers reach narration
    });

    it('returns empty narration for a zero-length skip', () => {
        const result = runTimeskip({
            provider: null,
            roster: [npc({ goalRecords: [goal()] })],
            weeks: 0,
            now: 0,
            sceneStakes: 'calm',
            advanceTick: (by) => by,
            rng: constRng(0.99),
        });
        expect(result.ticksConsumed).toBe(0);
        expect(result.narration).toBe('');
    });
});
