import { describe, it, expect } from 'vitest';
import {
    buildBehaviorDirective,
    buildDriftAlert,
    buildKnowledgeBoundary,
} from '../npcBehaviorDirective';
import { createWitnessResolver } from '../witnessResolve';
import type { NPCEntry, ArchiveIndexEntry, DivergenceEntry } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for npcBehaviorDirective.ts (Refactor 19-06 Plan 04 w1).
// Three exports. Hand-derived strings from the source. affinityDescriptor bands:
//   <=15 Nemesis | <=30 Distrustful | <=45 Wary | <=55 Neutral | <=70 Warm
//   | <=85 Trusted ally | else Devoted
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
    ...over,
} as NPCEntry);

describe('buildBehaviorDirective — affinity descriptor bands', () => {
    const cases: Array<[number, string]> = [
        [0, 'Nemesis — actively hostile'],
        [15, 'Nemesis — actively hostile'],     // boundary <= 15
        [16, 'Distrustful — suspicious and cold'],
        [30, 'Distrustful — suspicious and cold'], // boundary <= 30
        [31, 'Wary — cautious, guarded'],
        [45, 'Wary — cautious, guarded'],       // boundary <= 45
        [46, 'Neutral'],
        [55, 'Neutral'],                        // boundary <= 55
        [56, 'Warm — generally friendly'],
        [70, 'Warm — generally friendly'],      // boundary <= 70
        [71, 'Trusted ally'],
        [85, 'Trusted ally'],                   // boundary <= 85
        [86, 'Devoted — deep loyalty'],
        [100, 'Devoted — deep loyalty'],
    ];
    for (const [aff, label] of cases) {
        it(`affinity ${aff} -> "[Aff: ${label}]" (legacy fallback when pcRelation undefined)`, () => {
            // A hex-less legacy NPC: directive uses affinityDescriptor fallback, no Personality band line.
            const out = buildBehaviorDirective(baseNPC({ affinity: aff, personalityHex: undefined }));
            expect(out).toContain(`[Aff: ${label}]`);
        });
    }
});

describe('buildBehaviorDirective — assembly of parts (legacy hex-less NPC)', () => {
    it('minimal NPC (no personality/voice/example, no hex) -> just "PLAY AS: [Aff: ...]"', () => {
        const out = buildBehaviorDirective(baseNPC({ personality: '', disposition: '', voice: '', exampleOutput: '', personalityHex: undefined }));
        expect(out).toBe('PLAY AS: [Aff: Neutral]');
    });
    it('personality field is appended after the affinity bracket for a hex-less NPC, joined by " | "', () => {
        const out = buildBehaviorDirective(baseNPC({ personality: 'stoic and watchful', personalityHex: undefined }));
        expect(out).toBe('PLAY AS: [Aff: Neutral] | stoic and watchful');
    });
    it('falls back to disposition when personality is empty (hex-less NPC)', () => {
        const out = buildBehaviorDirective(baseNPC({ personality: '', disposition: 'jovial drunk', personalityHex: undefined }));
        expect(out).toBe('PLAY AS: [Aff: Neutral] | jovial drunk');
    });
    it('voice is prefixed with "Voice: "', () => {
        const out = buildBehaviorDirective(baseNPC({ voice: 'deep rumble', personalityHex: undefined }));
        expect(out).toContain('| Voice: deep rumble');
    });
    it('exampleOutput is prefixed with "Example: "', () => {
        const out = buildBehaviorDirective(baseNPC({ exampleOutput: '"Halt!"', personalityHex: undefined }));
        expect(out).toContain('| Example: "Halt!"');
    });
    it('all four parts present appear in order: aff | personality | Voice | Example (hex-less)', () => {
        const out = buildBehaviorDirective(baseNPC({
            personality: 'brave', voice: 'gruff', exampleOutput: '"Step back"', personalityHex: undefined,
        }));
        expect(out).toBe('PLAY AS: [Aff: Neutral] | brave | Voice: gruff | Example: "Step back"');
    });
    it('empty voice and empty exampleOutput are omitted (no "Voice:" / "Example:" fragments)', () => {
        const out = buildBehaviorDirective(baseNPC({ voice: '', exampleOutput: '', personalityHex: undefined }));
        expect(out).not.toContain('Voice:');
        expect(out).not.toContain('Example:');
    });
});

