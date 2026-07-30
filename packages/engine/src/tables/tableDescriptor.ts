// Table descriptor + registry — Project 5 / WO-P5-03.
//
// A "table descriptor" declares what a campaign file suffix is and how the app
// touches it. The registry holds the descriptors and answers three derived
// questions: which suffixes are campaign files, which tables opt into
// export/import, and which tables have a generic GET/PUT route pair. The
// generic machinery (server route mounter, client accessor factory, slice
// factory) lives in the app packages and is parameterised by what the registry
// reports here.
//
// Every touchpoint is OPTIONAL and defaults to absent. WO-P5-03 §1 proved only
// 5 of 18 tables have all nine touchpoints; a descriptor that required all
// nine would force twelve behaviour changes on the first conversion.
//
// This file lives in @narrative/engine (pure). It cannot import React, Express,
// node:*, better-sqlite3, zustand, idb-keyval, or any platform API. The hooks
// it names are typed against opaque `unknown` inputs — the caller (server or
// client) supplies the concrete signature. The registry stores them, it does
// not invoke them.

/**
 * The shape of a single record a table holds.
 *
 * - `array`: a JSON array of records (`lore`, `npcs`, `enemies`, ...).
 * - `single-object`: a JSON object (`campaign`, `state`, `enemy-combat`,
 *   `overworld`, `divergence`).
 *
 * The generic machinery uses this only to pick the right empty default
 * (`[]` vs `null`); it does not constrain the record type.
 */
export type RecordShape = 'array' | 'single-object';

/**
 * The five escape-hatch hook kinds a descriptor may declare. WO-P5-03 §3 caps
 * the count at five on purpose: each must serve at least two real tables.
 *
 * The hooks are typed as `unknown` here because their concrete signatures
 * belong to the platform layer that invokes them (server-side Express
 * handlers vs client-side fetch/save). The registry stores the function
 * reference; the app layer casts it to the shape it promised when it
 * registered the descriptor. Nothing in this file calls a hook.
 *
 * - `onBeforeWrite`: run before the file is written. Forced by `state`
 *   (read-before-write to preserve omitted `pinnedExcerpts`, strip
 *   `debugPayload`/`retryable`/`precontext`).
 * - `onAfterWrite`: run after the file is written. Forced by `lore`
 *   (background embedding job); also by `state` (bump meta `lastPlayedAt`).
 * - `onAfterRead`: run after the file is read, may transform the record.
 *   Forced by `archive-chapters` (recompute + persist `sceneCount`), by
 *   `npcs` (home `pcRelation`, coerce array fields to strings).
 * - `onRemove`: run when a record is deleted by id. Forced by `locations`
 *   (clear `context.currentPlaceId`/`currentFeature` + state save), by
 *   `npcs` (pre-op backup).
 * - `writeLock`: serialise mutating handlers for this table. Forced by
 *   `archive-chapters` (the only table whose handlers take
 *   `withCampaignLock`).
 */
export type HookKind = 'onBeforeWrite' | 'onAfterWrite' | 'onAfterRead' | 'onRemove' | 'writeLock';

/** Per-table optional hooks, keyed by kind. Absent means "this table does not need it." */
export type TableHooks = Partial<Record<HookKind, (...args: unknown[]) => unknown>>;

/**
 * The declaration of a touchpoint a descriptor may have. Absent means "this
 * table does not have that touchpoint" — for thirteen of eighteen tables
 * that is the truth (WO-P5-03 §1).
 *
 * Touchpoint evidence (file/line) lives in the census; the descriptor records
 * the fact, not the evidence.
 */
export interface TouchpointDeclaration<T = unknown> {
    present: true;
    /** Opaque pointer to the concrete handler/object. The app layer interprets it. */
    value: T;
}

/** Convenience alias for "this touchpoint is absent". */
export type AbsentTouchpoint = { present: false };

/** A touchpoint slot: present-with-value or absent. */
export type Touchpoint<T = unknown> = TouchpointDeclaration<T> | AbsentTouchpoint;

const isPresent = <T>(t: Touchpoint<T>): t is TouchpointDeclaration<T> => t.present === true;

/**
 * The full descriptor. Every field except `name`, `fileSuffix`, and
 * `recordShape` is optional, because every one of them is a touchpoint a
 * table may not have.
 *
 * Per WO-P5-03 §1, a descriptor that requires all nine touchpoints would
 * force twelve behaviour changes on conversion. A descriptor that knows a
 * table only by suffix (the minimum) is enough for `CAMPAIGN_FILE_SUFFIXES`
 * to be derived.
 */
export interface TableDescriptor {
    /** Stable unique table name. Opaque — the registry does not branch on it. */
    name: string;
    /** File suffix with leading dot, e.g. `.lore.json`. */
    fileSuffix: string;
    /** Shape of the record this table stores. */
    recordShape: RecordShape;

