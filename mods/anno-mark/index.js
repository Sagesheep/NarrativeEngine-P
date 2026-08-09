// Anno Mark — a per-message annotation mod.
//
// Written against docs only:
//   - docs/narrative-mod-api.d.ts  (the shipped .d.ts)
//   - docs/MODDING.md
//   - Upgrade/EPIC Project - Full Modularity/{API,EVENTS,MOUNTS,MANIFEST}.md
// No file under src/ was read to write this mod.
//
// THE ONE RULE: a mod talks to the `ctx` object handed to it. A mod NEVER
// imports from `src/`.
//
// Surface exercised:
//   - message.below  (MOUNTS.md §2.6) — per-message indicator + mark button
//   - message.actions (MOUNTS.md §2.5) — chrome bookmark button
//   - chat.rail      (MOUNTS.md §2.4) — right-rail panel: marks list + settings
//   - ctx.table      (API.md §6.2)    — own tables: marks, settings
//   - ctx.subscribe  (API.md §6.4)    — live reads on marks / settings / messages
//   - ctx.events     (EVENTS.md)      — campaign.opened (sticky), message.deleted
//   - ctx.macros     (Phase 5.1)      — {{mod.anno-mark.markedContent}} expansion
//
// Design notes / findings are collected in PROGRESS.md.

// ─── Module-scope state ────────────────────────────────────────────────────
// Live host state is kept current by subscriptions set up in `activate`
// (API.md §6.4, MODDING.md "interceptor" guidance: subscribe in activate,
// read the closure elsewhere). The macro resolver reads these closures.

let marks = [];          // rows of the mod's `marks` table
let settings = { maxInject: 3 };  // row of the mod's `settings` table
let messages = [];       // mirror of ctx.data.messages

// Subscription handles — kept so onDisable can be explicit, although the host
// tears them down regardless (MOUNTS.md §8.5).
let unsubs = [];
// Mount handles — kept for handle.update() on subscription wakeups.
let railHandle = null;
let actionsHandle = null;
// Whether a campaign is currently open. table.read/write reject with
// `[facade] no active campaign` when none (API.md §6.5); we guard writes.
let campaignOpen = false;
// Bumping counter so update() can force chrome re-render after a mark toggle.
let markVersion = 0;

// ─── Helpers ───────────────────────────────────────────────────────────────

const MARK_TABLE = 'marks';
const SETTINGS_TABLE = 'settings';

function findMark(sceneIdOrId) {
    return marks.find((m) => m.key === sceneIdOrId);
}

function isMarked(sceneIdOrId) {
    return Boolean(findMark(sceneIdOrId));
}

function pickInjectableMarks() {
    const cap = Number(settings.maxInject);
    const limit = Number.isFinite(cap) && cap > 0 ? cap : 0;
    if (limit === 0) return [];
    return marks.slice(0, limit);
}

function buildMacroText() {
    const picked = pickInjectableMarks();
    if (picked.length === 0) return '';
    const header = `[MARKED CONTENT — ${picked.length} of ${marks.length} marks]`;
    const body = picked.map((m, i) => {
        const tag = m.note ? m.note : '(no note)';
        const who = m.role ? m.role.toUpperCase() : 'MSG';
        return `(${i + 1}) [${who}] ${tag}\n${truncate(m.content, 400)}`;
    });
    return [header, ...body].join('\n\n');
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length <= n ? s : s.slice(0, n) + '…';
}

function deriveKey(message) {
    // Prefer sceneId (durable across sessions per MOUNTS.md §8.4); fall back
    // to message id for messages that never got a scene stamp (user bubbles).
    if (message && message.sceneId) return message.sceneId;
    return message ? message.id : null;
}

function findMessageByKey(key) {
    return messages.find((m) => deriveKey(m) === key);
}

async function persistMarks(ctx) {
    if (!campaignOpen) return;
    try {
        await ctx.table.write(MARK_TABLE, marks);
    } catch (e) {
        ctx.log('failed to write marks:', e instanceof Error ? e.message : String(e));
    }
}

async function persistSettings(ctx) {
    if (!campaignOpen) return;
    try {
        await ctx.table.write(SETTINGS_TABLE, settings);
    } catch (e) {
        ctx.log('failed to write settings:', e instanceof Error ? e.message : String(e));
    }
}

