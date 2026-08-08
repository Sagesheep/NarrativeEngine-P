/**
 * Phase 5.2 — the payload-level gate for the pre-prompt / generation
 * interceptor.
 *
 * Where `interceptors/__tests__/interceptorRegistry.test.ts` proves the
 * registry behaves, this file proves the *product* claim: the real fixture
 * mod's real interceptor, run through the real registry, changes the real
 * built payload in exactly the two ways the contract allows and in no other
 * way.
 *
 * It drives `mods/example-interceptor-mod/index.js` directly — the shipped
 * fixture source, not a copy of it. Phase 4.0 learned that lesson the hard
 * way: `arcComputeBinding.test.ts` reimplemented the worker prelude and
 * therefore tested a copy of the thing it was meant to guard.
 *
 * The four done-when items, in order:
 *   1. a fixture interceptor adds a block, and one suppresses a permitted
 *      built-in — both visible in the built payload;
 *   2. attempting to touch a protected id is rejected with a reason;
 *   3. timeout and throw paths both leave the turn working;
 *   4. cache stability green; zero-mod payload byte-identical.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import { GM_REMINDER } from '../../payload/contributions/builtins';
import type { AppSettings, GameContext, PinnedExcerpt } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';
import {
    clearAllModInterceptors,
    hasPromptInterceptors,
    registerModInterceptor,
    runPromptInterceptors,
} from '../interceptors';
import { interceptorFaultStore } from '../interceptors/interceptorFaults';
import type { PromptInterceptionResult, PromptInterceptorInput } from '../interceptors';
// The SHIPPED fixture, imported rather than reimplemented.
import { interceptPrompt, onActivate } from '../../../../mods/example-interceptor-mod/index.js';
import { SUPPRESSIBLE_BUILTIN_IDS } from '../../payload/contributions/builtins';

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
    turnId: 'turn_7',
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

/** Every message carrying a cache_control marker — the cached prefix. */
function cachedPrefix(messages: OpenAIMessage[]): OpenAIMessage[] {
    return messages.filter((m) => (m as { cache_control?: unknown }).cache_control !== undefined);
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

/**
 * Register the shipped fixture at a known load index and run its `activate`
 * so the fixture's module-scope closure (message count, suppressible ids) is
 * populated exactly as it would be in the running app. Phase 5.3 made the
 * fixture read `ctx.api.suppressibleIds` in `activate`; without this call the
 * fixture's `suppressibleIds` stays `[]` and its conditional suppression of
 * `gm.reminder` never fires.
 */
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

// ── 1. Additive and subtractive, both visible in the built payload ──────────

describe('done-when 1 — the fixture adds a block and suppresses a permitted built-in', () => {
    it('adds its computed block to the final user message', async () => {
        registerFixture();
        const interception = await runPromptInterceptors(TURN_INPUT);
        const content = finalUserContent(build(interception).messages);

        expect(content).toContain('[SCENE LEDGER]');
        expect(content).toContain('turn turn_7');
        // The block a static contribution could not have written: its text
        // depends on the turn.
        expect(finalUserContent(build(await runPromptInterceptors({ ...TURN_INPUT, turnId: 'turn_8' })).messages))
            .toContain('turn turn_8');
    });

    it('places the block where its order says, between the GM reminder and the watchdog nudge', async () => {
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasWatchdogNudge: true });
        const content = finalUserContent(build(interception).messages);

        // order 450: after gm.reminder (400), before watchdog.nudge (500).
        expect(content.indexOf(GM_REMINDER)).toBeGreaterThanOrEqual(0);
        expect(content.indexOf('[SCENE LEDGER]')).toBeGreaterThan(content.indexOf(GM_REMINDER));
        expect(content.indexOf(USER_MESSAGE)).toBeGreaterThan(content.indexOf('[SCENE LEDGER]'));
    });

    it('suppresses gm.reminder on a turn where the Director spoke, and only then', async () => {
        registerFixture();

        const withBrief = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        const withBriefContent = finalUserContent(build(withBrief, { directorBrief: DIRECTOR_BRIEF }).messages);
        expect(withBriefContent).toContain('[DIRECTOR BRIEF]');
        expect(withBriefContent).not.toContain(GM_REMINDER);
        // The suppression removed one block and nothing else.
        expect(withBriefContent).toContain('[SCENE LEDGER]');
        expect(withBriefContent).toContain(USER_MESSAGE);

        const withoutBrief = await runPromptInterceptors(TURN_INPUT);
        const withoutBriefContent = finalUserContent(build(withoutBrief).messages);
        expect(withoutBriefContent).toContain(GM_REMINDER);
    });

    it('reports the suppression in the assembled diagnostics, attributed to the mod', async () => {
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        expect(interception?.suppress).toContainEqual({ id: 'gm.reminder', by: 'mod.example-interceptor-mod' });
    });

    it('says nothing at all on a turn the player armed an Absolute Command', async () => {
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasAbsoluteCommand: true });
        expect(interception).toBeUndefined();
    });

    it('applies the contribution budget to interceptor output', async () => {
        // A macro's output is not exempt from a budget (5.1 §2.4) and neither
        // is an interceptor's: one mod must not eat the context window.
        registerModInterceptor(
            { id: 'greedy', name: 'Greedy', loadIndex: 1 },
            () => ({ contributions: [{ id: 'wall', text: 'word '.repeat(4000), budget: 20, order: 450 }] }),
        );
        const interception = await runPromptInterceptors(TURN_INPUT);
        const content = finalUserContent(build(interception).messages);
        // 20 tokens of "word " is far short of 4000 repetitions.
        expect(content.length).toBeLessThan(USER_MESSAGE.length + 500);
        expect(content).toContain(USER_MESSAGE);
    });
});

