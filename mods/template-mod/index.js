// Template Mod — a working mod that demonstrates every mount point, every
// table shape, the event bus, a macro, a fact, a budget claim, and the
// canonical subscription/cleanup patterns.
//
// THE ONE RULE (docs/MODDING.md, top): a mod talks to the `ctx` object handed
// to it. A mod NEVER imports from `src/`. This file does not.
//
// Copy this folder, rename the `id` in `manifest.json`, delete what you do
// not need, and edit from there. Every pattern below has a comment naming the
// doc section that explains it.
//
// SURFACE EXERCISED
//   ctx.mounts.header         (MOUNTS.md §2.2)         — chrome button
//   ctx.mounts.composer       (MOUNTS.md §2.3)         — chrome pill
//   ctx.mounts.messageAction  (MOUNTS.md §2.5)         — per-message icon
//   ctx.mounts.rail           (MOUNTS.md §2.4)         — right-rail panel
//   ctx.mounts.messageBelow   (MOUNTS.md §2.6)         — per-message slot
//   ctx.mounts.window         (MOUNTS.md §2.7)         — floating window
//   ctx.table.read/write      (API.md §6.2)            — own tables (array + single-object)
//   ctx.table.subscribe       (API.md §6.4)            — live own-table reads
//   ctx.subscribe             (API.md §6.4)            — live host-data reads
//   ctx.events.on/emit        (EVENTS.md)              — core + mod events
//   ctx.macros.register       (Phase 5.1)              — {{greeting}}
//   ctx.facts.register        (Phase 5.4)              — namespaced mod fact
//   ctx.budgets.claim         (Phase 7.4)              — budget map entry
//   ctx.tokens.count          (Phase 7.4)              — host tokenizer
//   ctx.write.updateNPC       (API.md §5)              — ModNpcPatch
//   ctx.write.addTimelineEvent (API.md §5.3)           — append to timeline
//   native.generateInterceptor (Phase 5.2)             — pre-prompt hook

// ─── Module-scope state ────────────────────────────────────────────────────
// Live host state is kept current by subscriptions set up in `activate`
// (API.md §6.4 / MODDING.md "The interceptor"). The interceptor and macro
// read these closures — they do not get their own `ctx` (MODDING.md
// "The pre-prompt interceptor" rule 3).

let entries = [];                 // rows of the mod's `entries` table (recordShape: "array")
let settings = { greeting: 'hi' };// row of the mod's `settings` table (recordShape: "single-object")
let onStageIds = [];              // mirror of ctx.data.onStageNpcIds
let npcLedger = [];               // mirror of ctx.data.npcLedger (ModNpcEntry[])
let messages = [];                // mirror of ctx.data.messages
let campaignOpen = false;

// Subscription handles — kept so onDisable can be explicit, although the host
// tears them down regardless (MOUNTS.md §8.5). Grouped so the cleanup path is
// obvious to a reader copying this file.
let unsubs = [];
let winHandle = null;
let railHandle = null;
let headerHandle = null;
let composerHandle = null;

// ─── Lifecycle hooks ───────────────────────────────────────────────────────