async function loadTables(ctx) {
    if (!campaignOpen) return;
    try {
        const m = await ctx.table.read(MARK_TABLE);
        if (Array.isArray(m)) marks = m;
    } catch (e) {
        ctx.log('marks read failed:', e instanceof Error ? e.message : String(e));
    }
    try {
        const s = await ctx.table.read(SETTINGS_TABLE);
        if (s && typeof s === 'object' && !Array.isArray(s)) {
            settings = { ...settings, ...s };
        }
    } catch (e) {
        ctx.log('settings read failed:', e instanceof Error ? e.message : String(e));
    }
}

// ─── Lifecycle hooks ───────────────────────────────────────────────────────

export function onInstall(ctx) {
    // Seed defaults the first time the mod id is seen (MANIFEST.md §3.1).
    // install never fires again, even after disable/enable. The settings
    // row is a single-object table (MANIFEST.md §9 — settings schema declined;
    // "a single-object table plus a form panel" is the pattern). We write it
    // here, opportunistically, if a campaign is already open.
    if (!ctx) return;
    ctx.log('anno-mark installed');
    void persistSettings(ctx);
}

export async function onActivate(ctx) {
    if (!ctx) {
        // Load cycle fired before any campaign was open (API.md §6.5).
        // Mounts will be registered on a later activate; subscriptions set
        // up now are harmless but table.read/write would reject, so we skip.
        return;
    }

    // Reset state on re-activate (the host fires activate on every load and
    // after a user toggles the mod back on from Extensions).
    unsubs = [];
    railHandle = null;
    actionsHandle = null;
    campaignOpen = ctx.data.campaignId !== null && ctx.data.campaignId !== undefined;
    messages = [...ctx.data.messages];

    // Load own tables (marks + settings) for this campaign.
    await loadTables(ctx);

    // ── Subscriptions: ONE each for the whole mod (MOUNTS.md §8.4, 4.4 §3) ──
    unsubs.push(ctx.subscribe('messages', (m) => {
        messages = Array.isArray(m) ? [...m] : [];
        markVersion++;
        if (actionsHandle) actionsHandle.update();
    }));
    unsubs.push(ctx.subscribe('campaignId', (id) => {
        campaignOpen = id !== null && id !== undefined;
        if (campaignOpen) {
            void loadTables(ctx);
        }
    }));

    // Subscribe to the mod's own `marks` table so a sandboxed compute hook
    // (if this mod ever ships one) or an external write is reflected live
    // (API.md §6.4: "including a change a compute hook made mid-turn — the
    // case the screen API cannot see at all today"). Same for `settings`.
    unsubs.push(ctx.table.subscribe(MARK_TABLE, (rows) => {
        marks = Array.isArray(rows) ? rows : [];
        markVersion++;
        if (actionsHandle) actionsHandle.update();
        if (railHandle) railHandle.update();
    }));
    unsubs.push(ctx.table.subscribe(SETTINGS_TABLE, (rows) => {
        if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
            settings = { ...settings, ...rows };
        }
        if (railHandle) railHandle.update();
    }));

    // ── Events ────────────────────────────────────────────────────────────
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
    // message.deleted → drop marks whose key no longer resolves to a message.
    unsubs.push(ctx.events.on('message.deleted', (p) => {
        const ids = new Set(p.messageIds);
        const before = marks.length;
        marks = marks.filter((m) => {
            const msg = findMessageByKey(m.key);
            if (!msg) return true; // unknown, keep
            return !ids.has(msg.id);
        });
        if (marks.length !== before) void persistMarks(ctx);
    }));

    // ── Macro: {{mod.anno-mark.markedContent}} ────────────────────────────
    // Phase 5.1 (narrative-mod-api.d.ts §Macros). The host qualifies the
    // registered name to mod.<modId>.<name>, so the manifest contribution's
    // `{{mod.anno-mark.markedContent}}` slot expands to our text. Pure and
    // synchronous: runs on the hot path of every turn. Returning '' is the
    // defined "inactive this turn" path.
    unsubs.push(ctx.macros.register('markedContent', () => buildMacroText()));

    // ── Mount: message.actions — chrome bookmark button ───────────────────
    // MOUNTS.md §2.5 / §8.2. Host renders; mod supplies data + callbacks.
    // Per-message identity: the action rail renders one button per row, but
    // the same onSelect closure is shared (example-message-mod confirms this).
    // We can't tell WHICH message was clicked from onSelect alone — recorded
    // as an awkward moment in PROGRESS.md. We use it as a "toggle last
    // assistant message mark" convenience.
    actionsHandle = ctx.mounts.messageAction({
        id: 'bookmark',
        icon: 'Bookmark',
        label: 'Mark',
        tooltip: 'Mark the latest GM message',
        onSelect: () => {
            // Find the latest assistant message with content.
            const last = [...messages].reverse().find(
                (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0,
            );
            if (!last) {
                ctx.log('no assistant message to mark');
                return;
            }
            const key = deriveKey(last);
            if (!key) return;
            toggleMark(ctx, key, last);
        },
        state: () => ({
            // ChromeState (MOUNTS.md §8.2). `active` when any message is
            // marked; `badge` shows the count.
            active: marks.length > 0,
            badge: marks.length > 0 ? marks.length : undefined,
        }),
    });

    // ── Mount: message.below — per-message indicator + mark button ────────
    // MOUNTS.md §2.6 / §8.3. Imperative content into a host-owned node per
    // visible message. Receives MessageRef { id, role, sceneId } (§8.4).
    // Safe to mount twice for the same sceneId (swipe/scene-continue); we
    // re-read messages rather than caching (§8.4).
    ctx.mounts.messageBelow({
        id: 'mark-indicator',
        mount: (node, modCtx, message) => {
            paintBelow(node, modCtx, message);
            const u1 = modCtx.subscribe('messages', () => paintBelow(node, modCtx, message));
            const u2 = modCtx.table.subscribe(MARK_TABLE, () => paintBelow(node, modCtx, message));
            return () => { if (u1) u1(); if (u2) u2(); };
        },
    });

    // ── Mount: chat.rail — right-rail panel: marks list + settings ────────
    // MOUNTS.md §2.4 / §4.2 (tabs, one per mod; no tab strip at one panel).
    // Imperative content into a host-owned dock node. Live data via
    // ctx.subscribe / ctx.table.subscribe.
    railHandle = ctx.mounts.rail({
        id: 'marks-panel',
        title: 'Marks',
        icon: 'Bookmark',
        mount: (node, modCtx) => mountRail(node, modCtx),
    });

    ctx.log('anno-mark activated; marks =', marks.length, 'campaignOpen =', campaignOpen);
}