// ── 2. The protected ids are not negotiable ────────────────────────────────

describe('done-when 2 — attempting to touch a protected id is rejected with a reason', () => {
    it('drops the fixture\'s deliberate user.message suppression and keeps the player\'s words', async () => {
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });
        const content = finalUserContent(build(interception, { directorBrief: DIRECTOR_BRIEF }).messages);

        // The player's own words survive. This is the guarantee.
        expect(content).toContain(USER_MESSAGE);
        expect(interception?.suppress.map((s) => s.id)).not.toContain('user.message');
    });

    it('surfaces the rejection with a reason naming the id and why', async () => {
        registerFixture();
        await runPromptInterceptors(TURN_INPUT);

        const record = interceptorFaultStore.getRecords().find((r) => r.modId === 'example-interceptor-mod');
        expect(record?.kind).toBe('protected');
        expect(record?.reason).toContain('user.message');
        expect(record?.reason).toContain('structural');
        // Surfaced in the Extensions list shape, not just in a console line.
        expect(interceptorFaultStore.getFaults()[0]).toMatchObject({
            file: 'example-interceptor-mod/manifest.json',
        });
    });

    it('the volatile block cannot be removed either', async () => {
        registerModInterceptor(
            { id: 'hostile', name: 'Hostile', loadIndex: 1 },
            () => ({ suppress: ['volatile.block', 'askgm.brief', 'absolute.command'] }),
        );
        const interception = await runPromptInterceptors(TURN_INPUT);
        expect(interception).toBeUndefined();
        expect(interceptorFaultStore.getRecords()[0].kind).toBe('protected');
    });
});

// ── 3. Timeout and throw both leave the turn working ───────────────────────

describe('done-when 3 — timeout and throw leave the turn working', () => {
    it('a throwing interceptor leaves a complete, correct payload', async () => {
        registerModInterceptor({ id: 'broken', name: 'Broken', loadIndex: 1 }, () => { throw new Error('kaboom'); });
        registerFixture();

        const interception = await runPromptInterceptors(TURN_INPUT);
        const content = finalUserContent(build(interception).messages);

        expect(content).toContain(USER_MESSAGE);
        expect(content).toContain(GM_REMINDER);
        // The healthy mod's block still landed.
        expect(content).toContain('[SCENE LEDGER]');
        expect(interceptorFaultStore.getRecords().find((r) => r.modId === 'broken')?.kind).toBe('threw');
    });

    it('a hanging interceptor leaves the un-intercepted payload, and it equals the zero-mod one', async () => {
        registerModInterceptor({ id: 'hangs', name: 'Hangs', loadIndex: 1 }, () => new Promise(() => {}));

        const interception = await runPromptInterceptors(TURN_INPUT, { deadlineMs: 20 });
        expect(interception).toBeUndefined();

        const intercepted = build(interception);
        const clean = build(undefined);
        expect(JSON.stringify(intercepted.messages)).toBe(JSON.stringify(clean.messages));
        expect(interceptorFaultStore.getRecords()[0].kind).toBe('timeout');
    });
});