/**
 * `install` fires once, the first time this mod id is seen (MANIFEST.md §3.1).
 * Seed the `settings` single-object table with its default row. Never fires
 * again, even after disable/enable.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onInstall(ctx) {
    if (!ctx) return;
    ctx.log('template-mod installed');
    // Opportunistic seed — a campaign may already be open. table.write is
    // wholesale replacement (MODDING.md "Tables"), so we write the full
    // object, not a merge.
    if (ctx.data.campaignId !== null) {
        void ctx.table.write('settings', settings);
    }
}

/**
 * `activate` fires at every app load and after a user toggles the mod back
 * on. This is where mounts, subscriptions, events, macros, facts and budgets
 * are registered.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export async function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        // Cold-start load before a campaign, or a sandboxed lease (mounts are
        // native-tier only — narrative-mod-api.d.ts:231). Nothing to register;
        // a later activate with a real context will register everything.
        return;
    }

    // Reset state on re-activate (the host fires activate on every load and
    // after a user toggles the mod back on from Extensions).
    unsubs = [];
    winHandle = null;
    railHandle = null;
    headerHandle = null;
    composerHandle = null;
    campaignOpen = ctx.data.campaignId !== null && ctx.data.campaignId !== undefined;
    onStageIds = [...ctx.data.onStageNpcIds];
    npcLedger = [...ctx.data.npcLedger];
    messages = [...ctx.data.messages];

    // ── Tables: load own tables for this campaign ────────────────────────
    // Native-tier table access needs NO capability string (MODDING.md
    // "Native vs sandboxed table access" / Phase 9.1 §5.2). The
    // `compute.capabilities` allow-list applies to the sandboxed compute hook
    // only.
    await loadTables(ctx);

    // ── Subscriptions: ONE each for the whole mod (MODDING.md §"Subscriptions") ──
    unsubs.push(ctx.subscribe('onStageNpcIds', (v) => {
        onStageIds = Array.isArray(v) ? [...v] : [];
        if (headerHandle) headerHandle.update();
    }));
    unsubs.push(ctx.subscribe('npcLedger', (v) => {
        npcLedger = Array.isArray(v) ? [...v] : [];
    }));
    unsubs.push(ctx.subscribe('messages', (m) => {
        messages = Array.isArray(m) ? [...m] : [];
        if (composerHandle) composerHandle.update();
    }));
    unsubs.push(ctx.subscribe('campaignId', (id) => {
        campaignOpen = id !== null && id !== undefined;
        if (campaignOpen) void loadTables(ctx);
    }));
    // Subscribe to the mod's own tables so a sandboxed compute hook (if this
    // mod ever ships one) or an external write is reflected live (API.md §6.4:
    // "including a change a compute hook made mid-turn"). Same for `settings`.
    unsubs.push(ctx.table.subscribe('entries', (rows) => {
        entries = Array.isArray(rows) ? rows : [];
        if (railHandle) railHandle.update();
    }));
    unsubs.push(ctx.table.subscribe('settings', (rows) => {
        // recordShape: "single-object" → table.read returns the object (or
        // null on empty). MODDING.md "Tables" / Phase 9.1 §5.3.
        if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
            settings = { ...settings, ...rows };
        }
        if (railHandle) railHandle.update();
    }));

    // ── Events (EVENTS.md) ───────────────────────────────────────────────
    // campaign.opened is sticky (EVENTS.md §4.4): a late subscriber gets the
    // last payload with replayed:true, which closes the cold-start race
    // (API.md §6.5). We re-load tables when a campaign opens.
    unsubs.push(ctx.events.on('campaign.opened', () => {
        campaignOpen = true;
        void loadTables(ctx);
    }));
    unsubs.push(ctx.events.on('campaign.closing', () => {
        campaignOpen = false;
    }));
    // turn.committed fires when the post-turn pipeline has finished and the
    // turn is ordinary history (EVENTS.md §6.4). Slow work is fine here — the
    // emit does not await the listener.
    unsubs.push(ctx.events.on('turn.committed', (p) => {
        ctx.log('turn committed:', p.turnId, 'scene', p.sceneId);
    }));
    // message.deleted → drop entries whose messageId no longer exists.
    unsubs.push(ctx.events.on('message.deleted', (p) => {
        const ids = new Set(p.messageIds);
        const before = entries.length;
        entries = entries.filter((e) => !ids.has(e.messageId));
        if (entries.length !== before) void persistEntries(ctx);
    }));
    // Emit a custom mod event (EVENTS.md §4.5). The host stamps the
    // mod.<id>. prefix, so this fires as `mod.template-mod.activated`.
    ctx.events.emit('activated', { at: Date.now() });

    // ── Macro (Phase 5.1) ────────────────────────────────────────────────
    // The manifest contribution `{{greeting}}` expands to whatever this
    // resolver returns. Reference your own macro by the BARE name — the host
    // namespaces on its side, and `{{mod.<id>.<name>}}` is a load rejection
    // (Phase 9.2). Pure and synchronous; runs on the hot path of every turn.
    // Returning '' is the "inactive this turn" path.
    unsubs.push(ctx.macros.register('greeting', () => {
        const g = typeof settings.greeting === 'string' ? settings.greeting : '';
        return g ? `[Template Mod: ${g}]` : '';
    }));

    // ── Fact (Phase 5.4) ─────────────────────────────────────────────────
    // A namespaced mod fact (no claim). Not read by `when` today; the
    // namespacing exists so a future expansion of `when` can read mod-owned
    // facts without a second registration surface (MODDING.md "Namespaced
    // mod facts"). `inCombat` is the one core fact open for claims today.
    unsubs.push(ctx.facts.register('mood', () => {
        // Pure and synchronous. Reading ctx.data is fine; awaiting is not.
        // A throwing publisher yields no fact + a surfaced fault; the turn
        // never breaks.
        return onStageIds.length > 2 ? 'crowded' : 'quiet';
    }));

    // ── Budget claim (Phase 7.4) ─────────────────────────────────────────
    // Claim a slice of the prompt budget by id. The host qualifies it to
    // `mod.template-mod.myFeature`, runs the allocator once per
    // `buildPayload`, and exposes the result through the budget map. Never
    // throws; the host removes every claim on disable.
    unsubs.push(ctx.budgets.claim(
        'myFeature',
        (allocCtx) => {
            // Pure: reads only the context and closed-over constants.
            const { remainingAfterRules } = allocCtx;
            return Math.floor(remainingAfterRules * 0.05);
        },
        { name: 'Template feature', description: 'A demonstration budget claim.' },
    ));

    // ── ctx.tokens.count (Phase 7.4) ─────────────────────────────────────
    // Exposes the host's tokenizer (cl100k_base BPE) so a mod can do
    // token-accurate trimming of its own contributions. Native-tier only.
    const sampleTokens = ctx.tokens.count('Hello, world.');
    ctx.log('token count sample:', sampleTokens);

    // ── Mount: window.layer (MOUNTS.md §2.7) ─────────────────────────────
    // Declared once, opened many times. The host owns the chrome (title bar,
    // drag, resize, z-order, focus, close); the mod owns the interior node.
    winHandle = ctx.mounts.window({
        id: 'editor',
        title: 'Template Editor',
        defaultSize: { width: 480, height: 360 },
        minSize: { width: 280, height: 200 },
        resizable: true,
        mount: (node, modCtx) => mountWindowInterior(node, modCtx),
    });

    // ── Mount: header.actions (MOUNTS.md §2.2 / §8.2) ────────────────────
    // Chrome — the host renders the button; we supply data + callbacks.
    // `icon` is a PascalCase lucide name (MODDING.md "Icons" / Phase 9.1
    // §5.7). `state()` is re-read on every header re-render and on
    // handle.update() (Phase 9.1 §5.6). For a button whose state depends on
    // a ModData key, subscribe to that key and call handle.update() — do
    // NOT rely on the host re-rendering on its own.
    headerHandle = ctx.mounts.header({
        id: 'openEditor',
        icon: 'AppWindow',
        label: 'TEMPLATE',
        tooltip: 'Open the template editor window',
        onSelect: () => winHandle.open(),
        state: () => ({
            badge: entries.length > 0 ? entries.length : undefined,
            active: onStageIds.length > 0,
        }),
    });

    // ── Mount: composer.actions (MOUNTS.md §2.3) ─────────────────────────
    // Chrome pill in the row above the composer. Same shape as header;
    // `busy` makes the host spin the icon (Save's SAVING… state).
    composerHandle = ctx.mounts.composer({
        id: 'stampTurn',
        icon: 'Bookmark',
        label: 'STAMP',
        tooltip: 'Append a template entry to the mod table',
        onSelect: async () => {
            // The host drains any pending commit before dispatching (§8.8),
            // so reading ctx.data here sees settled state.
            const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
            const entry = {
                id: 'entry-' + Date.now(),
                messageId: last ? last.id : null,
                text: last ? (typeof last.content === 'string' ? last.content.slice(0, 120) : '') : '',
                at: Date.now(),
            };
            entries = [...entries, entry];
            await persistEntries(ctx);
            // Also demonstrate addTimelineEvent (API.md §5.3) — append-only,
            // deduped by id.
            ctx.write.addTimelineEvent({
                id: 'tl-template-' + entry.id,
                sceneId: 'template',
                summary: 'Template mod stamped a turn',
            });
        },
        state: () => ({
            disabled: messages.length === 0,
            badge: entries.length > 0 ? entries.length : undefined,
        }),
    });

    // ── Mount: message.actions (MOUNTS.md §2.5) ──────────────────────────
    // Chrome icon in each message's action rail. One button per row; the
    // same onSelect closure is shared (example-message-mod confirms this).
    // The host drains a pending commit before dispatching (§8.8).
    ctx.mounts.messageAction({
        id: 'tag',
        icon: 'Tag',
        label: 'Tag',
        tooltip: 'Tag this message (template)',
        onSelect: () => {
            ctx.log('message.actions: tag onSelect fired');
        },
        state: () => ({ active: entries.length > 0 }),
    });

    // ── Mount: message.below (MOUNTS.md §2.6) ────────────────────────────
    // Imperative content into a host-owned node per visible message. Receives
    // MessageRef { id, role, sceneId } (§8.4) so the slot can act on that
    // specific message. ONE subscription for the whole mod, not one per row
    // (4.4 §3). Safe to mount twice for the same sceneId (swipe /
    // scene-continue); re-read messages rather than caching (§8.4).
    ctx.mounts.messageBelow({
        id: 'annotation',
        mount: (node, modCtx, message) => {
            const paint = () => {
                const row = modCtx.data.messages.find((m) => m.id === message.id);
                const len = row ? (typeof row.content === 'string' ? row.content.length : 0) : 0;
                node.textContent = `[template] ${message.role} · scene ${message.sceneId ?? '—'} · ${len} chars`;
            };
            paint();
            // Phase 9.1 §5.5 — a subscription created inside mount() MUST be
            // returned as the cleanup, or it lives until the mod is disabled,
            // not until the mount is unmounted. Return them.
            const unsub = modCtx.subscribe('messages', paint);
            return () => { unsub(); node.replaceChildren(); };
        },
    });

    // ── Mount: chat.rail (MOUNTS.md §2.4) ────────────────────────────────
    // Imperative content into a host-owned right-hand dock. One tab per mod;
    // no tab strip at one mod. Live data via ctx.subscribe /
    // ctx.table.subscribe.
    railHandle = ctx.mounts.rail({
        id: 'panel',
        title: 'Template',
        icon: 'Bookmark',
        mount: (node, modCtx) => mountRailPanel(node, modCtx),
    });

    // ── Demonstrate ctx.write.updateNPC with a ModNpcPatch ───────────────
    // Phase 9.1 §5.1 — ModNpcEntry is a projection of the host's ~30-field
    // NPCEntry. updateNPC accepts a Partial<ModNpcEntry> patch of the
    // writable fields (name, faction, disposition, affinity, …). Read-only
    // fields (id, isPC, tier, archived*) are silently dropped. See
    // docs/narrative-mod-api.d.ts `ModNpcPatch` for the full list.
    if (npcLedger.length > 0 && campaignOpen) {
        // Example: read an NPC's faction from the ledger, nudge affinity.
        const first = npcLedger[0];
        ctx.log('first NPC:', first.name, 'faction:', first.faction, 'affinity:', first.affinity);
        // ctx.write.updateNPC(first.id, { affinity: Math.max(-3, first.affinity - 1) });
        // ↑ commented out so installing the template does not mutate real
        //   campaigns. Uncomment to exercise the write.
    }

    ctx.log('template-mod activated; entries =', entries.length, 'campaignOpen =', campaignOpen);
}

/**
 * `disable` fires when the user toggles the mod off. The host removes every
 * mount, subscription and event listener the mod registered (MOUNTS.md §8.5);
 * we tear down defensively anyway, because a stale closure after disable is
 * a no-op plus a fault rather than a throw, and the defensive cleanup makes
 * the intent obvious to a reader.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onDisable(ctx) {
    for (const u of unsubs) {
        try { if (typeof u === 'function') u(); } catch { /* ignore */ }
    }
    unsubs = [];
    winHandle = null;
    railHandle = null;
    headerHandle = null;
    composerHandle = null;
    if (ctx) ctx.log('template-mod disabled');
}