describe('buildBehaviorDirective — Phase-4 surfacing (migrated NPC with hex/wants)', () => {
    const HEX = { drive: 0, diligence: 1, boldness: 1, warmth: 2, empathy: 1, composure: 1 } as NPCEntry['personalityHex'];
    it('uses relationBand when pcRelation is defined (not the legacy affinity descriptor)', () => {
        const out = buildBehaviorDirective(baseNPC({ pcRelation: 2, personalityHex: undefined }));
        expect(out).toContain('[Aff: Close]'); // +2 → Close
    });
    it('hex NPC surfaces Personality band-words instead of free-text personality', () => {
        const out = buildBehaviorDirective(baseNPC({ personalityHex: HEX, personality: 'brave' }));
        // Migrated NPC: hex band-words replace free-text personality.
        // HEX = {drive:0,diligence:1,boldness:1,warmth:2,empathy:1,composure:1}
        // hexBand offsets by +3, so: drive[3]=Steady, diligence[4]=Diligent, boldness[4]=Bold,
        // warmth[5]=Affable, empathy[4]=Kind, composure[4]=Composed.
        expect(out).toContain('Personality: Steady, Diligent, Bold, Affable, Kind, Composed');
        expect(out).not.toContain('| brave');
    });
    it('wants (Phase-2) supersede legacy drives display', () => {
        const out = buildBehaviorDirective(baseNPC({
            personalityHex: undefined,
            wants: { short: ['eat'], medium: ['win a contest'], long: 'become the strongest' },
            drives: { coreWant: 'core', sessionWant: 'session', sceneWant: 'scene' },
        }));
        expect(out).toContain('GOAL: become the strongest');
        expect(out).toContain('PURSUING: win a contest');
        expect(out).toContain('NOW: eat');
        expect(out).not.toContain('WANTS:');
    });
    it('hardBoundaries / softBoundaries surface as WON\'T / RESENTS', () => {
        const out = buildBehaviorDirective(baseNPC({
            personalityHex: undefined,
            hardBoundaries: ['will not betray her sister'],
            softBoundaries: ['dislikes being excluded'],
        }));
        expect(out).toContain("WON'T: will not betray her sister");
        expect(out).toContain('RESENTS: dislikes being excluded');
    });
});

describe('buildBehaviorDirective — reaction menu line (Phase 2 §9.1)', () => {
    it('appends a REACTIONS line with the enforcement clause for a hex-bearing NPC', () => {
        const out = buildBehaviorDirective(baseNPC({
            personalityHex: { drive: 1, diligence: 2, boldness: 1, warmth: 2, empathy: 2, composure: 1 },
            traits: ['loyal', 'protective'],
        }), { rng: () => 0.5 });
        expect(out).toContain('REACTIONS (choose ONE and play it');
        expect(out).toContain('do NOT invent a softer reaction');
    });
    it('omits the REACTIONS line for a legacy hex-less NPC', () => {
        const out = buildBehaviorDirective(baseNPC({ personalityHex: undefined }));
        expect(out).not.toContain('REACTIONS');
    });
});

