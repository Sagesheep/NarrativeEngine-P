import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * World Map — the mod inside the running app.
 *
 * `worldMapTerrain.spec.ts` mounts the renderer directly, which proves the
 * paint path but says nothing about whether the mod loads, registers its
 * window, and gets a working table adapter and campaign context from the
 * host. That wiring is a seam, and seams are where this feature's bugs have
 * all lived.
 *
 * **This spec is deliberately read-only.** It opens the map and looks; it does
 * not depart, advance a leg or abandon a journey, because the dev server
 * writes to `data/campaigns/` — the user's live save. Travel behaviour is
 * covered against fixtures in vitest and against the real renderer in the
 * terrain spec; neither can corrupt a real campaign.
 */

const ARTIFACTS = resolve(
    'C:/Users/User/AppData/Local/Temp/claude',
    'D--Games-AI-DM-Project-Automated-system-mainApp',
    'beda2d2d-bafd-4786-8bb7-ca8e06ed51af/scratchpad/worldmap-shots',
);

test.beforeAll(() => {
    mkdirSync(ARTIFACTS, { recursive: true });
});

test.describe('World Map — inside the running app', () => {
    test('the mod loads, opens its window, and paints real campaign terrain', async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on('console', msg => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const enterBtn = page
            .locator('button:has-text("Enter"), button:has-text("Click to enter")')
            .first();
        await expect(enterBtn).toBeVisible({ timeout: 20000 });
        await enterBtn.click();
        await expect(page.locator('header')).toBeVisible({ timeout: 20000 });

        // Mod panels live under a collapsed "Mods" section in the context
        // navigation, so expand it first.
        const modsSection = page.getByRole('button', { name: /^Mods/ }).first();
        await expect(modsSection, 'the nav has a Mods section').toBeVisible({ timeout: 20000 });
        if ((await modsSection.getAttribute('aria-expanded')) !== 'true') {
            await modsSection.click();
        }

        // The mod contributes a "World Map" entry. If the mod failed to
        // activate, this is simply absent — which is the single most useful
        // thing this spec can catch.
        const mapEntry = page.getByRole('button', { name: 'World Map', exact: true }).first();
        await expect(mapEntry, 'the World Map mod registered its panel').toBeVisible({ timeout: 20000 });
        await mapEntry.click();

        // The window mounts a canvas. Wait for it to carry terrain rather than
        // for a timeout: an unpainted canvas is exactly the failure mode the
        // in-app browser pane produces, and it must not read as a pass.
        const canvas = page.locator('canvas[role="img"]').first();
        await expect(canvas).toBeVisible({ timeout: 20000 });
        await page.waitForFunction(() => {
            const c = document.querySelector('canvas[role="img"]') as HTMLCanvasElement | null;
            if (!c || c.width < 100) return false;
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
            let painted = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted += 1;
            return painted > (d.length / 4) * 0.8;
        }, undefined, { timeout: 30000 });

        const stats = await page.evaluate(() => {
            const c = document.querySelector('canvas[role="img"]') as HTMLCanvasElement;
            const g = c.getContext('2d', { willReadFrequently: true })!;
            const w = Math.min(400, c.width), h = Math.min(300, c.height);
            const d = g.getImageData(Math.floor(c.width / 2) - w / 2, Math.floor(c.height / 2) - h / 2, w, h).data;
            const colours = new Set<number>();
            for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
            return { size: [c.width, c.height], distinctColours: colours.size };
        });

        // eslint-disable-next-line no-console
        console.log('APP MAP', JSON.stringify(stats));
        await page.screenshot({ path: `${ARTIFACTS}/app-worldmap.png`, fullPage: false });

        // Real terrain, not a flat fill and not the void background.
        expect(stats.distinctColours).toBeGreaterThan(300);

        // The mod must not be shouting into the console while it works. Server
        // noise is filtered: the backend is not this spec's subject.
        const modErrors = consoleErrors.filter(text => /worldmap|world map/i.test(text));
        expect(modErrors, modErrors.join('\n')).toHaveLength(0);
    });
});
