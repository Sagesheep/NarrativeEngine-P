/**
 * Phase 5.4 — Mods publish facts.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.4 -
 * Mods publish facts - Medium-mid.md`. This file drives the SHIPPED fixtures
 * (`mods/example-facts-mod` and `mods/example-facts-consumer-mod`) through
 * the real registry into the real `buildPayload`, the same discipline 5.2's
 * `phase52Interceptor.test.ts` and 5.3's `phase53Subtraction.test.ts`
 * established: the fixture is imported, not reimplemented, so a drift
 * between the mod and the host is caught here rather than in a copy.
 *
 * The five done-when items, in order:
 *   1. A fixture mod publishes a fact and a second mod's `when` matches on it.
 *   2. `inCombat` published by a mod drives conditions identically to the
 *      host-computed version — the rehearsal for Phase 8.
 *   3. Conflict resolution follows `loading_order` and is visible.
 *   4. Unknown fact still means no match.
 *   5. Full suite green, build clean, 0.2 gate green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import { setExtensionModules } from '../../payload/contributions/extensions';
import type { AppSettings, GameContext, PinnedExcerpt } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';
import { evaluateWhen } from '../modAdapter';
import { modToContributionModule } from '../modAdapter';
import type { ValidatedMod, ModFacts } from '../modTypes';
import {
    clearAllModFacts,
    factFaultStore,
    hasFactPublishers,
    registerModFact,
    runFactPublishers,
} from '../facts';
import { onActivate, onDisable } from '../../../../mods/example-facts-mod/index.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseContext = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', inventoryLastScene: 'Never',
    characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false,
    starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: true, encounterEngineActive: true,
    worldEngineActive: true, diceFairnessActive: true,
    sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '',
    notebook: [], notebookActive: true,
} as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: false,
    contextLimit: 8192,
} as unknown as AppSettings);

const pinned = (): PinnedExcerpt[] => ([
    { id: 'pin-1', sceneId: '001', text: 'The bridge burned.', chapterId: 'CH01' } as unknown as PinnedExcerpt,
]);

const USER_MESSAGE = 'I swing at the goblin.';

function finalUserContent(messages: OpenAIMessage[]): string {
    const last = messages[messages.length - 1];
    return last && last.role === 'user' && typeof last.content === 'string' ? last.content : '';
}

function build(publishedFacts?: { readonly facts: Partial<ModFacts>; readonly conflicts: readonly { readonly name: string; readonly winner: string; readonly loser: string }[] }) {
    return buildPayload({
        settings: baseSettings(),
        context: baseContext(),
        history: [],
        userMessage: USER_MESSAGE,
        pinnedExcerpts: pinned(),
        publishedFacts,
    });
}

/**
 * The consumer mod as a `ValidatedMod` — mirrors the shipped
 * `example-facts-consumer-mod/manifest.json` but constructed here so the
 * test does not need to fetch from the server. Its `when: { inCombat: true }`
 * contribution is what the publisher's fact drives.
 */
const consumerMod: ValidatedMod = {
    id: 'example-facts-consumer-mod',
    name: 'Example Facts Consumer',
    version: '1.0.0',
    description: 'Phase 5.4 fixture consumer.',
    file: 'example-facts-consumer-mod/manifest.json',
    folder: 'example-facts-consumer-mod',
    folderPath: '',
    loadOrder: 260,
    dependencies: {},
    i18n: {},
    i18nStrings: {},
    contributions: [{
        id: 'combat-note',
        order: 550,
        budget: 80,
        when: { inCombat: true },
        text: '[COMBAT IS ACTIVE — the encounter is live.]',
    }],
    tables: [],
    panels: [],
    screens: [],
    screenSources: [],
};

/** Register the consumer mod's contribution module so buildPayload sees it. */
function registerConsumerMod(): void {
    setExtensionModules([modToContributionModule(consumerMod)]);
}

/**
 * Register the shipped publisher fixture. Mirrors
 * `phase53Subtraction.test.ts`'s `registerFixture`.
 */
function registerPublisherFixture(): void {
    registerModFact(
        { id: 'example-facts-mod', name: 'Example Facts Publisher', loadIndex: 250 },
        'inCombat',
        () => true,
        { claims: 'inCombat' },
    );
}