    /**
     * Server-side schema validator invoked on PUT and on import. Absent
     * means "no validation, write req.body verbatim" — true for 13 of 18.
     */
    serverSchema?: Touchpoint<(...args: unknown[]) => { errors: unknown[]; value: unknown }>;
    /**
     * Client-side schema normaliser invoked on load. Absent means "no
     * normaliser" — true for 13 of 18. Distinct from the server schema
     * because the client normalises loaded data in place while the server
     * rejects malformed PUTs.
     */
    clientSchema?: Touchpoint<(value: unknown) => unknown>;
    /**
     * Export/import bundle participant. Absent means the table is NOT in
     * the export/import bundle today (e.g. `locations`, `divergence`,
     * `overworld`, `archive`). WO-P5-03 §6: opt-in per descriptor so
     * converting a table never silently changes export/import behaviour.
     */
    transfer?: Touchpoint<{ bundleKey: string }>;
    /**
     * Hydration loader — called from the campaign hydrator's `Promise.all`.
     * Absent means the table is not loaded during hydration (e.g. `facts`,
     * `overworld`, `archive`).
     */
    hydrator?: Touchpoint<(campaignId: string) => Promise<unknown>>;
    /**
     * Slice state field declaration. Absent means the table's slice state
     * lives elsewhere (`overworld` → mapSlice, `divergence` → chatSlice) or
     * the table has no slice state (`archive`).
     */
    slice?: Touchpoint<{ field: string }>;
    /**
     * Public store accessors (get/save). `save: false` marks a read-only
     * accessor (`archive-index`, `entities`, `enemy-combat`). Absent means
     * the table has no entry in `campaignStore.ts` at all (`overworld`,
     * `archive`).
     */
    storeAccessor?: Touchpoint<{ read: boolean; write: boolean }>;
    /**
     * Server GET/PUT route pair. Absent means the table's routes are
     * bespoke (POST/DELETE/PATCH, in another router file) or it has no
     * routes at all. WO-P5-03 §2 lists seven route files; the generic pair
     * is an opt-in, not the only shape.
     */
    serverRoutes?: Touchpoint<{ get: true; put: true }>;

    /** Per-table escape hatches. See {@link HookKind} and WO-P5-03 §3. */
    hooks?: TableHooks;
}

/**
 * The table registry. Holds descriptors and answers the derived questions the
 * generic machinery asks. It NEVER branches on `descriptor.name` — the opaque
 * test (swap every name for a meaningless string and assert identical
 * behaviour) is the contract.
 *
 * Empty registry → the app behaves identically to today (default-as-plugin).
 * The server-side suffix list degrades to the built-in 18 suffixes; no generic
 * routes are mounted; transfer iterates nothing new. WO-P5-03 builds this
 * machinery and converts nothing.
 */
export interface TableRegistry {
    /** Register a descriptor. Throws on duplicate `name` — a packaging bug. */
    register(descriptor: TableDescriptor): void;
    /** Remove a descriptor by name. Returns whether it was present. */
    unregister(name: string): boolean;
    /** All registered descriptors, in registration order. */
    list(): readonly TableDescriptor[];
    get(name: string): TableDescriptor | undefined;
    clear(): void;

    /**
     * Every registered file suffix, in registration order. Used to derive
     * `CAMPAIGN_FILE_SUFFIXES` on the server. With no descriptors this is
     * the empty list — the server layer falls back to the built-in 18.
     */
    suffixes(): readonly string[];

    /**
     * Descriptors that declare `transfer`. Export/import iterates these.
     * With no descriptors this is the empty list, so the bundle is unchanged.
     */
    transferable(): readonly TableDescriptor[];

    /**
     * Descriptors that declare `serverRoutes` (a GET/PUT pair). The generic
     * route mounter iterates these. With no descriptors this is the empty
     * list, so no generic route is mounted and the seven existing route
     * files are untouched.
     */
    withGenericRoutes(): readonly TableDescriptor[];
}

export function createTableRegistry(): TableRegistry {
    const byName = new Map<string, TableDescriptor>();
    const order: string[] = [];

    return {
        register(descriptor) {
            if (byName.has(descriptor.name)) {
                throw new Error(`[tables] duplicate descriptor: ${descriptor.name}`);
            }
            byName.set(descriptor.name, descriptor);
            order.push(descriptor.name);
        },

        unregister(name) {
            const removed = byName.delete(name);
            if (removed) {
                const idx = order.indexOf(name);
                if (idx >= 0) order.splice(idx, 1);
            }
            return removed;
        },

        list() {
            return order.map((n) => byName.get(n) as TableDescriptor);
        },

        get(name) {
            return byName.get(name);
        },

        clear() {
            byName.clear();
            order.length = 0;
        },

        suffixes() {
            return order.map((n) => (byName.get(n) as TableDescriptor).fileSuffix);
        },

        transferable() {
            return order
                .map((n) => byName.get(n) as TableDescriptor)
                .filter((d) => d.transfer !== undefined && isPresent(d.transfer));
        },

        withGenericRoutes() {
            return order
                .map((n) => byName.get(n) as TableDescriptor)
                .filter((d) => d.serverRoutes !== undefined && isPresent(d.serverRoutes));
        },
    };
}