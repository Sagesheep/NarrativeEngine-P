import { describe, it, expect } from 'vitest';
import {
    scanPressure,
    shouldArchiveNPC,
    findArchivedToRestore,
    buildPressurePatch,
    type PressureUpdate,
} from '../npcPressureTracker';
import type { NPCEntry } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for npcPressureTracker.ts (Refactor 19-06 Plan 04 w1).
// Hand-derived numbers from the source. DECAY_RATE=0.1, ARCHIVE_THRESHOLD_TURNS=15,
// ARCHIVE_PRESSURE_FLOOR=0.5, ARCHIVE_AFFINITY_PROTECT=7, MAX_HISTORY=50.
// ─────────────────────────────────────────────────────────────────────────────

const baseNPC = (over: Partial<NPCEntry>): NPCEntry => ({
    id: 'npc1',
    name: 'Aldric',
    aliases: '',
    appearance: '',
    faction: '',
    storyRelevance: '',
    disposition: '',
    status: '',
    goals: '',
    voice: '',
    personality: '',
    exampleOutput: '',
    affinity: 50,
    drives: { coreWant: 'revenge', sessionWant: 'find the sword', sceneWant: 'talk' },
    ...over,
} as NPCEntry);

describe('scanPressure — engaged/ignored deltas and reasons', () => {
    it('skips NPCs that have no drives/triggers/boundaries (no deltas emitted)', () => {
        const npc = baseNPC({
            id: 'blank',
            drives: undefined,
            behavioralTriggers: undefined,
            hardBoundaries: undefined,
            softBoundaries: undefined,
        });
        const out = scanPressure('Aldric is here', [npc]);
        expect(out).toEqual([]);
    });
    it('name mention → engaged +1, reason "name mentioned"', () => {
        const out = scanPressure('Aldric, come here', [baseNPC({})]);
        expect(out).toHaveLength(1);
        expect(out[0].engagedDelta).toBe(1);
        expect(out[0].ignoredDelta).toBe(0);
        expect(out[0].reasons).toContain('name mentioned');
    });
    it('alias mention counts as a name mention (+1 engaged)', () => {
        const npc = baseNPC({ aliases: 'Al, The Brave' });
        const out = scanPressure('hey Al, come here', [npc]);
        expect(out[0].engagedDelta).toBe(1);
        expect(out[0].reasons).toContain('name mentioned');
    });
    it('pronoun near name → engaged +0.5 (on top of +1 name mention = 1.5)', () => {
        const out = scanPressure('Aldric, she is here with me', [baseNPC({})]);
        // mentionsName +1, pronounNearName +0.5 -> 1.5
        expect(out[0].engagedDelta).toBeCloseTo(1.5);
        expect(out[0].reasons).toContain('pronoun near name');
    });
    it('pronoun near alias also triggers (+0.5)', () => {
        const npc = baseNPC({ aliases: 'Al' });
        const out = scanPressure('I told Al, he agreed', [npc]);
        // name mention (+1 for Al) + pronoun near name (+0.5 for "he" near "al")
        expect(out[0].engagedDelta).toBeCloseTo(1.5);
    });
    it('directed action ("talk to aldric") → engaged +2 on top of +1 name mention = 3', () => {
        // "talk to Aldric" both mentions the name (+1) AND triggers directsActionAt (+2)
        const out = scanPressure('I want to talk to Aldric about the map', [baseNPC({})]);
        expect(out[0].engagedDelta).toBe(3);
        expect(out[0].reasons).toContain('directed action at NPC');
        expect(out[0].reasons).toContain('name mentioned');
    });
    it('"i ask aldric" also triggers directed action (+2) alongside name mention (+1) = 3', () => {
        const out = scanPressure('i ask Aldric a question', [baseNPC({})]);
        expect(out[0].engagedDelta).toBe(3);
        expect(out[0].reasons).toContain('directed action at NPC');
    });
    it('matched behavioral trigger keyword → ignored +1', () => {
        const npc = baseNPC({ behavioralTriggers: [{ keyword: 'insult', shift: 'angry' }] });
        const out = scanPressure('I insult Aldric loudly', [npc]);
        expect(out[0].ignoredDelta).toBe(1);
        expect(out[0].reasons).toContain('trigger keyword: "insult"');
    });
    it('soft boundary crossing → ignored +1', () => {
        const npc = baseNPC({ softBoundaries: ['the vault topic'] });
        const out = scanPressure('let us discuss the vault topic', [npc]);
        expect(out[0].ignoredDelta).toBe(1);
        expect(out[0].reasons).toContain('soft boundary crossed');
    });
    it('empty softBoundaries array never crosses (no ignored delta)', () => {
        const npc = baseNPC({ softBoundaries: [] });
        const out = scanPressure('anything goes', [npc]);
        expect(out).toEqual([]); // nothing triggered, drives exist but no name/boundary
    });
    it('GM response: name mention +0.8 engaged, pronoun near +0.3 engaged (player input has no mention)', () => {
        const out = scanPressure('hello', [baseNPC({})], 'Aldric arrives, he looks tired');
        // player: no mention ; GM: mention +0.8 + pronoun +0.3 = 1.1
        expect(out[0].engagedDelta).toBeCloseTo(1.1);
        expect(out[0].reasons).toContain('GM mentioned NPC');
        expect(out[0].reasons).toContain('GM pronoun near NPC name');
    });
    it('GM trigger keyword → engaged +0.5 with "GM trigger:" reason prefix', () => {
        const npc = baseNPC({ behavioralTriggers: [{ keyword: 'dragon', shift: 'panic' }] });
        const out = scanPressure('hello', [npc], 'the dragon attacks');
        // player: no trigger ; GM: trigger +0.5
        expect(out[0].engagedDelta).toBeCloseTo(0.5);
        expect(out[0].reasons.some(r => r.startsWith('GM trigger:'))).toBe(true);
    });
    it('emits no update when neither ignored nor engaged delta is positive', () => {
        // Player input doesn't mention NPC, no triggers, no boundaries — GM response empty
        const out = scanPressure('the weather is nice', [baseNPC({})]);
        expect(out).toEqual([]);
    });
    it('npcId on the update matches the npc.id that triggered it', () => {
        const npc = baseNPC({ id: 'unique-id-42' });
        expect(scanPressure('Aldric!', [npc])[0].npcId).toBe('unique-id-42');
    });
});

