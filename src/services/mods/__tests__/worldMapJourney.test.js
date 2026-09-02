import { describe, expect, it, vi } from 'vitest';
import {
    buildCheckpoints,
    partyCellForJourney,
    validJourney,
    mapSnapshot,
    writeJourney,
    clearJourney,
    _hydrateJourneyForTest,
} from '../../../../public/bundled-mods/worldmap/index.js';

/**
 * WO 6.5 — the party walks camp to camp. One press = one day = one checkpoint.
 *
 * Per the WO 5.4 §4 seam rule, these tests assert the observable result — the
 * cell the party is drawn on — not the internal call. The mapping is verified
 * against `travelState.ts` (WO 6.5):
 *   - `depart()` sets `leg: 1` and advances the day → leg 1 is checkpoint 0
 *     (the first camp), NOT the origin. The party leaves the origin on the
 *     first press.
 *   - Each `advance()` adds one leg and one day → leg L is checkpoint
 *     `L - 1` in the zero-indexed list.
 *   - `arrive()` clears `travel`; the party is at the destination anchor.
 */

/** A minimal journey record for the party-cell tests. */
function journey(overrides = {}) {
    return {
        fromId: 'a',
        toId: 'b',
        mode: 'foot',
        cells: [
            { x: 0, y: 0, cost: 0 },
            { x: 1, y: 0, cost: 1 },
            { x: 2, y: 0, cost: 2 },
            { x: 3, y: 0, cost: 3 },
            { x: 4, y: 0, cost: 4 },
            { x: 5, y: 0, cost: 5 },
        ],
        checkpoints: [
            { x: 1, y: 0, day: 1, kind: 'camp' },
            { x: 3, y: 0, day: 2, kind: 'camp' },
            { x: 4, y: 0, day: 3, kind: 'camp' },
        ],
        totalLegs: 5,
        startedOnDay: 1,
        ...overrides,
    };
}

/** A minimal `TravelState` for the party-cell tests. */
function travel(overrides = {}) {
    return {
        fromId: 'a',
        toId: 'b',
        transitId: 't1',
        mode: 'foot',
        leg: 1,
        totalLegs: 5,
        agency: 'free',
        ...overrides,
    };
}

// ── §2: party cell mapping ───────────────────────────────────────────────

describe('WO 6.5 — leg 1 puts the party on camp 1 (checkpoint 0), not the origin', () => {
    it('leg 1 → checkpoint[0] = the first camp (x:1), NOT the origin (x:0)', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 1 }));
        expect(cell).toEqual({ x: 1, y: 0 });
    });

    it('leg 1 is NOT the origin cell', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 1 }));
        // The origin is at (0, 0) — leg 1 must NOT be there (WO 6.5).
        expect(cell).not.toEqual({ x: 0, y: 0 });
    });
});

describe('WO 6.5 — leg N maps to checkpoint[N-1] (zero-indexed)', () => {
    it('leg 2 → checkpoint[1] = { x: 3, y: 0 } (day 2 camp)', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 2 }));
        expect(cell).toEqual({ x: 3, y: 0 });
    });

    it('leg 3 → checkpoint[2] = { x: 4, y: 0 } (day 3 camp)', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 3 }));
        expect(cell).toEqual({ x: 4, y: 0 });
    });

    it('leg 5 → clamps to the last checkpoint (day 3, x:4)', () => {
        // leg 5 → checkpoint[4] — but there are only 3 checkpoints (indices
        // 0, 1, 2), so this clamps to the last one (day 3, x=4).
        const cell = partyCellForJourney(journey(), travel({ leg: 5 }));
        expect(cell).toEqual({ x: 4, y: 0 });
    });
});

describe('WO 6.2 §2 — a journey record whose toId disagrees with context.travel is ignored', () => {
    it('mismatched toId → null (fall back to the transit anchor)', () => {
        const j = journey({ toId: 'b' });
        const t = travel({ toId: 'c' }); // different destination
        const cell = partyCellForJourney(j, t);
        expect(cell).toBeNull();
    });

    it('mismatched fromId → null', () => {
        const j = journey({ fromId: 'x' });
        const t = travel({ fromId: 'a' });
        const cell = partyCellForJourney(j, t);
        expect(cell).toBeNull();
    });

    it('matching fromId AND toId → the party cell is computed', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 2 }));
        expect(cell).toEqual({ x: 3, y: 0 });
    });
});

