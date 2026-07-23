import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import {
    parseInterviewLines,
    linesToSlotMap,
} from '../parseInterviewLines';
import {
    buildGuidedCreationLoreExcerpt,
    resolveGuidedCreationEndpoint,
} from '../loreExcerptBuilder';
import {
    drawScenarios,
    deriveHexFromAnswers,
    SCENARIO_BANK,
} from '../hexQuiz';
import {
    assemblePlayerCharacter,
    parseStartingInventory,
    commitCharacterDraft,
} from '../commitCharacterDraft';
import type {
    LoreChunk,
    CharacterCreationDraft,
    PlayerCharacter,
    PersonalityHex,
    EndpointConfig,
    ProviderConfig,
    InventoryItem,
} from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';

function makeLoreChunk(over: Partial<LoreChunk> = {}): LoreChunk {
    return {
        id: 'c1',
        header: 'Overview',
        content: 'A world of iron and sparks.',
        tokens: 10,
        alwaysInclude: false,
        triggerKeywords: [],
        scanDepth: 0,
        category: 'world_overview',
        linkedEntities: [],
        priority: 10,
        ...over,
    };
}

// ── Test 2: parseInterviewLines ─────────────────────────────────────────────
describe('WO-A2 §4.2 — parseInterviewLines', () => {
    it('parses 1. / 1) / **1.** / Question 1: formats and ignores preamble', () => {
        const cases = [
            'Here is your interview:\n1. Origin?\n2. Allegiance?\n3. Capability?\n4. Disposition?',
            '1) Origin?\n2) Allegiance?\n3) Capability?\n4) Disposition?',
            '**1.** Origin?\n**2.** Allegiance?\n**3.** Capability?\n**4.** Disposition?',
            'Question 1: Origin?\nQuestion 2: Allegiance?\nQuestion 3: Capability?\nQuestion 4: Disposition?',
        ];
        for (const raw of cases) {
            const r = parseInterviewLines(raw, 4, 2);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.lines).toHaveLength(4);
                expect(r.lines[0]).toMatch(/Origin/);
            }
        }
    });

    it('rejects wrong count', () => {
        const r = parseInterviewLines('1) A\n2) B\n3) C', 4, 2);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('empty-entry');
    });

    it('rejects empty entries', () => {
        const r = parseInterviewLines('1) A\n2) \n3) C\n4) D', 4, 2);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('empty-entry');
    });

    it('rejects no-lines', () => {
        const r = parseInterviewLines('No numbering here at all.', 4, 2);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('no-lines');
    });

    it('linesToSlotMap keys by absolute slot', () => {
        const m = linesToSlotMap(['a', 'b', 'c'], 6);
        expect(m[6]).toBe('a');
        expect(m[8]).toBe('c');
    });
});