describe('shouldArchiveNPC — staleness + pressure floor + protectors', () => {
    const staleNPC = (over: Partial<NPCEntry> = {}): NPCEntry => baseNPC({
        affinity: 0, // below ARCHIVE_AFFINITY_PROTECT=7 so the protector branch doesn't short-circuit
        pressure: { ignored: 0, engaged: 0, lastDecayTurn: 0, lastActiveTurn: 0, history: [] },
        ...over,
    });

    it('already-archived NPC: never archives, empty reason', () => {
        const r = shouldArchiveNPC(staleNPC({ archived: true }), 100, 15);
        expect(r.shouldArchive).toBe(false);
        expect(r.turnsSince).toBe(0);
        expect(r.reason).toBe('');
    });
    it('maxStaleTurns <= 0 disables archiving', () => {
        const r = shouldArchiveNPC(staleNPC(), 100, 0);
        expect(r.shouldArchive).toBe(false);
    });
    it('affinity >= 7 protects from archiving', () => {
        const r = shouldArchiveNPC(staleNPC({ affinity: 7 }), 100, 15);
        expect(r.shouldArchive).toBe(false);
    });
    it('affinity 6 (below 7) is NOT protected and can archive when stale', () => {
        const r = shouldArchiveNPC(staleNPC({ affinity: 6 }), 100, 15);
        expect(r.shouldArchive).toBe(true);
    });
    it('shiftNote present protects from archiving', () => {
        const r = shouldArchiveNPC(staleNPC({ shiftNote: 'grieving' }), 100, 15);
        expect(r.shouldArchive).toBe(false);
    });
    it('just-active NPC (turnsSince < threshold) does not archive; turnsSince reported', () => {
        // lastActiveTurn 95, current 100, threshold 15 -> turnsSince 5, under threshold
        const r = shouldArchiveNPC(staleNPC({ pressure: { ignored: 0, engaged: 0, lastDecayTurn: 0, lastActiveTurn: 95, history: [] } }), 100, 15);
        expect(r.shouldArchive).toBe(false);
        expect(r.turnsSince).toBe(5);
    });
    it('stale + low pressure (< 0.5 both) -> "auto-archive: stale + low pressure"', () => {
        // lastActiveTurn 0, current 100 -> turnsSince 100. decay: 0 - 0.1*100 = -10 -> clamp 0. floor 0.5 -> low pressure.
        const r = shouldArchiveNPC(staleNPC(), 100, 15);
        expect(r.shouldArchive).toBe(true);
        expect(r.turnsSince).toBe(100);
        expect(r.reason).toBe('auto-archive: stale + low pressure');
    });
    it('stale + high engaged pressure -> "auto-archive: stale" (high pressure, still archives)', () => {
        const npc = staleNPC({ pressure: { ignored: 0, engaged: 10, lastDecayTurn: 100, lastActiveTurn: 0, history: [] } });
        // turnsSince 100, decay from lastDecayTurn 100 -> 0 turns -> engaged stays 10, ignored stays 0
        // engaged 10 >= 0.5 -> NOT low pressure -> reason "auto-archive: stale"
        const r = shouldArchiveNPC(npc, 100, 15);
        expect(r.shouldArchive).toBe(true);
        expect(r.reason).toBe('auto-archive: stale');
    });
    it('decayed engaged (10 - 0.1*100 = 0 ... wait 10-10=0 clamped 0) below floor after long gap -> low pressure reason', () => {
        // engaged 10, lastDecayTurn 0, current 100 -> decay = max(0, 10 - 0.1*100) = 0 -> low pressure
        const npc = staleNPC({ pressure: { ignored: 0, engaged: 10, lastDecayTurn: 0, lastActiveTurn: 0, history: [] } });
        const r = shouldArchiveNPC(npc, 100, 15);
        expect(r.shouldArchive).toBe(true);
        expect(r.reason).toBe('auto-archive: stale + low pressure');
    });
    it('uses currentTurn as lastActiveTurn fallback when pressure.lastActiveTurn undefined', () => {
        const npc = staleNPC({ pressure: { ignored: 0, engaged: 0, lastDecayTurn: 0, history: [] } }); // no lastActiveTurn
        // lastActiveTurn = currentTurn (100) -> turnsSince 0 -> not stale
        const r = shouldArchiveNPC(npc, 100, 15);
        expect(r.shouldArchive).toBe(false);
        expect(r.turnsSince).toBe(0);
    });
    it('custom maxStaleTurns: 30 requires turnsSince >= 30', () => {
        const npc = staleNPC({ pressure: { ignored: 0, engaged: 0, lastDecayTurn: 0, lastActiveTurn: 70, history: [] } });
        // turnsSince = 100 - 70 = 30 -> exactly at threshold -> archive
        const r = shouldArchiveNPC(npc, 100, 30);
        expect(r.shouldArchive).toBe(true);
        expect(r.turnsSince).toBe(30);
    });
});

