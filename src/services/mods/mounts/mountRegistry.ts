/**
 * Phase 4.2 — the mount point registry.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/MOUNTS.md`.
 * This module owns the per-region stores, the ordering rule (§3), the budget
 * gate (§5), the duplicate-id check (§4.1), the icon resolution + fault
 * (§8.2), and the host-owned teardown (§8.5). A React row reads a region's
 * ordered entries through `subscribe`; a mod's `activate` writes through the
 * `ModMountsApi` (`ctx.mounts`).
 *
 * Design notes carried from `MOUNTS.md`:
 *
 *   • **One registry, two regions** for this phase (`header.actions` and
 *     `composer.actions`). The rows differ in visual contract and trailing
 *     alignment, not in whether they carry state. The registry is
 *     region-agnostic; the renderer is per-row.
 *   • **Built-ins render first** in their fixed declared order; mod entries
 *     insert between the leading built-ins and the trailing group (§3.3).
 *     A built-in entry may carry its own bespoke renderer (§8.2), which is
 *     how the zero-mod pixel-identity rule stays winnable. A mod entry
 *     always renders through the generic chrome renderer.
 *   • **Ordering is `(loadIndex, withinModIndex)`** (§3.2) — NOT registration
 *     time. A mod enabled mid-session **inserts at its proper place** so
 *     what the user sees after toggling a mod is what they will see after a
 *     restart. The cost is one comparator; the guarantee is the win.
 *   • **Teardown is host-owned** (§8.5). `disableModMounts` removes every
 *     mount the mod registered; `clearAllModMounts` clears all of them on
 *     `reset()`. The mod is never trusted to call `remove()`. A `register`
 *     call after the mod's lease is revoked is a no-op plus a fault.
 *   • **Over-budget / duplicate / unknown-icon / revoked** all record a fault
 *     and return a no-op handle — they never throw (§5, §8.6). Throwing
 *     inside `activate` would count a strike against the mod and latch its
 *     hooks off after three, killing registrations that were fine.
 */
import type { ChromeEntry, MessageContentSlot, MountHandle, MountRegistryMod, MountRegionId, RailPanel, WindowDeclaration } from './mountTypes';
import { MOUNT_BUDGET } from './mountTypes';
import { mountFaultStore, formatMountFaultReason } from './mountFaults';
import { resolveMountIcon } from './mountIcons';
import {
    clearAllWindowsWindows,
    closeWindow as closeWindowHandle,
    disableModWindows,
    focusWindow as focusWindowHandle,
    getModWindowCount,
    openWindow as openWindowHandle,
    registerWindowDeclaration,
    unregisterWindowDeclaration,
} from './windowStore';

/**
 * The id prefix that marks a mod-owned entry. A built-in never carries it,
 * so a mod cannot impersonate a built-in id by construction (MOUNTS.md §2.1,
 * §4.1) — the qualified form always carries the `mod.` prefix a built-in
 * never has. The check is structural rather than a lookup.
 */
const MOD_PREFIX = 'mod.';

/** The qualified id for a mod entry: `mod.<modId>.<entryId>`. */
export function qualifyEntryId(modId: string, entryId: string): string {
    return `${MOD_PREFIX}${modId}.${entryId}`;
}

/**
 * A registered entry in a region. Carries the resolved sort key
 * (`loadIndex`, `withinModIndex`) so a mid-session enable inserts at its
 * proper place (MOUNTS.md §3.2). Built-ins carry `loadIndex: -1` so they sort
 * before every mod entry; within the built-ins, `withinModIndex` is the
 * declared order.
 *
 * `renderer` is the optional bespoke host component a built-in may carry
 * (§8.2). A mod entry never has one — it renders through the generic chrome
 * renderer. `undefined` here means "generic".
 */
