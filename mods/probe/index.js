// Phase 4.9.2 — the probe mod.
//
// One throwaway mod that claims EVERY Phase 4 mount point at once, to prove they
// compose rather than interfere. THE ONE RULE: a mod talks to the `ctx` object
// handed to it. A mod NEVER imports from `src/`. Written against the shipped
// `docs/narrative-mod-api.d.ts` and `Upgrade/.../API.md` only — reading `src/`
// to write the probe would itself be the finding this checkpoint exists to surface.
//
// The seven claims this mod makes simultaneously:
//   1. A header button (Phase 4.2)  → ctx.mounts.header
//   2. A chat rail panel showing a live host value that changes each turn
//      (4.3 + 2.4)                  → ctx.mounts.rail + ctx.subscribe('messages')
//   3. A message-row action button AND a content slot on every message (4.4)
//                                    → ctx.mounts.messageAction + ctx.mounts.messageBelow
//   4. A floating window opened by the header button (4.5)
//                                    → ctx.mounts.window + WindowHandle.open()
//   5. Subscriptions to three core events, logging each (3.2/3.3)
//                                    → ctx.events.on('turn.start' | 'turn.committed' | 'archive.sceneAppended')
//   6. Its own table, written from the window and read by the rail panel
//                                    → ctx.table.read('notes') / ctx.table.write('notes', …)
//   7. Styled entirely from theme tokens (4.6)
//                                    → chrome entries use `tone`; content mounts use
//                                      `inherit`/`currentColor` + the CSS custom properties
//                                      MOUNTS.md §6.1 promises they inherit in-page.
//
// Single shared mutable state for the whole mod, module-scoped so every mount
// and every subscription sees the same values. Re-enable must NOT double-register:
// the host tears down everything on disable (MOUNTS.md §8.5), and `activate` on
// re-enable rebuilds from a fresh closure — so we reset on disable and rebuild
// on activate. The three event subscriptions are stored here so disable can
// revoke them if the host ever delegated teardown to the mod (it does not, but
// the discipline matches example-message-mod and is the safe posture).

/**
 * Module-scoped mod state. One object, shared by every mount and subscription.
 * Reset on disable so a re-enable starts clean — no double-registration, no
 * stale closures over a revoked lease.
 */
let state = {
    /** @type {Array<{ id: string, text: string, at: number }>} */
    notes: [],
    /** Incremented by the `turn.committed` subscription — the "live host value
     *  that changes each turn" the rail panel displays. */
    turnCount: 0,
    /** Incremented by each of the three core event subscriptions. */
    eventLog: [],
    /** Unsubscribers for the three core event subscriptions + the data
     *  subscription. The host revokes all of these on disable (MOUNTS.md §8.5),
     *  but we hold them so a manual disable path could revoke too. */
    unsub: [],
    /** The WindowHandle returned by `ctx.mounts.window`. The header button's
     *  `onSelect` calls `win.open()`. */
    win: null,
    /** The MountHandle for the header button, so a window-open state could
     *  re-render it (`handle.update()`). */
    headerHandle: null,
    /** The MountHandle for the messageAction entry. */
    actionHandle: null,
};

function reset() {
    state = {
        notes: [],
        turnCount: 0,
        eventLog: [],
        unsub: [],
        win: null,
        headerHandle: null,
        actionHandle: null,
    };
}