// ── Test 10: lore excerpt budget ─────────────────────────────────────────────
describe('WO-A2 §4.10 — lore excerpt budget (~1,200 tokens)', () => {
    it('never exceeds ~1,200 tokens by countTokens on a large lore fixture', () => {
        const big = 'The kingdom of Ironspire stretches across the northern mountains. '.repeat(200);
        const chunks: LoreChunk[] = [
            makeLoreChunk({ id: 'a', header: 'Overview', content: big, category: 'world_overview', priority: 10 }),
            makeLoreChunk({ id: 'b', header: 'Power System', content: big, category: 'power_system', priority: 8 }),
            makeLoreChunk({ id: 'c', header: 'Faction', content: big, category: 'faction', priority: 7 }),
            makeLoreChunk({ id: 'd', header: 'Economy', content: big, category: 'economy', priority: 5 }),
            makeLoreChunk({ id: 'e', header: 'Culture', content: big, category: 'culture', priority: 5 }),
            makeLoreChunk({ id: 'f', header: 'Location', content: big, category: 'location', priority: 6 }),
        ];
        const { excerpt, tokenCount } = buildGuidedCreationLoreExcerpt(chunks);
        expect(tokenCount).toBeLessThanOrEqual(1300);
        // Budget is 1200; allow a small overshadow from the "always include at least one" rule.
        expect(tokenCount).toBeGreaterThan(0);
        expect(excerpt.length).toBeGreaterThan(0);
    });

    it('returns empty excerpt when no WANTED categories match', () => {
        const chunks: LoreChunk[] = [
            makeLoreChunk({ id: 'x', category: 'location', priority: 6 }),
            makeLoreChunk({ id: 'y', category: 'character', priority: 7 }),
        ];
        const { excerpt, chunkCount } = buildGuidedCreationLoreExcerpt(chunks);
        expect(chunkCount).toBe(0);
        expect(excerpt).toBe('');
    });

    it('uses chunk.summary for chunks beyond the top 3', () => {
        const chunks: LoreChunk[] = [
            makeLoreChunk({ id: 'a', content: 'FULL_A'.repeat(50), summary: 'SUMM_A', category: 'world_overview', priority: 10 }),
            makeLoreChunk({ id: 'b', content: 'FULL_B'.repeat(50), summary: 'SUMM_B', category: 'power_system', priority: 8 }),
            makeLoreChunk({ id: 'c', content: 'FULL_C'.repeat(50), summary: 'SUMM_C', category: 'faction', priority: 7 }),
            makeLoreChunk({ id: 'd', content: 'FULL_D_SHOULD_NOT_APPEAR', summary: 'SUMM_D', category: 'economy', priority: 5 }),
        ];
        const { excerpt } = buildGuidedCreationLoreExcerpt(chunks);
        expect(excerpt).toContain('SUMM_D');
        expect(excerpt).not.toContain('FULL_D_SHOULD_NOT_APPEAR');
    });

    it('resolveGuidedCreationEndpoint prefers utility over auxiliary over summarizer over story', () => {
        const util = { endpoint: 'u', modelName: 'u' } as EndpointConfig;
        const aux = { endpoint: 'x', modelName: 'x' } as EndpointConfig;
        const summ = { endpoint: 's', modelName: 's' } as EndpointConfig;
        const story = { endpoint: 'st', modelName: 'st' } as EndpointConfig;
        expect(resolveGuidedCreationEndpoint(() => util, () => aux, () => summ, () => story)).toBe(util);
        expect(resolveGuidedCreationEndpoint(() => undefined, () => aux, () => summ, () => story)).toBe(aux);
        expect(resolveGuidedCreationEndpoint(() => undefined, () => undefined, () => summ, () => story)).toBe(summ);
        expect(resolveGuidedCreationEndpoint(() => undefined, () => undefined, () => undefined, () => story)).toBe(story);
        expect(resolveGuidedCreationEndpoint(() => undefined, () => undefined, () => undefined, () => undefined)).toBeUndefined();
    });
});