export interface RegisteredChromeEntry {
    /** The fully-qualified id. Built-ins use their bare id (no `mod.` prefix). */
    readonly qualifiedId: string;
    /** The bare id the entry was declared with. */
    readonly entryId: string;
    /** The mod that registered this entry, or `undefined` for a built-in. */
    readonly mod: MountRegistryMod | undefined;
    /** Lower sorts first. Built-ins are `-loadIndex - 1`; mods are the load index. */
    readonly loadIndex: number;
    /** Within a mod (or within the built-ins), the registration order. */
    readonly withinModIndex: number;
    /** The mod's declared entry. */
    readonly entry: ChromeEntry;
    /**
     * Optional bespoke renderer for a built-in. A mod entry always renders
     * through the generic chrome renderer. Carried so the renderer does not
     * need a second lookup.
     */
    readonly renderer: 'builtin' | 'generic';
}

export interface RegisteredRailPanel {
    readonly qualifiedId: string;
    readonly entryId: string;
    readonly mod: MountRegistryMod;
    readonly loadIndex: number;
    readonly withinModIndex: number;
    readonly panel: RailPanel;
    readonly context: unknown;
}

/**
 * `MOUNTS.md` §2.6 / §8.3 — a registered `message.below` slot. Like a rail
 * panel, but the host hands the mod's `mount` a `MessageRef` in addition to
 * the node and context, so the slot can act on that specific message. The
 * slot is rendered once per visible message; the host owns the per-row node
 * and the mod's interior is bounded by `overflow` (§2.6 / §6).
 */
export interface RegisteredMessageBelowSlot {
    readonly qualifiedId: string;
    readonly entryId: string;
    readonly mod: MountRegistryMod;
    readonly loadIndex: number;
    readonly withinModIndex: number;
    readonly slot: MessageContentSlot;
    readonly context: unknown;
}

interface RegionStore {
    /** All entries (built-ins + mods), kept ordered by the comparator on every mutation. */
    entries: Array<RegisteredChromeEntry | RegisteredRailPanel | RegisteredMessageBelowSlot>;
    /** The built-in ids that form the trailing group (§3.3). Mod entries insert before them. */
    trailingIds: ReadonlySet<string>;
    /** Count of entries per mod id, for the budget gate (§5). */
    perModCount: Map<string, number>;
    /** Qualified ids present in this region, for the duplicate check (§4.1). */
    knownIds: Set<string>;
    /** The next `withinModIndex` for each mod (registration order within a mod). */
    nextWithinIndex: Map<string, number>;
}

function createRegionStore(trailingIds: readonly string[]): RegionStore {
    return {
        entries: [],
        trailingIds: new Set(trailingIds),
        perModCount: new Map(),
        knownIds: new Set(),
        nextWithinIndex: new Map(),
    };
}

/**
 * `MOUNTS.md` §3.1 / §3.2 / §3.3 — the comparator. The order within a region
 * is:
 *   1. **Leading built-ins** (non-trailing), in their declared order;
 *   2. **Mod entries**, sorted by `(loadIndex, withinModIndex)` (§3.2);
 *   3. **Trailing-group built-ins** (`settings`+`exit` in header, `archive`
 *      in composer), in their declared order (§3.3).
 *
 * Built-ins have no `loadIndex` (they are not mods); they use a synthetic
 * `loadIndex` of `-1` and sort by `withinModIndex` (the declared order) —
 * BUT a trailing-group built-in sorts AFTER every mod entry. The cleanest
 * expression: assign trailing built-ins a synthetic `loadIndex` of
 * `+Infinity` and leading built-ins `-1`, so the three groups fall out of
 * one numeric sort on `loadIndex`:
 *   • leading built-in: `loadIndex = -1`
 *   • mod entry: `loadIndex = <resolved index, ≥ 0>`
 *   • trailing built-in: `loadIndex = Number.POSITIVE_INFINITY`
 */
function compareEntries(a: Pick<RegisteredChromeEntry, 'loadIndex' | 'withinModIndex'>, b: Pick<RegisteredChromeEntry, 'loadIndex' | 'withinModIndex'>): number {
    if (a.loadIndex !== b.loadIndex) return a.loadIndex - b.loadIndex;
    // Same loadIndex group: within built-ins, the declared `withinModIndex`;
    // within a mod's entries, the registration order (also `withinModIndex`).
    return a.withinModIndex - b.withinModIndex;
}

