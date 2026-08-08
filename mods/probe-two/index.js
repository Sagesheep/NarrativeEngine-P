// Phase 4.9.3 — the probe-TWO mod.
//
// A SECOND throwaway mod claiming the SAME Phase 4 mount regions as
// `mods/probe/index.js`, to verify the conflict rule in `MOUNTS.md` Decision C
// holds exactly as written when two mods claim one region. THE ONE RULE: a mod
// talks to the `ctx` object handed to it. A mod NEVER imports from `src/`.
// Written against the shipped `docs/narrative-mod-api.d.ts` and `API.md` only.
//
// The five claims this mod makes — the SAME five `mods/probe/` makes, so every
// conflict rule is exercised by the pair:
//   1. A header button (4.2)         → ctx.mounts.header
//   2. A chat rail panel (4.3)       → ctx.mounts.rail
//   3. A message-row action button (4.4)  → ctx.mounts.messageAction
//   4. A content slot beneath every message (4.4) → ctx.mounts.messageBelow
//   5. A floating window opened by the header button (4.5)
//                                    → ctx.mounts.window + WindowHandle.open()
//
// Entry ids are DISTINCT from probe's so the two mods never collide on id
// (MOUNTS.md §4.1 — qualified ids `mod.probe-two.*` vs `mod.probe.*`). Labels
// and icons are distinguishable so a verifier can SEE which mod is which in the
// running app and confirm the order swaps when `loadOrder` is swapped.
//
// `loadOrder` in the manifest is 200; `mods/probe/`'s is 100. Lower runs first,
// so probe's entries sort before probe-two's in every region. The checkpoint's
// item 3 swaps these two values and confirms the visual order swaps with them.
//
// Single shared mutable state for the whole mod, module-scoped. Reset on
// disable so a re-enable starts clean — same discipline as `mods/probe/`.

let state = {
    /** @type {Array<{ id: string, text: string, at: number }>} */
    notes: [],
    turnCount: 0,
    eventLog: [],
    unsub: [],
    win: null,
    headerHandle: null,
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
 * The mod's `activate` hook. Guards the no-campaign case so a cold start does
 * not fault (same guard as `mods/probe/`).
 *
 * @param {import('../../docs/narrative-mod-api').ModContext | undefined} ctx
 */
export function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        return;
    }

    // Three core event subscriptions, mirroring probe so the bus can be seen
    // firing both mods' listeners in load order (4.9.3 item 2 / 4.9.4).
    const sub1 = ctx.events.on('turn.start', (p) => {
        const line = `[probe-two] turn.start turnId=${p.turnId} tier=${p.tier ?? '—'}`;
        state.eventLog.push(line);
        ctx.log(line);
    });
    const sub2 = ctx.events.on('turn.committed', (p) => {
        state.turnCount += 1;
        const line = `[probe-two] turn.committed turnId=${p.turnId ?? '—'} scene=${p.sceneId} (#${state.turnCount})`;
        state.eventLog.push(line);
        ctx.log(line);
    });
    const sub3 = ctx.events.on('archive.sceneAppended', (p) => {
        const line = `[probe-two] archive.sceneAppended scene=${p.sceneId}`;
        state.eventLog.push(line);
        ctx.log(line);
    });
    state.unsub.push(sub1, sub2, sub3);

    // The mod's own table — same shape as probe's so the read/write path is
    // exercised against `mod.probe-two.notes` (namespaced by mod id).
    void ctx.table.read('notes')
        .then((rows) => { state.notes = Array.isArray(rows) ? rows : []; })
        .catch(() => { /* no campaign yet */ });
    const subTable = ctx.table.subscribe('notes', (rows) => {
        state.notes = Array.isArray(rows) ? rows : [];
    });
    state.unsub.push(subTable);

    // ── Claim 5: a floating window opened by the header button (Phase 4.5) ──
    state.win = ctx.mounts.window({
        id: 'probeTwoWindow',
        title: 'Probe-Two — add a note',
        defaultSize: { width: 360, height: 280 },
        minSize: { width: 260, height: 180 },
        resizable: true,
        mount: (node, modCtx) => paintWindow(node, modCtx),
    });

    // ── Claim 1: a header button that opens the window (Phase 4.2) ──────────
    // `tone: 'warn'` distinguishes probe-two's button from probe's `active`
    // tone visually, so a verifier can tell the two mod buttons apart in the
    // header and confirm their order.
    state.headerHandle = ctx.mounts.header({
        id: 'openProbeTwoWindow',
        icon: 'TestTube',
        label: 'PROBE-2',
        tooltip: 'Open the Phase 4.9.3 probe-TWO window',
        onSelect: () => {
            if (state.win) state.win.open();
        },
        state: () => ({
            tone: 'warn',
        }),
    });

    // ── Claim 2: a chat rail panel (Phase 4.3) ──────────────────────────────
    // With probe also claiming `chat.rail`, the host renders a TAB STRIP
    // (MOUNTS.md §4.2 — one tab per panel, NOT first-wins). Tab order is
    // `(loadIndex, withinModIndex)`; probe's loadOrder 100 < probe-two's 200,
    // so probe's tab is first. Swapping the two loadOrders swaps the tab order.
    ctx.mounts.rail({
        id: 'probeTwoRail',
        title: 'Probe-Two',
        icon: 'TestTube',
        mount: (node, modCtx) => paintRail(node, modCtx),
    });

    // ── Claim 3a: a message-row action button on every message (Phase 4.4) ──
    state.actionHandle = ctx.mounts.messageAction({
        id: 'probeTwoAction',
        icon: 'Bookmark',
        label: 'Probe-2',
        tooltip: 'Probe-Two: log this message',
        onSelect: () => {
            ctx.log('[probe-two] message.actions onSelect fired');
        },
        state: () => ({
            tone: state.notes.length > 0 ? 'warn' : 'default',
        }),
    });

    // ── Claim 3b: a content slot beneath every message (Phase 4.4) ──────────
    // With probe also claiming `message.below`, the host STACKS the two slots
    // in load order (MOUNTS.md §4.3 — stack, NOT tabs). probe's slot is above
    // probe-two's because probe's loadIndex is lower.
    ctx.mounts.messageBelow({
        id: 'probeTwoBelow',
        mount: (node, modCtx, message) => paintBelow(node, modCtx, message),
    });
}

