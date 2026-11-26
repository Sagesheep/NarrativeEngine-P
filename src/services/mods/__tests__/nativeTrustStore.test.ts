/**
 * Phase 6.1 — `nativeTrustStore` unit tests.
 *
 * Pins the "accept once per mod id, re-warn if native is added later"
 * contract from `TRUST.md` §D. Uses an in-memory `NativeTrustStore` so the
 * tests do not touch `idb-keyval` (the real store lazy-imports it).
 */
import { describe, expect, it } from 'vitest';
import {
    needsNativeTrustWarning,
    recordNativeTrustAcceptance,
    type NativeTrustStore,
} from '../nativeTrustStore';

/** A throwaway in-memory store, so tests are synchronous and hermetic. */
function memoryStore(): NativeTrustStore {
    const map = new Map<string, { acceptedNative: boolean; version: string }>();
    return {
        async get(modId) { return map.get(modId); },
        async set(modId, record) { map.set(modId, record); },
        async clear() { map.clear(); },
    };
}

describe('needsNativeTrustWarning', () => {
    it('returns false when the mod has no native block', async () => {
        const store = memoryStore();
        expect(await needsNativeTrustWarning(store, 'plain-mod', false)).toBe(false);
    });

    it('returns true when the mod has native and no record exists', async () => {
        const store = memoryStore();
        expect(await needsNativeTrustWarning(store, 'native-mod', true)).toBe(true);
    });

    it('returns false when the mod has native and was already accepted native', async () => {
        const store = memoryStore();
        await recordNativeTrustAcceptance(store, 'native-mod', '1.0.0');
        expect(await needsNativeTrustWarning(store, 'native-mod', true)).toBe(false);
    });

    it('returns true again if the record accepted non-native and native was later added', async () => {
        const store = memoryStore();
        // User accepted the mod back when it had no native block. The record
        // is written by the non-native enable path... but this store is only
        // written by `recordNativeTrustAcceptance` (which sets acceptedNative:
        // true). The §D contract is "re-warn if the mod later adds native
        // after having been accepted as non-native." A non-native acceptance
        // would carry `acceptedNative: false`. Simulate that:
        await store.set('mod-id', { acceptedNative: false, version: '1.0.0' });
        // Now the mod adds native in v2.0.0.
        expect(await needsNativeTrustWarning(store, 'mod-id', true)).toBe(true);
    });

    it('does not re-warn on a version bump that keeps native (accepted native stays accepted)', async () => {
        const store = memoryStore();
        await recordNativeTrustAcceptance(store, 'native-mod', '1.0.0');
        // Mod upgrades to 2.0.0, still native. No re-warn — the user already
        // accepted native for this mod id. §D: "show it only again if the mod
        // later adds a native entry point after having been accepted as
        // non-native."
        expect(await needsNativeTrustWarning(store, 'native-mod', true)).toBe(false);
    });
});

describe('recordNativeTrustAcceptance', () => {
    it('writes acceptedNative: true with the version', async () => {
        const store = memoryStore();
        await recordNativeTrustAcceptance(store, 'native-mod', '1.2.0');
        const record = await store.get('native-mod');
        expect(record).toEqual({ acceptedNative: true, version: '1.2.0' });
    });

    it('overwrites a prior non-native acceptance so the next enable skips the dialog', async () => {
        const store = memoryStore();
        await store.set('mod-id', { acceptedNative: false, version: '1.0.0' });
        await recordNativeTrustAcceptance(store, 'mod-id', '2.0.0');
        expect(await needsNativeTrustWarning(store, 'mod-id', true)).toBe(false);
    });
});