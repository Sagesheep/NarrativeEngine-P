/**
 * Phase 4.2 — the generic chrome renderer for a mod's header/composer entry.
 *
 * `MOUNTS.md` §8.2: a mod entry always renders through the generic chrome
 * renderer; a built-in may carry its own bespoke renderer. This keeps the
 * zero-mod pixel-identity rule winnable — eleven bespoke buttons keep their
 * exact markup — while a mod's button is visually native (§1: "a mod's
 * header button looks exactly like yours because it is yours").
 *
 * The renderer reads `state()` on every render (re-rendered by the row's
 * `subscribeToRegion` listener). It maps `ChromeState` to the host's
 * classes: `active` → filled border, `disabled` → greyed, `hidden` →
 * removed, `busy` → spun icon, `badge` → count pill, `tone` → host tokens.
 *
 * Header and composer rows differ in visual contract (MOUNTS.md §2.3), so
 * there are two renderers — one per row. They share the `ChromeState`
 * mapping; the classes differ.
 */
import type { ReactNode } from 'react';
import type { ChromeState, MessageRef } from './mountTypes';
import { resolveMountIcon } from './mountIcons';
import type { RegisteredChromeEntry } from './mountRegistry';

/**
 * The `t`-shaped function the renderers accept. Loose on purpose: a mod's
 * i18n key (`mod.<modId>.<key>`) is not in the host's `TranslationKey`
 * union, so the renderer accepts any string and the host's `t` is cast to
 * this shape at the call site. The host's `t` falls back key-as-last-resort,
 * so an unknown mod key renders something visible rather than empty.
 */
type ModT = (key: string, vars?: Record<string, string | number>) => string;

/** The i18n key prefix for a mod's namespace: `mod.<modId>.<key>`. */
function modKey(modId: string, key: string): string {
    return `mod.${modId}.${key}`;
}

/**
 * Resolve a label/tooltip through the host's i18n lookup in the mod's
 * namespace. A literal string misses the lookup and renders as itself
 * (`MANIFEST.md` §5 / `MOUNTS.md` §8.2 — no new mechanism).
 *
 * The lookup is attempted first, so a mod that ships translations gets them by
 * writing a key. When the key is not in the bundle, the host's `t` returns the
 * KEY ITSELF as its last-resort fallback — which is a sensible default for the
 * app's own strings (a missing `header.backup.label` is a bug worth seeing) and
 * exactly wrong here, because a mod passing a literal is the SUPPORTED case, not
 * a mistake. Without the miss check below, `label: 'WINDOW'` renders as
 * `mod.example-window-mod.WINDOW`, uppercased by the header's own styling into
 * `MOD.EXAMPLE-WINDOW-MOD.WINDOW`. That is what shipped before this branch
 * existed: the comment described it, the code never did it.
 *
 * Detecting the miss by comparing against the key we passed in — rather than
 * guessing from the shape of `value` (spaces, dots, casing) — means a mod is
 * never punished for choosing a label that happens to look like a key, and a
 * one-word label like `WINDOW` still resolves when a translation for it exists.
 */
export function resolveModText(modId: string, value: string | undefined, t: ModT): string | undefined {
    if (value === undefined) return undefined;
    const key = modKey(modId, value);
    const translated = t(key, {});
    // `t` returned the key unchanged: nothing in the bundle matched, so `value`
    // was a literal all along. Render the author's own words.
    return translated === key ? value : translated;
}

/**
 * Read `state()` safely; a throw renders the entry from its last good state
 * (MOUNTS.md §8.6).
 *
 * Phase 9.2 — `message` is forwarded to `state()` for `message.actions`, so a
 * row's button can be `active` because THAT row qualifies. `undefined` for the
 * two mod-scoped rows, which are not message-scoped.
 */
function readStateSafe(
    entry: RegisteredChromeEntry,
    lastGood: ChromeState | undefined,
    message?: MessageRef,
): { state: ChromeState | undefined; threw: boolean } {
    if (!entry.entry.state) return { state: undefined, threw: false };
    try {
        return { state: entry.entry.state(message), threw: false };
    } catch {
        return { state: lastGood, threw: true };
    }
}