function sortRegion(store: RegionStore): void {
    store.entries = [...store.entries].sort(compareEntries);
}

/** The per-region stores. Built-ins are registered once at module load; mods mutate on `activate`. */
const regions: Record<MountRegionId, RegionStore> = {
    'header.actions': createRegionStore(['settings', 'exit']),
    'composer.actions': createRegionStore(['archive']),
    'message.actions': createRegionStore([]),
    'chat.rail': createRegionStore([]),
    'message.below': createRegionStore([]),
    'window.layer': createRegionStore([]),
};

/** Listeners per region — a React row subscribes so it re-renders on add/remove. */
const regionListeners = new Map<MountRegionId, Set<() => void>>([
    ['header.actions', new Set()],
    ['composer.actions', new Set()],
    ['message.actions', new Set()],
    ['chat.rail', new Set()],
    ['message.below', new Set()],
    ['window.layer', new Set()],
]);

function notifyRegion(region: MountRegionId): void {
    const listeners = regionListeners.get(region);
    if (!listeners) return;
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* a render listener must not break a registration */ }
    }
}

/** The set of mods whose lease has been revoked (disabled). Registration after this is a no-op + fault. */
const revokedMods = new Set<string>();

/**
 * Subscribe to a region's ordered entries. A React row calls this once and
 * re-renders on every add/remove/update. Returns an unsubscribe.
 */
export function subscribeToRegion(region: MountRegionId, listener: () => void): () => void {
    const set = regionListeners.get(region);
    if (!set) return () => undefined;
    set.add(listener);
    return () => set.delete(listener);
}

/**
 * Read a region's ordered entries. The array is a snapshot — callers must
 * not mutate it. Built-ins come first in their declared order, then mod
 * entries in `(loadIndex, withinModIndex)` order, with trailing-group
 * built-ins pinned to the end of the built-ins.
 */
export function readRegion(region: MountRegionId): readonly RegisteredChromeEntry[] {
    return regions[region].entries as readonly RegisteredChromeEntry[];
}


/** Read the ordered `chat.rail` panels without exposing content mounts as chrome. */
export function readRailPanels(): readonly RegisteredRailPanel[] {
    return regions['chat.rail'].entries as readonly RegisteredRailPanel[];
}

/**
 * `MOUNTS.md` §2.6 — read the ordered `message.below` slots. The host's
 * `MessageBelowSlots` component calls this once per visible message and
 * renders each slot into its own bounded, error-boundaried node. Stacked in
 * `(loadIndex, withinModIndex)` order (§4.3).
 */
export function readMessageBelowSlots(): readonly RegisteredMessageBelowSlot[] {
    return regions['message.below'].entries as readonly RegisteredMessageBelowSlot[];
}
/**
 * `MOUNTS.md` §3.3 — register a built-in entry. Built-ins are registered
 * once at module load (before any mod), in their fixed declared order. The
 * `withinModIndex` is the call order; the registry preserves it. A built-in
 * may carry a bespoke renderer (`renderer: 'builtin'`); a mod entry never
 * does. This is how the zero-mod pixel-identity rule stays winnable (§8.2).
 *
 * Trailing-group built-ins (recorded in the region's `trailingIds`) get a
 * synthetic `loadIndex` of `+Infinity` so they sort AFTER every mod entry
 * (§3.3). Leading built-ins get `-1` so they sort before every mod entry.
 * The three groups (leading built-ins, mod entries, trailing built-ins)
 * then fall out of one numeric sort on `loadIndex`.
 *
 * Built-ins bypass the budget gate (they are not mods) and the duplicate-id
 * check is against the bare id (no `mod.` prefix).
 */
