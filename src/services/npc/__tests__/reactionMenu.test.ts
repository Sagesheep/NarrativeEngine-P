import { describe, it, expect } from 'vitest';
import type { NPCEntry, PersonalityHex } from '../../../types';
import {
    scoreReaction,
    passesGate,
    buildReactionMenu
} from '../reactionMenu';
import { REACTION_VOCAB, type ReactionEntry } from '../agency/agencyPools';
import { buildBehaviorDirective } from '../npcBehaviorDirective';

// ── Seeded RNG (mulberry32) — deterministic across runs. Matches the codebase convention
// (see hexRoll.test.ts). Injected into buildReactionMenu so the sampled ranks are stable.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeNpc(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'test-1',
        name: 'Test NPC',
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
        personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
        traits: [],
        ...overrides
    } as NPCEntry;
}

// A loyal / high-empathy / high-warmth NPC — the "Kakashi" headline case. Jealousy/betrayal
// must NEVER appear on this NPC's menu (gate excludes + low score excludes → double backstop).
const KAKASHI_HEX: PersonalityHex = { drive: 1, diligence: 2, boldness: 1, warmth: 2, empathy: 2, composure: 1 };
const KAKASHI = (): NPCEntry => makeNpc({
    id: 'kakashi',
    name: 'Kakashi',
    personalityHex: KAKASHI_HEX,
    traits: ['loyal', 'protective', 'honorable']
});

describe('reactionMenu — scoreReaction', () => {
    it('dots axisWeights against the NPC hex', () => {
        const r: ReactionEntry = {
            text: 'warm encouragement', context: 'peaceful', tier: 'default',
            axisWeights: { warmth: 1, empathy: 1 }
        };
        // warmth 2 + empathy 2 = 4 (relationWeight absent → no relationship term)
        expect(scoreReaction(r, KAKASHI(), 0)).toBe(4);
    });

    it('adds TRAIT_BONUS per matching traitKey', () => {
        const r: ReactionEntry = {
            text: 'protective deflection', context: 'dangerous', tier: 'default',
            axisWeights: { warmth: 1 }, traitKeys: ['loyal', 'protective', 'curious']
        };
        // warmth 2 + (loyal + protective = 2 hits) * 2 = 6
        expect(scoreReaction(r, KAKASHI(), 0)).toBe(6);
    });

    it('applies relationWeight * pcRel — a negative weight scores HIGH at low trust, fades when liked', () => {
        const betray: ReactionEntry = {
            text: 'sell out', context: 'peaceful', tier: 'default',
            axisWeights: {}, relationWeight: -2
        };
        const npc = makeNpc();
        expect(scoreReaction(betray, npc, 0)).toBe(0);    // stranger: -2 * 0 = 0
        expect(scoreReaction(betray, npc, -3)).toBe(6);   // hostile: -2 * -3 = +6 (very likely)
        expect(scoreReaction(betray, npc, 3)).toBe(-6);   // devoted: -2 * 3 = -6 (vanishes)
    });

    it('returns 0 when NPC has no hex (legacy)', () => {
        const r: ReactionEntry = {
            text: 'x', context: 'peaceful', tier: 'default', axisWeights: { warmth: 2 }
        };
        const npc = makeNpc({ personalityHex: undefined });
        expect(scoreReaction(r, npc, 0)).toBe(0);
    });
});

