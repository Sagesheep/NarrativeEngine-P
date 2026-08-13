import { describe, it, expect } from 'vitest';
import type { NPCEntry, PersonalityHex } from '../../types';
import { REACTION_VOCAB } from '../agency/agencyPools';
import {
    repressKind,
    repressKindOf,
    hideScoreOf,
    rollRepression,
    repressionToken,
    applyRepressionToMenu,
    bookRepression,
    BURST_THRESHOLD,
    type RepressionEvent,
} from '../reactionRepression';

const hex = (over: Partial<PersonalityHex> = {}): PersonalityHex => ({
    drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0, ...over,
});

const npc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'n', name: 'Test', aliases: '', appearance: '', faction: '', storyRelevance: '',
    disposition: '', status: '', goals: '', voice: '', personality: '', exampleOutput: '',
    affinity: 50, personalityHex: hex(), ...over,
} as NPCEntry);

// A deterministic rng that yields a fixed queue of values, then repeats the last.
const seq = (...vals: number[]) => {
    let i = 0;
    return () => (i < vals.length ? vals[i++] : vals[vals.length - 1]);
};

describe('reactionRepression — valence classification', () => {
    it('tags relationWeight<0 reactions as concealed intent', () => {
        expect(repressKindOf('quietly sell you out')).toBe('concealed');
        expect(repressKindOf('opportunistic side-switch / surrender')).toBe('none'); // dangerous context
    });

    it('tags cold-axis reactions (warmth+empathy<0, no neg relationWeight) as leaked feeling', () => {
        expect(repressKindOf('mocking laughter / sarcastic remark')).toBe('leaked');
        expect(repressKindOf('jealous sabotage')).toBe('leaked');
    });

    it('never tags positive/neutral reactions', () => {
        expect(repressKindOf('warm, encouraging praise')).toBe('none');
        expect(repressKindOf('offer a generous gift / share resources')).toBe('none');
        expect(repressKindOf('obsessive study / lose themselves in detail')).toBe('none');
    });

    it('excludes "withdraw and go quiet" — it IS the mask, not a target', () => {
        const entry = REACTION_VOCAB.find(r => r.text === 'withdraw and go quiet')!;
        expect((entry.axisWeights.warmth ?? 0)).toBeLessThan(0);
        expect(repressKind(entry)).toBe('none');
    });

    it('never tags dangerous-context reactions (peaceful-only scope)', () => {
        const dangerous = REACTION_VOCAB.filter(r => r.context === 'dangerous');
        for (const r of dangerous) expect(repressKind(r)).toBe('none');
    });
});

describe('reactionRepression — hideScore', () => {
    it('rises with composure, falls with boldness, closeness, and pressure', () => {
        const guarded = npc({ personalityHex: hex({ composure: 3, boldness: -2 }), pcRelation: -2 });
        const open = npc({ personalityHex: hex({ composure: -2, boldness: 3 }), pcRelation: 3 });
        expect(hideScoreOf(guarded)).toBeGreaterThan(hideScoreOf(open));
    });

    it('pressure lowers the hide score (pushes toward the break)', () => {
        const base = npc({ personalityHex: hex({ composure: 2 }) });
        const loaded = npc({ personalityHex: hex({ composure: 2 }), repressionPressure: 5 });
        expect(hideScoreOf(loaded)).toBe(hideScoreOf(base) - 5);
    });
});

describe('reactionRepression — rollRepression', () => {
    it('forces a burst (express + discharge + catharsis) at/above the threshold', () => {
        const n = npc({ repressionPressure: BURST_THRESHOLD, pcRelation: 0 });
        const ev = rollRepression(n, seq(0.5)); // catharsis roll < 0.6 → +1
        expect(ev.outcome).toBe('burst');
        expect(ev.pressureDelta).toBe(-BURST_THRESHOLD);
        expect(ev.pcRelationDelta).toBe(1);
    });

    it('hides (+1 pressure) when the roll is below the hide chance', () => {
        const n = npc({ personalityHex: hex({ composure: 3, boldness: -1 }), pcRelation: 0 });
        const ev = rollRepression(n, seq(0.01));
        expect(ev.pressureDelta).toBe(1);
        expect(ev.outcome).toBe('mask'); // composure-boldness = 4 >= MASK_CONTROL
    });

    it('leaks (not full mask) when control is modest', () => {
        const n = npc({ personalityHex: hex({ composure: 1, boldness: 1 }), pcRelation: 0 });
        const ev = rollRepression(n, seq(0.01));
        expect(ev.pressureDelta).toBe(1);
        expect(ev.outcome).toBe('leak'); // control 0 < MASK_CONTROL
    });

    it('expresses (no pressure change) when the roll exceeds the hide chance', () => {
        const n = npc({ personalityHex: hex({ composure: 0, boldness: 0 }), pcRelation: 0 });
        const ev = rollRepression(n, seq(0.99));
        expect(ev.outcome).toBe('express');
        expect(ev.pressureDelta).toBe(0);
    });
});

describe('reactionRepression — token rendering', () => {
    it('leaves raw text on express/burst', () => {
        expect(repressionToken('mocking laughter', 'leaked', 'express')).toBe('mocking laughter');
        expect(repressionToken('mocking laughter', 'leaked', 'burst')).toBe('mocking laughter');
    });

    it('leaked feeling → emotional tell; concealed intent → behavioral tell', () => {
        expect(repressionToken('mocking laughter', 'leaked', 'leak')).toMatch(/leaks through/);
        expect(repressionToken('quietly sell you out', 'concealed', 'leak')).toMatch(/behavior/);
    });

    it('mask wording is fainter than leak wording', () => {
        expect(repressionToken('mocking laughter', 'leaked', 'mask')).toMatch(/faintest/);
    });
});