export function registerBuiltin(region: MountRegionId, entryId: string, renderer: 'builtin'): void {
    const store = regions[region];
    if (!store) return;
    // A built-in id never carries the mod. prefix. Registering one that does
    // is a programming bug — surface it loudly rather than silently mis-sorting.
    if (entryId.startsWith(MOD_PREFIX)) {
        console.warn(`[mounts] built-in id "${entryId}" in "${region}" carries the mod. prefix; ignoring`);
        return;
    }
    if (store.knownIds.has(entryId)) {
        // Defensive: a built-in registered twice is a host programming bug.
        console.warn(`[mounts] built-in id "${entryId}" in "${region}" registered twice; keeping the first`);
        return;
    }
    store.knownIds.add(entryId);
    // Built-ins sort before every mod entry (leading) or after every mod
    // entry (trailing). The synthetic `loadIndex` makes the three-group sort
    // fall out of one numeric comparison.
    const isTrailing = store.trailingIds.has(entryId);
    const loadIndex = isTrailing ? Number.POSITIVE_INFINITY : -1;
    // Within the leading (or trailing) built-ins, the `withinModIndex` is
    // the call order so the declared order survives the sort. Compute it as
    // the count of existing built-ins in the same trailing group.
    const withinIndex = store.entries
        .filter((e) => e.mod === undefined && (isTrailing === store.trailingIds.has(e.entryId)))
        .length;
    store.entries.push({
        qualifiedId: entryId,
        entryId,
        mod: undefined,
        loadIndex,
        withinModIndex: withinIndex,
        // Built-ins do not declare a ChromeEntry through this path — they
        // carry their own renderer. The `entry` field is a placeholder so the
        // type is uniform; the renderer ignores it for built-ins.
        entry: BUILTIN_PLACEHOLDER,
        renderer,
    });
    sortRegion(store);
    notifyRegion(region);
}

/** A placeholder ChromeEntry for built-ins (which carry their own renderer). Never read by the generic renderer. */
const BUILTIN_PLACEHOLDER: ChromeEntry = {
    id: '__builtin__',
    icon: 'HelpCircle',
    label: '',
    onSelect: () => undefined,
};

/**
 * `MOUNTS.md` §8.1 — register a mod's chrome entry in a region. Returns a
 * `MountHandle`. Enforces the budget (§5), the duplicate-id check (§4.1),
 * the icon resolution + fault (§8.2), and the revoked-lease check (§8.5).
 *
 * Never throws: an over-budget / duplicate / unknown-icon / revoked call
 * records a fault and returns a no-op handle. Throwing inside `activate`
 * would count a strike against the mod and latch its hooks off after three
 * (`lifecycleHost.ts`), killing registrations that were fine (§5).
 *
 * `loadIndex` is the mod's resolved load index (the loader returns `mods[]`
 * in resolved order; the registry reads an index it is handed rather than
 * computing one, MOUNTS.md §3.1).
 */
