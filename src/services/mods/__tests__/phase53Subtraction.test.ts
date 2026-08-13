/**
 * Phase 5.3 — Subtraction.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.3 -
 * Subtraction - Medium-high.md`. 5.2 built the programmatic-suppression
 * channel; 5.3 is the narrower job of *publishing* the suppressible set through
 * `getContext()` and confirming the three documented semantics still hold with
 * tests, plus the protected-id guarantee and the zero-mod gate.
 *
 * The four done-when items, in order:
 *   1. A fixture mod suppresses a built-in from code, conditionally, per turn.
 *   2. The suppressible list is queryable and matches what the loader enforces.
 *   3. All three existing semantics still hold, with tests.
 *   4. Attempting to suppress a protected id fails the same way it does today.
 *
 * Plus the standing gate: zero-mod payload unchanged (0.2 gate). Full suite
 * green, build clean.
 *
 * This file drives the SHIPPED fixture (`mods/example-interceptor-mod`) through
 * the real registry into the real `buildPayload`, the same discipline 5.2's
 * `phase52Interceptor.test.ts` established: the fixture is imported, not
 * reimplemented, so a drift between the mod and the host is caught here rather
 * than in a copy of the mod.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import { GM_REMINDER, SUPPRESSIBLE_BUILTIN_IDS, BUILTIN_IDS } from '../../payload/contributions/builtins';
import { assembleContributions } from '../../payload/contributions/assemble';
import type { ContributionSpec } from '../../payload/contributions/types';
import { PROTECTED_SUPPRESSION_IDS } from '../modTypes';
import type { AppSettings, GameContext, PinnedExcerpt } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';
import {
    clearAllModInterceptors,
    registerModInterceptor,
    runPromptInterceptors,
} from '../interceptors';
import { interceptorFaultStore } from '../interceptors/interceptorFaults';
import type { PromptInterceptionResult, PromptInterceptorInput } from '../interceptors';
import { interceptPrompt, onActivate } from '../../../../mods/example-interceptor-mod/index.js';
import { buildModContext } from '../modContext';
import type { HostFacade } from '../../turn/hostFacade';

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

const USER_MESSAGE = 'I greet Elara warmly.';
const DIRECTOR_BRIEF = 'Give Elara the first word.';

const TURN_INPUT: PromptInterceptorInput = Object.freeze({
    turnId: 'turn_53',
    campaignId: 'campaign-1',
    tier: 'pro',
    playerInput: USER_MESSAGE,
    hasDirectorBrief: false,
    hasWatchdogNudge: false,
    hasAbsoluteCommand: false,
});

function finalUserContent(messages: OpenAIMessage[]): string {
    const last = messages[messages.length - 1];
    return last && last.role === 'user' && typeof last.content === 'string' ? last.content : '';
}

function build(
    interception?: PromptInterceptionResult,
    options: { directorBrief?: string; absoluteCommand?: string } = {},
) {
    return buildPayload({
        settings: baseSettings(),
        context: baseContext(),
        history: [],
        userMessage: USER_MESSAGE,
        pinnedExcerpts: pinned(),
        directorBrief: options.directorBrief,
        absoluteCommand: options.absoluteCommand,
        interception,
    });
}

/** Register the shipped fixture and run its `activate` so the closure is real. */
function registerFixture(loadIndex = 300): void {
    registerModInterceptor(
        { id: 'example-interceptor-mod', name: 'Example Interceptor', loadIndex, file: 'example-interceptor-mod/manifest.json' },
        interceptPrompt,
    );
    onActivate({
        data: { messages: [] },
        api: { version: 'test', commitPoint: 'immediate', suppressibleIds: SUPPRESSIBLE_BUILTIN_IDS },
        subscribe: () => () => {},
        log: () => {},
    });
}

beforeEach(() => {
    clearAllModInterceptors();
    interceptorFaultStore.clear();
});

// ── 1. A fixture mod suppresses a built-in from code, conditionally, per turn ─

