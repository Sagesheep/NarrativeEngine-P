import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import { budgetClaims } from '../budgetClaims';
import { composeVolatileBlock, renderVolatileSegments, VOLATILE_ANCHOR, type VolatileSegment } from '../volatileSegments';
import { buildEnemyVolatileSegment } from '../../enemy/enemyPayloadSegment';
import { createContributionRegistry } from '../contributions/registry';
import type { FinalUserModuleInput } from '../contributions/builtins';
import type { AppSettings, EnemyEntry, GameContext } from '../../../types';

/**
 * Phase 7.5 — the volatile-block segment seam.
 *
 * The phase's §3 item 3: *"Absence must be quiet, not broken. A missing role
 * produces no block, no fact, no panel — and no error. The app is smaller, not
 * damaged."* These tests hold that for the seam the enemy block leaves through.
 */

const baseContext = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '', starter: '',
    continuePrompt: '', inventory: '', inventoryLastScene: 'Never',
    characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: false, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', notebook: [], notebookActive: false,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (): AppSettings => ({ debugMode: true, contextLimit: 32_768 } as unknown as AppSettings);

const finalUserOf = (result: ReturnType<typeof buildPayload>): string =>
    ([...result.messages].reverse().find((m) => m.role === 'user')?.content as string) ?? '';

/** A trivial segment for the ordering/containment tests; claims no budget. */
const textSegment = (id: string, order: number, text: string): VolatileSegment => ({
    id,
    order,
    render: () => ({ text }),
});

describe('Phase 7.5 — absence is quiet', () => {
    it('no segments produces the same payload as an empty segment list', () => {
        const settings = baseSettings();
        const context = baseContext();
        const absent = buildPayload({ settings, context, history: [], userMessage: 'Hello' });
        const empty = buildPayload({ settings, context, history: [], userMessage: 'Hello', volatileSegments: [] });
        expect(JSON.stringify(empty.messages)).toBe(JSON.stringify(absent.messages));
    });

    it('no segments means no segment trace and no inCombat', () => {
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hello',
        });
        // Nothing claims to be volatile subsystem context.
        const sources = (result.trace ?? []).map((row) => row.source);
        expect(sources).not.toContain('Active Enemy Encounter');
        expect(sources).not.toContain('Enemy Compendium');
        // And nothing threw — the payload is complete.
        expect(finalUserOf(result)).toContain('Hello');
    });

    it('a segment that renders nothing adds nothing to the block', () => {
        const settings = baseSettings();
        const context = baseContext();
        const quiet = buildPayload({
            settings, context, history: [], userMessage: 'Hello',
            volatileSegments: [textSegment('quiet', 300, '')],
        });
        const absent = buildPayload({ settings, context, history: [], userMessage: 'Hello' });
        expect(JSON.stringify(quiet.messages)).toBe(JSON.stringify(absent.messages));
    });

    it('a segment that throws is skipped and the turn still builds', () => {
        const settings = baseSettings();
        const context = baseContext();
        const exploding: VolatileSegment = {
            id: 'exploding',
            order: 300,
            render: () => { throw new Error('boom'); },
        };
        const withThrower = buildPayload({
            settings, context, history: [], userMessage: 'Hello',
            volatileSegments: [exploding, textSegment('healthy', 310, 'HEALTHY SEGMENT')],
        });
        // The healthy neighbour still lands; the thrower contributes nothing.
        expect(finalUserOf(withThrower)).toContain('HEALTHY SEGMENT');
        expect(finalUserOf(withThrower)).toContain('Hello');
    });
});

describe('Phase 7.5 — ordering against the published anchors', () => {
    it('composes core parts and segments by order, ties by declaration index', () => {
        const composed = composeVolatileBlock(
            { rules: 'RULES', world: 'WORLD', state: 'STATE' },
            [
                { id: 'b', order: 300, text: 'B', tokens: 1 },
                { id: 'a', order: 300, text: 'A', tokens: 1 },
                { id: 'first', order: VOLATILE_ANCHOR.RULES - 1, text: 'FIRST', tokens: 1 },
                { id: 'last', order: VOLATILE_ANCHOR.STATE + 1, text: 'LAST', tokens: 1 },
            ],
        );
        expect(composed).toBe('FIRST\n\nRULES\n\nWORLD\n\nB\n\nA\n\nSTATE\n\nLAST');
    });

    it('with no segments the composition is exactly the pre-7.5 expression', () => {
        expect(composeVolatileBlock({ rules: 'R', world: 'W', state: 'S' }, [])).toBe('R\n\nW\n\nS');
        expect(composeVolatileBlock({ rules: '', world: 'W', state: undefined }, [])).toBe('W');
        expect(composeVolatileBlock({}, [])).toBe('');
    });
});

