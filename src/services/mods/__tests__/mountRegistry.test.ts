/**
 * Phase 4.2 — the mount registry tests.
 *
 * Proves the `MOUNTS.md` contract:
 *   • Built-ins render first in their declared order; the trailing group
 *     (`settings`+`exit` in header, `archive` in composer) sorts last
 *     within the built-ins (§3.3).
 *   • Mod entries insert between the leading built-ins and the trailing
 *     group, sorted by `(loadIndex, withinModIndex)` (§3.2).
 *   • A mid-session enable INSERTS at its proper place, not appends (§3.2).
 *   • The per-mod budget of 2 per row is enforced with a surfaced fault,
 *     not a silent drop (§5).
 *   • A duplicate entry id in one region faults naming both (§4.1).
 *   • An unknown icon faults and renders with the fallback glyph (§8.2).
 *   • Teardown is host-owned: `disableModMounts` removes every entry the
 *     mod registered; `enableModMounts` clears the revoked lease (§8.5).
 *   • A registration after disable is a no-op plus a `revoked` fault (§8.5).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
    registerModChrome,
    registerModMessageBelow,
    readRegion,
    readMessageBelowSlots,
    subscribeToRegion,
    disableModMounts,
    enableModMounts,
    clearAllModEntries,
    getModEntryCount,
    isModMountsRevoked,
    qualifyEntryId,
    resetMountRegistryForTests,
} from '../mounts/mountRegistry';
import { mountFaultStore } from '../mounts/mountFaults';
import { resolveMountIcon, MOUNT_ICON_FALLBACK } from '../mounts/mountIcons';
import { MOUNT_BUDGET } from '../mounts/mountTypes';
import { registerHeaderBuiltins, HEADER_BUILTIN_IDS } from '../mounts/headerBuiltins';
import { registerComposerBuiltins, COMPOSER_BUILTIN_IDS } from '../mounts/composerBuiltins';

const MOD_A = { id: 'mod-a', name: 'Mod A' };
const MOD_B = { id: 'mod-b', name: 'Mod B' };

const noopEntry = (id: string) => ({
    id,
    icon: 'Swords',
    label: id,
    onSelect: () => undefined,
});

beforeEach(() => {
    // `resetMountRegistryForTests` clears the region stores AND resets the
    // built-in registration guards, so each test re-registers built-ins
    // cleanly. Production never calls this.
    resetMountRegistryForTests();
});

describe('Phase 4.2 — mount registry: built-in ordering & trailing group', () => {
    it('header built-ins register in their declared order with settings+exit last', () => {
        registerHeaderBuiltins();
        const ids = readRegion('header.actions').map((e) => e.entryId);
        expect(ids).toEqual([...HEADER_BUILTIN_IDS]);
        // The trailing group is last within the built-ins.
        const settingsIdx = ids.indexOf('settings');
        const exitIdx = ids.indexOf('exit');
        expect(settingsIdx).toBe(ids.length - 2);
        expect(exitIdx).toBe(ids.length - 1);
    });

    it('composer built-ins register in their declared order with archive last', () => {
        registerComposerBuiltins();
        const ids = readRegion('composer.actions').map((e) => e.entryId);
        expect(ids).toEqual([...COMPOSER_BUILTIN_IDS]);
        expect(ids[ids.length - 1]).toBe('archive');
    });

    it('registerBuiltin is idempotent (a second call does not double-register)', () => {
        registerHeaderBuiltins();
        registerHeaderBuiltins();
        expect(readRegion('header.actions').map((e) => e.entryId)).toEqual([...HEADER_BUILTIN_IDS]);
    });
});

describe('Phase 4.2 — mount registry: mod entry ordering (loadIndex, withinModIndex)', () => {
    it('mod entries insert between leading built-ins and the trailing group (§3.3)', () => {
        registerHeaderBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('alpha'), 5);
        const ids = readRegion('header.actions').map((e) => e.qualifiedId);
        // alpha sits after the leading built-ins (backup..pinned) and before settings/exit.
        const alphaIdx = ids.indexOf('mod.mod-a.alpha');
        const settingsIdx = ids.indexOf('settings');
        expect(alphaIdx).toBeGreaterThan(-1);
        expect(alphaIdx).toBeLessThan(settingsIdx);
    });

    it('orders mod entries by loadIndex ascending', () => {
        registerComposerBuiltins();
        // MOD_B has a lower loadIndex than MOD_A, so it sorts first.
        registerModChrome('composer.actions', MOD_A, noopEntry('a'), 10);
        registerModChrome('composer.actions', MOD_B, noopEntry('b'), 5);
        const modEntries = readRegion('composer.actions').filter((e) => e.mod !== undefined);
        expect(modEntries.map((e) => e.qualifiedId)).toEqual(['mod.mod-b.b', 'mod.mod-a.a']);
    });

    it('orders entries within one mod by registration order (withinModIndex)', () => {
        registerComposerBuiltins();
        registerModChrome('composer.actions', MOD_A, noopEntry('first'), 0);
        registerModChrome('composer.actions', MOD_A, noopEntry('second'), 0);
        const modEntries = readRegion('composer.actions').filter((e) => e.mod?.id === 'mod-a');
        expect(modEntries.map((e) => e.entryId)).toEqual(['first', 'second']);
    });

    it('a mid-session enable INSERTS at its proper place, not appends (§3.2)', () => {
        registerComposerBuiltins();
        // MOD_A registers first (loadIndex 5).
        registerModChrome('composer.actions', MOD_A, noopEntry('a'), 5);
        // MOD_B registers second but has a LOWER loadIndex (it loaded earlier;
        // it was just enabled mid-session). It must insert BEFORE MOD_A.
        registerModChrome('composer.actions', MOD_B, noopEntry('b'), 2);
        const modEntries = readRegion('composer.actions').filter((e) => e.mod !== undefined);
        expect(modEntries.map((e) => e.qualifiedId)).toEqual(['mod.mod-b.b', 'mod.mod-a.a']);
    });
});

describe('Phase 4.2 — mount registry: budget (§5)', () => {
    it('allows up to 2 entries per mod in header.actions', () => {
        registerHeaderBuiltins();
        const h1 = registerModChrome('header.actions', MOD_A, noopEntry('h1'), 0);
        const h2 = registerModChrome('header.actions', MOD_A, noopEntry('h2'), 0);
        const h3 = registerModChrome('header.actions', MOD_A, noopEntry('h3'), 0);
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(2);
        expect(h3.update).toBeInstanceOf(Function);
        // The third entry is a no-op handle: removing it does nothing.
        h3.remove();
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(2);
        // h1/h2 can be removed.
        h1.remove();
        h2.remove();
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(0);
    });

    it('over-budget registration records a budget fault naming the mod and region', () => {
        registerHeaderBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('h1'), 0);
        registerModChrome('header.actions', MOD_A, noopEntry('h2'), 0);
        mountFaultStore.clear();
        registerModChrome('header.actions', MOD_A, noopEntry('h3'), 0);
        const faults = mountFaultStore.getRecords();
        expect(faults.length).toBe(1);
        expect(faults[0].kind).toBe('budget');
        expect(faults[0].modId).toBe('mod-a');
        expect(faults[0].region).toBe('header.actions');
        expect(faults[0].entryId).toBe('h3');
    });

    it('budget caps match MOUNTS.md §5', () => {
        expect(MOUNT_BUDGET['header.actions']).toBe(2);
        expect(MOUNT_BUDGET['composer.actions']).toBe(2);
        expect(MOUNT_BUDGET['message.actions']).toBe(3);
        expect(MOUNT_BUDGET['chat.rail']).toBe(1);
        expect(MOUNT_BUDGET['message.below']).toBe(1);
        expect(MOUNT_BUDGET['window.layer']).toBe(3);
    });
});

describe('Phase 4.2 — mount registry: duplicate id (§4.1)', () => {
    it('a second registration of the same entry id in one region faults', () => {
        registerHeaderBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('dup'), 0);
        mountFaultStore.clear();
        registerModChrome('header.actions', MOD_A, noopEntry('dup'), 0);
        const faults = mountFaultStore.getRecords();
        expect(faults.length).toBe(1);
        expect(faults[0].kind).toBe('duplicate');
        expect(faults[0].entryId).toBe('dup');
        // Only one entry exists.
        const modEntries = readRegion('header.actions').filter((e) => e.mod?.id === 'mod-a');
        expect(modEntries.length).toBe(1);
    });

    it('two mods can register the same entry id (namespacing prevents collision)', () => {
        registerHeaderBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('shared'), 0);
        registerModChrome('header.actions', MOD_B, noopEntry('shared'), 0);
        const modEntries = readRegion('header.actions').filter((e) => e.mod !== undefined);
        expect(modEntries.map((e) => e.qualifiedId).sort()).toEqual(['mod.mod-a.shared', 'mod.mod-b.shared']);
    });

    it('a mod cannot impersonate a built-in id (the mod. prefix is structural)', () => {
        registerHeaderBuiltins();
        // A mod registering entry id 'settings' becomes 'mod.mod-a.settings',
        // which is NOT the built-in 'settings'.
        registerModChrome('header.actions', MOD_A, noopEntry('settings'), 0);
        const ids = readRegion('header.actions').map((e) => e.qualifiedId);
        expect(ids).toContain('settings'); // the built-in
        expect(ids).toContain('mod.mod-a.settings'); // the mod entry
    });
});

describe('Phase 4.2 — mount registry: icon resolution + fault (§8.2)', () => {
    it('resolves a known lucide icon name to a component', () => {
        const { icon, known } = resolveMountIcon('Swords');
        expect(known).toBe(true);
        // Lucide icons are `React.forwardRef` components (objects with a
        // `$$typeof` marker), not plain functions.
        expect(icon).toBeTruthy();
        expect(typeof icon.render === 'function' || typeof icon === 'function' || '$$typeof' in (icon as object)).toBe(true);
    });

    it('an unknown icon name returns the fallback glyph and known=false', () => {
        const { icon, known } = resolveMountIcon('NotARealIcon');
        expect(known).toBe(false);
        expect(icon).toBe(MOUNT_ICON_FALLBACK);
    });

    it('an unknown icon records an icon fault but still registers the entry', () => {
        registerHeaderBuiltins();
        mountFaultStore.clear();
        registerModChrome('header.actions', MOD_A, {
            id: 'badicon',
            icon: 'NotARealIcon',
            label: 'Bad',
            onSelect: () => undefined,
        }, 0);
        const faults = mountFaultStore.getRecords();
        expect(faults.length).toBe(1);
        expect(faults[0].kind).toBe('icon');
        expect(faults[0].entryId).toBe('badicon');
        // The entry still registered (with the fallback glyph).
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(1);
    });
});

describe('Phase 4.2 — mount registry: host-owned teardown (§8.5)', () => {
    it('disableModMounts removes every entry the mod registered', () => {
        registerHeaderBuiltins();
        registerComposerBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('h1'), 0);
        registerModChrome('composer.actions', MOD_A, noopEntry('c1'), 0);
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(1);
        expect(getModEntryCount('composer.actions', 'mod-a')).toBe(1);
        const removed = disableModMounts('mod-a');
        expect(removed).toBe(2);
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(0);
        expect(getModEntryCount('composer.actions', 'mod-a')).toBe(0);
    });

    it('disableModMounts revokes the lease; a later registration is a no-op + revoked fault', () => {
        registerHeaderBuiltins();
        disableModMounts('mod-a');
        expect(isModMountsRevoked('mod-a')).toBe(true);
        mountFaultStore.clear();
        const handle = registerModChrome('header.actions', MOD_A, noopEntry('after'), 0);
        const faults = mountFaultStore.getRecords();
        expect(faults.length).toBe(1);
        expect(faults[0].kind).toBe('revoked');
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(0);
        // The handle is a no-op.
        handle.remove();
        handle.update();
    });

    it('enableModMounts clears the revoked lease so the mod can register again', () => {
        registerHeaderBuiltins();
        disableModMounts('mod-a');
        enableModMounts('mod-a');
        expect(isModMountsRevoked('mod-a')).toBe(false);
        const handle = registerModChrome('header.actions', MOD_A, noopEntry('after-enable'), 0);
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(1);
        handle.remove();
    });

    it('MountHandle.remove unregisters a single entry', () => {
        registerHeaderBuiltins();
        const handle = registerModChrome('header.actions', MOD_A, noopEntry('removable'), 0);
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(1);
        handle.remove();
        expect(getModEntryCount('header.actions', 'mod-a')).toBe(0);
    });

    it('clearAllModEntries removes only mod entries, keeping built-ins', () => {
        registerHeaderBuiltins();
        registerModChrome('header.actions', MOD_A, noopEntry('a1'), 0);
        clearAllModEntries();
        const ids = readRegion('header.actions').map((e) => e.entryId);
        expect(ids).toEqual([...HEADER_BUILTIN_IDS]);
    });
});

describe('Phase 4.2 — mount registry: subscribe (React row re-renders)', () => {
    it('subscribeToRegion fires on add and remove', () => {
        registerHeaderBuiltins();
        let notifications = 0;
        const unsubscribe = subscribeToRegion('header.actions', () => { notifications++; });
        registerModChrome('header.actions', MOD_A, noopEntry('sub1'), 0);
        expect(notifications).toBe(1);
        const handle = registerModChrome('header.actions', MOD_A, noopEntry('sub2'), 1);
        expect(notifications).toBe(2);
        handle.remove();
        expect(notifications).toBe(3);
        unsubscribe();
        registerModChrome('header.actions', MOD_A, noopEntry('sub3'), 2);
        expect(notifications).toBe(3);
    });
});

describe('Phase 4.2 — mount registry: qualified id', () => {
    it('qualifyEntryId produces mod.<modId>.<entryId>', () => {
        expect(qualifyEntryId('arc', 'injectArc')).toBe('mod.arc.injectArc');
    });
});

// ── Phase 4.4 — message.actions (chrome) + message.below (content) ──────
//
// `MOUNTS.md` §2.5 / §2.6. The chrome path (`message.actions`) goes through
// the same `registerModChrome` as the header/composer rows — the registry is
// region-agnostic. The content path (`message.below`) goes through the new
// `registerModMessageBelow`, mirroring `registerModRail`. These tests prove
// the two paths against the same contract the rail already satisfies:
// budget (§5), duplicate id (§4.1), host-owned teardown (§8.5), and ordering
// by `(loadIndex, withinModIndex)` (§3.2).

describe('Phase 4.4 — message.actions chrome registry', () => {
    it('registers a mod entry through registerModChrome on message.actions', () => {
        const handle = registerModChrome('message.actions', MOD_A, noopEntry('tag'), 0);
        expect(getModEntryCount('message.actions', 'mod-a')).toBe(1);
        const ids = readRegion('message.actions').map((e) => e.qualifiedId);
        expect(ids).toContain('mod.mod-a.tag');
        handle.remove();
        expect(getModEntryCount('message.actions', 'mod-a')).toBe(0);
    });

    it('enforces the per-mod budget of 3 on message.actions (MOUNTS.md §5)', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('a1'), 0);
        registerModChrome('message.actions', MOD_A, noopEntry('a2'), 0);
        registerModChrome('message.actions', MOD_A, noopEntry('a3'), 0);
        mountFaultStore.clear();
        registerModChrome('message.actions', MOD_A, noopEntry('a4'), 0);
        expect(getModEntryCount('message.actions', 'mod-a')).toBe(3);
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'budget' && f.region === 'message.actions')).toBe(true);
    });

    it('two mods can each register up to the budget (no cross-mod budget)', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('a1'), 0);
        registerModChrome('message.actions', MOD_B, noopEntry('b1'), 0);
        expect(getModEntryCount('message.actions', 'mod-a')).toBe(1);
        expect(getModEntryCount('message.actions', 'mod-b')).toBe(1);
        const ids = readRegion('message.actions').filter((e) => e.mod !== undefined).map((e) => e.qualifiedId);
        expect(ids).toEqual(['mod.mod-a.a1', 'mod.mod-b.b1']);
    });
});

describe('Phase 4.4 — message.below content registry', () => {
    const noopSlot = (id: string) => ({ id, mount: () => undefined });

    it('registers a content slot through registerModMessageBelow', () => {
        const handle = registerModMessageBelow(MOD_A, noopSlot('annotation'), 0, {});
        const slots = readMessageBelowSlots();
        expect(slots).toHaveLength(1);
        expect(slots[0].qualifiedId).toBe('mod.mod-a.annotation');
        expect(slots[0].context).toEqual({});
        expect(typeof handle.update).toBe('function');
        expect(typeof handle.remove).toBe('function');
        handle.remove();
        expect(readMessageBelowSlots()).toHaveLength(0);
    });

    it('enforces the per-mod budget of 1 on message.below (MOUNTS.md §5)', () => {
        registerModMessageBelow(MOD_A, noopSlot('first'), 0, {});
        mountFaultStore.clear();
        const handle = registerModMessageBelow(MOD_A, noopSlot('second'), 0, {});
        expect(getModEntryCount('message.below', 'mod-a')).toBe(1);
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'budget' && f.region === 'message.below' && f.entryId === 'second')).toBe(true);
        // The over-budget handle is a no-op: removing it does nothing.
        handle.remove();
        expect(getModEntryCount('message.below', 'mod-a')).toBe(1);
    });

    it('a duplicate slot id is caught by the budget gate first (budget=1, §5 vs §4.1)', () => {
        // `message.below`'s per-mod budget is 1 (MOUNTS.md §5), so a second
        // registration of ANY id — duplicate or not — hits the budget gate
        // before the duplicate check. The duplicate-id check is reachable
        // only on regions with budget > 1 (e.g. `message.actions` cap 3,
        // tested above). Here we assert the budget fault fires and the slot
        // count stays at 1: the duplicate protection is structural (the
        // qualified id is in `knownIds`), but the budget gate is the
        // user-visible one for this region.
        registerModMessageBelow(MOD_A, noopSlot('first'), 0, {});
        mountFaultStore.clear();
        registerModMessageBelow(MOD_A, noopSlot('first'), 0, {});
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'budget' && f.region === 'message.below' && f.entryId === 'first')).toBe(true);
        expect(readMessageBelowSlots()).toHaveLength(1);
    });

    it('two mods can each register a slot (namespacing prevents collision)', () => {
        registerModMessageBelow(MOD_A, noopSlot('note'), 0, {});
        registerModMessageBelow(MOD_B, noopSlot('note'), 0, {});
        const ids = readMessageBelowSlots().map((s) => s.qualifiedId);
        expect(ids).toEqual(['mod.mod-a.note', 'mod.mod-b.note']);
    });

    it('orders slots by (loadIndex, withinModIndex) — a lower loadIndex sorts first', () => {
        registerModMessageBelow(MOD_A, noopSlot('late'), 5, {});
        registerModMessageBelow(MOD_B, noopSlot('early'), 1, {});
        const ids = readMessageBelowSlots().map((s) => s.qualifiedId);
        // MOD_B has the lower loadIndex, so it sorts first.
        expect(ids).toEqual(['mod.mod-b.early', 'mod.mod-a.late']);
    });

    it('disableModMounts removes every message.below slot the mod registered (§8.5)', () => {
        registerModMessageBelow(MOD_A, noopSlot('a1'), 0, {});
        registerModMessageBelow(MOD_B, noopSlot('b1'), 0, {});
        expect(readMessageBelowSlots()).toHaveLength(2);
        const removed = disableModMounts('mod-a');
        expect(removed).toBe(1);
        const remaining = readMessageBelowSlots().map((s) => s.qualifiedId);
        expect(remaining).toEqual(['mod.mod-b.b1']);
        // MOD_A's lease is revoked; a re-registration is a no-op + fault.
        mountFaultStore.clear();
        registerModMessageBelow(MOD_A, noopSlot('after'), 0, {});
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'revoked' && f.region === 'message.below')).toBe(true);
    });

    it('a revoked mod cannot register a message.below slot (no-op + revoked fault)', () => {
        disableModMounts('mod-a');
        mountFaultStore.clear();
        registerModMessageBelow(MOD_A, noopSlot('after'), 0, {});
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'revoked' && f.region === 'message.below')).toBe(true);
        expect(readMessageBelowSlots()).toHaveLength(0);
    });

    it('subscribeToRegion fires on message.below add and remove', () => {
        let notifications = 0;
        const unsubscribe = subscribeToRegion('message.below', () => { notifications++; });
        const handle = registerModMessageBelow(MOD_A, noopSlot('sub'), 0, {});
        expect(notifications).toBe(1);
        handle.remove();
        expect(notifications).toBe(2);
        unsubscribe();
        registerModMessageBelow(MOD_A, noopSlot('after-unsub'), 0, {});
        expect(notifications).toBe(2);
    });

    it('MountHandle.update is a no-op for content slots (MOUNTS.md §8.5)', () => {
        const handle = registerModMessageBelow(MOD_A, noopSlot('noop'), 0, {});
        expect(() => handle.update()).not.toThrow();
        // update does not notify — it is a no-op for content mounts.
        let notifications = 0;
        const unsubscribe = subscribeToRegion('message.below', () => { notifications++; });
        handle.update();
        expect(notifications).toBe(0);
        unsubscribe();
        handle.remove();
    });
});