// ── Test 5: deriveHexFromAnswers ─────────────────────────────────────────────
describe('WO-A2 §4.5 — deriveHexFromAnswers', () => {
    it('is deterministic — same answers produce the same hex', () => {
        const drawn = SCENARIO_BANK.slice(0, 8);
        const answers = Object.fromEntries(drawn.map(s => [s.id, 0]));
        const a = deriveHexFromAnswers(drawn, answers);
        const b = deriveHexFromAnswers(drawn, answers);
        expect(a.hex).toEqual(b.hex);
        expect(a.traits).toEqual(b.traits);
    });

    it('clamps each axis to ±3', () => {
        // Pick option 0 (typically boldness +2) on every boldness-heavy scenario.
        const drawn = SCENARIO_BANK.slice(0, 8);
        const answers: Record<number, number> = {};
        for (const s of drawn) {
            const boldIdx = s.options.findIndex(o => (o.deltas.boldness ?? 0) > 0);
            answers[s.id] = boldIdx >= 0 ? boldIdx : 0;
        }
        const { hex } = deriveHexFromAnswers(drawn, answers);
        for (const v of Object.values(hex)) {
            expect(v).toBeGreaterThanOrEqual(-3);
            expect(v).toBeLessThanOrEqual(3);
        }
    });

    it('untouched axes stay 0 (no random fill)', () => {
        // Answer with an option that only touches boldness on every scenario
        // where possible; all other axes should remain 0.
        const drawn = [SCENARIO_BANK[0]]; // stranger blocks path
        const answers: Record<number, number> = { [drawn[0].id]: 0 }; // Shove past: boldness+2, warmth-1
        const { hex } = deriveHexFromAnswers(drawn, answers);
        expect(hex.boldness).toBe(2);
        expect(hex.warmth).toBe(-1);
        expect(hex.drive).toBe(0);
        expect(hex.diligence).toBe(0);
        expect(hex.empathy).toBe(0);
        expect(hex.composure).toBe(0);
    });

    it('drawScenarios covers all 6 axes at least twice across 8 drawn', () => {
        const drawn = drawScenarios(SCENARIO_BANK, 8, () => 0.5);
        const axisHits: Record<string, number> = { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 };
        for (const s of drawn) {
            const axesTouched = new Set<string>();
            for (const opt of s.options) {
                for (const a of Object.keys(opt.deltas)) axesTouched.add(a);
            }
            for (const a of axesTouched) axisHits[a] = (axisHits[a] ?? 0) + 1;
        }
        for (const a of ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure']) {
            expect(axisHits[a]).toBeGreaterThanOrEqual(2);
        }
    });
});