describe('buildDriftAlert — no-snapshot / suppressed / no-shift cases', () => {
    it('returns null when previousSnapshot is undefined', () => {
        expect(buildDriftAlert(baseNPC({ previousSnapshot: undefined }))).toBeNull();
    });
    it('returns null when shiftTurnCount >= 3 (suppression gate)', () => {
        const npc = baseNPC({
            shiftTurnCount: 3,
            previousSnapshot: { personality: '', voice: '', affinity: 50 },
            affinity: 80, // big shift, but suppression gate fires first
        });
        expect(buildDriftAlert(npc)).toBeNull();
    });
    it('shiftTurnCount 2 (below 3) still allows an alert', () => {
        const npc = baseNPC({
            shiftTurnCount: 2,
            previousSnapshot: { personality: '', voice: '', affinity: 50 },
            affinity: 80,
        });
        expect(buildDriftAlert(npc)).not.toBeNull();
    });
    it('returns null when no fields actually changed', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'gruff', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBeNull();
    });
});

describe('buildDriftAlert — shift detection', () => {
    it('affinity change >= 10 emits "affinity <prev>→<curr>"', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'gruff', affinity: 62,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: affinity 50→62');
    });
    it('affinity change < 10 does NOT emit an affinity shift', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'gruff', affinity: 59,
        });
        // 59-50 = 9 < 10 -> no affinity shift ; no other shifts -> null
        expect(buildDriftAlert(npc)).toBeNull();
    });
    it('affinity change of exactly 10 emits a shift (>= 10 boundary)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'gruff', affinity: 60,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: affinity 50→60');
    });
    it('affinity decrease of 10 also emits (absolute value)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'gruff', affinity: 40,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: affinity 50→40');
    });
    it('personality change emits "personality changed" (both prev and current non-empty)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'cautious', voice: 'gruff', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: personality changed');
    });
    it('personality fallback to disposition is used for the current-side comparison', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: '', disposition: 'cautious', voice: 'gruff', affinity: 50,
        });
        // currentPersonality = npc.personality || npc.disposition = 'cautious' != prev 'brave'
        expect(buildDriftAlert(npc)).toBe('SHIFT: personality changed');
    });
    it('empty previous personality does NOT emit personality change (prev.personality !== "" gate)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: '', voice: 'gruff', affinity: 50 },
            personality: 'cautious', voice: 'gruff', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBeNull();
    });
    it('empty current personality does NOT emit (currentPersonality !== "" gate)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: '', disposition: '', voice: 'gruff', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBeNull();
    });
    it('voice change emits "voice changed" (both prev and current non-empty)', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'brave', voice: 'soft', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: voice changed');
    });
    it('empty previous voice does NOT emit voice change', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: '', affinity: 50 },
            personality: 'brave', voice: 'soft', affinity: 50,
        });
        expect(buildDriftAlert(npc)).toBeNull();
    });
    it('multiple shifts are joined with ", " in order: affinity, personality, voice', () => {
        const npc = baseNPC({
            previousSnapshot: { personality: 'brave', voice: 'gruff', affinity: 50 },
            personality: 'cautious', voice: 'soft', affinity: 70,
        });
        expect(buildDriftAlert(npc)).toBe('SHIFT: affinity 50→70, personality changed, voice changed');
    });
});