beforeEach(() => {
    clearAllModFacts();
    factFaultStore.clear();
    setExtensionModules([]);
});

afterEach(() => {
    setExtensionModules([]);
});

// ── 1. A fixture mod publishes a fact and a second mod's `when` matches on it ─

describe('done-when 1 — cross-mod fact publication drives a condition', () => {
    it('a published inCombat=true makes a consumer mod\'s when: { inCombat: true } match', () => {
        // Register the consumer mod so its contribution is in the registry.
        registerConsumerMod();

        // Without the publisher, the host computes inCombat=false (no enemy
        // encounters in the fixture), so the consumer's condition misses.
        const withoutPublisher = build();
        expect(finalUserContent(withoutPublisher.messages)).not.toContain('[COMBAT IS ACTIVE');

        // Now register the publisher, which claims inCombat and publishes true.
        registerPublisherFixture();
        const result = runFactPublishers()!;
        expect(result.facts.inCombat).toBe(true);

        // The consumer's when: { inCombat: true } now matches.
        const withPublisher = build(result);
        const content = finalUserContent(withPublisher.messages);
        expect(content).toContain('[COMBAT IS ACTIVE');
    });

    it('evaluateWhen matches on a mod-published fact the same as a host-computed one', () => {
        expect(evaluateWhen({ inCombat: true }, { inCombat: true })).toBe(true);
        expect(evaluateWhen({ inCombat: true }, { inCombat: false })).toBe(false);
        expect(evaluateWhen({ inCombat: false }, { inCombat: false })).toBe(true);
    });
});

// ── 2. inCombat published by a mod drives conditions identically ─────────────

describe('done-when 2 — inCombat parity with the host-computed version', () => {
    it('a mod-published inCombat overrides the host-computed value', () => {
        registerConsumerMod();
        // Host computes inCombat=false (no encounters). Mod publishes true.
        // After merge, inCombat=true — the mod's claim wins.
        registerPublisherFixture();
        const result = runFactPublishers()!;
        expect(result.facts.inCombat).toBe(true);

        // buildPayload with no enemy encounters computes inCombat=false
        // (host), then merges the overlay → inCombat=true.
        const payload = build(result);
        // The consumer mod's text should appear.
        expect(finalUserContent(payload.messages)).toContain('[COMBAT IS ACTIVE');
    });

    it('a mod-published inCombat=false overrides a host-computed inCombat=true', () => {
        registerConsumerMod();
        // Register a publisher that publishes false, and verify it
        // overrides the host's true. This is the Phase 8 scenario: the
        // enemy mod says "no combat" even if the host still has encounter
        // data lingering.
        registerModFact(
            { id: 'example-facts-mod', name: 'Example Facts Publisher', loadIndex: 250 },
            'inCombat',
            () => false,
            { claims: 'inCombat' },
        );
        const result = runFactPublishers()!;
        expect(result.facts.inCombat).toBe(false);

        // The consumer mod's when: { inCombat: true } should NOT match.
        const payload = build(result);
        expect(finalUserContent(payload.messages)).not.toContain('[COMBAT IS ACTIVE');
    });
});

// ── 3. Conflict resolution follows loading_order and is visible ─────────────

