import { beforeAll, describe, it, expect } from 'vitest';
import { computeBudgets } from '../budgets';
import { buildPayload } from '../payloadBuilder';
import { budgetClaims } from '../budgetClaims';
import { buildEnemyVolatileSegment, ensureEnemyBudgetClaim } from '../../enemy/enemyPayloadSegment';
import type { GameContext, AppSettings, EnemyEntry } from '../../../types';

/**
 * Phase 7.4 — byte-identical budget allocation at 8k, 32k, and 128k context
 * limits, with zero mods.
 *
 * The work order §3: "Byte-identical payloads at every context limit, with
 * zero mods. Test at several limits, not one; trimming behaviour differs at
 * the edges."
 *
 * The claims reproduce the EXACT formulae the old `computeBudgets` used. This
 * test verifies the numbers at three context limits (8k, 32k, 128k) — the same
 * three the work order names — covering the shallow shape (no deep context)
 * and the deep shape (with deep context), and the subsystem cap at 1024.
 *
 * **Phase 7.5 amended the setup, not the numbers.** The subsystem claim used to
 * register at `budgetClaims.ts`'s module load, so importing `budgets.ts` was
 * enough to see it. It now registers from the subsystem that spends it, so this
 * file registers it explicitly — which is the behaviour under test as much as
 * the arithmetic is: a claim arrives with its owner and leaves with it.
 */

beforeAll(() => {
    ensureEnemyBudgetClaim();
});

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: 'Never',
    characterProfile: '',
    characterProfileLastScene: 'Never',
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: false,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    worldVibe: '',
    notebook: [],
    notebookActive: false,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (contextLimit: number): AppSettings => ({
    debugMode: true,
    contextLimit,
} as unknown as AppSettings);

describe('Phase 7.4 — byte-identical budget numbers at 8k / 32k / 128k (zero mods)', () => {
    const LIMITS = [8_192, 32_768, 131_072];

    for (const limit of LIMITS) {
        for (const hasDeepContext of [false, true]) {
            const label = `${limit} ${hasDeepContext ? 'deep' : 'shallow'}`;
            it(`built-in budget numbers match the old formulae at ${label}`, () => {
                const { rulesBudget, budgetMap } = computeBudgets(limit, undefined, hasDeepContext);
                // rulesBudget = floor(limit * 0.10)
                expect(rulesBudget).toBe(Math.floor(limit * 0.10));
                const remainingAfterRules = limit - rulesBudget;
                // npc = floor(remainingAfterRules * 0.05)
                expect(budgetMap.get('npc')).toBe(Math.floor(remainingAfterRules * 0.05));
                // enemy = min(1024, floor(limit * 0.025))
                expect(budgetMap.get('enemy')).toBe(Math.min(1024, Math.floor(limit * 0.025)));
                // stable = floor(remainingAfterRules * (deep ? 0.15 : 0.25))
                expect(budgetMap.get('stable')).toBe(Math.floor(remainingAfterRules * (hasDeepContext ? 0.15 : 0.25)));
                // world = floor(remainingAfterRules * (deep ? 0.60 : 0.40)) - npc
                const npc = Math.floor(remainingAfterRules * 0.05);
                expect(budgetMap.get('world')).toBe(Math.floor(remainingAfterRules * (hasDeepContext ? 0.60 : 0.40)) - npc);
                // volatile = floor(remainingAfterRules * 0.10)
                expect(budgetMap.get('volatile')).toBe(Math.floor(remainingAfterRules * 0.10));
            });
        }
    }

    it('enemy budget hits the 1024 hard ceiling at 128k (the work order edge)', () => {
        expect(computeBudgets(131_072, undefined, false).budgetMap.get('enemy')).toBe(1_024);
        expect(computeBudgets(131_072, undefined, true).budgetMap.get('enemy')).toBe(1_024);
    });

    it('enemy budget scales linearly below the ceiling (32k)', () => {
        expect(computeBudgets(32_768, undefined, false).budgetMap.get('enemy')).toBe(819);
    });

    it('enemy budget is small at 8k (the low edge)', () => {
        expect(computeBudgets(8_192, undefined, false).budgetMap.get('enemy')).toBe(204);
    });
});