export function registerModChrome(
    region: MountRegionId,
    mod: MountRegistryMod,
    entry: ChromeEntry,
    loadIndex: number,
    options: { faultFile?: string } = {},
): MountHandle {
    const store = regions[region];
    if (!store) return noopHandle();
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    // Revoked lease (§8.5): a register call after the mod's lease is revoked
    // is a no-op plus a fault, not a throw.
    if (revokedMods.has(mod.id)) {
        mountFaultStore.add({
            modId: mod.id,
            file: faultFile,
            region,
            kind: 'revoked',
            entryId: entry.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'revoked', entryId: entry.id }),
        });
        return noopHandle();
    }

    // Budget gate (§5). The over-budget call records a fault and returns a
    // no-op handle.
    const count = store.perModCount.get(mod.id) ?? 0;
    const cap = MOUNT_BUDGET[region];
    if (count >= cap) {
        mountFaultStore.add({
            modId: mod.id,
            file: faultFile,
            region,
            kind: 'budget',
            entryId: entry.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'budget', entryId: entry.id }),
        });
        return noopHandle();
    }

    const qualifiedId = qualifyEntryId(mod.id, entry.id);

    // Duplicate-id check (§4.1). Name both — do not silently first-win
    // (`MANIFEST.md` §6.1's duplicate-id voice).
    if (store.knownIds.has(qualifiedId)) {
        mountFaultStore.add({
            modId: mod.id,
            file: faultFile,
            region,
            kind: 'duplicate',
            entryId: entry.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'duplicate', entryId: entry.id }),
        });
        return noopHandle();
    }

    // Icon resolution + fault (§8.2). Unknown name → fault plus fallback
    // glyph (never a blank button). The fault does not block registration —
    // the entry renders with the fallback.
    const { known } = resolveMountIcon(entry.icon);
    if (!known) {
        mountFaultStore.add({
            modId: mod.id,
            file: faultFile,
            region,
            kind: 'icon',
            entryId: entry.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'icon', entryId: entry.id, message: entry.icon }),
        });
    }

    const withinIndex = store.nextWithinIndex.get(mod.id) ?? 0;
    store.nextWithinIndex.set(mod.id, withinIndex + 1);
    store.perModCount.set(mod.id, count + 1);
    store.knownIds.add(qualifiedId);
    store.entries.push({
        qualifiedId,
        entryId: entry.id,
        mod,
        loadIndex,
        withinModIndex: withinIndex,
        entry,
        renderer: 'generic',
    });
    sortRegion(store);
    notifyRegion(region);

    let removed = false;
    return {
        update: () => {
            // The row re-reads `state()` on the next render; nothing to do
            // here except wake the listeners so the row re-renders.
            notifyRegion(region);
        },
        remove: () => {
            if (removed) return;
            removed = true;
            removeEntry(store, region, qualifiedId, mod.id);
        },
    };
}

/** Register one `chat.rail` content panel under the shared mount contract. */
export function registerModRail(
    mod: MountRegistryMod,
    panel: RailPanel,
    loadIndex: number,
    context: unknown,
    options: { faultFile?: string } = {},
): MountHandle {
    const region: MountRegionId = 'chat.rail';
    const store = regions[region];
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    if (revokedMods.has(mod.id)) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'revoked', entryId: panel.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'revoked', entryId: panel.id }),
        });
        return noopHandle();
    }

    const count = store.perModCount.get(mod.id) ?? 0;
    if (count >= MOUNT_BUDGET[region]) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'budget', entryId: panel.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'budget', entryId: panel.id }),
        });
        return noopHandle();
    }

    const qualifiedId = qualifyEntryId(mod.id, panel.id);
    if (store.knownIds.has(qualifiedId)) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'duplicate', entryId: panel.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'duplicate', entryId: panel.id }),
        });
        return noopHandle();
    }

    if (panel.icon && !resolveMountIcon(panel.icon).known) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'icon', entryId: panel.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'icon', entryId: panel.id, message: panel.icon }),
        });
    }

    const withinIndex = store.nextWithinIndex.get(mod.id) ?? 0;
    store.nextWithinIndex.set(mod.id, withinIndex + 1);
    store.perModCount.set(mod.id, count + 1);
    store.knownIds.add(qualifiedId);
    store.entries.push({
        qualifiedId,
        entryId: panel.id,
        mod,
        loadIndex,
        withinModIndex: withinIndex,
        panel,
        context,
    });
    sortRegion(store);
    notifyRegion(region);

    let removed = false;
    return {
        // Content panels subscribe to the live ModContext themselves;
        // `update()` is intentionally a no-op (MOUNTS.md ?8.5).
        update: () => undefined,
        remove: () => {
            if (removed) return;
            removed = true;
            removeEntry(store, region, qualifiedId, mod.id);
        },
    };
}

/** Remove a faulted rail panel without revoking the rest of its mod's lease. */
export function unregisterRailPanel(qualifiedId: string): void {
    const region: MountRegionId = 'chat.rail';
    const store = regions[region];
    const entry = store.entries.find((candidate) => candidate.qualifiedId === qualifiedId);
    if (!entry?.mod) return;
    removeEntry(store, region, qualifiedId, entry.mod.id);
}

