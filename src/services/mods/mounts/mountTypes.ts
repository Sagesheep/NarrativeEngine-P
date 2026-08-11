/**
 * Phase 4.2 — the mount point contract types.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/MOUNTS.md`. Two
 * shapes of region exist (§1):
 *
 *   • **Chrome — declared:** the host renders the element from a serialisable
 *     entry plus callbacks. A mod supplies data, never markup.
 *     Regions: `header.actions`, `composer.actions`, `message.actions`.
 *   • **Content — imperative:** the mod renders into a host-owned DOM node.
 *     Regions: `chat.rail`, `message.below`, `window.layer`.
 *
 * This phase implements the two chrome rows (`header.actions` and
 * `composer.actions`, MOUNTS.md §2.2/§2.3). The content regions and
 * `message.actions` land in 4.3–4.5; their types are declared here so the
 * `ModMounts` interface is complete and 4.3–4.5 implement rather than
 * re-design.
 *
 * The two rows share one registry with two region ids (§2.3): the rows
 * differ in visual contract and trailing alignment, not in whether they
 * carry state.
 */

/**
 * `MOUNTS.md` §8.2 — the closed `tone` set. Mapped to host tokens (Phase 4.6);
 * a chrome entry may not specify an arbitrary colour.
 */
export type ChromeTone = 'default' | 'active' | 'warn' | 'danger';

/**
 * `MOUNTS.md` §8.2 — the state a chrome entry's optional `state()` returns.
 * Re-read on every render of the row the entry lives in, and on
 * `MountHandle.update()`. Must be cheap and synchronous: it runs on every
 * render of a row that, for `message.actions`, exists once per visible
 * message.
 *
 * Every field is optional; an entry that has no dynamic state returns
 * `undefined` (no `state()` at all). Each field maps to a real built-in
 * (MOUNTS.md §8.2 table), so every built-in is expressible as a generic
 * entry — and a built-in may still carry its own bespoke renderer, which is
 * how the zero-mod pixel-identity rule stays winnable (§8.2).
 */
export interface ChromeState {
    /** Override the declared icon for this render. A lucide name. */
    readonly icon?: string;
    /** Override the declared label. A literal or i18n key in the mod namespace. */
    readonly label?: string;
    /** Override the declared tooltip. Same. */
    readonly tooltip?: string;
    /** A small count or short string drawn beside the label (Pin's count). */
    readonly badge?: number | string;
    /** Styled active (Pin's filled border; Deep Search armed). */
    readonly active?: boolean;
    /** Greyed and non-interactive (Trim while streaming). */
    readonly disabled?: boolean;
    /** Removed from the row entirely (Deep Search when its setting is off). */
    readonly hidden?: boolean;
    /** Host spins the icon (Save's SAVING… state). */
    readonly busy?: boolean;
    /** Mapped to host tokens by the host, never a raw colour (§6.1). */
    readonly tone?: ChromeTone;
}

/**
 * `MOUNTS.md` §8.2 — a chrome entry. The host renders the element; the mod
 * supplies data and callbacks. `id` is the only field the mod controls that
 * is visible to the host's ordering logic; the host qualifies it to
 * `mod.<modId>.<entryId>` (§2.1), so two mods cannot collide and a mod cannot
 * impersonate a built-in (the `mod.` prefix a built-in never has).
 *
 * `icon` is a lucide name, not a component. The host resolves it against the
 * icon set it already ships, so the entry stays serialisable (Mod Management
 * can render a mod's entries without mounting the mod, §8.2) and the mod's
 * button is visually native (§1).
 *
 * `label` / `tooltip` run through the host's i18n lookup in the mod's
 * namespace (`MANIFEST.md` §5): `mod.<modId>.<key>`. A literal string misses
 * the lookup and renders as itself — no new mechanism.
 */
export interface ChromeEntry {
    /** ID_REGEX (`/^[a-zA-Z0-9_-]+$/`). Host qualifies to `mod.<modId>.<entryId>`. */
    readonly id: string;
    /** A lucide icon name. Unknown name → fault plus a neutral fallback glyph (never blank). */
    readonly icon: string;
    /** Literal, or a key in this mod's i18n namespace (`mod.<modId>.<key>`). */
    readonly label: string;
    /** Same as `label`. Optional; absent → no tooltip. */
    readonly tooltip?: string;
    /**
     * Fired on click. The host drains a pending commit first in chat-scoped
     * regions (§8.8).
     *
     * Phase 9.2 — `ctx` is the mod's live `ModContext`. Before 9.2 the host
     * passed `undefined` here while the shipped `.d.ts` declared `ModContext`;
     * a mod that used the parameter instead of closing over its `activate`
     * lease crashed. The context is now threaded from the registration.
     *
     * Phase 9.2 / 6.9.2 — `message` is the row the button was rendered on, and
     * is present **only** for `message.actions` registrations. `header.actions`
     * and `composer.actions` are not message-scoped and receive `undefined`.
     * Without it, a per-row rail button could only ever act on "the latest
     * message", which is not what a rail of one-button-per-row promises.
     */
    onSelect(ctx: unknown, message?: MessageRef): void | Promise<void>;
    /**
     * Re-read on render and on `handle.update()`. Optional; absent → no
     * dynamic state.
     *
     * Phase 9.2 / 6.9.2 — receives the same `MessageRef` as `onSelect` for
     * `message.actions`, so a row's button can be `active` because **that row**
     * is marked. `ChromeState` was previously one object for the whole mod
     * while the rail renders one button per message, which made every row light
     * up the moment any row qualified.
     */
    state?(message?: MessageRef): ChromeState;
}

/**
 * `MOUNTS.md` §8.3 — content mount shapes. Declared here so `ModMounts` is
 * complete; implemented in 4.3–4.5.
 */