/**
 * Resolve a fresh `ModContext` for a click. The context captured at
 * registration (`entry.context`) is a snapshot from activate time — if the
 * mod activated at app load (no active campaign), that snapshot's `table`
 * and `data` read empty forever, so a click silently no-ops (the Arc
 * Engine's `onSelect` finds no anchor and returns). `ModContext` exposes
 * `refresh()` (API.md §6.3) which rebuilds from the live store; calling it
 * here honors the "live ModContext" contract `mountTypes.ts` documents for
 * `onSelect`.
 *
 * Returns the refreshed context as a Promise when `refresh` is present
 * (production), or the captured context synchronously when it is absent
 * (tests inject a bare sentinel object). The call sites branch on the
 * return shape so a no-`refresh` context keeps synchronous dispatch —
 * `phase92ChromeIdentity.test.tsx` asserts that the registered object is
 * delivered to `onSelect` before the click handler returns.
 */
function resolveFreshContext(entry: RegisteredChromeEntry): unknown | Promise<unknown> {
    const ctx = entry.context as { refresh?: () => Promise<unknown> } | undefined;
    if (ctx && typeof ctx.refresh === 'function') {
        try {
            return ctx.refresh().catch(() => ctx);
        } catch {
            return ctx;
        }
    }
    return ctx;
}

/**
 * Dispatch `onSelect` with a context resolved by `resolveFreshContext`, after
 * an optional §8.8 pending-commit drain.
 *
 * The drain runs BEFORE the refresh, not after. That ordering is the whole
 * point of §8.8: the drain writes the committed turn into `archiveIndex` /
 * `chapters` / the NPC ledger, and a context refreshed ahead of it is a
 * snapshot of the state the commit was about to replace. The Arc Engine is the
 * worked example — injecting straight after a swipe would read the previous
 * scene as `bornScene` and the previous chapter as `worldContext`.
 *
 * Synchronous when there is no drain and the context has no `refresh`
 * (preserves the identity contract and the test that asserts synchronous
 * delivery); async otherwise (production — the click handler has no
 * synchronous requirement). Errors are contained either way.
 */
function dispatchOnSelect(
    entry: RegisteredChromeEntry,
    message?: MessageRef,
    drain?: () => Promise<void>,
): void {
    if (drain) {
        drain()
            .then(() => dispatchResolved(entry, message))
            .catch(() => { /* the drain already warned */ });
        return;
    }
    dispatchResolved(entry, message);
}

/** Resolve the live context and hand it to `onSelect`. See `dispatchOnSelect`. */
function dispatchResolved(entry: RegisteredChromeEntry, message?: MessageRef): void {
    const fresh = resolveFreshContext(entry);
    if (fresh instanceof Promise) {
        fresh
            .then((ctx) => entry.entry.onSelect(ctx, message))
            .catch(() => { /* a mod onSelect fault is contained by the lifecycle host */ });
    } else {
        Promise.resolve(entry.entry.onSelect(fresh, message))
            .catch(() => { /* a mod onSelect fault is contained by the lifecycle host */ });
    }
}

/** The header's button classes. Matches `Header.tsx`'s built-in classes exactly. */
const HEADER_BASE = 'chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono';
const HEADER_INACTIVE = 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal';
const HEADER_ACTIVE = 'border-terminal text-terminal bg-terminal/5';
const HEADER_EXIT = 'border-border/40 hover:border-ember bg-void-lighter hover:bg-ember/5 text-text-dim hover:text-ember';

/** Map a `ChromeState` to the header button's classes. */
function headerClasses(state: ChromeState | undefined, isExitTone: boolean): string {
    if (state?.disabled) return `${HEADER_BASE} ${HEADER_INACTIVE} opacity-50 cursor-not-allowed`;
    if (state?.active) return `${HEADER_BASE} ${HEADER_ACTIVE}`;
    if (isExitTone) return `${HEADER_BASE} ${HEADER_EXIT}`;
    return `${HEADER_BASE} ${HEADER_INACTIVE}`;
}

/**
 * Render a mod's header entry. Returns `null` when `state().hidden`. The
 * caller (`HeaderActions`) keys on the qualified id and renders this for
 * every entry whose `renderer === 'generic'`.
 */
