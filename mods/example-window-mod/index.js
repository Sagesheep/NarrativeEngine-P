// Phase 4.5 fixture — a native mod that exercises the `window.layer` mount
// point defined in MOUNTS.md §2.7.
//
// THE ONE RULE: a mod talks to the `ctx` object handed to it. A mod NEVER
// imports from `src/`. This file proves a native mod can:
//   1. declare a floating window via `ctx.mounts.window(...)` — the host owns
//      the chrome (title bar, drag, resize, z-order, focus, close, minimize,
//      bounds clamping) and the mod owns the interior;
//   2. open that window from a `header.actions` button (the canonical pattern
//      per MOUNTS.md §11.3 — the enemy compendium's shape);
//   3. render into the host-handed DOM node, with live updates driven by
//      `ctx.subscribe('messages', ...)` — ONE subscription for the whole mod,
//      matching the 4.4 fixture's discipline;
//   4. survive disable: the host closes the window and removes the
//      declaration on disable (MOUNTS.md §8.5). The mod never needs to call
//      `handle.remove()` or `handle.close()` itself.
//
// The interior counts messages and shows the latest GM line — enough to prove
// the imperative mount + `ctx.subscribe` path works inside a floating window,
// which is the same path the rail panel and the message-below slot use.

/**
 * The mod's `activate` hook. Receives the `ModContext` (or `undefined` when
 * fired from the load cycle before any campaign is open). Guards the
 * no-campaign case so a cold start does not fault.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        // No context (load before a campaign) or no mounts API (sandbox).
        // The 4.0 load cycle fires `activate` before a campaign is open;
        // a mod that needs state guards against `undefined`.
        return;
    }

    // Declare the window first. A window is declared once and opened many
    // times (MOUNTS.md §8.3); `WindowHandle.open()` is what makes it appear.
    // The host owns the chrome; the mod's `mount(node, ctx)` fills the
    // interior node the host hands it.
    const win = ctx.mounts.window({
        id: 'example',
        title: 'Example Window',
        defaultSize: { width: 360, height: 240 },
        minSize: { width: 240, height: 160 },
        resizable: true,
        mount: (node, modCtx) => {
            // The mod owns the interior. The host hands a stable DOM node;
            // the mod fills it and may return a teardown. Live updates come
            // from `ctx.subscribe` (Phase 2.4) — ONE subscription for the
            // whole mod, not one per render (same discipline as 4.4's
            // fixture).
            const body = document.createElement('div');
            body.style.padding = '8px';
            body.style.fontFamily = 'inherit';
            body.style.fontSize = '12px';
            body.style.color = 'inherit';
            node.append(body);

            const paint = () => {
                const messages = modCtx.data.messages ?? [];
                const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
                const count = messages.length;
                const preview = lastAssistant
                    ? (typeof lastAssistant.content === 'string' ? lastAssistant.content : '').slice(0, 80)
                    : '(no GM line yet)';
                body.replaceChildren(
                    document.createTextNode(`Messages: ${count}`),
                    document.createElement('br'),
                    document.createTextNode(`Last GM: ${preview}`),
                );
            };
            paint();
            const unsubscribe = modCtx.subscribe('messages', paint);
            return () => {
                if (unsubscribe) unsubscribe();
                node.replaceChildren();
            };
        },
    });

    // Register a header button that opens the window. This is the canonical
    // shape (MOUNTS.md §11.3 — the enemy compendium's `header.actions` × 1
    // plus `window.layer` × 1, with `onSelect` calling `handle.open()`).
    ctx.mounts.header({
        id: 'openWindow',
        icon: 'AppWindow',
        label: 'WINDOW',
        tooltip: 'Open the example floating window',
        onSelect: () => {
            win.open();
        },
        state: () => ({
            // The host's window store tracks open state; the mod could read
            // it through a subscription, but for this fixture we leave the
            // label static and let the host's chrome speak for itself.
            active: undefined,
        }),
    });
}

export function onDisable() {
    // Host-owned teardown (MOUNTS.md §8.5): the lifecycle host removes every
    // mount the mod registered and closes every window the mod opened. The
    // mod never needs to call `handle.remove()` or `handle.close()` itself
    // — and it must not, because a stale closure after disable is a no-op
    // plus a fault rather than a throw. This hook exists only to log that
    // teardown ran, mirroring the 4.4 fixture.
    console.log('[example-window-mod] disable fired — Phase 4.5 teardown');
}
