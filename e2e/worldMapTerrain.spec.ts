import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * World Map — terrain rendering, in a real browser.
 *
 * Everything below is unverifiable in vitest and unverifiable in the in-app
 * browser pane. jsdom has no 2D canvas context at all, and the in-app pane
 * does not composite, which means `requestAnimationFrame` never fires there —
 * so the map's entire paint path is unreachable: the canvas gets sized, the
 * overlay gets built, and not one pixel is ever drawn. Every "green" result
 * about terrain from those two environments is a statement about a stub.
 *
 * Playwright drives headless Chromium, which composites offscreen and fires
 * RAF, so this is where claims about what the map LOOKS like belong.
 *
 * The renderer is mounted directly rather than driven through the app UI: the
 * subject is the paint path, and going through the app would make the test
 * depend on campaign data on disk — and, worse, write to the user's live save.
 * The app itself is covered read-only in `worldMapApp.spec.ts`.
 */

const ARTIFACTS = resolve(
    'C:/Users/User/AppData/Local/Temp/claude',
    'D--Games-AI-DM-Project-Automated-system-mainApp',
    'beda2d2d-bafd-4786-8bb7-ca8e06ed51af/scratchpad/worldmap-shots',
);

test.beforeAll(() => {
    mkdirSync(ARTIFACTS, { recursive: true });
});

/**
 * Mount the real renderer on a fixed-size host and wait for the tile pyramid
 * to rasterise. Returns the wrapper's selector.
 *
 * `mountMapRenderer` overwrites the host's inline style with `width:100%;
 * height:100%`, so the host's PARENT is what has to carry a definite size —
 * mounting into a bare div yields a 2px-tall canvas and a blank map.
 */
async function mountMap(page: import('@playwright/test').Page, opts: {
    id: string;
    cellPixels: number;
    seed?: string;
    travel?: Record<string, unknown> | null;
}) {
    await page.evaluate(async ({ id, cellPixels, seed, travel }) => {
        const [{ mountMapRenderer }, { ChunkStore, buildWarpField }, { solveWorldMap }] = await Promise.all([
            import('/bundled-mods/worldmap/renderer.js' as string),
            import('/bundled-mods/worldmap/field.js' as string),
            import('/bundled-mods/worldmap/solver.js' as string),
        ]) as any[];
        const worldSeed = seed ?? 'e2e-terrain-seed';
        const locations = [
            { id: 'a', name: 'Aethelgard', aliases: '', connections: [{ toId: 'b', band: 'regional' }] },
            { id: 'b', name: 'Briarwatch', aliases: '', connections: [{ toId: 'a', band: 'regional' }] },
        ];
        const result = solveWorldMap({ locations, loreChunks: [], worldSeed });
        const controls = buildWarpField(result.transects);
        const snapshot = {
            anchors: result.anchors.map((a: any) => ({ ...a, name: a.locationId })),
            transects: result.transects || [],
            connections: result.connections || [],
            waypoints: result.waypoints || [],
            settings: { worldSeed, climateGradient: 0.65 },
            hardened: new Map(),
            locationId: travel ? 'transit-a-b' : 'a',
            worldVersion: 1,
            travel: travel ?? null,
            worldDay: 12,
            chunkStore: new ChunkStore(worldSeed, 0.65, controls, new Map()),
            controls,
        };
        const wrap = document.createElement('div');
        wrap.id = id;
        wrap.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;overflow:hidden;z-index:99999';
        document.body.appendChild(wrap);
        const host = document.createElement('div');
        wrap.appendChild(host);
        mountMapRenderer(host, {
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction: () => undefined,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
            getInitialView: () => ({ cx: 500, cy: 500, cellPixels }),
        });
    }, opts);

    // The pyramid rasterises tiles off the main paint, so wait for the canvas
    // to actually carry terrain rather than for a fixed timeout.
    await page.waitForFunction((id) => {
        const c = document.querySelector(`#${id} canvas`) as HTMLCanvasElement | null;
        if (!c || c.width < 100) return false;
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted += 1;
        return painted > (d.length / 4) * 0.9;
    }, opts.id, { timeout: 20000 });

    return `#${opts.id}`;
}

