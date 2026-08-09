// NPC Tagger — a cold-start mod written from the public docs only.
//
// THE ONE RULE (narrative-mod-api.d.ts:8): a mod talks to the `ctx` object
// handed to it. A mod NEVER imports from `src/`. This file does not.
//
// TASK (as a user would state it): "add a button in the header that opens a
// window listing every NPC currently on stage, and let me tag them."
//
// SHAPE, from MOUNTS.md §11.3 (the enemy compendium cross-check):
//   header.actions × 1  (the button)
//   window.layer   × 1  (the list + tag editor)
// `onSelect` calls `handle.open()` — the canonical pattern.
//
// LIVE DATA, from API.md §4 / MOUNTS.md §11.2:
//   ctx.data.npcLedger       — every NPC the host knows about
//   ctx.data.onStageNpcIds   — the subset currently on stage
//   ctx.subscribe('onStageNpcIds', …) — live updates, ONE subscription
//   ctx.table.read/write('tags', …)   — the mod's OWN declared table
//
// The interior is plain DOM (MOUNTS.md §7: the host hands a node, not a React
// element), matching the example-window-mod fixture's discipline.

/**
 * The mod's `activate` hook. Receives the `ModContext` (or `undefined` when
 * fired from the load cycle before any campaign is open — API.md §6.5).
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        // Cold-start load before a campaign, or a sandboxed lease (mounts are
        // native-tier only — narrative-mod-api.d.ts:231). Nothing to register.
        return;
    }

    // A closure holding the latest on-stage NPC ids. Updated by ONE
    // subscription (MOUNTS.md §11.2: "not one per row"). The window's mount
    // function reads this so it does not need its own subscription.
    let onStageIds = ctx.data.onStageNpcIds ?? [];
    let unsubscribe = null;

    // ── Declare the window (MOUNTS.md §8.3 / §2.7) ──
    // Declared once, opened many times. The host owns the chrome (title bar,
    // drag, resize, z-order, focus, close); the mod owns the interior node.
    const win = ctx.mounts.window({
        id: 'tagger',
        title: 'NPC Tagger',
        defaultSize: { width: 420, height: 320 },
        minSize: { width: 280, height: 200 },
        resizable: true,
        mount: (node, modCtx) => {
            const body = document.createElement('div');
            body.style.padding = '8px';
            body.style.fontFamily = 'inherit';
            body.style.fontSize = '12px';
            body.style.color = 'inherit';
            body.style.display = 'flex';
            body.style.flexDirection = 'column';
            body.style.gap = '6px';
            node.append(body);

            const paint = async () => {
                const ids = onStageIds;
                // NPCEntry has { id, name } (narrative-mod-api.d.ts:97). The
                // host's on-stage list is ids; the ledger is the id→name map.
                const ledger = modCtx.data.npcLedger ?? [];
                const byId = new Map(ledger.map((n) => [n.id, n]));

                // Read this mod's own tags table (API.md §6.2: bare name
                // resolves to mod.npc-tagger.tags). Promise-returning in both
                // bindings (API.md §1.2).
                let tags = {};
                try {
                    const rows = await modCtx.table.read('tags');
                    // recordShape: "array" — we store [{ npcId, tags: [] }]
                    const list = Array.isArray(rows) ? rows : [];
                    for (const row of list) {
                        if (row && typeof row.npcId === 'string') {
                            tags[row.npcId] = Array.isArray(row.tags) ? row.tags : [];
                        }
                    }
                } catch (_e) {
                    // No campaign open, or table not seeded yet. Render the
                    // list without tags; the write path will seed it.
                }

                body.replaceChildren();

                if (ids.length === 0) {
                    const empty = document.createElement('div');
                    empty.textContent = 'No NPCs currently on stage.';
                    empty.style.opacity = '0.6';
                    body.append(empty);
                    return;
                }

                for (const id of ids) {
                    const npc = byId.get(id);
                    const name = npc ? npc.name : id;
                    const row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.flexDirection = 'column';
                    row.style.gap = '2px';

                    const label = document.createElement('div');
                    label.textContent = name;
                    label.style.fontWeight = '600';
                    row.append(label);

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = (tags[id] ?? []).join(', ');
                    input.placeholder = 'comma-separated tags';
                    input.style.width = '100%';
                    input.style.boxSizing = 'border-box';
                    input.style.padding = '2px 4px';

                    input.addEventListener('change', async () => {
                        const newTags = input.value
                            .split(',')
                            .map((t) => t.trim())
                            .filter((t) => t.length > 0);
                        await saveTags(modCtx, id, newTags);
                    });
                    row.append(input);

                    body.append(row);
                }
            };

            // ONE subscription for the whole mod (MOUNTS.md §11.2). onStageNpcIds
            // is on ModData (narrative-mod-api.d.ts:302), so it is subscribable.
            const unsubStage = modCtx.subscribe('onStageNpcIds', (value) => {
                onStageIds = value ?? [];
                void paint();
            });
            // Also repaint when the ledger itself changes (a new NPC named).
            const unsubLedger = modCtx.subscribe('npcLedger', () => void paint());

            void paint();
            return () => {
                if (unsubStage) unsubStage();
                if (unsubLedger) unsubLedger();
                node.replaceChildren();
            };
        },
    });

    // ── Register the header button (MOUNTS.md §8.2 / §2.2) ──
    // `icon` is a lucide name, resolved by the host. `id` is qualified to
    // mod.npc-tagger.openWindow by the host. `onSelect` opens the window.
    ctx.mounts.header({
        id: 'openTagger',
        icon: 'Tags',
        label: 'TAG NPCS',
        tooltip: 'List on-stage NPCs and tag them',
        onSelect: () => {
            win.open();
        },
    });

    // Capture the subscription teardown so the mod could call it — though
    // MOUNTS.md §8.5 says the host removes every mount on disable, so a mod
    // does not need to. Kept for symmetry with the example-window-mod fixture.
    unsubscribe = ctx.subscribe('onStageNpcIds', (value) => {
        onStageIds = value ?? [];
    });
}

/**
 * Read-modify-write the mod's own tags table for one NPC. The bare name
 * 'tags' resolves to mod.npc-tagger.tags (API.md §6.2).
 *
 * @param {import('../../docs/narrative-mod-api').ModContext} ctx
 * @param {string} npcId
 * @param {string[]} newTags
 */
async function saveTags(ctx, npcId, newTags) {
    let rows = [];
    try {
        const read = await ctx.table.read('tags');
        rows = Array.isArray(read) ? read : [];
    } catch (_e) {
        // No campaign / empty table — start fresh.
    }
    const without = rows.filter((r) => r && r.npcId !== npcId);
    without.push({ npcId, tags: newTags });
    await ctx.table.write('tags', without);
}