describe('Phase 7.5 — a segment is handed the budget its own id claims', () => {
    it('resolves each segment\'s budget by that segment\'s id', () => {
        const seen: Array<[string, number]> = [];
        const recorder = (id: string, order: number): VolatileSegment => ({
            id,
            order,
            render: ({ budget }) => { seen.push([id, budget]); return { text: '' }; },
        });
        renderVolatileSegments(
            [recorder('claimed', 300), recorder('unclaimed', 310)],
            (id) => ({ budget: id === 'claimed' ? 512 : 0, history: [], userMessage: '' }),
        );
        expect(seen).toEqual([['claimed', 512], ['unclaimed', 0]]);
    });

    it('buildPayload resolves the budget through the real budget map', () => {
        let observed = -1;
        buildPayload({
            settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hi',
            volatileSegments: [{
                id: 'npc', // an id core's structural claims own — 5% of the remainder
                order: 300,
                render: ({ budget }) => { observed = budget; return { text: '' }; },
            }],
        });
        const rules = Math.floor(32_768 * 0.10);
        expect(observed).toBe(Math.floor((32_768 - rules) * 0.05));
    });

    it('the enemy segment spends the claim its own module registers', () => {
        // `buildEnemyVolatileSegment` registers the claim as a side effect, so
        // asking for the segment is what puts the allocation on the map. This
        // is the coupling Phase 7.5 wanted: one owner for the block and its
        // budget, so one deletion removes both.
        budgetClaims.unregister('enemy');
        expect(budgetClaims.get('enemy')).toBeUndefined();
        buildEnemyVolatileSegment({});
        expect(budgetClaims.get('enemy')).toBeDefined();
    });
});

describe('Phase 7.5 — facts travel with the segment, not with core', () => {
    const goblin = {
        id: 'e1', name: 'Goblin', aliases: 'goblin', classification: 'Humanoid',
        threatTier: '1', faction: '', stats: [{ name: 'HP', value: '7' }],
        actions: [], specialBehaviors: [], weaknesses: [], resistances: [],
        tactics: '', passiveTraits: [], description: 'Small and vicious.',
        loot: '', gmNotes: '', promptEnabled: true,
    } as EnemyEntry;

    /**
     * A registry with two modules: a passthrough for the composed volatile
     * block (so the segment's text is still observable) and a probe that
     * renders whatever `facts.inCombat` resolved to. `facts` is not observable
     * from the payload otherwise — it is an input to contribution gating — so
     * the probe is how the merge order becomes assertable at all.
     */
    const factProbeRegistry = () => {
        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register({
            id: 'probe.volatile',
            name: 'Volatile passthrough',
            description: 'Test-only. Renders the composed volatile block.',
            source: 'builtin',
            defaultEnabled: true,
            toggleable: false,
            produce: (input) => [{
                id: 'probe.volatile',
                slot: 'final-user',
                order: 0,
                source: 'builtin',
                text: input.volatileBlock,
            }],
        });
        registry.register({
            id: 'probe.facts',
            name: 'Fact probe',
            description: 'Test-only. Renders the resolved inCombat fact.',
            source: 'builtin',
            defaultEnabled: true,
            toggleable: false,
            produce: (input) => [{
                id: 'probe.facts',
                slot: 'final-user',
                order: 1,
                source: 'builtin',
                text: `INCOMBAT=${String(input.facts.inCombat)}`,
            }],
        });
        return registry;
    };

    const inCombatFrom = (result: ReturnType<typeof buildPayload>): string =>
        finalUserOf(result).match(/INCOMBAT=(\w+)/)?.[1] ?? '<missing>';

    it('with no segment the fact is false — absence stays false', () => {
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hi',
            finalUserRegistry: factProbeRegistry(),
        });
        expect(inCombatFrom(result)).toBe('false');
    });

    it('a segment establishes the fact core no longer derives', () => {
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hi',
            finalUserRegistry: factProbeRegistry(),
            volatileSegments: [{
                id: 'combat-ish', order: 300,
                render: () => ({ text: '', facts: { inCombat: true } }),
            }],
        });
        expect(inCombatFrom(result)).toBe('true');
    });

    it('a mod-published fact still wins over a segment (5.4 precedence)', () => {
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [], userMessage: 'Hi',
            finalUserRegistry: factProbeRegistry(),
            volatileSegments: [{
                id: 'combat-ish', order: 300,
                render: () => ({ text: '', facts: { inCombat: true } }),
            }],
            publishedFacts: { facts: { inCombat: false } } as never,
        });
        expect(inCombatFrom(result)).toBe('false');
    });

    it('a compendium match is not combat — the block renders, the fact stays false', () => {
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [],
            userMessage: 'I look at the goblin.',
            finalUserRegistry: factProbeRegistry(),
            volatileSegments: [buildEnemyVolatileSegment({ enemyCompendium: [goblin] })],
        });
        expect(finalUserOf(result)).toContain('Goblin');
        expect(inCombatFrom(result)).toBe('false');
    });
});
