// Phase 2.3 fixture — a native mod that exercises the full getContext() v1 surface.
//
// THE ONE RULE: a mod talks to the `ctx` object handed to it. A mod NEVER
// imports from `src/`. This file proves a native mod can read host state,
// perform a write, call a model, and read/write its own table — all through
// the ModContext, with zero imports from the app's source.
//
// `activate` fires at app load (Phase 1.4 §3), which can be BEFORE any campaign
// is open. In that lease `data.campaignId` is null and `table.read`/`table.write`
// reject with `[facade] no active campaign` (API.md §6.5). The mod guards against
// that case so a cold-start activate does not fault; the surface is exercised
// when a campaign is open and the host fires a second activate (the lifecycle
// host's load cycle is idempotent — install fires once, but activate fires on
// every load). A test that wants to prove the surface works hands the mod a
// `ModContext` directly and calls `onActivate(ctx)`.

/**
 * The mod's `activate` hook. Receives the `ModContext` (or `undefined` when
 * fired from the load cycle before any campaign is open). Guards the
 * no-campaign case so a cold start does not fault.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx) {
        // The load cycle fired before any campaign was open. The host passes
        // `undefined` for the context in this case (API.md §6.5). Nothing to do;
        // the surface is exercised on a later activate with a real context.
        return;
    }

    try {
        exerciseSurface(ctx);
    } catch (error) {
        // A fault in the surface exercise is contained by the lifecycle host
        // (Phase 1.4 §3). We re-throw only in the test harness; in production
        // the host records a fault and the app continues.
        ctx.log('activate exercise failed:', error instanceof Error ? error.message : String(error));
        throw error;
    }
}

/**
 * Exercise the full v1 surface: read host state, write to the store, call a
 * model, and read/write the mod's own table. Pure side-effect — the mod's
 * purpose is to prove every channel works through `ctx` with zero imports
 * from `src/`.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext} ctx
 */
function exerciseSurface(ctx) {
    // ── §4: reads ──
    // Frozen, cloned per handout. A mod must not be able to mutate host state
    // by writing to a read (2.3 §3). Live values arrive through `subscribe`
    // (Phase 2.4), not by unfreezing this.
    const campaignId = ctx.data.campaignId;
    const playerInput = ctx.data.playerInput;
    const npcLedger = ctx.data.npcLedger;
    const location = ctx.data.location;
    const config = ctx.config.aiTier;

    ctx.log('surface read:', {
        campaignId,
        playerInput: playerInput.slice(0, 40),
        npcCount: npcLedger.length,
        currentPlaceId: location.currentPlaceId,
        aiTier: config,
    });

    // ── §6.2: tables (async) ──
    // The mod's OWN declared table. The bare name `'ledger'` resolves to
    // `mod.example-surface-mod.ledger` because the object already knows which
    // mod it belongs to (API.md §6.2). The fully-qualified name is accepted as
    // an alias. `table.read` / `table.write` are Promise-returning in both
    // bindings (API.md §1.2).
    if (campaignId === null) {
        // No campaign — table.read/write reject. The mod's activate at app
        // load reaches here on a cold start. We log and return; the surface is
        // exercised when a campaign is open.
        ctx.log('no active campaign — table exercise skipped');
        return;
    }

    // The table exercise is async, but `activate` is fired under a 5s deadline
    // by the lifecycle host and the host does NOT await the promise returned by
    // a fire-and-forget table.write (the journal applies on clean return for
    // sandboxed compute; for native, the host awaits the hook under the
    // deadline). We kick off the exercise and let it run; the test harness
    // awaits it explicitly.
    void exerciseTable(ctx);

    // ── §5: writes (synchronous, void) ──
    // Every write goes through the same callback the app itself uses. No direct
    // store writes, ever (2.3 §3). We use `addNpcSuggestions` (append-only, no
    // read needed) so the exercise does not clobber real state.
    ctx.write.addNpcSuggestions(['surface-mod-probe'], 'Phase 2.3 fixture exercise');

    // ── §6.1: model (async) ──
    // Brokers by role. No endpoint, no provider config, no credential ever
    // crosses the surface. The cap is 3 calls per lease; we make one. Kicked
    // off and awaited by the test harness.
    if (ctx.model.available('utility')) {
        void exerciseModel(ctx);
    } else {
        ctx.log('utility model not configured — model exercise skipped');
    }
}

/**
 * Read-modify-write the mod's own table. Demonstrates the read+write channel
 * for mod-owned data. The bare name and the fully-qualified name both resolve
 * to the same table.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext} ctx
 */
async function exerciseTable(ctx) {
    const rows = await ctx.table.read('ledger');
    const list = Array.isArray(rows) ? rows : [];
    const next = [
        ...list,
        {
            id: 'probe-' + Date.now(),
            campaignId: ctx.data.campaignId,
            playerInput: ctx.data.playerInput.slice(0, 80),
            timestamp: Date.now(),
        },
    ];
    await ctx.table.write('ledger', next);
    ctx.log('table exercise complete — wrote', next.length, 'rows');
}

/**
 * Call a model through the brokered channel. No credential crosses the
 * surface; the host resolves the endpoint by role.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext} ctx
 */
async function exerciseModel(ctx) {
    const response = await ctx.model.call('utility', {
        prompt: 'Reply with the single word: OK',
        maxTokens: 16,
        trackingLabel: 'example-surface-mod:activate',
    });
    ctx.log('model exercise complete — response:', response.content.slice(0, 40));
}

// Exported for the test harness, which imports this module directly and calls
// `onActivate` with a constructed `ModContext`. The lifecycle host calls the
// default `activate` hook via the named export; the test harness uses the same
// export to exercise the surface without the lifecycle host.
export { exerciseSurface };