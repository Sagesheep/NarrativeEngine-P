/**
 * Phase 6.2 — `loadOrderConflicts` unit tests.
 *
 * Pins that cross-mod fact conflicts are aggregated into per-mod summaries
 * with the winner named, and that non-conflict faults (throws, revoked,
 * duplicates) are NOT surfaced as load-order conflicts.
 *
 * The fact fault store is a real module singleton; each test resets it so
 * cases are independent. The mount fault store is also reset to confirm
 * mount duplicates (a per-mod programming bug) are NOT treated as cross-
 * mod conflicts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factFaultStore } from '../../facts/factFaults';
import { mountFaultStore } from '../../mounts/mountFaults';
import {
    collectLoadOrderConflicts,
    conflictsByModId,
} from '../loadOrderConflicts';

beforeEach(() => {
    factFaultStore.clear();
    mountFaultStore.clear();
});

describe('collectLoadOrderConflicts', () => {
    it('returns an empty list when no faults are recorded', () => {
        expect(collectLoadOrderConflicts()).toEqual([]);
    });

    it('surfaces a fact conflict with the winner named', () => {
        // Simulate the registry's conflict fault: mod 'later' lost a claim
        // on 'inCombat' to mod 'earlier'. The reason string is formatted
        // by `formatFactFaultReason` — we use the exact shape here so the
        // winner extraction is tested against the real format.
        factFaultStore.add({
            modId: 'later',
            file: 'later/manifest.json',
            kind: 'conflict',
            name: 'inCombat',
            reason: 'Later Mod: fact publisher "inCombat" lost a conflict with Earlier Mod (resolved by loading_order)',
        });

        const summaries = collectLoadOrderConflicts();
        expect(summaries).toHaveLength(1);
        expect(summaries[0].modId).toBe('later');
        expect(summaries[0].kind).toBe('fact');
        expect(summaries[0].name).toBe('inCombat');
        expect(summaries[0].winner).toBe('Earlier Mod');
    });

    it('does not surface a fact throw as a conflict', () => {
        factFaultStore.add({
            modId: 'broken',
            file: 'broken/manifest.json',
            kind: 'threw',
            name: 'inCombat',
            reason: 'Broken Mod: fact publisher "inCombat" threw (error); the fact yielded no value this turn',
        });
        expect(collectLoadOrderConflicts()).toEqual([]);
    });

    it('does not surface a fact duplicate as a conflict', () => {
        factFaultStore.add({
            modId: 'dup',
            file: 'dup/manifest.json',
            kind: 'duplicate',
            name: 'mood',
            reason: 'Dup Mod: fact publisher "mood" registered the same name twice',
        });
        expect(collectLoadOrderConflicts()).toEqual([]);
    });

    it('does not surface a mount duplicate as a conflict (per-mod bug, not cross-mod)', () => {
        mountFaultStore.add({
            modId: 'mounts-mod',
            file: 'mounts-mod/manifest.json',
            region: 'header.actions',
            kind: 'duplicate',
            entryId: 'btn',
            reason: 'Mounts Mod: mount in "header.actions" "btn" registered the same entry id twice',
        });
        expect(collectLoadOrderConflicts()).toEqual([]);
    });

    it('does not surface a mount budget fault as a conflict', () => {
        mountFaultStore.add({
            modId: 'greedy',
            file: 'greedy/manifest.json',
            region: 'header.actions',
            kind: 'budget',
            entryId: 'btn4',
            reason: 'Greedy Mod: mount in "header.actions" "btn4" exceeded the per-mod budget',
        });
        expect(collectLoadOrderConflicts()).toEqual([]);
    });

    it('surfaces multiple fact conflicts, one per losing mod', () => {
        factFaultStore.add({
            modId: 'later-a',
            file: 'a/manifest.json',
            kind: 'conflict',
            name: 'inCombat',
            reason: 'A: fact publisher "inCombat" lost a conflict with Winner (resolved by loading_order)',
        });
        factFaultStore.add({
            modId: 'later-b',
            file: 'b/manifest.json',
            kind: 'conflict',
            name: 'location',
            reason: 'B: fact publisher "location" lost a conflict with Other Winner (resolved by loading_order)',
        });

        const summaries = collectLoadOrderConflicts();
        expect(summaries).toHaveLength(2);
        const ids = summaries.map((s) => s.modId).sort();
        expect(ids).toEqual(['later-a', 'later-b']);
    });
});

describe('conflictsByModId', () => {
    it('keeps one row per mod, latest conflict wins', () => {
        factFaultStore.add({
            modId: 'greedy-loser',
            file: 'g/manifest.json',
            kind: 'conflict',
            name: 'inCombat',
            reason: 'Greedy: fact publisher "inCombat" lost a conflict with Winner (resolved by loading_order)',
        });
        factFaultStore.add({
            modId: 'greedy-loser',
            file: 'g/manifest.json',
            kind: 'conflict',
            name: 'location',
            reason: 'Greedy: fact publisher "location" lost a conflict with Other (resolved by loading_order)',
        });

        // `factFaultStore` is keyed by mod id — one record per mod, latest
        // wins — so that a publisher throwing every turn cannot grow the
        // Extensions list (`factFaults.ts`). Grouping therefore yields a
        // one-element list carrying the most recent conflict, not a history.
        const byMod = conflictsByModId();
        const list = byMod.get('greedy-loser');
        expect(list).toHaveLength(1);
        expect(list![0].name).toBe('location');
    });

    it('returns an empty map when there are no conflicts', () => {
        expect(conflictsByModId().size).toBe(0);
    });

    it('does not include mods that have only non-conflict faults', () => {
        factFaultStore.add({
            modId: 'threw-mod',
            file: 't/manifest.json',
            kind: 'threw',
            name: 'inCombat',
            reason: 'Threw: fact publisher "inCombat" threw (err)',
        });
        expect(conflictsByModId().has('threw-mod')).toBe(false);
    });
});