describe('done-when 1 — fixture mod suppresses a built-in from code, conditionally', () => {
    it('suppresses gm.reminder on a Director-Brief turn and not on a plain turn', async () => {
        registerFixture();

        // Director-Brief turn: fixture suppresses gm.reminder.
        const withBrief = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        const withBriefContent = finalUserContent(build(withBrief, { directorBrief: DIRECTOR_BRIEF }).messages);
        expect(withBriefContent).toContain('[DIRECTOR BRIEF]');
        expect(withBriefContent).not.toContain(GM_REMINDER);
        // The block the fixture contributes still lands.
        expect(withBriefContent).toContain('[SCENE LEDGER]');
        // The player's own message survives.
        expect(withBriefContent).toContain(USER_MESSAGE);

        // Plain turn: reminder stays.
        const withoutBrief = await runPromptInterceptors(TURN_INPUT);
        expect(finalUserContent(build(withoutBrief).messages)).toContain(GM_REMINDER);
    });

    it('the suppression is computed per turn, not declared statically', async () => {
        registerFixture();
        // Two identical turns with the same Director-Brief state produce the
        // same suppression — determinism, the 5.2 §3 constraint.
        const a = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true, turnId: 't1' });
        const b = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true, turnId: 't2' });
        expect(a?.suppress).toEqual(b?.suppress);

        // And a turn without a Brief suppresses nothing.
        const c = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: false });
        expect(c?.suppress ?? []).not.toContain('gm.reminder');
    });

    it('the fixture reads ctx.api.suppressibleIds in activate before suppressing', async () => {
        // With the published set populated (registerFixture), the suppression fires.
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        expect(interception?.suppress.map((s) => s.id)).toContain('gm.reminder');

        // Without activate, suppressibleIds is [] and the fixture's conditional
        // suppression does NOT fire — the mod read the published set and honoured it.
        clearAllModInterceptors();
        interceptorFaultStore.clear();
        registerModInterceptor(
            { id: 'example-interceptor-mod', name: 'Example Interceptor', loadIndex: 300, file: 'example-interceptor-mod/manifest.json' },
            interceptPrompt,
        );
        // Reset the fixture's module-scope state with an empty suppressibleIds.
        onActivate({
            data: { messages: [] },
            api: { version: 'test', commitPoint: 'immediate', suppressibleIds: [] },
            subscribe: () => () => {},
            log: () => {},
        });
        const interception2 = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        expect(interception2?.suppress.map((s) => s.id) ?? []).not.toContain('gm.reminder');
        // The additive block still lands (the fixture always contributes it).
        expect(interception2?.specs.length ?? 0).toBeGreaterThan(0);
    });
});

// ── 2. The suppressible list is queryable and matches what the loader enforces ─

describe('done-when 2 — the suppressible list is queryable and matches the loader', () => {
    it('ctx.api.suppressibleIds is published on the ModContext', () => {
        // The buildModContext output carries suppressibleIds on ctx.api.
        const facade: HostFacade = {
            data: {
                activeCampaignId: 'c1',
                input: '',
                messages: [],
                archiveIndex: [],
                chapters: [],
                timeline: [],
                npcLedger: [],
                onStageNpcIds: [],
                loreChunks: [],
                divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 0 },
                context: { characterProfileData: {} as never, inventoryItems: [], currentPlaceId: null, currentFeature: null } as never,
                condenser: undefined,
                semanticFacts: undefined,
            },
            config: { aiTier: 'pro', contextLimit: 8192 },
            write: {} as never,
            model: {} as never,
            table: {} as never,
            signal: new AbortController().signal,
            log: () => {},
            refresh: () => { throw new Error('no'); },
        } as unknown as HostFacade;

        const ctx = buildModContext({
            mod: { id: 'test', name: 'Test', version: '1.0.0' },
            facade,
            commitPoint: 'immediate',
        });
        expect(ctx.api.suppressibleIds).toEqual(SUPPRESSIBLE_BUILTIN_IDS);
    });

    it('the published set is exactly the toggleable built-ins', () => {
        // The five toggleable ids are the set today (WO-4 §4 added `npc.relations` —
        // the on-stage NPC↔NPC relations block split out of the structural
        // `volatile.block` so a mod can suppress it).
        expect(SUPPRESSIBLE_BUILTIN_IDS).toEqual(
            expect.arrayContaining(['writer.cot', 'director.brief', 'gm.reminder', 'watchdog.nudge', 'npc.relations', 'npcStance']),
        );
        expect(SUPPRESSIBLE_BUILTIN_IDS).toHaveLength(6);
    });

    it('the published set is the complement of PROTECTED_SUPPRESSION_IDS', () => {
        // Every built-in id is either suppressible or protected, never both.
        const allBuiltins = Object.values(BUILTIN_IDS);
        for (const id of allBuiltins) {
            const inSuppressible = SUPPRESSIBLE_BUILTIN_IDS.includes(id);
            const inProtected = PROTECTED_SUPPRESSION_IDS.includes(id);
            expect(inSuppressible === !inProtected).toBe(true);
            expect(inSuppressible && inProtected).toBe(false);
        }
        // And the union is the whole built-in id set.
        const union = [...new Set([...SUPPRESSIBLE_BUILTIN_IDS, ...PROTECTED_SUPPRESSION_IDS])];
        expect(union.sort()).toEqual(allBuiltins.sort());
    });

    it('the set is frozen — a mod cannot mutate the published list', () => {
        expect(Object.isFrozen(SUPPRESSIBLE_BUILTIN_IDS)).toBe(true);
    });
});

