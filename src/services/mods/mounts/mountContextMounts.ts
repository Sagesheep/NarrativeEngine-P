/**
 * Phase 4.2 — build the `ctx.mounts` API for one mod.
 *
 * `MOUNTS.md` §8.1: six named methods, one per region. This module implements
 * all six: the two chrome rows (`header.actions` and `composer.actions`,
 * §2.2/§2.3), the two message regions (`message.actions` and `message.below`,
 * §2.5/§2.6), the chat rail (`chat.rail`, §2.4), and the floating window
 * layer (`window.layer`, §2.7 — Phase 4.5).
 *
 * The API object is per-mod: it carries the mod's identity and resolved load
 * index so registrations sort by `(loadIndex, withinModIndex)` (§3.2) and the
 * host owns teardown on disable (§8.5).
 */
import type {
    ChromeEntry,
    MessageContentSlot,
    ModMountsApi,
    MountHandle,
    MountRegistryMod,
    RailPanel,
    WindowDeclaration,
    WindowHandle,
} from './mountTypes';
import {
    registerModChrome,
    registerModMessageBelow,
    registerModRail,
    registerModWindow,
} from './mountRegistry';

export interface ModMountsApiOptions {
    readonly mod: MountRegistryMod;
    /** The mod's resolved load index (MOUNTS.md §3.1). Default 0. */
    readonly loadIndex?: number;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly faultFile?: string;
    readonly getContext?: () => unknown;
}

/**
 * Build the `ctx.mounts` API for one mod. The returned object is frozen; a
 * mod cannot reassign its methods. Every method returns a `MountHandle` —
 * for a faulted registration, a no-op handle (§5, §8.6).
 */
export function buildModMountsApi(options: ModMountsApiOptions): ModMountsApi {
    const mod = options.mod;
    const loadIndex = options.loadIndex ?? 0;
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    // Lazily read the live context per registration call. The context is
    // set on `contextRef.current` AFTER `buildModMountsApi` returns (see
    // `modContext.ts`), so evaluating `options.getContext?.()` once at the
    // top would capture `undefined`. A mod calls `ctx.mounts.rail(...)` /
    // `ctx.mounts.messageBelow(...)` from its `activate` hook, by which
    // point `contextRef.current` is set; the deferred read returns the
    // live context. Mirrors the 4.3 rail wiring.
    const liveContext = () => options.getContext?.();

    // Phase 9.2 — the chrome rows now carry the live context too. Before this,
    // only the three content regions did, and `onSelect(ctx)` received
    // `undefined` while the shipped `.d.ts` declared a `ModContext`. Same
    // deferred read as the content regions, for the same reason.
    const header = (entry: ChromeEntry): MountHandle =>
        registerModChrome('header.actions', mod, entry, loadIndex, liveContext(), { faultFile });
    const composer = (entry: ChromeEntry): MountHandle =>
        registerModChrome('composer.actions', mod, entry, loadIndex, liveContext(), { faultFile });
    const messageAction = (entry: ChromeEntry): MountHandle =>
        registerModChrome('message.actions', mod, entry, loadIndex, liveContext(), { faultFile });

    const rail = (panel: RailPanel): MountHandle =>
        registerModRail(mod, panel, loadIndex, liveContext(), { faultFile });
    const messageBelow = (slot: MessageContentSlot): MountHandle =>
        registerModMessageBelow(mod, slot, loadIndex, liveContext(), { faultFile });

    // Phase 4.5 — `ctx.mounts.window` returns a real `WindowHandle` whose
    // `open()` / `close()` / `focus()` drive the host-owned window manager
    // (`windowStore.ts`). The declaration is registered here; the host's
    // `WindowManager` component renders the chrome and the mod's `mount`
    // callback fills the interior node. Same fault discipline as the other
    // regions: over-budget / duplicate / revoked record a fault and return
    // a no-op handle — never a throw (§5, §8.6).
    const window = (win: WindowDeclaration): WindowHandle =>
        registerModWindow(mod, win, loadIndex, liveContext(), { faultFile });

    return Object.freeze({
        header,
        composer,
        messageAction,
        rail,
        messageBelow,
        window,
    });
}