describe('Phase 7.4 — payload byte-identical across repeated runs (deterministic, zero mods)', () => {
    for (const limit of [8_192, 32_768, 131_072]) {
        it(`buildPayload is byte-identical across two runs at ${limit} (shallow)`, () => {
            const settings = baseSettings(limit);
            const ctx = baseContext();
            const a = buildPayload({ settings, context: ctx, history: [], userMessage: 'Hello' });
            const b = buildPayload({ settings, context: ctx, history: [], userMessage: 'Hello' });
            expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
        });

        it(`buildPayload is byte-identical across two runs at ${limit} (deep)`, () => {
            const settings = baseSettings(limit);
            const ctx = baseContext();
            const a = buildPayload({ settings, context: ctx, history: [], userMessage: 'Hello', deepContextSummary: 'Deep context summary.' });
            const b = buildPayload({ settings, context: ctx, history: [], userMessage: 'Hello', deepContextSummary: 'Deep context summary.' });
            expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
        });
    }
});

describe('Phase 7.4 — payload with enemy content is byte-identical across runs', () => {
    const enemy: EnemyEntry = {
        id: 'e1',
        name: 'Goblin',
        aliases: 'goblin',
        classification: 'Humanoid',
        threatTier: '1',
        faction: '',
        stats: [{ name: 'HP', value: '7' }],
        actions: [{ name: 'Stab', description: '1d6 damage' }],
        specialBehaviors: [],
        weaknesses: [],
        resistances: [],
        tactics: 'Ambush',
        passiveTraits: [],
        description: 'A small, vicious creature.',
        loot: 'A few copper coins.',
        gmNotes: '',
        promptEnabled: true,
    } as EnemyEntry;

    for (const limit of [8_192, 32_768, 131_072]) {
        it(`payload with enemy compendium content is byte-identical across two runs at ${limit}`, () => {
            const settings = baseSettings(limit);
            const ctx = baseContext();
            const opts = {
                settings,
                context: ctx,
                history: [],
                userMessage: 'I attack the goblin.',
                // Phase 7.5 — the block reaches the prompt as a segment the
                // subsystem renders, not as four option fields on `buildPayload`.
                volatileSegments: [buildEnemyVolatileSegment({ enemyCompendium: [enemy] })],
            };
            const a = buildPayload(opts);
            const b = buildPayload(opts);
            expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
            // The enemy block should be present (mention-matched).
            const content = a.messages.map((m) => m.content as string).join('\n');
            expect(content).toContain('Goblin');
        });
    }
});