describe('reactionMenu — passesGate', () => {
    it('drops mature entries when matureMode is false', () => {
        const r: ReactionEntry = { text: 'cruel', context: 'peaceful', tier: 'mature', axisWeights: {} };
        expect(passesGate(r, KAKASHI(), 0, false)).toBe(false);
        expect(passesGate(r, KAKASHI(), 0, true)).toBe(true);
    });

    it('forbidTraitAny is an UNCONDITIONAL exclude (honour blocks underhandedness at any trust)', () => {
        const r: ReactionEntry = {
            text: 'underhanded trick', context: 'peaceful', tier: 'default',
            axisWeights: {}, gate: { forbidTraitAny: ['honorable'] }
        };
        expect(passesGate(r, KAKASHI(), 0, false)).toBe(false);
        expect(passesGate(r, KAKASHI(), 3, false)).toBe(false);
    });

    it('forbidTraitWhenClose is RELATIONSHIP-scoped: loyal blocks betrayal of a CLOSE ally only', () => {
        const betray: ReactionEntry = {
            text: 'quietly sell you out', context: 'peaceful', tier: 'default',
            axisWeights: {}, relationWeight: -2, gate: { forbidTraitWhenClose: ['loyal'] }
        };
        const loyal = makeNpc({ traits: ['loyal'] });
        expect(passesGate(betray, loyal, 0, false)).toBe(true);    // stranger/neutral → CAN betray
        expect(passesGate(betray, loyal, 1, false)).toBe(true);    // warm but not yet "close"
        expect(passesGate(betray, loyal, 2, false)).toBe(false);   // close bond → loyalty engages
        expect(passesGate(betray, loyal, 3, false)).toBe(false);   // devoted → never
        const disloyal = makeNpc({ traits: ['scheming'] });
        expect(passesGate(betray, disloyal, 3, false)).toBe(true); // no loyalty → gate never fires
    });

    it('requireTraitAny excludes an NPC lacking the disposition', () => {
        const r: ReactionEntry = {
            text: 'sadistic cruelty', context: 'peaceful', tier: 'mature',
            axisWeights: { empathy: -2 }, gate: { requireTraitAny: ['sadistic'] }
        };
        expect(passesGate(r, KAKASHI(), 0, true)).toBe(false);
        const sadist = makeNpc({ traits: ['sadistic'] });
        expect(passesGate(r, sadist, 0, true)).toBe(true);
    });

    it('passes when no gate is declared', () => {
        const r: ReactionEntry = { text: 'x', context: 'peaceful', tier: 'default', axisWeights: {} };
        expect(passesGate(r, KAKASHI(), 0, false)).toBe(true);
    });
});