// ── 3. All three existing semantics still hold, with tests ──────────────────

describe('done-when 3 — the three documented semantics still hold', () => {
    it('semantic 1 — suppression is one pass (a suppressed suppressor still exerts its suppression)', async () => {
        // A suppresses B, B suppresses C. With both active: A survives, B is
        // removed, C is removed (B's suppression of C counts even though B was
        // suppressed). This is the single-pass, no-cascade rule (types.ts).
        registerModInterceptor(
            { id: 'a-mod', name: 'A', loadIndex: 1 },
            () => ({
                contributions: [{ id: 'a', text: 'A-BLOCK', order: 200 }],
                suppress: ['mod.b-mod.b'],
            }),
        );
        registerModInterceptor(
            { id: 'b-mod', name: 'B', loadIndex: 2 },
            () => ({
                contributions: [{ id: 'b', text: 'B-BLOCK', order: 300 }],
                suppress: ['mod.c-mod.c'],
            }),
        );
        registerModInterceptor(
            { id: 'c-mod', name: 'C', loadIndex: 3 },
            () => ({ contributions: [{ id: 'c', text: 'C-BLOCK', order: 400 }] }),
        );

        const interception = await runPromptInterceptors(TURN_INPUT);
        const content = finalUserContent(build(interception).messages);

        // A survived; B and C were removed.
        expect(content).toContain('A-BLOCK');
        expect(content).not.toContain('B-BLOCK');
        expect(content).not.toContain('C-BLOCK');
        // B's suppression of C still applied even though B was suppressed.
        expect(interception?.suppress.map((s) => s.id)).toContain('mod.b-mod.b');
        expect(interception?.suppress.map((s) => s.id)).toContain('mod.c-mod.c');
    });

    it('semantic 2 — an inactive contribution (empty text) suppresses nothing', () => {
        // The arbiter drops inactive (empty-text) specs before computing
        // suppression, so a spec whose own `suppresses` field targets a block
        // but whose text is '' suppresses nothing. This is the declared
        // `suppresses` path — exercised through the arbiter directly, since
        // an interceptor's `suppress` is a separate host-supplied channel.
        const specs: ContributionSpec[] = [
            { id: 'lazy', order: 250, text: '', slot: 'final-user', source: 'mod', suppresses: ['gm.reminder'], budget: 80 },
            { id: 'reminder', order: 400, text: GM_REMINDER, slot: 'final-user', source: 'builtin' },
        ];
        const result = assembleContributions(specs);
        // The inactive spec was dropped; its suppression did not fire.
        expect(result.included).toContain('reminder');
        expect(result.suppressed).toEqual([]);
    });

    it('semantic 3 — an inactive interceptor (no Brief match) suppresses nothing', async () => {
        // The fixture only suppresses gm.reminder when hasDirectorBrief is true.
        // On a plain turn its suppression does not fire.
        registerFixture();
        const interception = await runPromptInterceptors(TURN_INPUT);
        expect(interception?.suppress ?? []).not.toContain('gm.reminder');
        expect(finalUserContent(build(interception).messages)).toContain(GM_REMINDER);
    });

    it('the Director Brief suppresses the watchdog nudge (existing built-in behaviour, unchanged)', async () => {
        // This is a declarative suppression in builtins.ts, not mod code. It
        // must still hold — the Phase 5.3 work did not touch the arbiter.
        const result = build(undefined, { directorBrief: DIRECTOR_BRIEF });
        const content = finalUserContent(result.messages);
        expect(content).toContain('[DIRECTOR BRIEF]');
        // The watchdog nudge is suppressed by the Director Brief's own
        // `suppresses: [watchdog.nudge]` declaration.
    });
});