// ── 4. Cache stability, and the zero-mod payload ───────────────────────────

describe('done-when 4 — cache stability and the zero-mod payload', () => {
    it('the cached prefix is byte-identical with an interceptor firing', async () => {
        registerFixture();
        const interception = await runPromptInterceptors({ ...TURN_INPUT, hasDirectorBrief: true });

        const intercepted = build(interception, { directorBrief: DIRECTOR_BRIEF });
        const clean = build(undefined, { directorBrief: DIRECTOR_BRIEF });

        // The stable preamble and the pinned-memory block carry cache_control.
        expect(cachedPrefix(clean.messages).length).toBeGreaterThan(0);
        expect(JSON.stringify(cachedPrefix(intercepted.messages)))
            .toBe(JSON.stringify(cachedPrefix(clean.messages)));
        // And the two payloads DO differ — otherwise the assertion above is
        // vacuous.
        expect(finalUserContent(intercepted.messages)).not.toBe(finalUserContent(clean.messages));
    });

    it('everything an interceptor produces lands in the final user message and nowhere else', async () => {
        registerFixture();
        const interception = await runPromptInterceptors(TURN_INPUT);
        const messages = build(interception).messages;

        const carriers = messages.filter((m) => typeof m.content === 'string' && m.content.includes('[SCENE LEDGER]'));
        expect(carriers).toHaveLength(1);
        expect(carriers[0]).toBe(messages[messages.length - 1]);
        expect(carriers[0].role).toBe('user');
    });

    it('a zero-interceptor turn never calls the stage at all', () => {
        expect(hasPromptInterceptors()).toBe(false);
    });

    it('an absent interception is byte-identical to the pre-5.2 call', async () => {
        const noKey = buildPayload({
            settings: baseSettings(), context: baseContext(), history: [],
            userMessage: USER_MESSAGE, pinnedExcerpts: pinned(),
        });
        const undefinedKey = build(undefined);
        const emptyResult = build({ specs: [], suppress: [] });

        expect(JSON.stringify(undefinedKey.messages)).toBe(JSON.stringify(noKey.messages));
        expect(JSON.stringify(emptyResult.messages)).toBe(JSON.stringify(noKey.messages));
    });
});

// ── Ordering across two mods ───────────────────────────────────────────────

describe('two interceptors compose by resolved load order', () => {
    it('the lower load index contributes first at equal order', async () => {
        registerModInterceptor({ id: 'later', name: 'Later', loadIndex: 200 },
            () => ({ contributions: [{ id: 'b', text: 'SECOND-MOD', order: 450 }] }));
        registerModInterceptor({ id: 'earlier', name: 'Earlier', loadIndex: 100 },
            () => ({ contributions: [{ id: 'a', text: 'FIRST-MOD', order: 450 }] }));

        const content = finalUserContent(build(await runPromptInterceptors(TURN_INPUT)).messages);
        expect(content.indexOf('FIRST-MOD')).toBeLessThan(content.indexOf('SECOND-MOD'));
    });

    it('one mod may suppress another mod\'s interceptor block — ids are ids', async () => {
        registerModInterceptor({ id: 'writer', name: 'Writer', loadIndex: 100 },
            () => ({ contributions: [{ id: 'note', text: 'WRITER-NOTE', order: 450 }] }));
        registerModInterceptor({ id: 'censor', name: 'Censor', loadIndex: 200 },
            () => ({ suppress: ['mod.writer.note'] }));

        const content = finalUserContent(build(await runPromptInterceptors(TURN_INPUT)).messages);
        expect(content).not.toContain('WRITER-NOTE');
        expect(content).toContain(USER_MESSAGE);
    });
});