export function onDisable(ctx) {
    // Host-owned teardown (MOUNTS.md §8.5): the lifecycle host removes every
    // mount, subscription and event listener the mod registered. We tear
    // down defensively anyway; stale closures after disable are no-op + fault.
    for (const u of unsubs) {
        try { if (typeof u === 'function') u(); } catch { /* ignore */ }
    }
    unsubs = [];
    railHandle = null;
    actionsHandle = null;
    if (ctx) ctx.log('anno-mark disabled');
}

// ─── Mark toggle ───────────────────────────────────────────────────────────

function toggleMark(ctx, key, message) {
    const existing = findMark(key);
    if (existing) {
        marks = marks.filter((m) => m.key !== key);
    } else {
        const content = typeof message.content === 'string' ? message.content : '';
        marks = [
            ...marks,
            {
                key,
                messageId: message.id,
                role: message.role,
                sceneId: message.sceneId ?? null,
                content,
                note: '',
                markedAt: Date.now(),
            },
        ];
    }
    void persistMarks(ctx);
    markVersion++;
    if (actionsHandle) actionsHandle.update();
    if (railHandle) railHandle.update();
}

function setNote(ctx, key, note) {
    const idx = marks.findIndex((m) => m.key === key);
    if (idx === -1) return;
    marks = marks.map((m, i) => i === idx ? { ...m, note } : m);
    void persistMarks(ctx);
    if (railHandle) railHandle.update();
}

function removeMark(ctx, key) {
    marks = marks.filter((m) => m.key !== key);
    void persistMarks(ctx);
    markVersion++;
    if (actionsHandle) actionsHandle.update();
    if (railHandle) railHandle.update();
}

async function setMaxInject(ctx, value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;
    settings = { ...settings, maxInject: Math.floor(n) };
    await persistSettings(ctx);
    if (railHandle) railHandle.update();
}