describe('findArchivedToRestore — word-boundary name matching', () => {
    const archived = (name: string, aliases: string = ''): NPCEntry => baseNPC({
        archived: true, name, aliases,
    });
    it('returns npc ids whose name appears as a whole word in the text', () => {
        const out = findArchivedToRestore('I want to speak with Aldric again', [archived('Aldric')]);
        expect(out).toEqual(['npc1']);
    });
    it('matches aliases too', () => {
        const out = findArchivedToRestore('call Al for me', [archived('Aldric', 'Al')]);
        expect(out).toEqual(['npc1']);
    });
    it('does NOT match substrings (word boundary enforced)', () => {
        // "Aldricson" contains "aldric" but the regex uses \b — should not match
        const out = findArchivedToRestore('Aldricson arrived', [archived('Aldric')]);
        expect(out).toEqual([]);
    });
    it('skips non-archived NPCs even if their name appears', () => {
        const npc = baseNPC({ archived: false });
        const out = findArchivedToRestore('Aldric is here', [npc]);
        expect(out).toEqual([]);
    });
    it('skips NPCs with empty name', () => {
        const npc = archived('');
        const out = findArchivedToRestore('anything', [npc]);
        expect(out).toEqual([]);
    });
    it('returns multiple ids when several archived NPCs are mentioned', () => {
        const a = archived('Aldric'); a.id = 'a1';
        const b = archived('Brennan'); b.id = 'b1';
        const out = findArchivedToRestore('Aldric and Brennan meet', [a, b]);
        expect(out).toEqual(['a1', 'b1']);
    });
    it('empty archived list -> empty result', () => {
        expect(findArchivedToRestore('Aldric', [])).toEqual([]);
    });
});