// ─── The pre-prompt interceptor (Phase 5.2) ────────────────────────────────
//
// Declared in the manifest as `native.generateInterceptor`. Fires once per
// turn, after the host knows every input the prompt consumes and before
// assembly begins. May ADD blocks and SUPPRESS permitted ones; may not
// rewrite, replace the player's message, or reorder assembly. The protected
// four (`user.message`, `volatile.block`, `askgm.brief`, `absolute.command`)
// can never be suppressed.
//
// Gets ONE argument, and it is NOT `ctx` (MODDING.md "The pre-prompt
// interceptor" rule 3). Subscribe in `activate` and read the closure here.
// Must return within 1.5s; must be deterministic.

/**
 * @param {import('../../docs/narrative-mod-api').PromptInterceptorInput} input
 * @returns {import('../../docs/narrative-mod-api').PromptInterception | void}
 */
export function interceptPrompt(input) {
    // The quiet path — under an Absolute Command the player has overridden
    // the GM's standing instructions, and a mod piling more on top is the
    // wrong reflex.
    if (input.hasAbsoluteCommand) return;

    // Additive: a computed block a static `contributions[]` entry could not
    // produce, because its text depends on the turn. `order: 450` lands after
    // the GM reminder (400) and before the watchdog nudge (500).
    return {
        contributions: [
            {
                id: 'scene-ledger',
                order: 450,
                budget: 120,
                text: `[Template scene ledger — turn ${input.turnId}, ${messages.length} messages so far]`,
            },
        ],
        // Subtractive, conditional on this turn. `gm.reminder` is in
        // ctx.api.suppressibleIds (Phase 5.3); naming a protected id is
        // refused with a reason and the rest of the interception still lands.
        suppress: input.hasDirectorBrief ? ['gm.reminder'] : [],
    };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const ENTRIES_TABLE = 'entries';
const SETTINGS_TABLE = 'settings';

async function loadTables(ctx) {
    if (!campaignOpen) return;
    try {
        // recordShape: "array" → table.read returns the array (or [] on
        // empty). MODDING.md "Tables" / Phase 9.1 §5.3.
        const rows = await ctx.table.read(ENTRIES_TABLE);
        entries = Array.isArray(rows) ? rows : [];
    } catch (e) {
        ctx.log('entries read failed:', e instanceof Error ? e.message : String(e));
    }
    try {
        // recordShape: "single-object" → table.read returns the object (or
        // null on empty). MODDING.md "Tables" / Phase 9.1 §5.3.
        const obj = await ctx.table.read(SETTINGS_TABLE);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            settings = { ...settings, ...obj };
        }
    } catch (e) {
        ctx.log('settings read failed:', e instanceof Error ? e.message : String(e));
    }
}