export interface RailPanel {
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
    mount(node: HTMLElement, ctx: unknown): void | (() => void);
}

export interface MessageContentSlot {
    readonly id: string;
    mount(node: HTMLElement, ctx: unknown, message: MessageRef): void | (() => void);
}

export interface WindowDeclaration {
    readonly id: string;
    readonly title: string;
    readonly defaultSize: { width: number; height: number };
    readonly minSize?: { width: number; height: number };
    readonly resizable?: boolean;
    mount(node: HTMLElement, ctx: unknown): void | (() => void);
}

/**
 * `MOUNTS.md` §2.7 / §8.3 — a registered `window.layer` declaration. A window
 * is declared once (via `ctx.mounts.window` from `activate`) and opened many
 * times (`WindowHandle.open()`). The host owns the chrome — title bar, drag,
 * resize, z-order, focus, close — and the mod owns the interior (§2.7).
 *
 * Unlike the rail panel, the window's runtime geometry / open / minimized
 * state lives in `windowStore.ts` (keyed by `qualifiedId` per §8.7); this
 * record is the static declaration. `MOUNTS.md` §4.4 rules that windows do
 * not conflict (two mods each get windows; host owns z-order), so there is
 * no comparator-relevant field here beyond `(loadIndex, withinModIndex)`,
 * which exists only to give the WindowManager a stable iteration order.
 */
export interface RegisteredWindowDeclaration {
    readonly qualifiedId: string;
    readonly entryId: string;
    readonly mod: MountRegistryMod;
    readonly loadIndex: number;
    readonly withinModIndex: number;
    readonly declaration: WindowDeclaration;
    readonly context: unknown;
}

/**
 * `MOUNTS.md` §8.4 — the message identity a message-scoped mount receives.
 * `sceneId` is the durable identity: `id` is per-session, `sceneId` maps a
 * bubble back to long-term memory. A mod that needs the prose reads
 * `ctx.data.messages` and finds the row by `id`; it never receives the full
 * `ChatMessage` (internals the API deliberately does not publish).
 */
export interface MessageRef {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly sceneId: string | null;
}

/**
 * `MOUNTS.md` §8.5 — the handle a registration call returns. Deliberately a
 * handle (two operations) where `ctx.events.on()` returns a bare function
 * (one operation): a mount has `update()` and `remove()`, a listener has only
 * teardown. Consistency is not worth a second call named `invalidate`.
 *
 * Teardown is host-owned (§8.5): `disable` removes every mount the mod
 * registered, at the same call site that already disposes subscriptions and
 * event listeners. The mod is never trusted to call `remove()`.
 */
export interface MountHandle {
    /** Re-read `state()` (chrome) / no-op (content). Cheap; safe to call from a 2.4 subscription. */
    update(): void;
    /** Unregister the entry. Also called by the host on disable. */
    remove(): void;
}

/**
 * `MOUNTS.md` §8.3 — `WindowHandle` adds `open`/`close`/`focus` to
 * `MountHandle`. A window is declared once and opened many times; what opens
 * it is typically a `header.actions` entry (4.5 §2.3). Implemented in 4.5.
 */
export interface WindowHandle extends MountHandle {
    open(): void;
    close(): void;
    focus(): void;
}

/**
 * `MOUNTS.md` §8.1 — the surface a mod's `activate` hook reaches. Six named
 * methods rather than one `register(regionId, …)`: the payload shape genuinely
 * differs per region, and a single method would take a union the type checker
 * cannot narrow from a string without overloads that read worse than six
 * names. It also makes an unknown region a compile error in the shipped
 * `.d.ts` rather than a runtime fault.
 *
 * Native-tier only: registration needs a callback (a closure), a closure
 * needs a module, and a module is `native.js`. A sandboxed compute mod is
 * handed one snapshot and one journal and cannot hold a closure across a
 * render — same ruling `EVENTS.md` §5.1 made for the bus.
 */
export interface ModMountsApi {
    header(entry: ChromeEntry): MountHandle;
    composer(entry: ChromeEntry): MountHandle;
    messageAction(entry: ChromeEntry): MountHandle;
    rail(panel: RailPanel): MountHandle;
    messageBelow(slot: MessageContentSlot): MountHandle;
    window(win: WindowDeclaration): WindowHandle;
}

/**
 * `MOUNTS.md` §2.1 — the region ids. Host-owned and never begin with `mod.`.
 * Permanent (renaming one after a third party ships is a breaking change).
 */
export type MountRegionId =
    | 'header.actions'
    | 'composer.actions'
    | 'message.actions'
    | 'chat.rail'
    | 'message.below'
    | 'window.layer';

/**
 * `MOUNTS.md` §5 — per mod, per region budget. Exceeding it is a surfaced
 * fault naming the mod and the region, never a silent drop (4.2 §3). The cap
 * is checked at registration (a runtime call, §8).
 */
export const MOUNT_BUDGET: Readonly<Record<MountRegionId, number>> = Object.freeze({
    'header.actions': 2,
    'composer.actions': 2,
    'message.actions': 3,
    'chat.rail': 1,
    'message.below': 1,
    'window.layer': 3,
});

/**
 * `MOUNTS.md` §8.6 — mount fault kinds. Uses the existing fault-store shape
 * (`{ modId, file, kind, reason }`), surfaced in Extensions beside the others.
 */
export type MountFaultKind = 'budget' | 'duplicate' | 'icon' | 'threw' | 'revoked';

/**
 * A narrow mod view the registry needs to attribute a registration. The
 * host owns the qualification (`mod.<modId>.<entryId>`) and the fault record,
 * both keyed by `modId`.
 */
export interface MountRegistryMod {
    readonly id: string;
    readonly name: string;
}