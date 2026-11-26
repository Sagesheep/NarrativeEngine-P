/**
 * Phase 6.1 — the native-tier trust acceptance store.
 *
 * `TRUST.md` §D requires the Mod Management screen to show a verbatim
 * security disclosure the first time a user enables a native-tier mod, and
 * again only if "the mod later adds a native entry point after having been
 * accepted as non-native." This module is the persistence layer for that
 * decision: one record per mod id, surviving across app loads, stored in
 * `idb-keyval` under the `nn_mod_trust_<modId>` namespace (the same store the
 * settings slice and `modBootstrap`'s `nn_mod_seen_<modId>` records use).
 *
 * The record carries a single boolean the UI reads as "has the user already
 * accepted native-tier access for this mod id?" The contract:
 *
 *  • No record, mod has `native` → warn. Acceptance writes `acceptedNative: true`.
 *  • Record with `acceptedNative: true`, mod has `native` → no warn (the user
 *    already accepted native for this mod id).
 *  • Record with `acceptedNative: false` (the user accepted the mod back when
 *    it had no `native` block), mod has since added `native` → warn, then write
 *    `acceptedNative: true` on acceptance.
 *
 * A version bump that keeps the `native` block does NOT re-warn — only the
 * addition of native after a prior non-native acceptance does. This is the
 * exact behaviour §D specifies ("show it only again if the mod later adds a
 * native entry point after having been accepted as non-native").
 *
 * The store is an interface so tests use an in-memory implementation and the
 * real one uses `idb-keyval`, keeping this module pure and testable (mirrors
 * `LifecycleStateStore` in `lifecycleTypes.ts`).
 */
export interface NativeTrustRecord {
    /** True once the user has accepted the native-tier warning for this mod id. */
    readonly acceptedNative: boolean;
    /** The mod version at which the record was last written, for diagnostics. */
    readonly version: string;
}

export interface NativeTrustStore {
    get(modId: string): Promise<NativeTrustRecord | undefined>;
    set(modId: string, record: NativeTrustRecord): Promise<void>;
    clear(): Promise<void>;
}

/**
 * The real store, lazily importing `idb-keyval` so this module stays importable
 * in tests without a DOM. The key namespace matches the existing
 * `nn_mod_seen_` convention from `modBootstrap.ts` (Phase 1.4 §3), prefixed
 * `nn_mod_trust_` so the two record sets never collide.
 */
export function createIdbNativeTrustStore(): NativeTrustStore {
    const keyFor = (modId: string) => `nn_mod_trust_${modId}`;
    return {
        async get(modId) {
            const { get: idbGet } = await import('idb-keyval');
            const value = await idbGet(keyFor(modId));
            if (typeof value === 'object' && value !== null && 'acceptedNative' in value) {
                return value as NativeTrustRecord;
            }
            return undefined;
        },
        async set(modId, record) {
            const { set: idbSet } = await import('idb-keyval');
            await idbSet(keyFor(modId), record);
        },
        async clear() {
            const { keys: idbKeys, del: idbDel } = await import('idb-keyval');
            const allKeys = await idbKeys();
            for (const key of allKeys) {
                if (typeof key === 'string' && key.startsWith('nn_mod_trust_')) {
                    await idbDel(key);
                }
            }
        },
    };
}

/**
 * Module-level singleton, created lazily on first use (mirrors
 * `getLifecycleWiring` in `modBootstrap.ts`). A single store survives across
 * calls within a session, so an acceptance in one tab persists for the next
 * toggle in the same session.
 */
let trustStore: NativeTrustStore | undefined;

export function getNativeTrustStore(): NativeTrustStore {
    if (!trustStore) trustStore = createIdbNativeTrustStore();
    return trustStore;
}

/**
 * Test seam: drop the singleton so a fresh store is created. The bootstrap
 * tests use this to assert idempotent behaviour without leaking module state
 * across cases (mirrors `__resetLifecycleHost`).
 */
export function __resetNativeTrustStore(): void {
    trustStore = undefined;
}

/**
 * Read-side helper for the UI: should the warning be shown for this mod?
 *
 * Returns `true` when the mod has a `native` block AND the user has not yet
 * accepted native-tier access for this mod id. A mod without a `native` block
 * never triggers the warning (declarative and sandboxed-compute mods do not
 * receive page-level access — `TRUST.md` §A). A mod with `native` and an
 * existing `acceptedNative: true` record does not trigger (the user already
 * accepted). A mod with `native` and either no record or an
 * `acceptedNative: false` record triggers.
 *
 * The loader is the source of truth for whether a mod has `native` — the UI
 * passes the validated `mod.native` field, not a string the user typed.
 */
export async function needsNativeTrustWarning(
    store: NativeTrustStore,
    modId: string,
    hasNative: boolean,
): Promise<boolean> {
    if (!hasNative) return false;
    const record = await store.get(modId);
    return !record?.acceptedNative;
}

/**
 * Write-side helper for the UI: record acceptance of the native-tier warning.
 *
 * Called from the dialog's affirmative action ("Enable native mod"). After
 * this call, `needsNativeTrustWarning` for the same mod id (with `native`
 * still present) returns `false` until the record is cleared.
 */
export async function recordNativeTrustAcceptance(
    store: NativeTrustStore,
    modId: string,
    version: string,
): Promise<void> {
    await store.set(modId, { acceptedNative: true, version });
}