/**
 * `MOUNTS.md` §2.6 / §8.3 — register a `message.below` content slot. Same
 * shape and discipline as `registerModRail`: the host owns the per-row node
 * and teardown; the mod renders into the node it is handed. The mod's
 * `mount` receives a `MessageRef` in addition to the node and context so the
 * slot can act on that specific message (§8.4). Budget is 1 per mod (§5) —
 * one slot per mod bounds the per-row cost to something 4.4 can measure; a
 * mod wanting two blocks composes them inside its one node.
 */
export function registerModMessageBelow(
    mod: MountRegistryMod,
    slot: MessageContentSlot,
    loadIndex: number,
    context: unknown,
    options: { faultFile?: string } = {},
): MountHandle {
    const region: MountRegionId = 'message.below';
    const store = regions[region];
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    if (revokedMods.has(mod.id)) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'revoked', entryId: slot.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'revoked', entryId: slot.id }),
        });
        return noopHandle();
    }

    const count = store.perModCount.get(mod.id) ?? 0;
    if (count >= MOUNT_BUDGET[region]) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'budget', entryId: slot.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'budget', entryId: slot.id }),
        });
        return noopHandle();
    }

    const qualifiedId = qualifyEntryId(mod.id, slot.id);
    if (store.knownIds.has(qualifiedId)) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'duplicate', entryId: slot.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'duplicate', entryId: slot.id }),
        });
        return noopHandle();
    }

    const withinIndex = store.nextWithinIndex.get(mod.id) ?? 0;
    store.nextWithinIndex.set(mod.id, withinIndex + 1);
    store.perModCount.set(mod.id, count + 1);
    store.knownIds.add(qualifiedId);
    store.entries.push({
        qualifiedId,
        entryId: slot.id,
        mod,
        loadIndex,
        withinModIndex: withinIndex,
        slot,
        context,
    });
    sortRegion(store);
    notifyRegion(region);

    let removed = false;
    return {
        // Content slots subscribe to the live ModContext themselves;
        // `update()` is intentionally a no-op (MOUNTS.md §8.5).
        update: () => undefined,
        remove: () => {
            if (removed) return;
            removed = true;
            removeEntry(store, region, qualifiedId, mod.id);
        },
    };
}

/** Remove a faulted `message.below` slot without revoking the rest of its mod's lease. */
export function unregisterMessageBelowSlot(qualifiedId: string): void {
    const region: MountRegionId = 'message.below';
    const store = regions[region];
    const entry = store.entries.find((candidate) => candidate.qualifiedId === qualifiedId);
    if (!entry?.mod) return;
    removeEntry(store, region, qualifiedId, entry.mod.id);
}

/**
 * `MOUNTS.md` §2.7 / §8.3 — register a `window.layer` declaration. A window
 * is declared once (from `activate`) and opened many times; the returned
 * `WindowHandle` carries `open`/`close`/`focus` (§8.3). The host owns the
 * chrome — title bar, drag, resize, z-order, focus, close — and the mod owns
 * the interior (§2.7).
 *
 * Same discipline as `registerModRail` / `registerModMessageBelow`: enforces
 * the per-mod budget (3 declared windows, §5), the duplicate-id check (§4.1),
 * and the revoked-lease check (§8.5). Never throws; over-budget / duplicate /
 * revoked record a fault and return a no-op handle.
 *
 * The budget caps **declarations**, not open windows — a mod that declared
 * three windows can have any of them open (§5). A window that was never
 * declared cannot be opened, so capping declarations bounds both.
 *
 * Auto-opens the window if the persisted state says it was open last session
 * (§8.7 — geometry and open/closed survive reload). The declaration is the
 * static contract; runtime geometry lives in `windowStore.ts`.
 */