describe('reactionMenu — buildReactionMenu', () => {
    describe('Kakashi case (the headline)', () => {
        it('NEVER contains a jealousy/betrayal reaction (gate + low score)', () => {
            for (let seed = 1; seed <= 50; seed++) {
                const rng = mulberry32(seed);
                const peaceful = buildReactionMenu(KAKASHI(), 'peaceful', rng, false);
                const dangerous = buildReactionMenu(KAKASHI(), 'dangerous', mulberry32(seed), false);
                for (const text of [...peaceful, ...dangerous]) {
                    expect(text).not.toMatch(/jealous|sabotage|betray/i);
                }
            }
        });

        it('excludes any reaction whose gate forbids loyal/honorable', () => {
            const menu = buildReactionMenu(KAKASHI(), 'peaceful', mulberry32(1), false);
            for (const text of menu) {
                const entry = REACTION_VOCAB.find(r => r.text === text);
                expect(entry).toBeDefined();
                const forbidden = entry!.gate?.forbidTraitAny ?? [];
                expect(forbidden.some(t => ['loyal', 'honorable'].includes(t))).toBe(false);
            }
        });
    });

    describe('Relationship-driven availability (the corrected headline)', () => {
        const schemer = (affinity: number) => makeNpc({
            traits: ['loyal', 'scheming', 'mercenary', 'ambitious'],
            personalityHex: { drive: 1, diligence: 0, boldness: 0, warmth: -2, empathy: -2, composure: 0 },
            affinity
        });

        it('a loyal NPC sells out a STRANGER (betrayal is on the table at low/neutral trust)', () => {
            const menu = buildReactionMenu(schemer(50), 'peaceful', mulberry32(1), false);
            expect(menu).toContain('quietly sell you out');
        });

        it('the SAME loyal NPC never betrays a CLOSE ally (relationship gate engages)', () => {
            const menu = buildReactionMenu(schemer(85), 'peaceful', mulberry32(1), false);
            expect(menu).not.toContain('quietly sell you out');
        });
    });

    describe('Selection shape', () => {
        it('rank-1 is always present', () => {
            const npc = makeNpc({
                personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 1, empathy: 1, composure: 1 },
                traits: ['protective', 'loyal']
            });
            const menu = buildReactionMenu(npc, 'peaceful', mulberry32(7), false);
            expect(menu.length).toBeGreaterThan(0);
            expect(menu[0]).toBe('proud, understated approval');
        });

        it('total length == 3 when pool >= 4', () => {
            const npc = makeNpc({
                personalityHex: { drive: -1, diligence: -1, boldness: 0, warmth: -1, empathy: -1, composure: 0 },
                traits: ['jealous', 'vengeful']
            });
            const menu = buildReactionMenu(npc, 'peaceful', mulberry32(3), false);
            expect(menu.length).toBe(3);
            expect(menu).toContain('jealous sabotage');
        });

        it('is deterministic with a seeded rng', () => {
            const npc = makeNpc({
                personalityHex: { drive: -1, diligence: -1, boldness: 0, warmth: -1, empathy: -1, composure: 0 },
                traits: ['jealous', 'vengeful']
            });
            const a = buildReactionMenu(npc, 'peaceful', mulberry32(42), false);
            const b = buildReactionMenu(npc, 'peaceful', mulberry32(42), false);
            expect(a).toEqual(b);
        });
    });

    describe('Gate backstops', () => {
        it('forbidTraitAny:[loyal] reaction never surfaces for a loyal NPC', () => {
            for (let seed = 1; seed <= 20; seed++) {
                const menu = buildReactionMenu(KAKASHI(), 'peaceful', mulberry32(seed), false);
                expect(menu).not.toContain('jealous sabotage');
            }
        });

        it('requireTraitAny reaction never surfaces for an NPC lacking the trait', () => {
            const requireEntries = REACTION_VOCAB.filter(r => r.gate?.requireTraitAny?.length);
            for (const r of requireEntries) {
                const menu = buildReactionMenu(KAKASHI(), r.context, mulberry32(1), false);
                expect(menu).not.toContain(r.text);
            }
        });
    });

    describe('Short-pool', () => {
        it('returns <= available without throwing', () => {
            const npc = makeNpc({
                personalityHex: { drive: 0, diligence: 0, boldness: 2, composure: -1, warmth: 0, empathy: 0 },
                traits: ['impulsive', 'proud']
            });
            const menu = buildReactionMenu(npc, 'dangerous', mulberry32(5), false);
            expect(menu.length).toBeGreaterThanOrEqual(1);
            expect(menu.length).toBeLessThanOrEqual(3);
            expect(menu).toContain('reckless charge');
        });

        it('returns [] for a legacy hex-less NPC', () => {
            const npc = makeNpc({ personalityHex: undefined });
            expect(buildReactionMenu(npc, 'peaceful', mulberry32(1), false)).toEqual([]);
        });

        it('returns [] when no eligible reactions remain after gating', () => {
            const npc = makeNpc({ personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 } });
            const menu = buildReactionMenu(npc, 'peaceful', mulberry32(1), false);
            expect(menu.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Context filter', () => {
        it('only surfaces reactions matching the requested context', () => {
            const npc = makeNpc({
                personalityHex: { drive: 0, diligence: 0, boldness: 2, composure: -1, warmth: 0, empathy: 0 },
                traits: ['impulsive', 'proud']
            });
            const dangerous = buildReactionMenu(npc, 'dangerous', mulberry32(2), false);
            for (const text of dangerous) {
                const entry = REACTION_VOCAB.find(r => r.text === text);
                expect(entry?.context).toBe('dangerous');
            }
        });
    });
});

describe('npcBehaviorDirective integration (enforcement clause)', () => {
    it('appends the REACTIONS line with the enforcement clause for a hex-bearing NPC', () => {
        const npc = KAKASHI();
        const directive = buildBehaviorDirective(npc, { rng: mulberry32(1) });
        expect(directive).toContain('REACTIONS (choose ONE and play it');
        expect(directive).toContain('do NOT invent a softer reaction');
    });

    it('omits the REACTIONS line for a legacy hex-less NPC', () => {
        const npc = makeNpc({ personalityHex: undefined });
        const directive = buildBehaviorDirective(npc);
        expect(directive).not.toContain('REACTIONS');
    });
});