// ─── message.below paint ──────────────────────────────────────────────────

function paintBelow(node, modCtx, message) {
    const key = deriveKey(message);
    const marked = key ? isMarked(key) : false;
    // The indicator + a per-message mark/unmark button.
    node.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'anno-mark-below';
    if (marked) {
        const dot = document.createElement('span');
        dot.className = 'anno-mark-dot';
        dot.textContent = '● MARKED';
        wrap.append(dot);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anno-mark-btn';
    btn.textContent = marked ? 'Unmark' : 'Mark';
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        // Find the current message by key from the live mirror, not the
        // MessageRef we were handed (content may have changed via swipe /
        // continue — MOUNTS.md §8.4 "safe to mount twice for the same
        // sceneId").
        const live = findMessageByKey(key);
        const msg = live || {
            id: message.id,
            role: message.role,
            sceneId: message.sceneId,
            content: '',
        };
        toggleMark(modCtx, key, msg);
    });
    wrap.append(btn);
    node.append(wrap);
}

// ─── chat.rail panel ──────────────────────────────────────────────────────

function mountRail(node, modCtx) {
    const root = document.createElement('div');
    root.className = 'anno-mark-rail';
    node.append(root);

    const paint = () => {
        root.replaceChildren();

        // ── Settings section ─────────────────────────────────────────────
        const settingsBox = document.createElement('div');
        settingsBox.className = 'anno-mark-section';
        const sTitle = document.createElement('div');
        sTitle.className = 'anno-mark-section-title';
        sTitle.textContent = 'Injection';
        settingsBox.append(sTitle);

        const label = document.createElement('label');
        label.className = 'anno-mark-field';
        label.textContent = 'Marks to inject into prompt: ';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '20';
        input.value = String(settings.maxInject);
        input.className = 'anno-mark-input';
        input.addEventListener('change', () => {
            void setMaxInject(modCtx, input.value);
        });
        label.append(input);
        settingsBox.append(label);

        const help = document.createElement('div');
        help.className = 'anno-mark-help';
        help.textContent =
            `Macro {{mod.anno-mark.markedContent}} expands to the first ${settings.maxInject} mark(s). ` +
            `Currently ${marks.length} mark(s) stored.`;
        settingsBox.append(help);

        root.append(settingsBox);

        // ── Marks list ──────────────────────────────────────────────────
        const listTitle = document.createElement('div');
        listTitle.className = 'anno-mark-section-title';
        listTitle.textContent = `Marks (${marks.length})`;
        root.append(listTitle);

        if (marks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'anno-mark-empty';
            empty.textContent = 'No marks yet. Click Mark beneath a message.';
            root.append(empty);
            return;
        }

        for (const m of marks) {
            const row = document.createElement('div');
            row.className = 'anno-mark-row';

            const head = document.createElement('div');
            head.className = 'anno-mark-row-head';
            const who = document.createElement('span');
            who.className = 'anno-mark-role';
            who.textContent = (m.role || 'msg').toUpperCase();
            const scene = document.createElement('span');
            scene.className = 'anno-mark-scene';
            scene.textContent = m.sceneId ? `scene ${m.sceneId.slice(0, 8)}` : '—';
            head.append(who, scene);
            row.append(head);

            const preview = document.createElement('div');
            preview.className = 'anno-mark-preview';
            preview.textContent = truncate(m.content, 120);
            row.append(preview);

            const noteIn = document.createElement('input');
            noteIn.type = 'text';
            noteIn.className = 'anno-mark-note';
            noteIn.placeholder = 'note…';
            noteIn.value = m.note || '';
            noteIn.addEventListener('change', () => {
                setNote(modCtx, m.key, noteIn.value);
            });
            row.append(noteIn);

            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'anno-mark-btn anno-mark-remove';
            rm.textContent = 'Remove';
            rm.addEventListener('click', () => {
                removeMark(modCtx, m.key);
            });
            row.append(rm);

            root.append(row);
        }
    };

    paint();
    const u1 = modCtx.table.subscribe(MARK_TABLE, paint);
    const u2 = modCtx.table.subscribe(SETTINGS_TABLE, paint);
    return () => { if (u1) u1(); if (u2) u2(); };
}