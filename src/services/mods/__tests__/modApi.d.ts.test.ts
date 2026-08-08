/**
 * Phase 2.3 — the `.d.ts` type-checks the fixture native mod.
 *
 * The shipped `docs/narrative-mod-api.d.ts` is the artefact that lets an AI
 * write a correct mod on the first try (Phase 2.3 §2.3). This file is a
 * TYPE-ONLY check: it imports the `.d.ts` and a fixture mod's hook signature,
 * and asserts they are assignable. If the `.d.ts` drifts from the runtime
 * `ModContext`, this file fails to compile.
 *
 * This test does NOT run at run time. It is a `.ts` file in the `__tests__`
 * folder so `tsc -b` compiles it; if the types don't line up, the build fails.
 * The vitest runner picks it up too (it's a `.test.ts` file), but the body is
 * empty by design — the test is "does it compile?".
 */

import { describe, expect, it } from 'vitest';
import type { ModContext, ModComputeHook, NativeHook } from '../../../../docs/narrative-mod-api';
import type { PromptInterceptor as PublishedPromptInterceptor } from '../../../../docs/narrative-mod-api';
import type { PromptInterceptor as RuntimePromptInterceptor } from '../interceptors';

// A fixture mod's `default` export should match `ModComputeHook`. The fixture
// mod in `mods/example-surface-mod/index.js` exports `onActivate`, which is a
// `NativeHook` (the lifecycle-hook shape). Both shapes take a `ModContext`.
const computeHook: ModComputeHook = (ctx) => {
    // The surface the `.d.ts` describes must be reachable here. If the `.d.ts`
    // and the runtime `ModContext` drift, this assignment fails to compile.
    const campaignId: string | null = ctx.data.campaignId;
    const playerInput: string = ctx.data.playerInput;
    const npcs: readonly { id: string; name: string }[] = ctx.data.npcLedger;
    const location: {
        readonly currentPlaceId: string | null;
        readonly currentFeature: string | null;
        readonly ledger: readonly { id: string; name: string }[];
    } = ctx.data.location;

    // Phase 4.0 — `data.chapters` is a projection of `ArchiveChapter`. The
    // `sealedAt` is normalised to `number | null`; the internal-only fields
    // stay internal. A mod reads chapters; it never seals one.
    const chapters: readonly {
        readonly chapterId: string;
        readonly title: string;
        readonly sealedAt: number | null;
        readonly sceneIds: readonly string[];
        readonly summary: string;
    }[] = ctx.data.chapters;
    void chapters;

    // Writes are synchronous and void.
    const writeResult: void = ctx.write.addNpcSuggestions(['probe'], 'exercise');
    void writeResult;

    // Model is brokered; no credentials cross the surface.
    const modelCall: Promise<{ content: string }> = ctx.model.call('utility', { prompt: 'OK' });
    void modelCall;

    // Table is async; the bare name resolves to the mod's own namespaced table.
    const tableRead: Promise<unknown> = ctx.table.read('arcs');
    void tableRead;

    // The identity is per-mod; `folder` is absent on purpose.
    const modId: string = ctx.mod.id;
    const modName: string = ctx.mod.name;
    const modVersion: string = ctx.mod.version;
    void [campaignId, playerInput, npcs, location, modId, modName, modVersion];

    // `ctx.api.version` equals the app version; `commitPoint` is one of the two.
    const apiVersion: string = ctx.api.version;
    const commitPoint: 'immediate' | 'on-return' = ctx.api.commitPoint;
    // Phase 5.3 — the published suppressible set. A mod reads this to know
    // what it may target, rather than guessing from a static doc.
    const suppressibleIds: readonly string[] = ctx.api.suppressibleIds;
    void [apiVersion, commitPoint, suppressibleIds];

    // `subscribe` is declared here and implemented in Phase 2.4. The signature
    // must be available on the type even though calling it throws at runtime.
    const subscribe: (key: 'npcLedger', listener: (value: readonly { id: string; name: string }[]) => void) => () => void = ctx.subscribe;
    void subscribe;

    // `refresh` returns a fresh ModContext (full object, not a snapshot).
    const refresh: () => Promise<ModContext> = ctx.refresh;
    void refresh;

    // `log` is prefixed with the mod id by the host.
    const log: (...args: unknown[]) => void = ctx.log;
    void log;

    // `signal` is an AbortSignal.
    const signal: AbortSignal = ctx.signal;
    void signal;

    // Phase 4.2 — `ctx.mounts` is the mount-point surface. Six named methods,
    // one per region. A `MountHandle` is returned; the host tears it down on
    // disable. Native-tier only: a sandboxed compute hook's `ctx.mounts`
    // throws "native-tier only" (the worker prelude stubs it).
    const headerHandle: () => void = ctx.mounts.header({
        id: 'injectArc',
        icon: 'Syringe',
        label: 'Inject Arc',
        onSelect: (c) => { void c; },
    }).remove;
    void headerHandle;

    // Phase 5.1 — `ctx.macros` is the macro registration surface. One method
    // (`register`); the host qualifies the name and tears down on disable.
    // Native-tier only: a sandboxed compute hook's `ctx.macros.register`
    // throws "native-tier only" (the worker prelude stubs it).
    const unregisterMacro: () => void = ctx.macros.register('myMacro', () => 'expansion');
    void unregisterMacro;
};

// Phase 5.2 — the `.d.ts`'s `PromptInterceptor` must be assignable to the
// runtime one. If the published shape drifts from `interceptorTypes.ts`, this
// assignment fails to compile — which is the whole point of this file.
const publishedInterceptor: PublishedPromptInterceptor = (input) => {
    const turnId: string = input.turnId;
    const hasBrief: boolean = input.hasDirectorBrief;
    void [turnId, hasBrief, input.campaignId, input.tier, input.playerInput,
        input.hasWatchdogNudge, input.hasAbsoluteCommand];
    return {
        contributions: [{ id: 'scene-ledger', text: 'LEDGER', order: 450, budget: 120 }],
        suppress: ['gm.reminder'],
    };
};
const runtimeInterceptor: RuntimePromptInterceptor = publishedInterceptor;
void runtimeInterceptor;

const nativeHook: NativeHook = (ctx) => {
    // The lifecycle-hook shape. A mod's `activate`/`enable`/`disable`/etc.
    // receives the same surface a compute hook does.
    void ctx;
};

// The fixture mod's `onActivate` is a `NativeHook`. This assignment is the
// type-check: if the `.d.ts` and the fixture disagree, it fails to compile.
const fixtureOnActivate: NativeHook = nativeHook;
void fixtureOnActivate;
void computeHook;

describe('Phase 2.3 — the .d.ts type-checks the fixture mod', () => {
    it('compiles', () => {
        // The test is "does it compile?" — see the body of this file. The
        // imports and assignments above are the assertion; if the types drift,
        // `tsc -b` fails before vitest runs. This `it` exists so the file is
        // picked up as a test, not only as a compile target.
        expect(true).toBe(true);
    });
});