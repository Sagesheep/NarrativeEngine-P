// Phase 4.4 fixture — a native mod that exercises both message-row mount
// points defined in MOUNTS.md §2.5/§2.6.
//
// THE ONE RULE: a mod talks to the `ctx` object handed to it. A mod NEVER
// imports from `src/`. This file proves a native mod can:
//   1. contribute an action button to every message's action rail
//      (`ctx.mounts.messageAction` — declared chrome, host-rendered);
//   2. render a one-line annotation beneath every message
//      (`ctx.mounts.messageBelow` — imperative content, mod-rendered into a
//      host-owned node).
//
// Both mounts receive the message identity (`MessageRef`: id, role, sceneId)
// so the mod can act on that specific message. The mod's annotation reads
// `ctx.data.messages` to find the row by id and surfaces a short tag line.
// Live updates arrive through `ctx.subscribe('messages', ...)` — ONE
// subscription for the whole mod, not one per row, which is the trap 4.4 §3
// names ("if every message row opens its own subscription, a 500-message
// chat opens 500. Design against that explicitly").
//
// The mod's `messageBelow` slot is safe to mount twice for the same sceneId:
// a swipe or scene-continue that replaces the body re-runs the mount, and
// the mod re-reads `ctx.data.messages` rather than caching. A mod that
// cannot tolerate that is a mod that is caching where it should be reading
// (MOUNTS.md §8.4).

/**
 * The mod's `activate` hook. Receives the `ModContext` (or `undefined` when
 * fired from the load cycle before any campaign is open). Guards the
 * no-campaign case so a cold start does not fault — mount registration
 * needs no campaign data, but `ctx.subscribe` against a null campaign is
 * harmless (the host drops the subscription on disable).
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx) {
        // The load cycle fired before any campaign was open. The host passes
        // `undefined` for the context in this case (API.md §6.5). Nothing to
        // do; the mounts register on a later activate with a real context.
        return;
    }

    // 1. message.actions — declared chrome. The host renders the button in
    //    the message action rail's style, alongside edit/rewind/speak/delete.
    //    `onSelect` receives nothing (the host drains a pending commit first,
    //    per §8.8); the mod reads the message it was invoked on through its
    //    own subscription / closure state. Here the button toggles a per-id
    //    tag stored in a closure-held Set.
    const tagged = new Set();
    ctx.mounts.messageAction({
        id: 'tag',
        icon: 'Tag',
        label: 'Tag',
        tooltip: 'Tag this message',
        onSelect: () => {
            // The host drains a pending commit before dispatching (§8.8). The
            // mod does not know which message was clicked from the call alone
            // — the rail renders one button per row, but the same `onSelect`
            // closure is shared. A real mod tracks the "currently hovered"
            // message through its own subscription; for this fixture, we
            // simply log and let the user observe the button is native.
            ctx.log('message.actions: tag onSelect fired');
        },
        state: () => ({ active: tagged.size > 0 ? true : undefined }),
    });

    // 2. message.below — imperative content. The host hands the mod a DOM
    //    node per visible message; the mod fills it. The `mount` callback
    //    receives the `MessageRef` (id, role, sceneId) so the mod can act on
    //    that specific message. ONE subscription for the whole mod — not one
    //    per row — drives live updates (4.4 §3).
    let unsubscribe = undefined;
    ctx.mounts.messageBelow({
        id: 'annotation',
        mount: (node, modCtx, message) => {
            const paint = () => {
                const msgs = modCtx.data.messages;
                const row = msgs.find((m) => m.id === message.id);
                const len = row ? (typeof row.content === 'string' ? row.content.length : 0) : 0;
                const tag = `[example-message-mod] ${message.role} · scene ${message.sceneId ?? '—'} · ${len} chars · id ${message.id.slice(0, 8)}`;
                node.textContent = tag;
            };
            paint();
            // One subscription for the whole mod. The host coalesces
            // mutations; the cost is one listener on `messages`, not one per
            // row. The slot re-paints on every `messages` change, which is
            // fine because `paint` is cheap (a find by id + a textContent
            // set). A mod with an expensive paint would diff instead.
            unsubscribe = modCtx.subscribe('messages', paint);
            return () => {
                if (unsubscribe) { unsubscribe(); unsubscribe = undefined; }
            };
        },
    });
}

export function onDisable() {
    // Host-owned teardown (MOUNTS.md §8.5): the lifecycle host removes every
    // mount the mod registered and disposes every subscription the mod
    // opened. The mod never needs to call `handle.remove()` or
    // `unsubscribe()` itself — and it must not, because a stale closure
    // after disable is a no-op plus a fault rather than a throw. This hook
    // exists only to log that teardown ran.
    console.log('[example-message-mod] disable fired — Phase 4.4 teardown');
}