describe('buildKnowledgeBoundary — Layer 1 (scene-witness filter)', () => {
    const archiveEntry = (over: Partial<ArchiveIndexEntry>): ArchiveIndexEntry => ({
        sceneId: '1',
        keywords: [],
        npcsMentioned: [],
        witnesses: [],
        userSnippet: '',
        ...over,
    } as ArchiveIndexEntry);

    it('empty archiveIndex -> no KNOWLEDGE LIMITS part, empty string result', () => {
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [])).toBe('');
    });
    it('NPC who witnessed all important scenes -> no KNOWLEDGE LIMITS part', () => {
        const entries = [
            archiveEntry({ sceneId: '1', witnesses: ['Aldric'], importance: 7, userSnippet: 'scene 1 snippet' }),
            archiveEntry({ sceneId: '2', witnesses: ['Aldric'], importance: 8, userSnippet: 'scene 2 snippet' }),
        ];
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries)).toBe('');
    });
    it('NPC not present for an importance>=6 scene -> KNOWLEDGE LIMITS lists that scene', () => {
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['Bob'], importance: 7, userSnippet: 'the heist' }),
        ];
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries);
        expect(out).toContain('KNOWLEDGE LIMITS:');
        expect(out).toContain('Scene 5: the heist');
        expect(out).toContain('Do not reference these events');
    });
    it('importance < 6 scenes are NOT listed (threshold filter)', () => {
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['Bob'], importance: 5, userSnippet: 'minor' }),
        ];
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries)).toBe('');
    });
    it('importance undefined scenes are excluded (filter requires truthy importance >= 6)', () => {
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['Bob'], importance: undefined, userSnippet: 'x' }),
        ];
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries)).toBe('');
    });
    it('witness match is case-insensitive on NPC name', () => {
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['ALDRIC'], importance: 7, userSnippet: 's' }),
        ];
        // Aldric witnessed (case-insensitive) -> not unknown -> no KNOWLEDGE LIMITS
        expect(buildKnowledgeBoundary(baseNPC({ name: 'aldric' }), entries)).toBe('');
    });
    it('at most 5 unknown scenes are listed (slice(0, 5))', () => {
        const entries = Array.from({ length: 8 }, (_, i) =>
            archiveEntry({ sceneId: String(i + 1), witnesses: ['Bob'], importance: 7, userSnippet: `s${i + 1}` })
        );
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries);
        // only scenes 1-5 should appear
        expect(out).toContain('Scene 1: s1');
        expect(out).toContain('Scene 5: s5');
        expect(out).not.toContain('Scene 6: s6');
        expect(out).not.toContain('Scene 7: s7');
    });
    it('unknown scenes are joined with "; " inside the bracket', () => {
        const entries = [
            archiveEntry({ sceneId: '1', witnesses: ['Bob'], importance: 7, userSnippet: 'alpha' }),
            archiveEntry({ sceneId: '2', witnesses: ['Bob'], importance: 7, userSnippet: 'beta' }),
        ];
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), entries);
        expect(out).toContain('Scene 1: alpha; Scene 2: beta');
    });
    it('a short witness name ("Rin") counts as the NPC being present', () => {
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['Rin'], importance: 7, userSnippet: 'the deal' }),
        ];
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Rin Holmes' }), entries)).toBe('');
    });
    it('with the ledger resolver, an ambiguous short name counts for nobody', () => {
        const rin = baseNPC({ id: 'npc_rin', name: 'Rin Holmes' });
        const grey = baseNPC({ id: 'npc_grey', name: 'Grey Holmes' });
        const entries = [
            archiveEntry({ sceneId: '5', witnesses: ['Holmes'], importance: 7, userSnippet: 'the deal' }),
        ];
        const out = buildKnowledgeBoundary(rin, entries, undefined, createWitnessResolver([rin, grey]));
        expect(out).toContain('Scene 5: the deal');
    });
});