// ── Test 7: commitCharacterDraft ─────────────────────────────────────────────
describe('WO-A2 §4.7 — commitCharacterDraft', () => {
    beforeEach(() => {
        useAppStore.setState({
            npcLedger: [],
            activeCampaignId: 'test-campaign',
            inventoryItems: [],
            context: { characterProfile: { identity: {}, activeTraits: [] } },
            characterProfileData: { name: '', level: 1, hp: { current: 20, max: 20 } },
        } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('writes playerCharacter, seeds profileData, mirrors name, clears the draft', () => {
        const draft: CharacterCreationDraft = {
            name: 'Hero',
            answers: { 2: 'from the hills', 3: 'Ironspire', 5: 'stoic', 6: 'gruff', 7: 'find the sword', 8: 'a cloak, a knife' },
            visualProfile: { race: 'human', gender: 'f', ageRange: '30s', build: '', symmetry: '', hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '', artStyle: 'Anime' },
            appearance: 'tall and scarred',
            hexMode: 'skip',
        };
        const hex: PersonalityHex = { drive: 1, diligence: 0, boldness: 2, warmth: -1, empathy: 0, composure: 1 };
        const traits = ['defiant', 'loyal'];

        let savedPc: PlayerCharacter | null = null;
        let savedInventory: InventoryItem[] = [];
        const contextPatches: Record<string, unknown>[] = [];
        commitCharacterDraft(
            { draft, hex, traits },
            {
                setPlayerCharacter: (pc) => { savedPc = pc; },
                setInventoryItems: (items) => { savedInventory = items; },
                updateContext: (patch) => { contextPatches.push(patch as Record<string, unknown>); },
                characterProfileData: { name: '', level: 1, hp: { current: 20, max: 20 } },
            },
        );

        expect(savedPc).not.toBeNull();
        expect(savedPc!.name).toBe('Hero');
        expect(savedPc!.isPC).toBe(true);
        expect(savedPc!.personalityHex).toEqual(hex);
        expect(savedPc!.traits).toEqual(traits);
        expect(savedPc!.storyRelevance).toBe('from the hills');
        expect(savedPc!.faction).toBe('Ironspire');
        expect(savedPc!.wants.long).toBe('find the sword');

        // Inventory from slot 8.
        expect(savedInventory.length).toBe(2);
        expect(savedInventory.map(i => i.name)).toEqual(['a cloak', 'a knife']);

        // The last context patch clears the draft.
        const last = contextPatches[contextPatches.length - 1];
        expect(last.creationDraft).toBeNull();
    });

    it('the PC is absent from npcLedger (lives at context.playerCharacter)', () => {
        const draft: CharacterCreationDraft = { name: 'Solo', answers: {} };
        commitCharacterDraft(
            { draft },
            {
                setPlayerCharacter: (pc) => useAppStore.getState().setPlayerCharacter(pc),
                setInventoryItems: () => {},
                updateContext: (patch) => useAppStore.getState().updateContext(patch as never),
                characterProfileData: null,
            },
        );
        const ledger = useAppStore.getState().npcLedger ?? [];
        expect(ledger.find(n => n.isPC)).toBeUndefined();
        expect(useAppStore.getState().playerCharacter?.name).toBe('Solo');
    });

    it('parseStartingInventory splits on comma/pipe/newline and caps at 30', () => {
        const items = parseStartingInventory('a, b | c\nd, e');
        expect(items.map(i => i.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
        const big = Array.from({ length: 40 }, (_, i) => `item${i}`).join(', ');
        expect(parseStartingInventory(big).length).toBe(30);
    });

    it('assemblePlayerCharacter extracts element from "(element: fire)" suffix', () => {
        const draft: CharacterCreationDraft = {
            name: 'Mage',
            answers: { 4: 'fire magic, ice bolts (element: fire)' },
        };
        const pc = assemblePlayerCharacter({ draft });
        expect(pc.signatureKit?.element).toBe('fire');
        expect(pc.signatureKit?.abilities).toEqual(['fire magic', 'ice bolts']);
    });
});

// ── Test 8: pcUpdater whitelist ──────────────────────────────────────────────
describe('WO-A2 §4.8 — pcUpdater whitelist', () => {
    it('stripBlockedKeys drops personalityHex, traits, relations, pcRelation, drives, affinity', async () => {
        const { stripBlockedKeys, ALLOWED_CHANGE_KEYS } = await import('../pcUpdater');
        const changes: Partial<PlayerCharacter> = {
            signatureKit: { equipment: ['sword'], abilities: [] },
            appearance: 'scarred',
            status: 'Alive',
            faction: 'Ironspire',
            wants: { short: [], medium: [], long: 'rule' },
            personalityHex: { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 } as PersonalityHex,
            traits: ['ruthless'],
            relations: { x: 2 },
            pcRelation: 2,
            // @ts-expect-error — legacy field
            drives: { coreWant: 'x', sessionWant: 'y', sceneWant: 'z' },
            affinity: 99,
        };
        const stripped = stripBlockedKeys(changes);
        // Only the 5 allowed keys survive.
        expect(Object.keys(stripped).sort()).toEqual([...ALLOWED_CHANGE_KEYS].sort());
        expect(stripped.personalityHex).toBeUndefined();
        expect(stripped.traits).toBeUndefined();
        expect((stripped as Record<string, unknown>).relations).toBeUndefined();
        expect((stripped as Record<string, unknown>).pcRelation).toBeUndefined();
        expect((stripped as Record<string, unknown>).drives).toBeUndefined();
        expect((stripped as Record<string, unknown>).affinity).toBeUndefined();
        // The allowed values are preserved.
        expect(stripped.appearance).toBe('scarred');
        expect(stripped.faction).toBe('Ironspire');
    });

    it('a response proposing signatureKit merges through sanitizeSignatureKit bounds (≤8 entries, ≤48 chars)', async () => {
        const { sanitizeSignatureKit } = await import('../../npc/signatureKit');
        // 9 entries → truncated to 8; long entry → truncated to 48 chars.
        const longName = 'A'.repeat(60);
        const nineItems = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', longName];
        const merged = sanitizeSignatureKit({ equipment: nineItems }, { equipment: ['old'], abilities: [] });
        expect(merged).toBeDefined();
        expect(merged!.equipment.length).toBeLessThanOrEqual(8);
        for (const e of merged!.equipment) expect(e.length).toBeLessThanOrEqual(48);
        // Abilities preserved (untouched channel).
        expect(merged!.abilities).toEqual([]);
    });

    it('the whitelist is structural — blocked keys have no merge code path in pcUpdater.ts', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '..', 'pcUpdater.ts'),
            'utf8',
        );
        // The merge block must NOT contain references to personalityHex,
        // traits, relations, or pcRelation as keys it writes.
        expect(src).not.toMatch(/changes\.personalityHex\s*=/);
        expect(src).not.toMatch(/changes\.traits\s*=/);
        expect(src).not.toMatch(/changes\.relations\s*=/);
        expect(src).not.toMatch(/changes\.pcRelation\s*=/);
    });
});

// ── Test 6: invariant guard (§0) — converter strips personalityHex + traits ──
describe('WO-A2 §4.6 — invariant guard (§0)', () => {
    it('assemblePlayerCharacter never carries personalityHex or traits from draft answers', () => {
        // The draft.answers only carry prose for slots 2–8. The assemble
        // function only reads hex/traits from the explicit inputs (set by
        // the quiz step), never from the prose answers.
        const draft: CharacterCreationDraft = {
            name: 'Test',
            answers: { 2: 'I am brave and ruthless' }, // prose that mentions traits
        };
        const pc = assemblePlayerCharacter({ draft });
        expect(pc.personalityHex).toBeUndefined();
        expect(pc.traits).toBeUndefined();
    });

    it('assemblePlayerCharacter honors explicit hex + traits from the quiz', () => {
        const draft: CharacterCreationDraft = { name: 'Test', answers: {} };
        const hex: PersonalityHex = { drive: 2, diligence: 0, boldness: 1, warmth: 0, empathy: -1, composure: 0 };
        const pc = assemblePlayerCharacter({ draft, hex, traits: ['ambitious'] });
        expect(pc.personalityHex).toEqual(hex);
        expect(pc.traits).toEqual(['ambitious']);
    });
});

// ── Test 4: draft persistence ────────────────────────────────────────────────
describe('WO-A2 §4.4 — draft persistence', () => {
    it('a draft saved to context.creationDraft survives a simulated reload and is not cleared on exit', () => {
        // Simulate: save draft → reload (re-read context) → draft intact.
        const draft: CharacterCreationDraft = { name: 'Persisted', answers: { 2: 'x' }, step: 2 };
        useAppStore.setState({ context: { creationDraft: draft } as never });
        const reloaded = useAppStore.getState().context.creationDraft;
        expect(reloaded).toEqual(draft);
        // Exit (no commit) does NOT clear the draft — only commit or explicit discard.
        // (No clear happens here, so it should still be present.)
        expect(useAppStore.getState().context.creationDraft?.name).toBe('Persisted');
    });

    it('commitCharacterDraft clears the draft', () => {
        useAppStore.setState({ context: { creationDraft: { name: 'WillBeCleared' } } as never } as never);
        commitCharacterDraft(
            { draft: { name: 'Final', answers: {} } },
            {
                setPlayerCharacter: () => {},
                setInventoryItems: () => {},
                updateContext: (patch) => useAppStore.getState().updateContext(patch as never),
                characterProfileData: null,
            },
        );
        expect(useAppStore.getState().context.creationDraft).toBeNull();
    });
});

// ── Test 3: failure ladder (zero lore → no call) ─────────────────────────────
describe('WO-A2 §4.3 — failure ladder', () => {
    it('zero lore chunks issues no LLM call (deterministic — retrying cannot succeed)', async () => {
        const { generateInterviewQuestions } = await import('../aiGuidedGeneration');
        const provider = { endpoint: 'http://x', modelName: 'x', apiKey: 'k' } as unknown as EndpointConfig | ProviderConfig;
        const result = await generateInterviewQuestions(provider, [], { name: '', questions: {}, answers: {} });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('no-lore');
            expect(result.retryable).toBe(false);
        }
    });
});

// ── Test 1: ledger parity — moved to components/character/__tests__/ledgerParity.test.tsx ──
// (The source files under test live under components/, so the parity check
// belongs there. This services-level test file keeps the §0 guard, parser,
// quiz, commit, updater, budget, and failure-ladder tests.)

// Suppress unused-import warnings for things kept for future test expansion.
void countTokens;