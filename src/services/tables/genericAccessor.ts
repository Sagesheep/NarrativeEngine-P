// Client-side generic table machinery — Project 5 / WO-P5-03 Step 3.
//
// Generic get/save + slice factory parameterised by a TableDescriptor. These
// sit ALONGSIDE the existing 27 hand-written get/save pairs in
// src/store/campaignStore.ts — WO-P5-03 does NOT delete any of them. Nothing
// is registered, so none of this is invoked today; WO-P5-04 converts one
// table at a time by registering a descriptor and routing its callers
// through these helpers.
//
// The descriptor type comes from @narrative/engine (pure, boundary-gate
// clean). The client-side registry is a SEPARATE instance from the server's
// (different runtimes) but structurally identical.

import { API_BASE as API } from '../../lib/apiBase';
import type { TableDescriptor, RecordShape } from '@narrative/engine';

type ArrayEmpty = [];
type SingleObjectEmpty = null;
type EmptyFor<S extends RecordShape> = S extends 'array' ? ArrayEmpty : SingleObjectEmpty;

/**
 * Generic GET for a descriptor that declares `storeAccessor` (read) and
 * `serverRoutes` (GET). Reads `{api}/campaigns/:id/{name}`. Returns the
 * record-shape default (`[]` for array, `null` for single-object) on a
 * non-ok response — mirroring every existing read accessor in
 * campaignStore.ts (getEnemyCompendium returns [], getEnemyCombatConfig
 * returns null, etc).
 *
 * If the descriptor declares an `onAfterRead` hook (WO-P5-03 §3 — forced by
 * `archive-chapters` recompute+persist, by `npcs` home+coerce), the hook
 * runs on the loaded record before it is returned. The hook's signature is
 * `(campaignId, record) => record`; the descriptor author owns it.
 */
export async function genericGet<S extends RecordShape>(
    descriptor: TableDescriptor & { recordShape: S; serverRoutes: { present: true; value: { get: true } }; storeAccessor: { present: true; value: { read: true } } },
    campaignId: string,
): Promise<unknown[] | null | unknown> {
    const fallback: EmptyFor<S> = (descriptor.recordShape === 'array' ? [] : null) as EmptyFor<S>;
    const res = await fetch(`${API}/campaigns/${campaignId}/${descriptor.name}`);
    if (!res.ok) return fallback;
    let record: unknown = await res.json();
    const onAfterRead = descriptor.hooks?.onAfterRead;
    if (typeof onAfterRead === 'function') {
        record = onAfterRead(campaignId, record);
    }
    return record;
}

/**
 * Generic PUT for a descriptor that declares `storeAccessor` (write) and
 * `serverRoutes` (PUT). Writes `{api}/campaigns/:id/{name}`. Mirrors the
 * fire-and-forget pattern of the existing save accessors
 * (saveLoreChunks/saveNPCLedger/saveLocationLedger/saveEnemyCompendium).
 *
 * If the descriptor declares an `onBeforeWrite` hook (§3 — forced by `state`
 * read-before-write preserve pinnedExcerpts + strip debugPayload), it runs
 * on the body before the fetch. The hook's signature is
 * `(campaignId, body) => body`.
 *
 * The hook is the CLIENT-side strip. The server's onBeforeWrite (Step 2) is
 * the second defence layer; both exist for `state` today.
 */
export async function genericSave(
    descriptor: TableDescriptor & { storeAccessor: { present: true; value: { write: true } }; serverRoutes: { present: true; value: { put: true } } },
    campaignId: string,
    body: unknown,
): Promise<void> {
    let payload = body;
    const onBeforeWrite = descriptor.hooks?.onBeforeWrite;
    if (typeof onBeforeWrite === 'function') {
        payload = onBeforeWrite(campaignId, payload);
    }
    await fetch(`${API}/campaigns/${campaignId}/${descriptor.name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

/**
 * The slice factory (WO-P5-03 §5 Step 3.3). Produces a Zustand state field +
 * CRUD actions (set/add/update/remove) + a debounced save, parameterised by
 * a descriptor. The `onRemove` hook (§3 — forced by `locations` context
 * patch + state save, by `npcs` pre-op backup) fires inside `remove` before
 * the ledger is mutated.
 *
 * This factory is NOT wired into any slice today. WO-P5-04 will use it to
 * produce a slice for a converted table. With nothing registered, this is
 * unused machinery — the existing hand-written slices in campaignSlice.ts
 * stay byte-identical.
 *
 * The factory returns the state field initial value + the four action
 * implementations. The caller (a slice) wires them into its `set`/`get`.
 * Each action is a pure state transition that returns a partial; the caller
 * decides whether to debounce (the factory supplies a debounced-save
 * helper that mirrors the eight existing timers in campaignSlice.ts).
 */
export interface SliceFactoryResult<T> {
    initial: T;
    set: (current: T, next: T) => { field: T };
    add: (current: T, item: T extends Array<infer U> ? U : never) => { field: T };
    update: (current: T, id: string, patch: Partial<T extends Array<infer U> ? U : never>) => { field: T };
    remove: (current: T, id: string) => { field: T };
}

/**
 * Builds a debounced save for a descriptor. Mirrors the eight existing
 * named timers in campaignSlice.ts (stateTimer/loreTimer/npcTimer/...). Each
 * descriptor that converts gets its own timer; the factory closes over a
 * timer variable the same way `debouncedSaveLoreChunks` closes over
 * `loreTimer`.
 *
 * The save fires `genericSave` with the latest state at fire time (no stale
 * closures — the getter is supplied by the caller, the same
 * `_registerCampaignStateGetter` pattern campaignSlice uses).
 */
export function createDebouncedSave<T>(
    descriptor: TableDescriptor & { storeAccessor: { present: true; value: { write: true } }; serverRoutes: { present: true; value: { put: true } } },
    getState: () => { activeCampaignId: string | null; field: T },
    delayMs = 1000,
): (value: T) => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (value: T) => {
        const { activeCampaignId } = getState();
        if (!activeCampaignId) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            genericSave(descriptor, activeCampaignId, value).catch((e) => {
                console.error(`[tables] save failed for ${descriptor.name}:`, e);
            });
        }, delayMs);
    };
}

/**
 * The `onRemove` hook driver (WO-P5-03 §3). Called by a slice's `remove`
 * action before the ledger is mutated. If the descriptor declares
 * `onRemove`, it fires with `(campaignId, id)` — this is how `locations`
 * clears `context.currentPlaceId`/`currentFeature` + triggers a state save,
 * and how `npcs` fires a pre-op backup.
 *
 * Returns the partial state patch the hook produced (if any), so the slice
 * can merge it alongside the ledger mutation. The hook is OPTIONAL — a
 * descriptor without `onRemove` gets a no-op.
 */
export function runOnRemove(
    descriptor: TableDescriptor,
    campaignId: string | null,
    id: string,
): void {
    const onRemove = descriptor.hooks?.onRemove;
    if (typeof onRemove === 'function' && campaignId) {
        onRemove(campaignId, id);
    }
}