export function registerModWindow(
    mod: MountRegistryMod,
    declaration: WindowDeclaration,
    loadIndex: number,
    context: unknown,
    options: { faultFile?: string } = {},
): MountHandle & { open(): void; close(): void; focus(): void } {
    const region: MountRegionId = 'window.layer';
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    // Revoked lease (§8.5).
    if (revokedMods.has(mod.id)) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'revoked', entryId: declaration.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'revoked', entryId: declaration.id }),
        });
        return noopWindowHandle();
    }

    // Budget gate (§5). The cap is on declarations, so the count is the
    // number of declarations the mod currently holds in the window store.
    const count = getModWindowCount(mod.id);
    if (count >= MOUNT_BUDGET[region]) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'budget', entryId: declaration.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'budget', entryId: declaration.id }),
        });
        return noopWindowHandle();
    }

    // The window store enforces the duplicate-id check itself (returns null
    // on a duplicate qualified id). Surface the fault here so the mod sees
    // the same feedback shape as the other regions.
    const declared = registerWindowDeclaration(
        mod.id,
        mod.name,
        declaration,
        loadIndex,
        context,
        {
            withinModIndex: count,
            // The budget gate above is authoritative; pass the same cap so
            // the store's internal guard is consistent if it is ever called
            // directly (it is not, in production).
            budget: MOUNT_BUDGET[region],
            declaredCount: count,
        },
    );
    if (!declared) {
        mountFaultStore.add({
            modId: mod.id, file: faultFile, region, kind: 'duplicate', entryId: declaration.id,
            reason: formatMountFaultReason({ modName: mod.name, region, kind: 'duplicate', entryId: declaration.id }),
        });
        return noopWindowHandle();
    }

    let removed = false;
    return {
        update: () => undefined,
        remove: () => {
            if (removed) return;
            removed = true;
            unregisterWindowDeclaration(declared.qualifiedId);
        },
        open: () => {
            // `WindowHandle.open` on a removed declaration is a no-op — a mod
            // that called `handle.remove()` and then `handle.open()` should
            // not fault (the mod may be mid-teardown).
            if (removed) return;
            openWindowHandle(declared.qualifiedId);
        },
        close: () => {
            if (removed) return;
            closeWindowHandle(declared.qualifiedId);
        },
        focus: () => {
            if (removed) return;
            focusWindowHandle(declared.qualifiedId);
        },
    };
}

/** A no-op handle for faulted window registrations. `open`/`close`/`focus` are no-ops. */
function noopWindowHandle(): MountHandle & { open(): void; close(): void; focus(): void } {
    return {
        update: () => undefined,
        remove: () => undefined,
        open: () => undefined,
        close: () => undefined,
        focus: () => undefined,
    };
}
/** Remove an entry from a region and update all the bookkeeping. */
function removeEntry(store: RegionStore, region: MountRegionId, qualifiedId: string, modId: string): void {
    const idx = store.entries.findIndex((e) => e.qualifiedId === qualifiedId);
    if (idx === -1) return;
    store.entries.splice(idx, 1);
    store.knownIds.delete(qualifiedId);
    const count = store.perModCount.get(modId) ?? 0;
    if (count <= 1) store.perModCount.delete(modId);
    else store.perModCount.set(modId, count - 1);
    sortRegion(store);
    notifyRegion(region);
}

/** A no-op handle for faulted registrations. `update` is a no-op; `remove` is a no-op. */
function noopHandle(): MountHandle {
    return { update: () => undefined, remove: () => undefined };
}

/**
 * `MOUNTS.md` §8.5 — host-owned teardown. `disable` removes every mount the
 * mod registered, at the same call site that already disposes subscriptions
 * and event listeners. The mod is never trusted to call `remove()`.
 *
 * Clears the mod's fault record too, so a re-enable starts clean in the
 * Extensions list (matches `eventFaultStore`'s per-mod clear on disable).
 */
