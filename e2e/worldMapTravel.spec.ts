import reportedJourney from './fixtures/reportedWorldMapJourney.json' with { type: 'json' };
/* eslint-disable @typescript-eslint/no-explicit-any -- browser fixture crosses the untyped runtime mod API. */
import { test, expect, type Page } from '@playwright/test';

// All API traffic is intercepted; the test server only serves frontend assets.
// Real map clicks -> mod events -> React bridge -> Zustand -> map subscription.
async function read(page: Page) {
    return page.evaluate(() => (window as any).worldmapTest.read());
}
async function depart(page: Page) {
    await page.getByRole('button', { name: 'Fit map to content', exact: true }).click();
    const target = await page.evaluate(() => {
        const anchors = (window as any).worldmapTest.anchors();
        const b = anchors.find((a: any) => a.locationId === 'b');
        const xs = anchors.map((a: any) => a.x), ys = anchors.map((a: any) => a.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const rect = document.querySelector('canvas')!.getBoundingClientRect();
        const cell = Math.max(4, Math.min(32, Math.min(rect.width, rect.height) / (Math.max(maxX-minX, maxY-minY, 10) + 8)));
        return { x: rect.left + rect.width/2 + (b.x - (minX+maxX)/2)*cell,
            y: rect.top + rect.height/2 + (b.y - (minY+maxY)/2)*cell };
    });
    await page.mouse.click(target.x, target.y);
    const estimate = page.getByText(/\d+ cells · \d+ days?/);
    await expect(estimate).toBeVisible();
    const days = Number((await estimate.innerText()).match(/· (\d+) days/)![1]);
    expect(days).toBeGreaterThan(2);
    await page.getByRole('button', { name: 'Travel', exact: true }).click();
    await expect.poll(async () => (await read(page)).context.travel?.leg).toBe(1);
    const journey = (await read(page)).journey;
    expect(journey.totalLegs).toBe(days);
    return { ...journey, days };
}

test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.goto('/e2e/fixtures/worldMapTravel.html');
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await expect(page.locator('canvas')).toBeVisible();
});

test('real map journey moves at each press, survives reload, and arrives on its advertised day', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const preview = await depart(page);
    for (let day = 1; day < preview.days; day++) {
        const checkpoint = preview.checkpoints[day - 1];
        await expect.poll(async () => (await read(page)).snapshot.party).toEqual({ x: checkpoint.x, y: checkpoint.y });
        expect((await read(page)).context.worldDay).toBe(10 + day);
        if (day === 1) {
            await page.reload();
            await page.waitForFunction(() => !!(window as any).worldmapTest);
            await expect.poll(async () => (await read(page)).snapshot.party).toEqual({ x: checkpoint.x, y: checkpoint.y });
            await page.screenshot({ path: testInfo.outputPath('checkpoint.png') });
        }
        await page.getByRole('button', { name: day === preview.days - 1 ? 'Arrive at Birch' : 'Continue →', exact: true }).click();
        await expect.poll(async () => (await read(page)).context.worldDay).toBe(11 + day);
    }
    await expect.poll(async () => (await read(page)).journey).toBeNull();
    const result = await read(page);
    expect(result.context.travel).toBeNull();
    expect(result.context.currentPlaceId).toBe('b');
    expect(result.context.worldDay).toBe(10 + preview.days);
    expect(result.messages).toHaveLength(0);
    expect(result.messages.every((m: any) => m.role === 'system')).toBe(true);
    expect(errors).toEqual([]);
});

test('Abandon clears the route without arriving or spending another day', async ({ page }) => {
    const journey = await depart(page);
    const checkpoint = { x: journey.checkpoints[0].x, y: journey.checkpoints[0].y };
    await page.getByRole('button', { name: 'Abandon', exact: true }).click();
    await expect.poll(async () => (await read(page)).journey).toBeNull();
    const result = await read(page);
    expect(result.context.travel).toBeNull();
    expect(result.context.currentPlaceId).not.toBe('b');
    expect(result.context.worldDay).toBe(11);
    await expect.poll(async () => (await read(page)).snapshot.party).toEqual(checkpoint);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await expect.poll(async () => (await read(page)).snapshot.party).toEqual(checkpoint);
    const resumed = await depart(page);
    expect({ x: resumed.cells[0].x, y: resumed.cells[0].y }).toEqual(checkpoint);
    expect((await read(page)).context.worldDay).toBe(12);
});


test('external departure picker uses the map preview before moving', async ({ page }) => {
    await page.evaluate(() => (window as any).worldmapTest.plan());
    await expect(page.getByText(/\d+ cells · \d+ days?/)).toBeVisible();
    expect((await read(page)).context.worldDay).toBe(10);
    expect((await read(page)).context.travel).toBeNull();
    await page.getByRole('button', { name: 'Travel', exact: true }).click();
    await expect.poll(async () => (await read(page)).context.travel?.leg).toBe(1);
});