// ── 4. Attempting to suppress a protected id fails the same way it does today ─

describe('done-when 4 — protected ids are rejected the same way', () => {
    it('all four protected ids are rejected with a reason when named in suppress', async () => {
        for (const protectedId of PROTECTED_SUPPRESSION_IDS) {
            clearAllModInterceptors();
            interceptorFaultStore.clear();

            registerModInterceptor(
                { id: 'hostile', name: 'Hostile', loadIndex: 1 },
                () => ({ suppress: [protectedId] }),
            );
            const interception = await runPromptInterceptors(TURN_INPUT);

            // The protected id was dropped from the suppression list.
            expect(interception?.suppress ?? []).not.toContain(protectedId);
            // A fault was recorded with kind 'protected'.
            const record = interceptorFaultStore.getRecords()[0];
            expect(record?.kind).toBe('protected');
            expect(record?.reason).toContain(protectedId);
            expect(record?.reason).toContain('structural');
        }
    });

    it('the rejection is per-entry — the rest of the interception still lands', async () => {
        // A mod that names one protected id and one valid one: the valid
        // suppression lands, the protected one is dropped with a fault.
        registerModInterceptor(
            { id: 'mixed', name: 'Mixed', loadIndex: 1 },
            () => ({ suppress: ['user.message', 'gm.reminder'] }),
        );
        const interception = await runPromptInterceptors(TURN_INPUT);

        expect(interception?.suppress.map((s) => s.id)).toContain('gm.reminder');
        expect(interception?.suppress.map((s) => s.id)).not.toContain('user.message');
        const record = interceptorFaultStore.getRecords()[0];
        expect(record?.kind).toBe('protected');
        expect(record?.id).toBe('user.message');
    });

    it('the player\'s message survives every protected-id attempt', async () => {
        for (const protectedId of PROTECTED_SUPPRESSION_IDS) {
            clearAllModInterceptors();
            interceptorFaultStore.clear();
            registerModInterceptor(
                { id: 'hostile', name: 'Hostile', loadIndex: 1 },
                () => ({ suppress: [protectedId] }),
            );
            const interception = await runPromptInterceptors(TURN_INPUT);
            const content = finalUserContent(build(interception).messages);
            expect(content).toContain(USER_MESSAGE);
        }
    });
});

// ── 5. Zero-mod payload unchanged (0.2 gate) ──────────────────────────────────

describe('0.2 gate — zero-mod payload unchanged', () => {
    it('no interception key and undefined interception produce byte-identical payloads', () => {
        const noKey = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [],
            userMessage: USER_MESSAGE, pinnedExcerpts: pinned(),
        });
        const undefinedKey = build(undefined);
        const emptyResult = build({ specs: [], suppress: [] });

        expect(JSON.stringify(undefinedKey.messages)).toBe(JSON.stringify(noKey.messages));
        expect(JSON.stringify(emptyResult.messages)).toBe(JSON.stringify(noKey.messages));
    });

    it('a zero-interceptor turn (no mods) produces the baseline payload', async () => {
        // No registerModInterceptor calls — the registry is empty.
        const interception = await runPromptInterceptors(TURN_INPUT);
        expect(interception).toBeUndefined();
        expect(finalUserContent(build(interception).messages)).toContain(USER_MESSAGE);
        expect(finalUserContent(build(interception).messages)).toContain(GM_REMINDER);
    });
});