/**
 * The mod's `activate` hook. Receives the `ModContext` (or `undefined` when
 * fired from the load cycle before any campaign is open — API.md §6.5). Guards
 * the no-campaign case so a cold start does not fault: mount registration needs
 * no campaign data, but `ctx.table.read`/`write` reject with no campaign, so
 * the table-backed claims are only exercised once a campaign is open.
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        // No context (load before a campaign) or no mounts API (sandbox tier —
        // MOUNTS.md §8.1, mount registration is native-only). Nothing to do.
        return;
    }

    // ── Claim 5: three core event subscriptions (Phase 3.2/3.3) ──────────
    //
    // `ctx.events.on` returns an unsubscribe (narrative-mod-api.d.ts §ModEventsApi).
    // The three events are chosen to span the canonical turn lifecycle:
    //   turn.start           — the user's input is locked in
    //   turn.committed       — the GM's reply is durably saved
    //   archive.sceneAppended — a scene was appended to the archive
    // Each listener logs the payload through `ctx.log` (prefixed with the mod
    // id by the host — API.md §6.3) and appends a one-line record to
    // `state.eventLog`, which the rail panel surfaces so a verifier can SEE the
    // events firing in order across the three turns.
    //
    // Fault containment (EVENTS.md §4.3): a throwing listener is contained by
    // the bus as a fault naming the mod. The probe does not throw.
    const sub1 = ctx.events.on('turn.start', (p) => {
        const line = `turn.start turnId=${p.turnId} tier=${p.tier ?? '—'} input=${(p.playerInput || '').slice(0, 30)}`;
        state.eventLog.push(line);
        ctx.log('[probe] ' + line);
    });
    const sub2 = ctx.events.on('turn.committed', (p) => {
        state.turnCount += 1;
        const line = `turn.committed turnId=${p.turnId ?? '—'} scene=${p.sceneId} (#${state.turnCount})`;
        state.eventLog.push(line);
        ctx.log('[probe] ' + line);
    });
    const sub3 = ctx.events.on('archive.sceneAppended', (p) => {
        const line = `archive.sceneAppended scene=${p.sceneId} msg=${p.messageId ?? '—'}`;
        state.eventLog.push(line);
        ctx.log('[probe] ' + line);
    });
    state.unsub.push(sub1, sub2, sub3);

    // ── Claim 6: the mod's own table, read here and written from the window ─
    //
    // `ctx.table.read('notes')` resolves to `mod.probe.notes` because the
    // object knows which mod it belongs to (API.md §6.2). Promise-returning in
    // both bindings (§1.2). On a cold start (campaignId === null) this rejects
    // with `[facade] no active campaign` — we catch and proceed with `[]`, so
    // the rail panel renders "no notes yet" rather than faulting. The window's
    // write path (claim 6 write half) is also guarded.
    void ctx.table.read('notes')
        .then((rows) => { state.notes = Array.isArray(rows) ? rows : []; })
        .catch(() => { /* no campaign yet — table not readable */ });

    // Subscribe to the mod's OWN table so the rail panel re-paints when the
    // window writes a note (Phase 2.4 — `ctx.table.subscribe`). This is the
    // cross-mount live-update path: window writes → table.subscribe → rail
    // re-paints. ONE subscription for the whole mod.
    const subTable = ctx.table.subscribe('notes', (rows) => {
        state.notes = Array.isArray(rows) ? rows : [];
    });
    state.unsub.push(subTable);

    // ── Claim 4: a floating window opened by the header button (Phase 4.5) ──
    //
    // Declared once, opened many times (MOUNTS.md §8.3). The host owns the
    // chrome (title bar, drag, resize, z-order, focus, close, minimize, bounds
    // clamp); the mod owns the interior node. `WindowHandle.open()` makes it
    // appear — called from the header button's `onSelect` (claim 1 + 4 wired
    // together, exactly the enemy-compendium shape of MOUNTS.md §11.3).
    //
    // The interior lets the user add a note to the mod's own table (claim 6,
    // write half). It reads the current note list from `state.notes` (kept live
    // by the table subscription above) and writes via `ctx.table.write`.
    state.win = ctx.mounts.window({
        id: 'probeWindow',
        title: 'Probe — add a note',
        defaultSize: { width: 380, height: 320 },
        minSize: { width: 280, height: 200 },
        resizable: true,
        mount: (node, modCtx) => paintWindow(node, modCtx),
    });

    // ── Claim 1: a header button that opens the window (Phase 4.2) ─────────
    //
    // Declared chrome — the host renders the button in the header's style. The
    // `tone: 'active'` is mapped to host tokens by the host (MOUNTS.md §6.1 —
    // "A chrome entry may not specify a colour. It may specify a `tone` from a
    // closed set, which the host maps to its own tokens."). That is the whole
    // of "styled from theme tokens" for a chrome entry.
    state.headerHandle = ctx.mounts.header({
        id: 'openProbeWindow',
        icon: 'FlaskConical',
        label: 'PROBE',
        tooltip: 'Open the Phase 4.9.2 probe window',
        onSelect: () => {
            // The host drains a pending commit before dispatching in
            // chat-scoped regions (MOUNTS.md §8.8). `header.actions` is NOT
            // chat-scoped (§8.8 excludes it), so no drain here — the header is
            // the right place for a window opener.
            if (state.win) state.win.open();
        },
        state: () => ({
            // `tone` is the only colour affordance on a chrome entry; the host
            // maps it to tokens. A static `active` tone proves the mapping.
            tone: 'active',
        }),
    });

    // ── Claim 2: a chat rail panel showing a live host value (Phase 4.3) ────
    //
    // Imperative content — the host hands a stable DOM node, the mod fills it.
    // The "live host value that changes each turn" is `state.turnCount`,
    // incremented by the `turn.committed` subscription (claim 5). The panel
    // also shows the latest three event-log lines, so a verifier can SEE the
    // three events firing in order across the three turns. And it shows the
    // note count from the mod's own table (claim 6, read half) — so the rail
    // and the window are coupled through the table.
    //
    // Live updates: ONE `ctx.subscribe('messages', …)` subscription for the
    // whole mod (Phase 2.4). The rail re-paints on every `messages` change,
    // which happens every turn. `paint` is cheap (a few textContent sets).
    ctx.mounts.rail({
        id: 'probeRail',
        title: 'Probe',
        icon: 'FlaskConical',
        mount: (node, modCtx) => paintRail(node, modCtx),
    });

    // ── Claim 3a: a message-row action button on every message (Phase 4.4) ──
    //
    // Declared chrome. The host renders one button per visible message in the
    // message action rail (MOUNTS.md §2.5). `onSelect` is shared across rows;
    // a real mod tracks the hovered message, but for the probe we log and let
    // the verifier observe the button is native. `state()` returns `active`
    // when at least one note exists, proving `state()` is re-read on render.
    state.actionHandle = ctx.mounts.messageAction({
        id: 'probeAction',
        icon: 'Bookmark',
        label: 'Probe',
        tooltip: 'Probe: log this message',
        onSelect: () => {
            ctx.log('[probe] message.actions onSelect fired');
        },
        state: () => ({
            tone: state.notes.length > 0 ? 'active' : 'default',
        }),
    });

    // ── Claim 3b: a content slot beneath every message (Phase 4.4) ──────────
    //
    // Imperative content. The host hands the mod a DOM node per visible
    // message; the mod fills it. `mount` receives the `MessageRef` (id, role,
    // sceneId) so the mod can act on that specific message (MOUNTS.md §8.4).
    // ONE subscription for the whole mod — not one per row — drives live
    // updates (4.4 §3: "if every message row opens its own subscription, a
    // 500-message chat opens 500. Design against that explicitly").
    //
    // The slot must be safe to mount twice for the same sceneId (MOUNTS.md
    // §8.4): a swipe or scene-continue that replaces the body re-runs the
    // mount, and the mod re-reads `ctx.data.messages` rather than caching. The
    // probe re-reads on every paint, so it is.
    ctx.mounts.messageBelow({
        id: 'probeBelow',
        mount: (node, modCtx, message) => paintBelow(node, modCtx, message),
    });
}