/** Pixel statistics for a canvas region — the honest measure of "bland". */
async function terrainStats(page: import('@playwright/test').Page, selector: string) {
    return page.evaluate((sel) => {
        const c = document.querySelector(`${sel} canvas`) as HTMLCanvasElement;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        // Inset well away from the HUD chrome and the map's own overlays.
        const d = g.getImageData(120, 120, 500, 380).data;
        const n = d.length / 4;
        let sr = 0, sg = 0, sb = 0;
        const colours = new Set<number>();
        for (let i = 0; i < d.length; i += 4) {
            sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
            colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
        const mr = sr / n, mg = sg / n, mb = sb / n;
        let v = 0;
        for (let i = 0; i < d.length; i += 4) {
            v += ((d[i] - mr) ** 2) + ((d[i + 1] - mg) ** 2) + ((d[i + 2] - mb) ** 2);
        }
        return {
            mean: [Math.round(mr), Math.round(mg), Math.round(mb)] as number[],
            sd: Number(Math.sqrt(v / n).toFixed(2)),
            distinctColours: colours.size,
        };
    }, selector);
}

test.describe('World Map terrain — a real browser, a real paint', () => {
    test('the ground is textured, not a flat rectangle of colour', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');

        const sel = await mountMap(page, { id: 'wm32', cellPixels: 32 });
        const stats = await terrainStats(page, sel);
        await page.locator(sel).screenshot({ path: `${ARTIFACTS}/terrain-zoom32.png` });

        // The whole complaint, stated as a number. A flat-colour map of one
        // biome under a near-flat hillshade lands in the low tens of colours;
        // textured ground is in the thousands.
        expect(stats.distinctColours).toBeGreaterThan(600);
        expect(stats.sd).toBeGreaterThan(6);
        // And it is still terrain, not noise: the mean is a real colour, not
        // a mid-grey mush, and not the void background.
        expect(Math.max(...stats.mean)).toBeGreaterThan(30);
    });

    test('neighbouring cells of one biome differ — no wallpaper repeat', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const sel = await mountMap(page, { id: 'wmrep', cellPixels: 32 });

        // Compare whole cells against each other rather than single pixels: a
        // single pixel can match by chance, a 32x32 block matching exactly
        // means the same atlas square was blitted twice with the same shade.
        const identicalPairs = await page.evaluate((s) => {
            const c = document.querySelector(`${s} canvas`) as HTMLCanvasElement;
            const g = c.getContext('2d', { willReadFrequently: true })!;
            const cell = 32;
            const sig = (cx: number, cy: number) => {
                const d = g.getImageData(cx, cy, cell, cell).data;
                let h = 2166136261;
                for (let i = 0; i < d.length; i += 4) {
                    h ^= d[i]; h = Math.imul(h, 16777619);
                    h ^= d[i + 1]; h = Math.imul(h, 16777619);
                    h ^= d[i + 2]; h = Math.imul(h, 16777619);
                }
                return h >>> 0;
            };
            let same = 0, pairs = 0;
            for (let y = 128; y < 448; y += cell) {
                for (let x = 128; x < 736 - cell; x += cell) {
                    pairs += 1;
                    if (sig(x, y) === sig(x + cell, y)) same += 1;
                }
            }
            return { same, pairs };
        }, sel);

        expect(identicalPairs.pairs).toBeGreaterThan(50);
        // With N variants, two neighbours land on the same square about 1/N of
        // the time, so 8 variants floor this near 0.125 — the threshold is
        // derived, not picked. It sat at 0.27 while `shoreBitmask` was handing
        // every inland cell the one flat `shore:0` square, and doubling the
        // variants barely moved it, which is what exposed that bug.
        expect(identicalPairs.same / identicalPairs.pairs).toBeLessThan(0.2);
    });

    test('texture survives the downscale to every zoom level', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const report: Record<string, unknown> = {};
        for (const cellPixels of [32, 16, 8, 4]) {
            const sel = await mountMap(page, { id: `wm${cellPixels}`, cellPixels });
            const stats = await terrainStats(page, sel);
            report[`cell${cellPixels}px`] = stats;
            await page.locator(sel).screenshot({ path: `${ARTIFACTS}/terrain-zoom${cellPixels}.png` });
            await page.evaluate((id) => document.getElementById(id)?.remove(), `wm${cellPixels}`);
        }
        // eslint-disable-next-line no-console
        console.log('TERRAIN STATS', JSON.stringify(report, null, 1));

        // The zoomed-out level is the one that flat colour would win: fine
        // marks average away under an 8x downscale, and only the broad
        // mottling and the per-variant tone step survive. If this assertion
        // fails, the mottling is doing nothing and only full zoom looks good.
        for (const [level, stats] of Object.entries(report) as [string, any][]) {
            expect(stats.sd, `${level} is flat`).toBeGreaterThan(4);
            expect(stats.distinctColours, `${level} has too few colours`).toBeGreaterThan(200);
        }
    });

    test('every biome on screen is drawn in its own colour', async ({ page }) => {
        // THE regression this file exists for. `shoreBitmask` returned 0 for
        // inland cells and the raster accepted `mask >= 0` as "this is a
        // shore", so every land cell of every biome was painted with one
        // plains-green square. Twelve biomes were generated, classified,
        // hardened, costed by the pathfinder and named in the hover readout,
        // and not one of them was ever drawn.
        //
        // Asserted against ground truth from the chunk store rather than a
        // colour count, so it calibrates itself to whatever the seed grows.
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const sel = await mountMap(page, { id: 'wmbio', cellPixels: 8 });

        const result = await page.evaluate(async (s) => {
            const { BIOME_COLORS } = await import('/bundled-mods/worldmap/field.js' as string) as any;
            const c = document.querySelector(`${s} canvas`) as HTMLCanvasElement;
            const g = c.getContext('2d', { willReadFrequently: true })!;
            const d = g.getImageData(120, 120, 500, 380).data;

            const hex = (v: string) => [
                parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16),
            ];
            // Which biome each rendered pixel is NEAREST to. Hillshade,
            // contours and the shore darken all move a pixel along its own
            // colour's ray, so nearest-neighbour is the right classifier.
            const palette = Object.entries(BIOME_COLORS).map(([id, v]) => ({ id, rgb: hex(v as string) }));
            const hits: Record<string, number> = {};
            let total = 0;
            for (let i = 0; i < d.length; i += 4) {
                let best = ''; let bestD = Infinity;
                for (const p of palette) {
                    const dd = ((d[i] - p.rgb[0]) ** 2) + ((d[i + 1] - p.rgb[1]) ** 2) + ((d[i + 2] - p.rgb[2]) ** 2);
                    if (dd < bestD) { bestD = dd; best = p.id; }
                }
                hits[best] = (hits[best] ?? 0) + 1;
                total += 1;
            }
            const shown = Object.entries(hits)
                .filter(([, n]) => n / total > 0.02)
                .map(([id, n]) => [id, +(n / total).toFixed(3)]);
            return { shown, total };
        }, sel);

        // eslint-disable-next-line no-console
        console.log('BIOMES ON SCREEN', JSON.stringify(result.shown));
        // At least three different biomes hold real area. One is what the bug
        // produced; two would be land plus ocean.
        expect(result.shown.length).toBeGreaterThanOrEqual(3);
        // And no single biome owns the whole frame.
        const largest = Math.max(...result.shown.map(([, f]) => f as number));
        expect(largest).toBeLessThan(0.9);
    });

    test('the "Loading terrain" indicator clears once the tiles are in', async ({ page }) => {
        // A progress label that never goes away is indistinguishable from a
        // renderer that has quietly stalled, and this map has a history of
        // exactly that. It showed over a fully painted map in a screenshot;
        // this decides whether that was a stuck label or just a screenshot
        // taken mid-flush.
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const sel = await mountMap(page, { id: 'wmload', cellPixels: 16 });
        await expect(page.locator(sel).getByText('Loading terrain...')).toBeHidden({ timeout: 15000 });
    });

    test('the journey panel does not bury the zoom or layer controls', async ({ page }) => {
        // All three overlay panels were pinned to the same corner, so opening
        // a route covered the zoom buttons and the layer toggles with an
        // opaque box — and the journey panel is up for the whole journey, not
        // a moment, which made it permanent. Geometry is the only honest test
        // for this, and jsdom has none: every rect there is zero.
        //
        // Done in one `evaluate` rather than with Playwright locators: a
        // locator that matches nothing retries until the test times out, which
        // reports a missing button as a 90-second hang instead of a failure.
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const sel = await mountMap(page, {
            id: 'wmoverlap',
            cellPixels: 16,
            travel: { toId: 'b', toName: 'Briarwatch', leg: 2, totalLegs: 8 },
        });

        const collisions = await page.evaluate((s) => {
            const rootEl = document.querySelector(s)!;
            const rect = (el: Element | null | undefined) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 ? r : null;
            };
            const byText = (text: string) => [...rootEl.querySelectorAll('button')]
                .find(b => (b.textContent || '').trim() === text);
            const panel = rect(byText('Continue →')?.closest('div'));
            if (!panel) return ['the journey panel is not on screen'];
            const hits: string[] = [];
            const check = (label: string, el: Element | null | undefined) => {
                const r = rect(el);
                if (!r) { hits.push(`${label} is missing entirely`); return; }
                const overlap = panel.x < r.x + r.width && panel.x + panel.width > r.x
                    && panel.y < r.y + r.height && panel.y + panel.height > r.y;
                if (overlap) hits.push(`${label} is buried under the journey panel`);
            };
            for (const label of ['Fit', 'Centre', '+', '−']) check(label, byText(label));
            check('the layer toggles', rootEl.querySelector('[data-layer-toggle="roads"]')?.closest('div'));
            return hits;
        }, sel);

        expect(collisions, collisions.join('; ')).toEqual([]);
    });

    test('the journey panel and its Continue button render on a real map', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('domcontentloaded');
        const sel = await mountMap(page, {
            id: 'wmj',
            cellPixels: 16,
            travel: { toId: 'b', toName: 'Briarwatch', leg: 3, totalLegs: 8 },
        });

        const panel = page.locator(sel);
        await expect(panel.getByText('camp 3 of 8')).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Continue →' })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Abandon' })).toBeVisible();
        // Planning chrome is gone while travelling — the mode selector is not
        // a thing you change halfway down a road.
        await expect(panel.getByRole('button', { name: 'Travel', exact: true })).toHaveCount(0);
        await panel.screenshot({ path: `${ARTIFACTS}/journey-panel.png` });
    });
});