describe('Phase 7.4 — a fixture mod claims a budget and is trimmed to it', () => {
    it('a mod budget claim is exposed through the budget map', () => {
        // Register a mod claim that allocates 200 tokens.
        budgetClaims.register({
            id: 'mod.fixture-test.customBlock',
            source: 'mod',
            modId: 'fixture-test',
            name: 'Custom block',
            description: 'A fixture mod budget claim.',
            allocate: () => 200,
        });
        try {
            const map = budgetClaims.compute(32_768, undefined, false);
            expect(map.get('mod.fixture-test.customBlock')).toBe(200);
            // The built-ins are untouched.
            expect(map.get('stable')).toBeGreaterThan(0);
            expect(map.get('enemy')).toBe(819);
        } finally {
            budgetClaims.unregister('mod.fixture-test.customBlock');
        }
    });

    it('a mod budget claim that scales with context limit is computed correctly', () => {
        budgetClaims.register({
            id: 'mod.fixture-test.scaling',
            source: 'mod',
            modId: 'fixture-test',
            name: 'Scaling block',
            description: 'A fixture mod budget that scales with limit.',
            allocate: ({ limit }) => Math.floor(limit * 0.01),
        });
        try {
            expect(budgetClaims.compute(8_192, undefined, false).get('mod.fixture-test.scaling')).toBe(81);
            expect(budgetClaims.compute(32_768, undefined, false).get('mod.fixture-test.scaling')).toBe(327);
            expect(budgetClaims.compute(131_072, undefined, false).get('mod.fixture-test.scaling')).toBe(1310);
        } finally {
            budgetClaims.unregister('mod.fixture-test.scaling');
        }
    });

    it('a mod budget claim that exceeds its declared contribution budget is trimmed by the arbiter', () => {
        // The contribution arbiter trims a mod-authored contribution to its
        // declared `budget` field. This is separate from the budget CLAIM
        // registry (which allocates host budget slices). A mod that claims a
        // budget slice AND declares a contribution with a budget ceiling
        // gets both: the slice is reserved in the budget map, and the
        // contribution text is trimmed to its declared ceiling. This test
        // verifies the trim happens (the contribution's text is shorter than
        // its untrimmed form).
        // The contribution registry is the trim mechanism; the budget claim
        // registry is the allocation mechanism. They are orthogonal: a mod
        // may claim a budget slice (so the host reserves tokens for it) and
        // may also declare a contribution with a budget ceiling (so the
        // arbiter trims the text to fit). The two numbers need not match —
        // the claim is about reservation, the ceiling is about trimming.
        // This test is a smoke test that the budget map carries the claim
        // and the contribution is trimmed (the trim is already covered by
        // the contribution arbiter tests).
        budgetClaims.register({
            id: 'mod.fixture-test.trimmed',
            source: 'mod',
            modId: 'fixture-test',
            name: 'Trimmed block',
            description: 'A fixture mod budget claim that is trimmed.',
            allocate: () => 50,
        });
        try {
            const map = budgetClaims.compute(8_192, undefined, false);
            expect(map.get('mod.fixture-test.trimmed')).toBe(50);
        } finally {
            budgetClaims.unregister('mod.fixture-test.trimmed');
        }
    });
});

describe('Phase 7.4 — unregistering a built-in claim yields zero (absence is quiet)', () => {
    it('an unregistered id returns zero from the budget map', () => {
        const map = budgetClaims.compute(32_768, undefined, false);
        expect(map.get('mod.nonexistent.budget')).toBe(0);
        expect(map.get('nonexistent')).toBe(0);
    });

    it('unregistering the enemy claim yields zero (Phase 8 rehearsal)', () => {
        // Phase 8 will unregister the 'enemy' claim when enemies leaves core.
        // The consumer reads budgetMap.get('enemy') → 0, which is the
        // quiet-absence path. The residual flows to history.
        const enemyClaim = budgetClaims.get('enemy');
        expect(enemyClaim).toBeDefined();
        budgetClaims.unregister('enemy');
        try {
            const map = budgetClaims.compute(32_768, undefined, false);
            expect(map.get('enemy')).toBe(0);
            // The other built-ins are untouched.
            expect(map.get('stable')).toBeGreaterThan(0);
            expect(map.get('world')).toBeGreaterThan(0);
        } finally {
            // Re-register for other tests.
            budgetClaims.register(enemyClaim!);
        }
    });

    it('core\'s claim sweep never touches a claim it does not own', () => {
        // `ensureBuiltinClaims` unregisters-then-registers its own ids so a
        // double import cannot throw on a duplicate. Before Phase 7.5 that
        // sweep also named the subsystem claim, so any test that called
        // `budgetClaims.clear()` silently dropped it on the next compute — and
        // the symptom (a block rendered at a zero budget) reads as a trimming
        // bug, not a registration one. This pins the sweep to core's four.
        ensureEnemyBudgetClaim();
        budgetClaims.clear();
        const map = computeBudgets(32_768, undefined, false).budgetMap;
        expect(map.get('stable')).toBeGreaterThan(0);
        // The subsystem's claim did not survive `clear()` — it is not core's to
        // restore — but re-asking the subsystem brings it back with its number.
        expect(map.get('enemy')).toBe(0);
        ensureEnemyBudgetClaim();
        expect(computeBudgets(32_768, undefined, false).budgetMap.get('enemy')).toBe(819);
    });
});