describe('buildPressurePatch — decay + delta accumulation + history', () => {
    it('first-time NPC (no prior pressure) gets exactly the update deltas', () => {
        const npc = baseNPC({ pressure: undefined });
        const update: PressureUpdate = {
            npcId: 'npc1',
            ignoredDelta: 1,
            engagedDelta: 2,
            reasons: ['name mentioned', 'directed action at NPC'],
        };
        const patch = buildPressurePatch(npc, update, 5).pressure!;
        // prevDecay from undefined -> applyDecay(0,0,5) = max(0, 0 - 0.1*5) = 0 ; +1 ignored = 1 ; +2 engaged = 2
        expect(patch.ignored).toBe(1);
        expect(patch.engaged).toBe(2);
        expect(patch.lastDecayTurn).toBe(5);
        expect(patch.lastActiveTurn).toBe(5); // engagedDelta > 0
        expect(patch.history).toHaveLength(2);
        // name mentioned -> engaged, delta 2/2=1 ; directed action -> engaged, delta 2/1=2 ... see source
        // engagedReasonCount = 2 (both reasons are engaged), so each delta = 2/2 = 1
        expect(patch.history[0]).toEqual({ turn: 5, type: 'engaged', delta: 1, reason: 'name mentioned' });
        expect(patch.history[1]).toEqual({ turn: 5, type: 'engaged', delta: 1, reason: 'directed action at NPC' });
    });
    it('mixed ignored+engaged reasons split delta by type count', () => {
        const npc = baseNPC({ pressure: undefined });
        const update: PressureUpdate = {
            npcId: 'npc1',
            ignoredDelta: 2,    // one "soft boundary crossed" + one "trigger keyword:" => 2 ignored reasons
            engagedDelta: 3,    // name mentioned + directed action + GM mentioned => 3 engaged reasons
            reasons: ['name mentioned', 'directed action at NPC', 'GM mentioned NPC', 'soft boundary crossed', 'trigger keyword: "insult"'],
        };
        const patch = buildPressurePatch(npc, update, 7).pressure!;
        // ignoredReasonCount=2, engagedReasonCount=3
        // ignored delta per reason = 2/2 = 1 ; engaged delta per reason = 3/3 = 1
        const ignoredH = patch.history.filter(h => h.type === 'ignored');
        const engagedH = patch.history.filter(h => h.type === 'engaged');
        expect(ignoredH).toHaveLength(2);
        expect(engagedH).toHaveLength(3);
        expect(ignoredH.every(h => h.delta === 1)).toBe(true);
        expect(engagedH.every(h => h.delta === 1)).toBe(true);
        expect(patch.ignored).toBe(2);
        expect(patch.engaged).toBe(3);
    });
    it('decays prior pressure before adding: engaged 5, lastDecayTurn 0, current 10 -> 5-1=4 + 1 = 5', () => {
        const npc = baseNPC({ pressure: { ignored: 0, engaged: 5, lastDecayTurn: 0, lastActiveTurn: 0, history: [] } });
        const update: PressureUpdate = { npcId: 'npc1', ignoredDelta: 0, engagedDelta: 1, reasons: ['name mentioned'] };
        const patch = buildPressurePatch(npc, update, 10).pressure!;
        // applyDecay(5,0,10) = max(0, 5 - 0.1*10) = 4 ; +1 = 5 (rounded to 1dp: 5)
        expect(patch.engaged).toBe(5);
    });
    it('rounds to 1 decimal place (0.5 + 0.3 = 0.8 stays, but check rounding on 0.1+0.2=0.30000000004 -> 0.3)', () => {
        const npc = baseNPC({ pressure: undefined });
        const update: PressureUpdate = {
            npcId: 'npc1', ignoredDelta: 0, engagedDelta: 0.3, reasons: ['GM pronoun near NPC name'],
        };
        // Wait: GM pronoun near NPC name is in engagedReasons list — engagedReasonCount = 1, delta = 0.3/1 = 0.3
        const patch = buildPressurePatch(npc, update, 1).pressure!;
        expect(patch.engaged).toBe(0.3);
        expect(patch.history[0].delta).toBe(0.3);
    });
    it('ignored-only update leaves lastActiveTurn unchanged (uses prev fallback)', () => {
        const npc = baseNPC({ pressure: { ignored: 1, engaged: 0, lastDecayTurn: 0, lastActiveTurn: 9, history: [] } });
        const update: PressureUpdate = {
            npcId: 'npc1', ignoredDelta: 1, engagedDelta: 0, reasons: ['soft boundary crossed'],
        };
        const patch = buildPressurePatch(npc, update, 10).pressure!;
        // hasEngagedDelta=false -> lastActiveTurn = prev.lastActiveTurn (9)
        expect(patch.lastActiveTurn).toBe(9);
    });
    it('when prev.lastActiveTurn undefined, lastActiveTurn falls back to currentTurn for ignored-only updates', () => {
        const npc = baseNPC({ pressure: { ignored: 1, engaged: 0, lastDecayTurn: 0, history: [] } });
        const update: PressureUpdate = {
            npcId: 'npc1', ignoredDelta: 1, engagedDelta: 0, reasons: ['soft boundary crossed'],
        };
        const patch = buildPressurePatch(npc, update, 10).pressure!;
        expect(patch.lastActiveTurn).toBe(10);
    });
    it('caps history at MAX_HISTORY=50 by dropping the oldest entries', () => {
        const history = Array.from({ length: 60 }, (_, i) => ({
            turn: i, type: 'engaged' as const, delta: 0.1, reason: 'name mentioned',
        }));
        const npc = baseNPC({ pressure: { ignored: 0, engaged: 0, lastDecayTurn: 0, history } });
        const update: PressureUpdate = {
            npcId: 'npc1', ignoredDelta: 0, engagedDelta: 1, reasons: ['name mentioned'],
        };
        const patch = buildPressurePatch(npc, update, 100).pressure!;
        // 60 + 1 = 61 -> splice to 50, dropping the 11 oldest (turns 0..10)
        expect(patch.history).toHaveLength(50);
        // first remaining entry should be the one with turn 11
        expect(patch.history[0].turn).toBe(11);
        expect(patch.history[patch.history.length - 1].turn).toBe(100);
    });
    it('only returns a `pressure` field (no other NPC fields mutated)', () => {
        const npc = baseNPC({ pressure: undefined });
        const update: PressureUpdate = { npcId: 'npc1', ignoredDelta: 0, engagedDelta: 1, reasons: ['name mentioned'] };
        const patch = buildPressurePatch(npc, update, 1);
        expect(Object.keys(patch)).toEqual(['pressure']);
    });
});