describe('reactionRepression — applyRepressionToMenu', () => {
    it('rewrites the first repressible entry and returns an event', () => {
        const menu = ['mocking laughter / sarcastic remark', 'warm, encouraging praise'];
        const n = npc({ personalityHex: hex({ composure: 3, boldness: -1 }) });
        const { menu: out, event } = applyRepressionToMenu(menu, n, 'peaceful', seq(0.01));
        expect(out[0]).not.toBe(menu[0]);
        expect(out[0]).toMatch(/mocking laughter/);
        expect(out[1]).toBe('warm, encouraging praise');
        expect(event?.pressureDelta).toBe(1);
    });

    it('is a no-op in dangerous context', () => {
        const menu = ['mocking laughter / sarcastic remark'];
        const { menu: out, event } = applyRepressionToMenu(menu, npc(), 'dangerous', seq(0.01));
        expect(out).toEqual(menu);
        expect(event).toBeNull();
    });

    it('is a no-op when no entry is repressible', () => {
        const menu = ['warm, encouraging praise', 'offer a generous gift / share resources'];
        const { menu: out, event } = applyRepressionToMenu(menu, npc(), 'peaceful', seq(0.01));
        expect(out).toEqual(menu);
        expect(event).toBeNull();
    });

    it('does not mutate the input npc', () => {
        const n = npc({ repressionPressure: 0 });
        applyRepressionToMenu(['jealous sabotage'], n, 'peaceful', seq(0.01));
        expect(n.repressionPressure).toBe(0);
    });
});

describe('reactionRepression — bookRepression reducer', () => {
    it('increments pressure on a hide', () => {
        const patch = bookRepression(npc({ repressionPressure: 2 }), { outcome: 'leak', pressureDelta: 1 });
        expect(patch.repressionPressure).toBe(3);
    });

    it('discharges pressure to 0 on burst and clamps at 0', () => {
        const ev: RepressionEvent = { outcome: 'burst', pressureDelta: -BURST_THRESHOLD, pcRelationDelta: 1 };
        const patch = bookRepression(npc({ repressionPressure: BURST_THRESHOLD, pcRelation: 0 }), ev);
        expect(patch.repressionPressure).toBe(0);
        expect(patch.pcRelation).toBe(1);
    });

    it('clamps the catharsis pcRelation step to ±1 within [-3,3] and skips when pcRelation unset', () => {
        const big: RepressionEvent = { outcome: 'burst', pressureDelta: -1, pcRelationDelta: 5 };
        expect(bookRepression(npc({ pcRelation: 3 }), big).pcRelation).toBeUndefined();
        expect(bookRepression(npc({ pcRelation: 1 }), big).pcRelation).toBe(2);
        expect(bookRepression(npc({ pcRelation: undefined }), big).pcRelation).toBeUndefined();
    });

    it('returns an empty patch when nothing changed (express)', () => {
        const patch = bookRepression(npc({ repressionPressure: 0 }), { outcome: 'express', pressureDelta: 0 });
        expect(patch).toEqual({});
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-3 (parity 30/06) — once-per-turn booking contract.
//
// The write-half of repression was deferred (bookRepression had no production caller),
// so pressure never accrued and the build-up → burst dynamic was inert. postTurnPipeline
// now books exactly once per on-stage NPC per turn: applyRepressionToMenu → bookRepression
// → merge. This locks in that loop's accrual math: +1 per turn while masking, discharge at
// BURST_THRESHOLD, and — critically — NOT double-counting within a single turn (the trap
// that kept booking out of the re-running payload read path).
// ─────────────────────────────────────────────────────────────────────────────
describe('reactionRepression — once-per-turn accrual → burst (WO-3 pipeline contract)', () => {
    const HOSTILE_MENU = ['mocking laughter / sarcastic remark']; // 'leaked' → repressible
    const GUARDED = () => npc({ personalityHex: hex({ composure: 3, boldness: -1 }), pcRelation: 0, repressionPressure: 0 });

    // Mirror the postTurnPipeline booking site exactly: one roll, one book, one merge.
    const bookOnce = (s: NPCEntry, rng: () => number): NPCEntry => {
        const { event } = applyRepressionToMenu(HOSTILE_MENU, s, 'peaceful', rng);
        if (!event) return s;
        return { ...s, ...bookRepression(s, event) };
    };

    it('accrues +1 pressure per turn while masking, then bursts at BURST_THRESHOLD', () => {
        const rng = () => 0.01; // always below the hide chance → hide every non-burst turn
        let state = GUARDED();

        for (let turn = 1; turn <= BURST_THRESHOLD; turn++) {
            state = bookOnce(state, rng);
            expect(state.repressionPressure).toBe(turn); // strictly +1 each turn
        }
        expect(state.repressionPressure).toBe(BURST_THRESHOLD);

        // Next turn: pressure is at threshold → burst discharges to 0 + catharsis nudge.
        const before = state.pcRelation!;
        state = bookOnce(state, rng);
        expect(state.repressionPressure).toBe(0);
        expect(state.pcRelation).toBe(before + 1); // rollCatharsis(0.01) < 0.6 → +1
    });

    it('a single booking call increments pressure exactly once (no double-count)', () => {
        const { event } = applyRepressionToMenu(HOSTILE_MENU, GUARDED(), 'peaceful', () => 0.01);
        expect(bookRepression(GUARDED(), event!).repressionPressure).toBe(1); // +1, never +2
    });

    it('freezes only the scalar catharsis correction when relationship memory is enabled', () => {
        const event = { outcome: 'burst' as const, pressureDelta: -4, pcRelationDelta: 1 };
        expect(bookRepression({ ...GUARDED(), repressionPressure: 4 }, event, true)).toEqual({ repressionPressure: 0 });
    });
});