export function onDisable() {
    // Host-owned teardown (MOUNTS.md §8.5): the lifecycle host removes every
    // mount the mod registered, closes every window the mod opened, disposes
    // every subscription the mod opened, and disposes every event listener the
    // mod registered. The mod never needs to call `handle.remove()`,
    // `unsubscribe()`, or `win.close()` itself — and it must not, because a
    // stale closure after disable is a no-op plus a fault rather than a throw.
    //
    // We DO defensively revoke the event subscriptions we held, in case a
    // future host path delegates teardown to the mod. Idempotent: calling an
    // unsubscribe twice is a no-op. Then reset, so a re-enable rebuilds from
    // a clean closure — no double-registration, no stale state.
    for (const u of state.unsub) {
        try { if (typeof u === 'function') u(); } catch { /* already revoked */ }
    }
    reset();
    console.log('[probe] disable fired — Phase 4.9.2 teardown');
}

// ─────────────────────────────────────────────────────────────────────────────
// Painters. Each is the mod's `mount(node, ctx)` for one content region.
// Styled entirely from theme tokens (claim 7): chrome entries use `tone`
// (mapped by the host); content mounts use `inherit` / `currentColor` and the
// app's CSS custom properties, which MOUNTS.md §6.1 promises they inherit
// in-page. No hardcoded colours — that would drift from the host's chrome and
// is exactly the failure 4.6 exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paint the floating window's interior. Lets the user add a note to the mod's
 * own table (claim 6, write half) and lists the notes already there (kept live
 * by the `ctx.table.subscribe('notes', …)` registered in `activate`).
 *
 * @param {HTMLElement} node
 * @param {import('../../docs/narrative-mod-api').ModContext} modCtx
 */