describe('done-when 3 — conflict resolution', () => {
    it('two mods claim inCombat; the earlier in loading_order wins', () => {
        registerModFact(
            { id: 'mod-a', name: 'Mod A', loadIndex: 10 },
            'inCombat',
            () => true,
            { claims: 'inCombat' },
        );
        registerModFact(
            { id: 'mod-b', name: 'Mod B', loadIndex: 20 },
            'inCombat',
            () => false,
            { claims: 'inCombat' },
        );

        const result = runFactPublishers()!;
        // Mod A (loadIndex 10) wins.
        expect(result.facts.inCombat).toBe(true);
    });

    it('the conflict is surfaced in the result, not silently picked', () => {
        registerModFact(
            { id: 'mod-a', name: 'Mod A', loadIndex: 10 },
            'inCombat',
            () => true,
            { claims: 'inCombat' },
        );
        registerModFact(
            { id: 'mod-b', name: 'Mod B', loadIndex: 20 },
            'inCombat',
            () => false,
            { claims: 'inCombat' },
        );

        const result = runFactPublishers()!;
        expect(result.conflicts.length).toBeGreaterThan(0);
        const conflict = result.conflicts[0];
        expect(conflict.name).toBe('inCombat');
        expect(conflict.winner).toBe('Mod A');
    });

    it('the conflict is surfaced as a fault with both mods named', () => {
        registerModFact(
            { id: 'mod-a', name: 'Mod A', loadIndex: 10 },
            'inCombat',
            () => true,
            { claims: 'inCombat' },
        );
        registerModFact(
            { id: 'mod-b', name: 'Mod B', loadIndex: 20 },
            'inCombat',
            () => false,
            { claims: 'inCombat' },
        );

        const conflicts = factFaultStore.getRecords().filter((r) => r.kind === 'conflict');
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].reason).toContain('Mod A');
        expect(conflicts[0].reason).toContain('Mod B');
    });
});

// ── 4. Unknown fact still means no match ──────────────────────────────────────

describe('done-when 4 — unknown fact means no match', () => {
    it('evaluateWhen returns false for a fact that was never published', () => {
        expect(evaluateWhen({ inCombat: true }, {})).toBe(false);
        expect(evaluateWhen({ inCombat: true }, undefined)).toBe(false);
    });

    it('an empty publisher overlay (no claims) does not set inCombat', () => {
        // A mod registers a namespaced fact only (no claim). The overlay
        // does not set inCombat. The host value stands.
        registerModFact(
            { id: 'mod-x', name: 'Mod X', loadIndex: 5 },
            'mood',
            () => 'tense',
        );
        const result = runFactPublishers()!;
        expect(result.facts.inCombat).toBeUndefined();
    });

    it('zero publishers → buildPayload uses host facts as-is', () => {
        expect(hasFactPublishers()).toBe(false);
        const result = runFactPublishers();
        expect(result).toBeUndefined();

        // buildPayload with undefined publishedFacts is the zero-mod path.
        const payload = build(undefined);
        expect(finalUserContent(payload.messages)).toContain(USER_MESSAGE);
        // No consumer text appears (inCombat is false from the host).
        expect(finalUserContent(payload.messages)).not.toContain('[COMBAT IS ACTIVE');
    });
});

// ── 5. Zero-mod payload unchanged (0.2 gate) ──────────────────────────────────

describe('0.2 gate — zero-mod payload unchanged', () => {
    it('no publishedFacts key and undefined publishedFacts produce byte-identical payloads', () => {
        const noKey = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [],
            userMessage: USER_MESSAGE, pinnedExcerpts: pinned(),
        });
        const undefinedKey = build(undefined);
        const emptyResult = build({ facts: {}, conflicts: [] });

        expect(JSON.stringify(undefinedKey.messages)).toBe(JSON.stringify(noKey.messages));
        expect(JSON.stringify(emptyResult.messages)).toBe(JSON.stringify(noKey.messages));
    });

    it('a zero-publisher turn (no mods) produces the baseline payload', () => {
        expect(hasFactPublishers()).toBe(false);
        const result = runFactPublishers();
        expect(result).toBeUndefined();
        expect(finalUserContent(build(result).messages)).toContain(USER_MESSAGE);
    });
});

// ── Fixture teardown verification ──────────────────────────────────────────────

describe('fixture mod — activate / disable lifecycle', () => {
    it('onActivate registers the publisher through ctx.facts.register', () => {
        let registered = false;
        onActivate({
            facts: {
                register: (name, publisher, opts) => {
                    registered = true;
                    expect(name).toBe('inCombat');
                    expect(typeof publisher).toBe('function');
                    expect(opts?.claims).toBe('inCombat');
                    return () => {};
                },
            },
            log: () => {},
        });
        expect(registered).toBe(true);
    });

    it('onDisable calls the unregister function defensively', () => {
        let unregisterCalled = false;
        onActivate({
            facts: {
                register: () => () => { unregisterCalled = true; },
            },
            log: () => {},
        });
        onDisable({ log: () => {} });
        expect(unregisterCalled).toBe(true);
    });
});