describe('WO 6.5 — a leg beyond the checkpoint list clamps to the last one and does not throw', () => {
    it('leg 100 of a 5-leg journey → the last checkpoint, no throw', () => {
        const cell = partyCellForJourney(journey(), travel({ leg: 100 }));
        // Clamps to the last checkpoint (day 3, x=4).
        expect(cell).toEqual({ x: 4, y: 0 });
    });

    it('leg 0 (below 1) → null (index -1, before the first camp)', () => {
        // leg 0 → index = -1, which is < 0 → null. The party has not departed yet.
        const cell = partyCellForJourney(journey(), travel({ leg: 0 }));
        expect(cell).toBeNull();
    });

    it('a journey with no checkpoints → the last cell of the route', () => {
        const j = journey({ checkpoints: [] });
        const cell = partyCellForJourney(j, travel({ leg: 3 }));
        // No checkpoints → fall back to the last cell (the destination).
        expect(cell).toEqual({ x: 5, y: 0 });
    });
});

describe('WO 6.2 §2 — no journey record or no travel state degrades, never breaks', () => {
    it('null journey → null (transit anchor fallback)', () => {
        expect(partyCellForJourney(null, travel())).toBeNull();
    });

    it('null travel → null', () => {
        expect(partyCellForJourney(journey(), null)).toBeNull();
    });

    it('both null → null', () => {
        expect(partyCellForJourney(null, null)).toBeNull();
    });
});

// ── §1: journey record validity ──────────────────────────────────────────

describe('WO 6.2 §1 — validJourney (defensive: a corrupt read degrades, never crashes)', () => {
    it('null is a valid journey (no journey in progress)', () => {
        expect(validJourney(null)).toBe(true);
    });

    it('a well-formed journey is valid', () => {
        expect(validJourney(journey())).toBe(true);
    });

    it('a non-object is invalid', () => {
        expect(validJourney('not a journey')).toBe(false);
        expect(validJourney(42)).toBe(false);
        expect(validJourney(undefined)).toBe(false);
    });

    it('missing fromId/toId is invalid', () => {
        expect(validJourney({ ...journey(), fromId: undefined })).toBe(false);
        expect(validJourney({ ...journey(), toId: 123 })).toBe(false);
    });

    it('non-array cells is invalid', () => {
        expect(validJourney({ ...journey(), cells: 'not an array' })).toBe(false);
    });

    it('cells with non-finite coords are invalid', () => {
        expect(validJourney({ ...journey(), cells: [{ x: NaN, y: 0 }] })).toBe(false);
        expect(validJourney({ ...journey(), cells: [{ x: 0, y: 'no' }] })).toBe(false);
    });

    it('non-array checkpoints is invalid', () => {
        expect(validJourney({ ...journey(), checkpoints: 'no' })).toBe(false);
    });

    it('checkpoints with bad kind are invalid', () => {
        expect(validJourney({ ...journey(), checkpoints: [{ x: 0, y: 0, day: 1, kind: 'bivouac' }] })).toBe(false);
    });

    it('non-finite totalLegs is invalid', () => {
        expect(validJourney({ ...journey(), totalLegs: 'five' })).toBe(false);
    });
});

// ── §5: buildCheckpoints integration (the mapping relies on these shapes) ─

describe('WO 6.2 §5 — checkpoints from buildCheckpoints map to party cells correctly', () => {
    /** A hop whose cells advance by `step` cost each, `count` cells long. */
    function hop(count, step, legs, startX = 0) {
        const cells = [];
        for (let i = 0; i < count; i += 1) {
            cells.push({ x: startX + i, y: 0, cost: i * step });
        }
        return { cells, legs, cost: (count - 1) * step };
    }

    it('a 5-leg journey has 4 checkpoints (days 1-4); leg 3 → day 3 camp', () => {
        // 3 grids/day on foot, multiplier 1 → a day is 3 cost. 16 cells of
        // cost 1 = 15 total cost = 5 legs (ceil(15/3) = 5). Checkpoints fall
        // on days 1, 2, 3, 4 (4 camps, the 5th day arrives — not a camp).
        const h = hop(16, 1, 5);
        const checkpoints = buildCheckpoints([h], 3, 1);
        expect(checkpoints.length).toBe(4);
        expect(checkpoints.map(c => c.day)).toEqual([1, 2, 3, 4]);
        // WO 6.5: leg 3 → checkpoint[2] = day 3 camp (index = leg - 1).
        const j = {
            fromId: 'a', toId: 'b', mode: 'foot',
            cells: h.cells, checkpoints, totalLegs: 5, startedOnDay: 1,
        };
        const cell = partyCellForJourney(j, travel({ leg: 3, totalLegs: 5 }));
        // checkpoint[2] should be at day 3.
        expect(cell).not.toBeNull();
        expect(checkpoints[2].day).toBe(3);
    });
});

// ── §2 + §5: mapSnapshot party field (integration) ────────────────────────