function paintWindow(node, modCtx) {
    // `inherit` keeps the window's interior in the app's font family/size/colour
    // — the same tokens host chrome uses, inherited because the window is in-page
    // (MOUNTS.md §6). No hardcoded colour.
    const shell = document.createElement('div');
    shell.style.padding = '10px';
    shell.style.fontFamily = 'inherit';
    shell.style.fontSize = 'inherit';
    shell.style.color = 'inherit';
    shell.style.display = 'flex';
    shell.style.flexDirection = 'column';
    shell.style.gap = '8px';
    shell.style.height = '100%';
    shell.style.boxSizing = 'border-box';

    const heading = document.createElement('div');
    heading.style.fontWeight = '600';
    heading.textContent = 'Add a note to mod.probe.notes';
    shell.append(heading);

    const input = document.createElement('textarea');
    input.rows = 2;
    input.placeholder = 'Type a note and press Add…';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.background = 'transparent';
    input.style.color = 'inherit';
    input.style.border = '1px solid currentColor';
    input.style.borderRadius = '4px';
    input.style.padding = '6px';
    input.style.fontFamily = 'inherit';
    input.style.fontSize = 'inherit';
    shell.append(input);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add note';
    addBtn.style.alignSelf = 'flex-start';
    addBtn.style.color = 'inherit';
    addBtn.style.fontFamily = 'inherit';
    addBtn.style.fontSize = 'inherit';
    // `currentColor` + `inherit` keep the button on-token. The host's chrome
    // buttons carry their own background; this is a mod-owned interior button,
    // so it stays transparent and inherits.
    addBtn.style.background = 'transparent';
    addBtn.style.border = '1px solid currentColor';
    addBtn.style.borderRadius = '4px';
    addBtn.style.padding = '4px 10px';
    addBtn.style.cursor = 'pointer';
    shell.append(addBtn);

    const list = document.createElement('div');
    list.style.flex = '1';
    list.style.overflow = 'auto';
    list.style.fontSize = '0.9em';
    list.style.opacity = '0.9';
    shell.append(list);

    const status = document.createElement('div');
    status.style.fontSize = '0.8em';
    status.style.opacity = '0.7';
    shell.append(status);

    const renderList = () => {
        if (state.notes.length === 0) {
            list.replaceChildren(document.createTextNode('(no notes yet — add one above)'));
        } else {
            const items = state.notes.slice(-8).map((n) => {
                const row = document.createElement('div');
                row.textContent = `• ${n.text ?? '(empty)'}  [${new Date(n.at ?? 0).toLocaleTimeString()}]`;
                return row;
            });
            list.replaceChildren(...items);
        }
        status.textContent = `${state.notes.length} note(s) · ${state.turnCount} turn(s) committed`;
    };
    renderList();

    // The table subscription registered in `activate` updates `state.notes`,
    // but the window was opened before that subscription's next tick in some
    // orderings. Subscribe locally too so the window re-renders on a write.
    // ONE local subscription per window-open; the returned teardown is called
    // when the host unmounts the window (MOUNTS.md §7 consequence 2).
    const subNotes = modCtx.table.subscribe('notes', () => renderList());

    const onAdd = async () => {
        const text = (input.value || '').trim();
        if (!text) return;
        addBtn.disabled = true;
        try {
            // Read-modify-write the mod's own table. The bare name resolves to
            // `mod.probe.notes` (API.md §6.2). `commitPoint` is 'immediate' on
            // the native lease, so a subsequent `table.read` sees the new value.
            const rows = await modCtx.table.read('notes');
            const list2 = Array.isArray(rows) ? rows : [];
            const note = { id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                           text, at: Date.now() };
            await modCtx.table.write('notes', [...list2, note]);
            input.value = '';
        } catch (err) {
            modCtx.log('[probe] window write failed:', err instanceof Error ? err.message : String(err));
            status.textContent = 'write failed — see console';
        } finally {
            addBtn.disabled = false;
        }
    };
    addBtn.addEventListener('click', onAdd);

    node.append(shell);

    // Teardown (MOUNTS.md §7 consequence 2): the host discards the node
    // regardless; we revoke the local subscription first, best-effort.
    return () => {
        addBtn.removeEventListener('click', onAdd);
        try { subNotes(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}

/**
 * Paint the chat rail panel. Shows the live "turns committed" count (the host
 * value that changes each turn — claim 2 + 2.4), the last three event-log lines
 * (so the three core events are visible firing in order), and the note count
 * from the mod's own table (claim 6, read half — coupled to the window).
 *
 * @param {HTMLElement} node
 * @param {import('../../docs/narrative-mod-api').ModContext} modCtx
 */
function paintRail(node, modCtx) {
    const shell = document.createElement('div');
    shell.style.padding = '10px';
    shell.style.fontFamily = 'inherit';
    shell.style.fontSize = 'inherit';
    shell.style.color = 'inherit';
    shell.style.display = 'flex';
    shell.style.flexDirection = 'column';
    shell.style.gap = '10px';
    shell.style.height = '100%';
    shell.style.boxSizing = 'border-box';
    shell.style.overflow = 'auto';

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = 'Probe rail';
    shell.append(title);

    const turnBox = document.createElement('div');
    turnBox.style.fontSize = '1.4em';
    turnBox.style.fontWeight = '700';
    shell.append(turnBox);

    const sub = document.createElement('div');
    sub.style.opacity = '0.7';
    sub.style.fontSize = '0.85em';
    sub.textContent = 'turns committed (live)';
    shell.append(sub);

    const notesLine = document.createElement('div');
    notesLine.style.fontSize = '0.9em';
    shell.append(notesLine);

    const eventsHeading = document.createElement('div');
    eventsHeading.style.fontWeight = '600';
    eventsHeading.style.marginTop = '6px';
    eventsHeading.textContent = 'Recent core events';
    shell.append(eventsHeading);

    const eventsList = document.createElement('div');
    eventsList.style.fontSize = '0.8em';
    eventsList.style.opacity = '0.85';
    eventsList.style.display = 'flex';
    eventsList.style.flexDirection = 'column';
    eventsList.style.gap = '2px';
    shell.append(eventsList);

    const paint = () => {
        turnBox.textContent = String(state.turnCount);
        notesLine.textContent = `notes in mod.probe.notes: ${state.notes.length}`;
        const last = state.eventLog.slice(-3);
        eventsList.replaceChildren(
            ...(last.length > 0
                ? last.map((line) => {
                      const d = document.createElement('div');
                      d.textContent = line;
                      return d;
                  })
                : [document.createTextNode('(no events yet — take a turn)')]),
        );
    };
    paint();

    // ONE subscription for the whole mod, on `messages` — the host value that
    // changes each turn (4.3 + 2.4). The rail re-paints on every `messages`
    // change, which is every turn. `paint` is cheap. The event-log lines are
    // already in `state.eventLog` (kept by the three event subscriptions), so
    // the `messages` wakeup is the re-render trigger, not the data source.
    const unsubscribe = modCtx.subscribe('messages', paint);

    node.append(shell);
    return () => {
        try { if (unsubscribe) unsubscribe(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}

/**
 * Paint the content slot beneath a single message. Shows the message's role,
 * sceneId, and a probe tag — enough to prove the imperative mount +
 * `MessageRef` path works, and that the slot survives a swipe/edit (the host
 * re-runs `mount` on a body replacement, and the mod re-reads rather than
 * caching — MOUNTS.md §8.4).
 *
 * @param {HTMLElement} node
 * @param {import('../../docs/narrative-mod-api').ModContext} modCtx
 * @param {import('../../docs/narrative-mod-api').MessageRef} message
 */
function paintBelow(node, modCtx, message) {
    const paint = () => {
        const msgs = modCtx.data.messages;
        const row = msgs.find((m) => m.id === message.id);
        const len = row && typeof row.content === 'string' ? row.content.length : 0;
        const line = `[probe] ${message.role} · scene ${message.sceneId ?? '—'} · ${len} chars · id ${message.id.slice(0, 8)} · turns=${state.turnCount}`;
        node.textContent = line;
    };
    paint();
    // ONE subscription for the whole mod, not one per row (4.4 §3). The slot
    // re-paints on every `messages` change; `paint` is a find-by-id + a
    // textContent set, so cheap enough to run per-visible-row on a turn.
    const unsubscribe = modCtx.subscribe('messages', paint);
    return () => {
        try { if (unsubscribe) unsubscribe(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}
