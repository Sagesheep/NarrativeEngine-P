/**
 * WO-P5-17 Step 3 — screen fault store + formatter (R5).
 *
 * Screens get their OWN fault kinds (`ScreenFaultKind`), NOT extending
 * `SandboxFaultKind` — a frame's failures are about loading and rendering,
 * not a worker's run. They converge only at the UI: both produce
 * `{ file, reason }` on the existing Extensions fault list. These tests
 * cover the store's observable contract (add/getFaults/subscribe/clear)
 * and the formatter's kind-to-prose mapping.
 *
 * The store keys on `${modId}/${screenId}` — a screen that faults
 * repeatedly overwrites its own record rather than stacking, so a runaway
 * screen produces one entry, not a flood. This is the same discipline as
 * `sandboxFaultStore` (one record per mod), one layer up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    createScreenFaultStore,
    formatScreenFaultReason,
    type ScreenFaultRecord,
} from '../screenFaults';

const baseRecord = (overrides: Partial<ScreenFaultRecord> = {}): ScreenFaultRecord => ({
    modId: 'screen-mod',
    screenId: 'main-screen',
    file: 'screen-mod.mod.json',
    kind: 'threw',
    reason: 'Screen Mod: screen "main-screen": threw (boom)',
    ...overrides,
});

describe('ScreenFaultStore — observable fault collector', () => {
    let store: ReturnType<typeof createScreenFaultStore>;

    beforeEach(() => {
        store = createScreenFaultStore();
    });

    it('starts empty', () => {
        expect(store.getFaults()).toEqual([]);
        expect(store.getRecords()).toEqual([]);
    });

    it('add stores a record and getFaults projects to { file, reason }', () => {
        store.add(baseRecord());
        expect(store.getFaults()).toEqual([
            { file: 'screen-mod.mod.json', reason: 'Screen Mod: screen "main-screen": threw (boom)' },
        ]);
        expect(store.getRecords()).toHaveLength(1);
        expect(store.getRecords()[0]).toMatchObject({
            modId: 'screen-mod',
            screenId: 'main-screen',
            kind: 'threw',
        });
    });

    it('a screen that faults repeatedly overwrites its own record (no flood)', () => {
        store.add(baseRecord({ reason: 'first' }));
        store.add(baseRecord({ reason: 'second' }));
        // One record keyed on modId/screenId, not two.
        expect(store.getFaults()).toEqual([
            { file: 'screen-mod.mod.json', reason: 'second' },
        ]);
        expect(store.getRecords()).toHaveLength(1);
    });

    it('different screens produce different records', () => {
        store.add(baseRecord({ screenId: 'a', reason: 'a fault' }));
        store.add(baseRecord({ screenId: 'b', reason: 'b fault' }));
        expect(store.getFaults()).toHaveLength(2);
        expect(store.getFaults().map((f) => f.reason)).toEqual(['a fault', 'b fault']);
    });

    it('subscribe is notified on add', () => {
        const listener = vi.fn();
        store.subscribe(listener);
        store.add(baseRecord());
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('subscribe is notified on clear', () => {
        store.add(baseRecord());
        const listener = vi.fn();
        store.subscribe(listener);
        store.clear();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getFaults()).toEqual([]);
    });

    it('unsubscribe stops notifications', () => {
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        unsubscribe();
        store.add(baseRecord());
        expect(listener).not.toHaveBeenCalled();
    });

    it('clear empties the store and notifies', () => {
        const listener = vi.fn();
        store.subscribe(listener);
        store.add(baseRecord());
        store.clear();
        expect(store.getFaults()).toEqual([]);
        expect(store.getRecords()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('getRecords returns defensive copies (mutating the returned array does not mutate the store)', () => {
        store.add(baseRecord());
        const records = store.getRecords();
        records.length = 0;
        expect(store.getRecords()).toHaveLength(1);
    });
});

describe('formatScreenFaultReason — kind to prose', () => {
    const base = {
        modName: 'Screen Mod',
        screenId: 'main-screen',
        message: 'boom',
    };

    it('formats a threw fault', () => {
        expect(formatScreenFaultReason({ ...base, kind: 'threw' }))
            .toBe('Screen Mod: screen "main-screen": threw (boom)');
    });

    it('formats a load fault', () => {
        expect(formatScreenFaultReason({ ...base, kind: 'load' }))
            .toBe('Screen Mod: screen "main-screen": failed to load (boom)');
    });

    it('formats a crashed fault', () => {
        expect(formatScreenFaultReason({ ...base, kind: 'crashed' }))
            .toBe('Screen Mod: screen "main-screen": frame process crashed (boom)');
    });
});