/**
 * The snapshot tests build a mod context through the real `onActivate`
 * lifecycle (same pattern as `worldMapRouting.test.js`). The `party` field on
 * the snapshot is the observable result: the cell the party is drawn on.
 *
 * `mapSnapshot` reads the journey from the in-memory `journeyByCampaign`
 * cache (hydrated by `mountMap`'s initial mount, or by
 * `_hydrateJourneyForTest` in a test). A test that exercises `mapSnapshot`
 * with a journey must hydrate the cache first.
 */
async function buildCtxForJourney(overrides = {}) {
    const { onInstall, onActivate } = await import('../../../../public/bundled-mods/worldmap/index.js');
    let settings = null;
    let anchors = [];
    let visited = [];
    let journeyRecord = overrides.journeyRecord ?? null;
    const ledger = overrides.ledger ?? [
        { id: 'a', name: 'A', aliases: '', connections: [{ toId: 'b' }] },
        { id: 'b', name: 'B', aliases: '', connections: [{ toId: 'a' }] },
    ];
    const ctx = {
        data: {
            campaignId: overrides.campaignId ?? 'campaign-journey',
            loreChunks: [],
            location: {
                currentPlaceId: overrides.currentPlaceId ?? 'a',
                currentFeature: null,
                ledger,
                travel: overrides.travel ?? null,
                worldDay: overrides.worldDay ?? 1,
            },
            context: { travelMode: 'foot' },
        },
        table: {
            read: vi.fn(async name => {
                if (name === 'settings') return settings;
                if (name === 'visited') return visited;
                if (name === 'anchors') return anchors;
                if (name === 'journey') return journeyRecord;
                return null;
            }),
            write: vi.fn(async (name, value) => {
                if (name === 'settings') settings = value;
                if (name === 'anchors') anchors = value;
                if (name === 'visited') visited = value;
                if (name === 'journey') journeyRecord = value;
            }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(() => ({ open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() })),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: {
            on: vi.fn(() => () => undefined),
            emit: vi.fn(),
        },
        subscribe: vi.fn(() => () => undefined),
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
        write: {
            setLocationLedger: vi.fn(),
            updateContext: vi.fn(),
        },
    };
    await onInstall(ctx);
    await onActivate(ctx);
    return ctx;
}

describe('WO 6.2 §5 — a Places-panel departure (no journey record) still draws a party marker', () => {
    it('no journey record → party is null (the renderer falls back to the anchor)', async () => {
        // No journey record, no travel state — the party is at the current
        // place's anchor (the normal, settled behaviour). `party` is null,
        // and the renderer's `drawAnchors` draws the current-place marker at
        // the anchor. This is the degrade path (§2): never break.
        const ctx = await buildCtxForJourney({ journeyRecord: null, travel: null });
        const snapshot = mapSnapshot(ctx);
        expect(snapshot).not.toBeNull();
        expect(snapshot.party).toBeNull();
        // The locationId is the current place — the marker draws there.
        expect(snapshot.locationId).toBe('a');
    });

    it('travel set but no journey record (Places-panel departure) → party is null', async () => {
        // A Places-panel or composer TRAVEL departure sets `travel` but has
        // NO route geometry (no `journey` record). The party falls back to
        // the transit anchor (today's behaviour). Degrade, never break.
        const ctx = await buildCtxForJourney({
            journeyRecord: null,
            travel: { fromId: 'a', toId: 'b', transitId: 't1', mode: 'foot', leg: 1, totalLegs: 3, agency: 'free' },
            currentPlaceId: 't1',
        });
        const snapshot = mapSnapshot(ctx);
        expect(snapshot.party).toBeNull();
        expect(snapshot.journey).toBeNull();
    });
});

describe('WO 6.2 §5 — the drawn route survives a repaint', () => {
    it('two snapshots with no intervening world change return the same journey (identity)', async () => {
        // The snapshot is memoised against `worldVersion` (WO 5.3 §7). A
        // repaint (same worldVersion) returns the SAME snapshot object, so
        // the journey survives — it is backed by the `journey` table, not
        // the ephemeral `routePreviewByCampaign`.
        const j = journey();
        const ctx = await buildCtxForJourney({
            journeyRecord: j,
            travel: travel({ leg: 2 }),
            currentPlaceId: 't1',
        });
        // Hydrate the in-memory journey cache (what `mountMap` does on
        // initial mount) so `mapSnapshot` can see the journey.
        await _hydrateJourneyForTest(ctx);
        const s1 = mapSnapshot(ctx);
        const s2 = mapSnapshot(ctx);
        // Same object identity (memoised) — the journey survives.
        expect(s1).toBe(s2);
        expect(s1.journey).not.toBeNull();
        expect(s1.journey).toEqual(j);
        // The party cell is computed from the journey + travel.leg.
        // WO 6.5: leg 2 → checkpoint[1] = { x: 3, y: 0 } (day 2 camp).
        expect(s1.party).toEqual({ x: 3, y: 0 });
    });

    it('a journey read back after a world-version bump still carries the route', async () => {
        // A re-solve bumps the world version. The snapshot cache is dropped,
        // but the journey is read from the in-memory `journeyByCampaign`
        // cache (hydrated at mount and kept in sync by the table
        // subscription), so the next snapshot still carries it.
        const j = journey();
        const ctx = await buildCtxForJourney({
            journeyRecord: j,
            travel: travel({ leg: 1 }),
            currentPlaceId: 't1',
        });
        await _hydrateJourneyForTest(ctx);
        const s1 = mapSnapshot(ctx);
        expect(s1.journey).toEqual(j);
        // The memoisation contract: same worldVersion → same identity.
        const s2 = mapSnapshot(ctx);
        expect(s2).toBe(s1);
        expect(s2.journey).toEqual(j);
    });
});

// ── §4: context.travel going null clears the record ──────────────────────

/**
 * The §4 clear path is tested through `clearJourney` directly (the
 * observable result is the table write — `null` on disk) and through the
 * decision logic (`shouldClearJourney`: active→inactive clears;
 * null→null does not). The wiring from `mountMap`'s `subscribe('location')`
 * handler to `clearJourney` is a thin pass-through that calls `clearJourney`
 * when `prevTravelWasActive && !travelActive`; the decision is what matters.
 *
 * Both `arrive()` and `halt()` manifest as `context.travel` becoming null —
 * the §4 trigger is the STATE, not the transition. Watch `travel` going
 * null, not a specific event.
 */
describe('WO 6.2 §4 — clearJourney writes null to the table and drops the cache', () => {
    it('clearJourney writes null and returns true', async () => {
        const ctx = await buildCtxForJourney({
            journeyRecord: journey(),
            travel: travel({ leg: 1 }),
            currentPlaceId: 't1',
        });
        // Hydrate the cache so we can assert it is dropped.
        await _hydrateJourneyForTest(ctx);
        expect(mapSnapshot(ctx).journey).not.toBeNull();

        const ok = await clearJourney(ctx);
        expect(ok).toBe(true);
        // The table was written null.
        const writes = ctx.table.write.mock.calls.filter(c => c[0] === 'journey');
        const last = writes[writes.length - 1];
        expect(last).toBeDefined();
        expect(last[1]).toBeNull();
        // The cache is dropped — the snapshot no longer carries the journey.
        // (The world version was bumped, so the cache is invalidated.)
        expect(mapSnapshot(ctx).journey).toBeNull();
    });
});

/**
 * The decision logic: `prevTravelWasActive && !travelActive` → clear. This is
 * the guard in `mountMap`'s `subscribe('location')` handler (§4). Both
 * `arrive` and `halt` manifest as `travel` going null; the guard fires on the
 * active→inactive transition, NOT on null→null (a normal ledger edit with no
 * journey) or inactive→active (a new departure).
 */
function shouldClearJourney(prevTravelWasActive, travelNow) {
    const travelActive = Boolean(travelNow);
    return prevTravelWasActive && !travelActive;
}

describe('WO 6.2 §4 — the clear decision: active→inactive clears; null→null does not', () => {
    it('arrive: active→null → clear', () => {
        // arrive(): travel was active, now null.
        expect(shouldClearJourney(true, null)).toBe(true);
    });

    it('halt: active→null → clear', () => {
        // halt(): travel was active, now null. Same observable result.
        expect(shouldClearJourney(true, null)).toBe(true);
    });

    it('a normal ledger edit with no journey (null→null) → do NOT clear', () => {
        // The guard: prev=false, now=false → no clear. A normal ledger edit
        // (e.g. a new place added) with no journey must not write `null` to
        // the journey table on every edit.
        expect(shouldClearJourney(false, null)).toBe(false);
    });

    it('a new departure (null→active) → do NOT clear (the journey was just written)', () => {
        // A new departure writes the journey record at commit, THEN sets
        // travel active. The handler sees prev=false (no journey before),
        // now=true (journey just started) → no clear.
        expect(shouldClearJourney(false, travel({ leg: 1 }))).toBe(false);
    });

    it('leg advance (active→active) → do NOT clear', () => {
        // A leg advance: travel stays active (leg changes from 1 to 2, but
        // travel is still non-null). No clear — the journey continues.
        expect(shouldClearJourney(true, travel({ leg: 2 }))).toBe(false);
    });

    it('campaign switch (active→null on the old campaign) → clear', () => {
        // A campaign switch: the old campaign's travel goes null (the new
        // campaign may or may not have its own journey). The guard fires on
        // the old campaign's handler before the campaign id changes.
        expect(shouldClearJourney(true, null)).toBe(true);
    });
});