export function renderHeaderModEntry(
    entry: RegisteredChromeEntry,
    t: ModT,
    lastGoodRef: { current: ChromeState | undefined },
): ReactNode | null {
    const { state, threw } = readStateSafe(entry, lastGoodRef.current);
    if (threw) {
        // A `state()` that throws renders from its last good state and faults
        // once per entry per session (MOUNTS.md §8.6). The fault is recorded
        // by the registry's `state()` wrapper in a future refinement; for
        // now, render from last good and carry on.
    }
    if (state) lastGoodRef.current = state;
    if (state?.hidden) return null;

    const mod = entry.mod;
    if (!mod) return null; // built-ins render through their bespoke renderer, not here

    const iconName = state?.icon ?? entry.entry.icon;
    const { icon: Icon } = resolveMountIcon(iconName);
    const label = resolveModText(mod.id, state?.label ?? entry.entry.label, t);
    const tooltip = resolveModText(mod.id, state?.tooltip ?? entry.entry.tooltip, t);
    const isDanger = state?.tone === 'danger';
    const classes = headerClasses(state, isDanger);

    const handleClick = () => {
        // The header is not chat-scoped, so no §8.8 pending-commit drain.
        // Phase 9.2 — refresh the mod's live context so a click sees current
        // store state, not the snapshot captured at activate time.
        dispatchOnSelect(entry);
    };

    return (
        <button
            key={entry.qualifiedId}
            onClick={handleClick}
            disabled={state?.disabled}
            title={tooltip}
            aria-label={tooltip ?? label}
            className={classes}
        >
            <Icon size={13} className={state?.busy ? 'animate-spin' : ''} />
            {label ? <span className="hidden sm:inline">{label}</span> : null}
            {state?.badge !== undefined && state.badge !== null && state.badge !== '' ? (
                <span className="min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                    {state.badge}
                </span>
            ) : null}
        </button>
    );
}

/**
 * Render a mod's header entry as a MENU ROW rather than a toolbar button, for
 * the header's overflow list. Returns `null` when `state().hidden`, same as the
 * inline renderer.
 *
 * Why a second renderer instead of reusing the button: the toolbar button is
 * icon-first, label-optional (`hidden sm:inline`), and sized for a 32px row. In
 * a vertical menu the label is the primary affordance and must always render —
 * an overflow list of unlabelled icons is worse than the overflow it replaced.
 * The `ChromeState` mapping is shared; only the presentation differs, which is
 * the same split the header/composer renderers already make (MOUNTS.md §2.3).
 *
 * `state.active` shows as a left accent rather than a filled border, because a
 * filled row in a dropdown reads as a hover/selection state rather than as
 * "this window is open".
 */