async function persistEntries(ctx) {
    if (!campaignOpen) return;
    try {
        // table.write is wholesale replacement — no append, no merge.
        await ctx.table.write(ENTRIES_TABLE, entries);
    } catch (e) {
        ctx.log('entries write failed:', e instanceof Error ? e.message : String(e));
    }
}

async function persistSettings(ctx) {
    if (!campaignOpen) return;
    try {
        await ctx.table.write(SETTINGS_TABLE, settings);
    } catch (e) {
        ctx.log('settings write failed:', e instanceof Error ? e.message : String(e));
    }
}

// ─── Mount interiors ───────────────────────────────────────────────────────

/**
 * Fill the window's interior node. The host hands a stable DOM node; the mod
 * fills it and may return a teardown. Live updates come from
 * `ctx.subscribe` (Phase 2.4) — ONE subscription for the whole mount, not
 * one per render. The `ctx` handed to `mount(node, ctx)` is the
 * activate-time lease (Phase 9.1 §5.4); call `await ctx.refresh()` for a
 * fresh lease with a fresh model budget.
 *
 * @param {HTMLElement} node
 * @param {import('../../docs/narrative-mod-api').ModContext} modCtx
 */
function mountWindowInterior(node, modCtx) {
    const root = document.createElement('div');
    root.className = 'template-mod-root';
    node.append(root);

    const paint = () => {
        root.replaceChildren();

        // ── Settings section ─────────────────────────────────────────────
        const settingsBox = document.createElement('div');
        const sTitle = document.createElement('div');
        sTitle.textContent = 'Settings (single-object table)';
        sTitle.style.fontWeight = '600';
        settingsBox.append(sTitle);

        const label = document.createElement('label');
        label.className = 'template-mod-row';
        label.textContent = 'Greeting: ';
        const input = document.createElement('input');
        input.className = 'template-mod-input';
        input.type = 'text';
        input.value = typeof settings.greeting === 'string' ? settings.greeting : '';
        input.addEventListener('change', async () => {
            settings = { ...settings, greeting: input.value };
            await persistSettings(modCtx);
        });
        label.append(input);
        settingsBox.append(label);
        root.append(settingsBox);

        // ── Entries list (array table) ──────────────────────────────────
        const listTitle = document.createElement('div');
        listTitle.textContent = `Entries (array table) — ${entries.length}`;
        listTitle.style.fontWeight = '600';
        root.append(listTitle);

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'template-mod-muted';
            empty.textContent = 'No entries yet. Press STAMP in the composer to add one.';
            root.append(empty);
        } else {
            for (const e of entries) {
                const row = document.createElement('div');
                row.className = 'template-mod-row';
                const text = document.createElement('span');
                text.textContent = e.text || '(empty)';
                const rm = document.createElement('button');
                rm.className = 'template-mod-btn';
                rm.type = 'button';
                rm.textContent = 'Remove';
                rm.addEventListener('click', async () => {
                    entries = entries.filter((x) => x.id !== e.id);
                    await persistEntries(modCtx);
                });
                row.append(text, rm);
                root.append(row);
            }
        }

        // ── On-stage NPCs (demonstrates ModNpcEntry reads) ───────────────
        const npcTitle = document.createElement('div');
        npcTitle.textContent = `On-stage NPCs — ${onStageIds.length}`;
        npcTitle.style.fontWeight = '600';
        root.append(npcTitle);

        if (onStageIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'template-mod-muted';
            empty.textContent = 'No NPCs currently on stage.';
            root.append(empty);
        } else {
            const byId = new Map(npcLedger.map((n) => [n.id, n]));
            for (const id of onStageIds) {
                const npc = byId.get(id);
                const row = document.createElement('div');
                row.className = 'template-mod-row';
                // Phase 9.1 §5.1 — ModNpcEntry exposes faction, disposition,
                // status, affinity, … for reads. The previous .d.ts shell
                // (NPCEntry { id, name }) hid all of these.
                const text = npc
                    ? `${npc.name} — faction: ${npc.faction || '—'}, disposition: ${npc.disposition || '—'}, affinity: ${npc.affinity ?? '—'}`
                    : id;
                row.textContent = text;
                root.append(row);
            }
        }
    };

    paint();
    // Phase 9.1 §5.5 — return the unsubscribes as the cleanup, or they leak
    // until disable. ONE subscription per host key, not one per render.
    const u1 = modCtx.subscribe('onStageNpcIds', paint);
    const u2 = modCtx.subscribe('npcLedger', paint);
    const u3 = modCtx.table.subscribe(ENTRIES_TABLE, paint);
    const u4 = modCtx.table.subscribe(SETTINGS_TABLE, paint);
    return () => { u1(); u2(); u3(); u4(); node.replaceChildren(); };
}

/**
 * Fill the rail panel's dock node. Same discipline as the window interior:
 * ONE subscription per host key, returned as the cleanup.
 *
 * @param {HTMLElement} node
 * @param {import('../../docs/narrative-mod-api').ModContext} modCtx
 */
function mountRailPanel(node, modCtx) {
    const root = document.createElement('div');
    root.className = 'template-mod-root';
    node.append(root);

    const paint = () => {
        root.replaceChildren();
        const title = document.createElement('div');
        title.textContent = `Template Panel — ${entries.length} entries`;
        title.style.fontWeight = '600';
        root.append(title);

        const summary = document.createElement('div');
        summary.className = 'template-mod-muted';
        summary.textContent = `On stage: ${onStageIds.length} · Campaign: ${campaignOpen ? 'yes' : 'no'}`;
        root.append(summary);

        const help = document.createElement('div');
        help.className = 'template-mod-muted';
        help.textContent = 'Macro {{greeting}} expands to the settings greeting.';
        root.append(help);
    };

    paint();
    const u1 = modCtx.table.subscribe(ENTRIES_TABLE, paint);
    const u2 = modCtx.subscribe('onStageNpcIds', paint);
    return () => { u1(); u2(); node.replaceChildren(); };
}