test('ground travel leaves visible persisted trails only behind the party', async ({ page }, testInfo) => {
    await page.evaluate(() => (window as any).worldmapTest.ground());
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    const journey = await depart(page);
    await expect.poll(async () => (await read(page)).trails?.edges.length ?? 0).toBeGreaterThan(0);
    const worn = (await read(page)).trails;
    expect(worn.edges.length).toBeLessThan(journey.cells.length - 1);
    expect(worn.edges.every((edge: any) => edge.passes === 1)).toBe(true);
    await page.getByRole('button', { name: 'Abandon', exact: true }).click();
    await expect.poll(async () => (await read(page)).journey).toBeNull();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    expect((await read(page)).trails).toEqual(worn);
    await page.screenshot({ path: testInfo.outputPath('ground-trails.png') });
});


test('discoveries can be named and revisited after reload', async ({ page }, testInfo) => {
    await page.evaluate(() => (window as any).worldmapTest.ground());
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    const journey = await depart(page);
    const panel = page.locator('[data-worldmap-discoveries]');
    for (let day = 1; day < journey.days && !await panel.isVisible(); day++) {
        await page.getByRole('button', { name: day === journey.days - 1 ? 'Arrive at Birch' : 'Continue →', exact: true }).click();
        await expect.poll(async () => (await read(page)).context.worldDay).toBe(11 + day);
        await expect.poll(async () => (await read(page)).context.mapDiscoveries?.worldDay).toBe(11 + day);
    }
    await expect(panel).toBeVisible();
    const id = await page.getByLabel('Discovered site').inputValue();
    await page.getByLabel('Site name', { exact: true }).fill('The Quiet Bell');
    await page.getByLabel('Site details', { exact: true }).fill('A cracked bell above a mossy doorway.');
    await page.getByRole('button', { name: 'Save site details' }).click();
    await expect.poll(async () => (await read(page)).discoveries?.sites.find((site: any) => site.id === id)?.name).toBe('The Quiet Bell');
    const saved = (await read(page)).discoveries.sites.find((site: any) => site.id === id);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('The Quiet Bell');
    expect((await read(page)).discoveries.sites.find((site: any) => site.id === id)).toEqual(saved);
    await expect.poll(async () => (await read(page)).context.mapDiscoveries?.sites.some((site: any) => site.name === 'The Quiet Bell')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('discovery.png') });
});


test('a discovered site becomes a fixed ledger destination and survives identity edits', async ({ page }, testInfo) => {
    await page.evaluate(() => (window as any).worldmapTest.ground());
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    const journey = await depart(page);
    const panel = page.locator('[data-worldmap-discoveries]');
    for (let day = 1; day < journey.days && !await panel.isVisible(); day++) {
        await page.getByRole('button', { name: day === journey.days - 1 ? 'Arrive at Birch' : 'Continue →', exact: true }).click();
        await expect.poll(async () => (await read(page)).context.mapDiscoveries?.worldDay).toBe(11 + day);
    }
    await expect(panel).toBeVisible();
    if ((await read(page)).context.travel) {
        await page.getByRole('button', { name: 'Abandon', exact: true }).click();
        await expect.poll(async () => (await read(page)).context.travel).toBeNull();
    }
    const id = await page.getByLabel('Discovered site').inputValue();
    const before = await read(page);
    const site = before.discoveries.sites.find((item: any) => item.id === id);
    const enter = page.getByRole('button', { name: 'Enter site', exact: true });
    if (await enter.isVisible()) await enter.click();
    else {
        await page.getByRole('button', { name: 'Visit site', exact: true }).click();
        await expect(page.getByText(/\d+ cells · \d+ days?/)).toBeVisible();
        await page.getByRole('button', { name: 'Travel', exact: true }).click();
        for (let i = 0; i < 40; i++) {
            const state = await read(page);
            if (state.context.currentPlaceId === id && !state.context.travel) break;
            if (state.context.travel) await page.getByRole('button', { name: /^(Continue →|Arrive at )/ }).click();
            await expect.poll(async () => (await read(page)).context.worldDay).toBeGreaterThan(state.context.worldDay);
        }
    }
    await expect.poll(async () => (await read(page)).context.currentPlaceId).toBe(id);
    await page.evaluate(id => (window as any).worldmapTest.renamePlace(id, 'Quiet Bell Abbey'), id);
    await expect.poll(async () => (await read(page)).discoveries.sites.find((item: any) => item.id === id)?.name).toBe('Quiet Bell Abbey');
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    const anchor = await page.evaluate(id => (window as any).worldmapTest.anchors().find((item: any) => item.locationId === id), id);
    expect(anchor).toMatchObject({ x: site.x, y: site.y, name: 'Quiet Bell Abbey' });
    expect((await read(page)).ledger.filter((entry: any) => entry.id === id)).toHaveLength(1);
    const finishPreview = async (destination: string) => {
        const estimate = page.getByText(/\d+ cells · \d+ days?/);
        await expect(estimate).toBeVisible();
        const days = Number((await estimate.innerText()).match(/· (\d+) days?/)![1]);
        const day = (await read(page)).context.worldDay;
        await page.getByRole('button', { name: 'Travel', exact: true }).click();
        await expect.poll(async () => (await read(page)).context.worldDay).toBe(day + 1);
        for (let step = 1; step < days; step++) {
            await page.getByRole('button', { name: /^(Continue →|Arrive at )/ }).click();
            await expect.poll(async () => (await read(page)).context.worldDay).toBe(day + step + 1);
        }
        expect((await read(page)).context.currentPlaceId).toBe(destination);
    };
    await page.evaluate(() => (window as any).worldmapTest.plan());
    await finishPreview('b');
    await page.getByLabel('Discovered site').selectOption(id);
    await page.getByRole('button', { name: 'Visit site', exact: true }).click();
    await finishPreview(id);
    const revisited = (await read(page)).discoveries.sites.find((item: any) => item.id === id);
    expect(revisited).toMatchObject({ x: site.x, y: site.y, name: 'Quiet Bell Abbey' });
    await page.screenshot({ path: testInfo.outputPath('site-revisited.png') });

});