describe('buildKnowledgeBoundary — Layer 2 (divergence knownBy tokens)', () => {
    const fact = (over: Partial<DivergenceEntry>): DivergenceEntry => ({
        id: 'f1',
        chapterId: 'CH01',
        category: 'misc',
        text: 'a secret fact',
        sceneRef: '001',
        npcIds: [],
        pinned: false,
        source: 'auto',
        ...over,
    } as DivergenceEntry);

    it('no divergenceFacts -> no UNKNOWN FACTS part', () => {
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], [])).toBe('');
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], undefined)).toBe('');
    });
    it('public fact (knownBy undefined) is NOT listed as unknown', () => {
        const f = fact({ text: 'public knowledge', knownBy: undefined });
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], [f])).toBe('');
    });
    it('secret fact (knownBy []) is listed as unknown to every NPC', () => {
        const f = fact({ text: 'the vault code', knownBy: [] });
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], [f]);
        expect(out).toContain('UNKNOWN FACTS:');
        expect(out).toContain('[the vault code]');
    });
    it('fact knownBy "npc:npc1" -> this NPC knows it -> NOT listed', () => {
        const f = fact({ text: 'shared with npc1', knownBy: ['npc:npc1'] });
        expect(buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric' }), [], [f])).toBe('');
    });
    it('fact knownBy "npc:other" -> this NPC does NOT know it -> listed', () => {
        const f = fact({ text: 'other npc secret', knownBy: ['npc:other'] });
        const out = buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric' }), [], [f]);
        expect(out).toContain('[other npc secret]');
    });
    it('fact knownBy "faction:crimson hand" matches an NPC in that faction (normalized)', () => {
        const f = fact({ text: 'faction secret', knownBy: ['faction:crimson hand'] });
        // NPC's faction "Crimson Hand" normalizes to "crimson hand" -> matches -> knows -> not listed
        expect(buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric', faction: 'Crimson Hand' }), [], [f])).toBe('');
    });
    it('fact knownBy "faction:other" does NOT match an NPC in a different faction -> listed', () => {
        const f = fact({ text: 'rival faction secret', knownBy: ['faction:other'] });
        const out = buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric', faction: 'Crimson Hand' }), [], [f]);
        expect(out).toContain('[rival faction secret]');
    });
    it('"player" token alone -> NPC does not know -> listed', () => {
        const f = fact({ text: 'player-only secret', knownBy: ['player'] });
        const out = buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric' }), [], [f]);
        expect(out).toContain('[player-only secret]');
    });
    it('bare NPC id (no "npc:" prefix) is treated as "npc:<id>" (implicit parsing)', () => {
        const f = fact({ text: 'bare id fact', knownBy: ['npc1'] });
        // parseKnownByToken treats "npc1" as { kind: 'npc', id: 'npc1' } -> npc1 knows -> not listed
        expect(buildKnowledgeBoundary(baseNPC({ id: 'npc1', name: 'Aldric' }), [], [f])).toBe('');
    });
    it('enabled=false facts are skipped entirely', () => {
        const f = fact({ text: 'disabled secret', knownBy: [], enabled: false });
        expect(buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], [f])).toBe('');
    });
    it('at most 5 unknown facts are listed (slice(0, 5))', () => {
        const facts = Array.from({ length: 8 }, (_, i) =>
            fact({ id: `f${i}`, text: `secret ${i + 1}`, knownBy: [] })
        );
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], facts);
        expect(out).toContain('[secret 1]');
        expect(out).toContain('[secret 5]');
        expect(out).not.toContain('[secret 6]');
    });
    it('unknown facts are wrapped in brackets and space-joined', () => {
        const facts = [
            fact({ id: 'f1', text: 'alpha', knownBy: [] }),
            fact({ id: 'f2', text: 'beta', knownBy: [] }),
        ];
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), [], facts);
        expect(out).toContain('[alpha] [beta]');
    });
});

describe('buildKnowledgeBoundary — both layers combined', () => {
    it('when both layers fire, parts are joined with "\\n  "', () => {
        const archive: ArchiveIndexEntry[] = [{
            sceneId: '1', keywords: [], npcsMentioned: [], witnesses: ['Bob'],
            userSnippet: 'the heist', importance: 7,
        } as unknown as ArchiveIndexEntry];
        const facts: DivergenceEntry[] = [{
            id: 'f1', chapterId: 'CH01', category: 'misc', text: 'vault code',
            sceneRef: '001', npcIds: [], pinned: false, source: 'auto', knownBy: [],
        } as DivergenceEntry];
        const out = buildKnowledgeBoundary(baseNPC({ name: 'Aldric' }), archive, facts);
        // Both parts present, separated by newline + two spaces
        expect(out).toContain('KNOWLEDGE LIMITS:');
        expect(out).toContain('UNKNOWN FACTS:');
        expect(out.indexOf('KNOWLEDGE LIMITS:')).toBeLessThan(out.indexOf('UNKNOWN FACTS:'));
        // The separator between the two parts is '\n  '
        expect(out).toContain('\n  UNKNOWN FACTS:');
    });
});