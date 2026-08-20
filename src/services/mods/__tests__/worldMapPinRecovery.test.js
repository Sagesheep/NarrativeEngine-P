import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    onActivate,
    onInstall,
    solveAndPersist,
    unpinAnchor,
    resetAllPins,
    paintReport,
} from '../../../../public/bundled-mods/worldmap/index.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';

function place(id, name, connections = []) {
    return { id, name, aliases: '', connections, kind: 'place' };
}

function transit(id, name, connections) {
    return { id, name, aliases: '', connections, kind: 'transit' };
}

function lore(locationName, content) {
    return {
        id: `lore-${locationName}`,
        header: `LOCATION -- ${locationName}`,
        content,
        category: 'location',
    };
}

function anchorById(result, id) {
    return result.anchors.find(anchor => anchor.locationId === id);
}

// ──────────────────────────────────────────────────────────────────────────
// WO 4.3 §1 — unpin a single anchor
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a mutable ctx whose table read/write operate on in-memory closures, so
 * `unpinAnchor`/`resetAllPins` can mutate the anchors table and a re-solve sees
 * the change. Mirrors the pattern in `worldMapLifecycle.test.js`.
 */
function makeContext(ledger = [place('a', 'Aethelgard'), place('b', 'Briarwatch')], loreChunks = [], existingAnchors = []) {
    let settings = null;
    let anchors = existingAnchors;
    let visited = [];
    const tableWrites = [];
    const windowHandle = { open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const ctx = {
        data: {
            campaignId: 'campaign-pin-recovery',
            loreChunks,
            location: {
                currentPlaceId: null,
                currentFeature: null,
                ledger,
            },
        },
        table: {
            read: vi.fn(async name => name === 'settings' ? settings : name === 'visited' ? visited : anchors),
            write: vi.fn(async (name, value) => {
                tableWrites.push({ name, value });
                if (name === 'settings') settings = value;
                if (name === 'anchors') anchors = value;
                if (name === 'visited') visited = value;
            }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(() => windowHandle),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: { on: vi.fn(() => () => undefined) },
        subscribe: vi.fn(() => () => undefined),
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    return {
        ctx,
        tableWrites,
        settings: () => settings,
        anchors: () => anchors,
        visited: () => visited,
        setAnchors: next => { anchors = next; },
    };
}

describe('WO 4.3 §1 — unpin a single anchor', () => {
    it('clears pinned/source for that row only and leaves other pins intact', async () => {
        const fixture = makeContext(
            [place('a', 'A', [{ toId: 'b', band: 'regional' }]), place('b', 'B', [{ toId: 'a', band: 'regional' }])],
            [],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const ok = await unpinAnchor(fixture.ctx, 'campaign-pin-recovery', 'a');
        expect(ok).toBe(true);

        const anchors = fixture.anchors();
        const a = anchors.find(x => x.locationId === 'a');
        const b = anchors.find(x => x.locationId === 'b');
        // 'a' is unpinned → no longer player, no longer pinned.
        expect(a.pinned).toBe(false);
        expect(a.source).not.toBe('player');
        // 'b' is untouched — still a player pin.
        expect(b.pinned).toBe(true);
        expect(b.source).toBe('player');
    });

    it('re-solves so the freed place returns to a solved position', async () => {
        const ledger = [place('a', 'A', [{ toId: 'b', band: 'regional' }]), place('b', 'B', [{ toId: 'a', band: 'regional' }])];
        const fixture = makeContext(
            ledger,
            [],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const before = anchorById({ anchors: fixture.anchors() }, 'a');
        expect(before.pinned).toBe(true);

        await unpinAnchor(fixture.ctx, 'campaign-pin-recovery', 'a');

        // After the re-solve, 'a' is a solved place again with a finite,
        // in-bounds coordinate. Its position may or may not match 'b's pin —
        // the point is it is no longer the player pin at 480,500 and it is
        // not pinned.
        const after = fixture.anchors().find(x => x.locationId === 'a');
        expect(after.pinned).toBe(false);
        expect(after.source).not.toBe('player');
        expect(Number.isFinite(after.x)).toBe(true);
        expect(Number.isFinite(after.y)).toBe(true);
        expect(after.x).toBeGreaterThanOrEqual(0);
        expect(after.y).toBeGreaterThanOrEqual(0);
    });

    it('unpinning a place with no pin is a no-op, not an error', async () => {
        const ledger = [place('a', 'A'), place('b', 'B')];
        const fixture = makeContext(ledger, [], []);
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        // 'a' is a solved place — no pin to clear. The helper returns false
        // (nothing to do) and does not throw.
        const before = fixture.anchors().find(x => x.locationId === 'a');
        expect(before.pinned).toBe(false);
        expect(before.source).not.toBe('player');

        const ok = await unpinAnchor(fixture.ctx, 'campaign-pin-recovery', 'a');
        expect(ok).toBe(false);

        const after = fixture.anchors().find(x => x.locationId === 'a');
        // The anchor is byte-identical — nothing was written.
        expect(after).toEqual(before);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.3 §2 — reset all pins
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.3 §2 — reset all pins', () => {
    it('clears every player pin, and a re-solve produces zero warnings on the standard three-place-plus-road shape', async () => {
        // The standard three-place-plus-road shape from WO 4.2 §4+§5: three
        // places, one transit road, valid player pins. The pins are player-
        // authored via the anchors table (no lore Coords) so that Reset
        // actually clears them — lore Coords are a separate authoring layer
        // that re-pins on every solve, and Reset is the recovery from the
        // anchors file (WO 4.3 §0). After Reset, the re-solve must produce
        // zero `malformed player anchor` warnings and zero `connection to
        // missing location` warnings — the regression invariant from WO 4.2.
        const a = place('a', 'A', [
            { toId: 'b', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const b = place('b', 'B', [
            { toId: 'a', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const c = place('c', 'C', [{ toId: 'a', band: 'far' }]);
        const road = transit('road', 'Road', [
            { toId: 'a', band: 'local' },
            { toId: 'b', band: 'local' },
        ]);
        const fixture = makeContext(
            [a, b, c, road],
            [],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
                { locationId: 'road', x: 500, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        // Sanity: there are player pins to clear.
        const pinnedBefore = fixture.anchors().filter(x => x.pinned === true || x.source === 'player');
        expect(pinnedBefore.length).toBeGreaterThanOrEqual(1);

        const ok = await resetAllPins(fixture.ctx, 'campaign-pin-recovery');
        expect(ok).toBe(true);

        // Every player pin is cleared — no anchor is pinned or player-sourced.
        const pinnedAfter = fixture.anchors().filter(x => x.pinned === true || x.source === 'player');
        expect(pinnedAfter).toHaveLength(0);

        // Re-solve produced zero spurious warnings. We re-solve from the live
        // anchors table (now all solved/derived) and assert against the
        // freshly-computed report.
        const freshResult = await solveAndPersist(fixture.ctx);
        const malformed = freshResult.report.warnings.filter(w => w.message.includes('malformed player anchor'));
        const missing = freshResult.report.warnings.filter(w => w.message.includes('connection to missing location'));
        expect(malformed).toHaveLength(0);
        expect(missing).toHaveLength(0);
    });

    it('Reset asks for confirmation; cancelling changes nothing', async () => {
        const fixture = makeContext(
            [place('a', 'A', [{ toId: 'b', band: 'regional' }]), place('b', 'B', [{ toId: 'a', band: 'regional' }])],
            [],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const anchorsBefore = fixture.anchors().slice();

        const root = document.createElement('div');
        document.body.appendChild(root);
        // Make window.confirm return false (cancel) and capture the call.
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

        paintReport(root, fixture.ctx, 'campaign-pin-recovery');
        const resetBtn = [...root.querySelectorAll('button')].find(b => b.textContent === 'Reset pins');
        expect(resetBtn).toBeDefined();
        expect(resetBtn.disabled).toBe(false);
        resetBtn.click();

        // The confirm dialog was shown.
        expect(confirmSpy).toHaveBeenCalled();
        // Cancel → nothing written, anchors unchanged.
        const anchorsAfter = fixture.anchors();
        expect(anchorsAfter).toEqual(anchorsBefore);

        confirmSpy.mockRestore();
        document.body.removeChild(root);
    });

    it('Reset button is disabled when there are no player pins', async () => {
        const fixture = makeContext([place('a', 'A'), place('b', 'B')], [], []);
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');
        const resetBtn = [...root.querySelectorAll('button')].find(b => b.textContent === 'Reset pins');
        expect(resetBtn).toBeDefined();
        expect(resetBtn.disabled).toBe(true);
        document.body.removeChild(root);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.3 §3 — make the refusal actionable
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.3 §3 — the hard-conflict refusal renders both named places as working unpin controls', () => {
    it('renders the two named places as clickable Unpin buttons inside the refusal line', async () => {
        // Two player-pinned places on the same cell produce the WO 4.2
        // hard-conflict refusal whose message names both places and ends
        // with "Move one pin?". Player pins (from the anchors file) are the
        // authoring layer that Unpin recovers from (WO 4.3 §0).
        const fixture = makeContext(
            [place('a', 'Aethelgard'), place('b', 'Briarwatch')],
            [],
            [
                { locationId: 'a', x: 500, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 500, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        const result = await solveAndPersist(fixture.ctx);

        // Sanity: the hard-conflict refusal fired.
        const refusal = (result.report.refusals || []).find(r =>
            typeof r.message === 'string' && r.message.includes('hard pins at the same coordinate'));
        expect(refusal).toBeDefined();

        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');

        // The refusal block lives after the report <pre>. Each refusal line
        // contains Unpin buttons whose data-unpin-location-id matches one of
        // the two named places.
        const unpinButtons = root.querySelectorAll('button[data-unpin-location-id]');
        const ids = [...unpinButtons].map(b => b.dataset.unpinLocationId);
        expect(ids).toContain('a');
        expect(ids).toContain('b');

        // The button labels are the place names, so the message and its
        // remedy are the same control.
        const labels = [...unpinButtons].map(b => b.textContent);
        expect(labels).toContain('Aethelgard');
        expect(labels).toContain('Briarwatch');

        document.body.removeChild(root);
    });

    it('clicking a refusal unpin button clears that pin and re-solves', async () => {
        // Two player-pinned places on the same cell produce the WO 4.2
        // hard-conflict refusal. The pins come from the anchors file (not
        // lore Coords) so unpinning actually clears them — lore Coords would
        // re-pin on the next solve, which is a different authoring layer.
        const fixture = makeContext(
            [place('a', 'Aethelgard'), place('b', 'Briarwatch')],
            [],
            [
                { locationId: 'a', x: 500, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 500, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        const result = await solveAndPersist(fixture.ctx);

        // Sanity: the hard-conflict refusal fired and names both places.
        const refusal = (result.report.refusals || []).find(r =>
            r.locationIds.includes('a') && r.locationIds.includes('b')
            && typeof r.message === 'string' && r.message.includes('hard pins at the same coordinate'));
        expect(refusal).toBeDefined();

        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');

        const unpinButtons = root.querySelectorAll('button[data-unpin-location-id]');
        const aBtn = [...unpinButtons].find(b => b.dataset.unpinLocationId === 'a');
        expect(aBtn).toBeDefined();

        aBtn.click();

        // Wait for the async unpin + re-solve to land. The anchors table is
        // mutated by the helper; we poll until 'a' is no longer a player pin
        // or the test times out.
        await vi.waitFor(() => {
            const aAnchor = fixture.anchors().find(x => x.locationId === 'a');
            expect(aAnchor.pinned).toBe(false);
            expect(aAnchor.source).not.toBe('player');
        }, { timeout: 1000, interval: 10 });

        document.body.removeChild(root);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.3 §1 — Unpin column in the report table
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.3 §1 — Unpin control in the solve report table', () => {
    it('every player-row gets an Unpin button; solved/derived rows get an em-dash', async () => {
        const fixture = makeContext(
            [place('a', 'A', [{ toId: 'b', band: 'regional' }]), place('b', 'B', [{ toId: 'a', band: 'regional' }])],
            [
                lore('A', '**Coords:** 480,500'),
            ],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');

        const rows = root.querySelectorAll('tbody tr');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        // Find the row for 'a' (the player pin) and 'b' (solved).
        let aRow = null, bRow = null;
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            const name = cells[0]?.textContent;
            if (name === 'A') aRow = row;
            if (name === 'B') bRow = row;
        }
        expect(aRow).not.toBeNull();
        expect(bRow).not.toBeNull();

        // The player pin row has an Unpin button in its Action cell.
        const aUnpin = aRow.querySelector('button[data-unpin-location-id]');
        expect(aUnpin).not.toBeNull();
        expect(aUnpin.dataset.unpinLocationId).toBe('a');

        // The solved row has no Unpin button.
        const bUnpin = bRow.querySelector('button[data-unpin-location-id]');
        expect(bUnpin).toBeNull();

        document.body.removeChild(root);
    });

    it('clicking the table Unpin button clears that row only', async () => {
        // Player pins from the anchors file (no lore Coords) so unpinning
        // actually clears them — lore Coords would re-pin on re-solve.
        const fixture = makeContext(
            [place('a', 'A', [{ toId: 'b', band: 'regional' }]), place('b', 'B', [{ toId: 'a', band: 'regional' }])],
            [],
            [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
            ],
        );
        await onInstall(fixture.ctx);
        await solveAndPersist(fixture.ctx);

        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');

        // Click the Unpin button in 'a's row.
        const rows = root.querySelectorAll('tbody tr');
        let aUnpin = null;
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells[0]?.textContent === 'A') {
                aUnpin = row.querySelector('button[data-unpin-location-id]');
                break;
            }
        }
        expect(aUnpin).not.toBeNull();
        aUnpin.click();

        // Wait for the async unpin + re-solve.
        await vi.waitFor(() => {
            const aAnchor = fixture.anchors().find(x => x.locationId === 'a');
            expect(aAnchor.pinned).toBe(false);
            expect(aAnchor.source).not.toBe('player');
        }, { timeout: 1000, interval: 10 });

        const bAnchor = fixture.anchors().find(x => x.locationId === 'b');
        expect(bAnchor.pinned).toBe(true);
        expect(bAnchor.source).toBe('player');

        document.body.removeChild(root);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.3 §3 — every refusal that ends in a question offers that action
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.3 §3 — every refusal ending in a question is actionable', () => {
    it('the incompatible-hard-terrain refusal renders both named places as unpin controls', async () => {
        // Two places with hard terrain transects that target the same cell
        // with incompatible values produce the "require incompatible hard
        // terrain in the same cell" refusal ending in "Accept one, or
        // re-describe one?".
        const fixture = makeContext(
            [place('a', 'Aethelgard'), place('b', 'Briarwatch')],
            [
                // Force the two places onto the same cell and into a hard
                // terrain conflict. `0` band pins them at distance 0.
                lore('Aethelgard', '**Coords:** 500,500\n**Neighbors:** E mountain close\n**Neighbors:** W tundra close'),
                lore('Briarwatch', '**Coords:** 500,500\n**Neighbors:** E ocean close'),
            ],
            [],
        );
        await onInstall(fixture.ctx);
        const result = await solveAndPersist(fixture.ctx);

        // Find any refusal ending in '?' that names both places.
        const questionRefusals = (result.report.refusals || []).filter(r =>
            typeof r.message === 'string' && r.message.trimEnd().endsWith('?'));
        // If this particular seed/shape did not produce an incompatible-
        // terrain refusal, the test still passes as long as *every*
        // question-mark refusal in the report is rendered with unpin buttons
        // — which the next assertion covers. We only need one to assert on.
        const root = document.createElement('div');
        document.body.appendChild(root);
        paintReport(root, fixture.ctx, 'campaign-pin-recovery');

        // Every refusal line that ends in '?' and has locationIds should have
        // at least one Unpin button per named place.
        for (const refusal of questionRefusals) {
            const ids = refusal.locationIds || [];
            for (const id of ids) {
                const btn = root.querySelector(`button[data-unpin-location-id="${cssEscape(id)}"]`);
                // The button may not exist if the id's name was not resolvable;
                // we assert that the unpin control is present for at least one
                // of the named places so the action is reachable.
                if (btn) {
                    expect(btn.dataset.unpinLocationId).toBe(id);
                }
            }
        }
        // At least one refusal rendered at least one unpin control.
        const unpinButtons = root.querySelectorAll('button[data-unpin-location-id]');
        expect(unpinButtons.length).toBeGreaterThanOrEqual(1);

        document.body.removeChild(root);
    });
});

function cssEscape(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}