export function renderHeaderModMenuItem(
    entry: RegisteredChromeEntry,
    t: ModT,
    lastGoodRef: { current: ChromeState | undefined },
    onSelected?: () => void,
): ReactNode | null {
    const { state } = readStateSafe(entry, lastGoodRef.current);
    if (state) lastGoodRef.current = state;
    if (state?.hidden) return null;

    const mod = entry.mod;
    if (!mod) return null;

    const iconName = state?.icon ?? entry.entry.icon;
    const { icon: Icon } = resolveMountIcon(iconName);
    const label = resolveModText(mod.id, state?.label ?? entry.entry.label, t);
    const tooltip = resolveModText(mod.id, state?.tooltip ?? entry.entry.tooltip, t);
    // The mod's own name, so an overflow list of eight entries from four mods
    // tells you which mod each row came from. The button row has no space for
    // this; the menu does, and it is the thing that makes the list legible.
    const modName = mod.name || mod.id;
    const isDanger = state?.tone === 'danger';

    const handleClick = () => {
        dispatchOnSelect(entry);
        // Close the menu on activation. A toolbar button has no menu to close;
        // this is the one behavioural difference between the two renderers.
        onSelected?.();
    };

    return (
        <button
            key={entry.qualifiedId}
            type="button"
            role="menuitem"
            onClick={handleClick}
            disabled={state?.disabled}
            title={tooltip}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed border-l-2 ${
                state?.active ? 'border-l-terminal bg-terminal/5' : 'border-l-transparent'
            } ${isDanger ? 'text-ember hover:bg-ember/10' : 'text-text-primary hover:bg-terminal/10'}`}
        >
            <Icon size={13} className={`shrink-0 ${state?.busy ? 'animate-spin' : ''}`} />
            <span className="min-w-0 flex-1">
                <span className="chrome-label block text-[10px] font-bold uppercase tracking-wider truncate">
                    {label || modName}
                </span>
                {label ? (
                    <span className="block text-[9px] text-text-dim truncate">{modName}</span>
                ) : null}
            </span>
            {state?.badge !== undefined && state.badge !== null && state.badge !== '' ? (
                <span className="shrink-0 min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                    {state.badge}
                </span>
            ) : null}
        </button>
    );
}

/** The composer strip's button classes. Matches `ChatActionStrip.tsx`'s built-in classes. */
const COMPOSER_BASE = 'flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap';

/** Map a `ChromeState` to the composer button's classes. */
function composerClasses(state: ChromeState | undefined): string {
    if (state?.disabled) return `${COMPOSER_BASE} border-border/40 opacity-50 cursor-not-allowed`;
    const tone = state?.tone ?? 'default';
    const active = state?.active;
    let toneBorder: string;
    let toneText: string;
    let toneBg = '';
    if (tone === 'warn' || active) {
        toneBorder = 'border-amber-500';
        toneText = 'text-amber-500';
        if (active) toneBg = 'bg-amber-500/10 hover:bg-amber-500/20';
        else toneBg = 'hover:bg-amber-500/5';
    } else if (tone === 'danger') {
        toneBorder = 'border-danger';
        toneText = 'text-danger';
        toneBg = 'bg-danger/15';
    } else {
        toneBorder = 'border-terminal/30 hover:border-terminal';
        toneText = 'text-terminal';
        toneBg = 'hover:bg-terminal/5';
    }
    return `${COMPOSER_BASE} ${toneBorder} ${toneText} ${toneBg}`;
}

/**
 * Render a mod's composer entry. Returns `null` when `state().hidden`. The
 * caller (`ComposerActions`) keys on the qualified id and renders this for
 * every entry whose `renderer === 'generic'`.
 */
export function renderComposerModEntry(
    entry: RegisteredChromeEntry,
    t: ModT,
    lastGoodRef: { current: ChromeState | undefined },
    drain?: () => Promise<void>,
): ReactNode | null {
    const { state, threw } = readStateSafe(entry, lastGoodRef.current);
    if (threw) {
        // Render from last good; see renderHeaderModEntry for the policy.
    }
    if (state) lastGoodRef.current = state;
    if (state?.hidden) return null;

    const mod = entry.mod;
    if (!mod) return null;

    const iconName = state?.icon ?? entry.entry.icon;
    const { icon: Icon } = resolveMountIcon(iconName);
    const label = resolveModText(mod.id, state?.label ?? entry.entry.label, t);
    const shortLabel = shortModLabel(label);
    const isExitTone = false;
    const classes = composerClasses(state);
    void isExitTone;

    const handleClick = () => {
        // §8.8: the host drains a pending commit before dispatching a mod
        // `onSelect` from `composer.actions`. The drain is injected by the
        // caller (`ChatActionStrip`) because the row owns the
        // `commitPendingTurn` import; the renderer stays free of the turn
        // pipeline, exactly as `message.actions` does it.
        //
        // Passing it through `dispatchOnSelect` rather than wrapping the
        // entry's `onSelect` is what keeps drain-then-refresh in that order —
        // a wrapper drains INSIDE the dispatch, after the Phase 9.2 refresh
        // has already snapshotted the pre-commit store.
        dispatchOnSelect(entry, undefined, drain);
    };

    return (
        <button
            key={entry.qualifiedId}
            onClick={handleClick}
            disabled={state?.disabled}
            title={label}
            className={classes}
        >
            <Icon size={13} className={state?.busy ? 'animate-spin' : ''} />
            {label ? (
                <>
                    <span className="hidden xs:inline">{label}</span>
                    <span className="inline xs:hidden">{shortLabel}</span>
                </>
            ) : null}
        </button>
    );
}

/**
 * The narrow-screen fallback for a mod composer entry's label. The built-in
 * composer buttons pair a full label (`hidden xs:inline`) with a short
 * fallback (`inline xs:hidden`) so a narrow viewport still shows something.
 * The generic mod renderer mirrors that pair; this helper derives the short
 * form from the full label — the first word (e.g. "INJECT ARC" → "INJECT").
 * A one-word label passes through unchanged. Empty/undefined yields undefined.
 */
function shortModLabel(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const trimmed = label.trim();
    if (trimmed.length === 0) return undefined;
    const firstWord = trimmed.split(/\s+/)[0];
    return firstWord.length > 0 ? firstWord : trimmed;
}

/**
 * `MOUNTS.md` §2.5 — the message-row action rail's button classes. Matches
 * `MessageActionRail.tsx`'s built-in buttons exactly: a 14px lucide icon in
 * a 1.5-padded `bg-void-lighter rounded` cell, `text-text-dim` idle and
 * `text-terminal` (or `text-amber-400` / `text-red-400` for warn / danger)
 * on hover or active. A mod's action icon is visually native — it sits in
 * the same vertical rail as edit/rewind/speak/delete, with the same
 * dimensions, the same hover transition, and the same opacity behaviour
 * (visible on mobile, hidden until `group-hover` on desktop).
 */
const MESSAGE_ACTION_BASE = 'p-1.5 bg-void-lighter rounded transition-colors';

/** Map a `ChromeState` to a message-action button's classes. */
function messageActionClasses(state: ChromeState | undefined): string {
    if (state?.disabled) return `${MESSAGE_ACTION_BASE} text-text-dim opacity-50 cursor-not-allowed`;
    if (state?.active) return `${MESSAGE_ACTION_BASE} text-terminal`;
    if (state?.tone === 'warn') return `${MESSAGE_ACTION_BASE} text-text-dim hover:text-amber-400`;
    if (state?.tone === 'danger') return `${MESSAGE_ACTION_BASE} text-text-dim hover:text-red-400`;
    return `${MESSAGE_ACTION_BASE} text-text-dim hover:text-terminal`;
}

/**
 * Render a mod's message-row action entry. Returns `null` when
 * `state().hidden`. The caller (`MessageActionRail`) keys on the qualified
 * id and renders this for every entry whose `renderer === 'generic'`.
 *
 * The click handler drains a pending commit before dispatching `onSelect`
 * (`MOUNTS.md` §8.8 — `message.actions` is chat-scoped). The drain is
 * injected by the caller through `drain` so this renderer stays free of the
 * turn-pipeline import.
 */
export function renderMessageActionModEntry(
    entry: RegisteredChromeEntry,
    t: ModT,
    lastGoodRef: { current: ChromeState | undefined },
    drain: () => Promise<void>,
    message: MessageRef,
): ReactNode | null {
    const { state, threw } = readStateSafe(entry, lastGoodRef.current, message);
    if (threw) {
        // Render from last good; see renderHeaderModEntry for the policy.
    }
    if (state) lastGoodRef.current = state;
    if (state?.hidden) return null;

    const mod = entry.mod;
    if (!mod) return null;

    const iconName = state?.icon ?? entry.entry.icon;
    const { icon: Icon } = resolveMountIcon(iconName);
    const label = resolveModText(mod.id, state?.label ?? entry.entry.label, t);
    const tooltip = resolveModText(mod.id, state?.tooltip ?? entry.entry.tooltip, t);
    const classes = messageActionClasses(state);

    const handleClick = () => {
        // §8.8: the host drains a pending commit before dispatching a mod
        // `onSelect` from `message.actions`. The drain is injected by the
        // caller because the rail component owns the `commitPendingTurn`
        // import path; the renderer stays free of the turn pipeline.
        // Phase 9.2 / 6.9.2 — the live context AND the row this button was
        // rendered on. Without the message argument a rail of
        // one-button-per-row could only ever act on "the latest message",
        // which is not what the rail visually promises. `dispatchOnSelect`
        // drains first, then refreshes, so the click sees post-commit state.
        dispatchOnSelect(entry, message, drain);
    };

    const title = tooltip ?? label;
    return (
        <button
            key={entry.qualifiedId}
            onClick={handleClick}
            disabled={state?.disabled}
            title={title}
            aria-label={title}
            className={classes}
        >
            <Icon size={14} className={state?.busy ? 'animate-spin' : ''} />
        </button>
    );
}