export function onDisable() {
    for (const u of state.unsub) {
        try { if (typeof u === 'function') u(); } catch { /* already revoked */ }
    }
    reset();
    console.log('[probe-two] disable fired — Phase 4.9.3 teardown');
}

// ─────────────────────────────────────────────────────────────────────────────
// Painters. Styled entirely from theme tokens (MOUNTS.md §6.1): chrome entries
// use `tone`; content mounts use `inherit` / `currentColor` + the app's CSS
// custom properties, inherited in-page. No hardcoded colours.
// ─────────────────────────────────────────────────────────────────────────────

function paintWindow(node, modCtx) {
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
    heading.textContent = 'Add a note to mod.probe-two.notes';
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

    const subNotes = modCtx.table.subscribe('notes', () => renderList());

    const onAdd = async () => {
        const text = (input.value || '').trim();
        if (!text) return;
        addBtn.disabled = true;
        try {
            const rows = await modCtx.table.read('notes');
            const list2 = Array.isArray(rows) ? rows : [];
            const note = { id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                           text, at: Date.now() };
            await modCtx.table.write('notes', [...list2, note]);
            input.value = '';
        } catch (err) {
            modCtx.log('[probe-two] window write failed:', err instanceof Error ? err.message : String(err));
            status.textContent = 'write failed — see console';
        } finally {
            addBtn.disabled = false;
        }
    };
    addBtn.addEventListener('click', onAdd);

    node.append(shell);

    return () => {
        addBtn.removeEventListener('click', onAdd);
        try { subNotes(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}

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
    title.textContent = 'Probe-TWO rail';
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
        notesLine.textContent = `notes in mod.probe-two.notes: ${state.notes.length}`;
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

    const unsubscribe = modCtx.subscribe('messages', paint);

    node.append(shell);
    return () => {
        try { if (unsubscribe) unsubscribe(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}

function paintBelow(node, modCtx, message) {
    const paint = () => {
        const msgs = modCtx.data.messages;
        const row = msgs.find((m) => m.id === message.id);
        const len = row && typeof row.content === 'string' ? row.content.length : 0;
        const line = `[probe-two] ${message.role} · scene ${message.sceneId ?? '—'} · ${len} chars · id ${message.id.slice(0, 8)} · turns=${state.turnCount}`;
        node.textContent = line;
    };
    paint();
    const unsubscribe = modCtx.subscribe('messages', paint);
    return () => {
        try { if (unsubscribe) unsubscribe(); } catch { /* already revoked */ }
        node.replaceChildren();
    };
}