export function disableModMounts(modId: string): number {
    revokedMods.add(modId);
    let removed = 0;
    for (const region of Object.keys(regions) as MountRegionId[]) {
        const store = regions[region];
        const toRemove = store.entries.filter((e) => e.mod?.id === modId);
        for (const entry of toRemove) {
            store.knownIds.delete(entry.qualifiedId);
            removed++;
        }
        if (toRemove.length > 0) {
            store.entries = store.entries.filter((e) => e.mod?.id !== modId);
            store.perModCount.delete(modId);
            store.nextWithinIndex.delete(modId);
            sortRegion(store);
            notifyRegion(region);
        }
    }
    // Phase 4.5 — same discipline for the window layer. `window.layer` is not
    // in the `regions` Record above (its state lives in `windowStore.ts`),
    // so its teardown is a separate call. Closes and destroys every window
    // the mod declared — no orphan chrome (4.5 §2.4 / MOUNTS.md §8.5).
    removed += disableModWindows(modId);
    mountFaultStore.clearMod(modId);
    return removed;
}

/** Allow a mod to register again after a re-enable. Called by the lifecycle host on `enable`. */
export function enableModMounts(modId: string): void {
    revokedMods.delete(modId);
}

/** `MOUNTS.md` §8.5 / `lifecycleHost.reset()` — clear ALL mounts. Test/teardown only. */
export function clearAllModMounts(): void {
    for (const region of Object.keys(regions) as MountRegionId[]) {
        const store = regions[region];
        if (store.entries.length > 0) {
            store.entries = [];
            store.perModCount.clear();
            store.knownIds.clear();
            store.nextWithinIndex.clear();
            notifyRegion(region);
        }
    }
    // Phase 4.5 — clear the window layer too. `window.layer` is not in the
    // `regions` Record (its state lives in `windowStore.ts`), so its reset
    // is a separate call. Test/teardown only.
    clearAllWindowsWindows();
    revokedMods.clear();
    mountFaultStore.clear();
}

/**
 * Test/teardown helper: reset the registry AND the built-in registration
 * guards. `clearAllModMounts` clears the region stores but the built-in
 * modules (`headerBuiltins`/`composerBuiltins`) guard against
 * re-registration with a module-level flag, so a test that calls
 * `clearAllModMounts` and re-runs `registerHeaderBuiltins` would get an
 * empty region. This resets the guards so the next `register*Builtins`
 * call re-registers. Production never calls this — `reset()` uses
 * `clearAllModMounts` and the app reload re-imports the built-in modules.
 */
export function resetMountRegistryForTests(): void {
    clearAllModMounts();
    for (const reset of builtinGuardResets) reset();
}

/** Built-in modules add their guard-reset here so the test reset can clear them. */
const builtinGuardResets: Array<() => void> = [];

/** Called by the built-in modules so the test reset can clear their guards. */
export function __registerBuiltinGuardReset(fn: () => void): void {
    builtinGuardResets.push(fn);
}

/**
 * Test/teardown helper: clear only the MOD entries, keeping built-ins. Used
 * by tests that re-run the load cycle without re-registering built-ins.
 */
export function clearAllModEntries(): void {
    for (const region of Object.keys(regions) as MountRegionId[]) {
        const store = regions[region];
        const hadMods = store.entries.some((e) => e.mod !== undefined);
        if (!hadMods) continue;
        store.entries = store.entries.filter((e) => e.mod === undefined);
        store.perModCount.clear();
        // Keep built-in ids in `knownIds` so a re-registration is still
        // duplicate-checked — but clear the mod entries' ids.
        for (const id of [...store.knownIds]) {
            if (id.startsWith(MOD_PREFIX)) store.knownIds.delete(id);
        }
        store.nextWithinIndex.clear();
        sortRegion(store);
        notifyRegion(region);
    }
    // Phase 4.5 — clear mod-declared windows too (test helper that re-runs
    // the load cycle). `window.layer` is not in the `regions` Record above.
    clearAllWindowsWindows();
    revokedMods.clear();
    mountFaultStore.clear();
}

/** Test helper: the number of entries a mod has in a region (budget check assertion). */
export function getModEntryCount(region: MountRegionId, modId: string): number {
    return regions[region].perModCount.get(modId) ?? 0;
}

/** Test helper: whether a mod's lease is revoked. */
export function isModMountsRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}