test('checkpoint situations persist, can be handled once, and never block Travel', async ({ page }, testInfo) => {
    await page.evaluate(() => (window as any).worldmapTest.ground());
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    const journey = await depart(page);
    for (let step = 1; step < journey.days; step++) {
        await expect.poll(async () => (await read(page)).context.mapEncounter?.worldDay).toBe(10 + step);
        if (!(await read(page)).context.mapEncounter.quiet) break;
        await page.getByRole('button', { name: /^(Continue →|Arrive at )/ }).click();
    }
    const panel = page.locator('[data-worldmap-encounter]');
    await expect(panel).toBeVisible();
    const before = await read(page);
    expect(before.context.mapEncounter.quiet).toBe(false);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    expect((await read(page)).encounters).toEqual(before.encounters);
    await page.getByRole('button', { name: 'Mark handled', exact: true }).click();
    await expect.poll(async () => (await read(page)).context.mapEncounter?.status).toBe('handled');
    const handled = await read(page);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    expect((await read(page)).encounters).toEqual(handled.encounters);
    await expect(page.getByRole('button', { name: 'Mark handled', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('handled-checkpoint.png') });
    await page.getByRole('button', { name: /^(Continue →|Arrive at )/ }).click();
    await expect.poll(async () => (await read(page)).context.mapEncounter?.worldDay).toBe(handled.context.worldDay + 1);
    expect((await read(page)).encounters.records.find((row: any) => row.key === handled.context.mapEncounter.key).status).toBe('handled');
});


test('the reported saved cart journey restores at its first checkpoint and continues physically', async ({ page }) => {
    await page.evaluate(data => (window as any).worldmapTest.restoreJourney(data), reportedJourney);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await expect.poll(async () => (await read(page)).snapshot.party).toEqual({ x: 499, y: 498 });
    const before = await read(page);
    await page.getByRole('button', { name: 'Continue →', exact: true }).click();
    await expect.poll(async () => (await read(page)).snapshot.party).toEqual({ x: 496, y: 494 });
    const after = await read(page);
    expect(after.context.worldDay).toBe(before.context.worldDay + 1);
    expect(after.context.travel.leg).toBe(2);
    expect(after.messages).toEqual(before.messages);
});


test('pixel artwork loads with transparent sprites and connected terrain', async ({ page }, testInfo) => {
    await page.evaluate(() => (window as any).worldmapTest.artScene());
    await page.reload();
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await expect(page.locator('#map')).toHaveAttribute('data-worldmap-art', 'pixel-v1');
    await page.getByRole('button', { name: 'Centre on your party (C)', exact: true }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByLabel('Grid layer')).not.toBeChecked();
    const alpha = await page.evaluate(async () => {
        const art = new Image(); art.src = '/bundled-mods/worldmap/assets/overworld-sprites-v1.png'; await art.decode();
        const canvas = document.createElement('canvas'); canvas.width = art.width; canvas.height = art.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(art, 0, 0);
        return ctx.getImageData(0, 0, 1, 1).data[3];
    });
    expect(alpha).toBe(0);
    await expect(page.locator('[data-worldmap-loading]')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('pixel-overworld.png') });
});


test('an actual floating map window updates after Continue without reopening', async ({ page }) => {
    await page.goto('/e2e/fixtures/worldMapTravel.html?realWindow=1');
    await page.waitForFunction(() => !!(window as any).worldmapTest);
    await page.evaluate(() => (window as any).worldmapTest.plan());
    await page.getByRole('button', { name: 'Travel', exact: true }).click();
    await expect.poll(async () => (await read(page)).context.travel?.leg).toBe(1);
    const journey = (await read(page)).journey;
    const canvas = page.locator('canvas');
    await expect(canvas).toHaveAttribute('data-worldmap-party-cell', `${journey.checkpoints[0].x},${journey.checkpoints[0].y}`);
    await expect(page.getByText(/camp 1 of .*day 11/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue →', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-worldmap-party-cell', `${journey.checkpoints[1].x},${journey.checkpoints[1].y}`);
    await expect(page.getByText(/camp 2 of .*day 12/)).toBeVisible();
    await expect(page.getByText('OVERWORLD · Day 12', { exact: true })).toBeVisible();
});
