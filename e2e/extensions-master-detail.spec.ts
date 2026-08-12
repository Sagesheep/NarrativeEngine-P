import { test, expect, type Page } from '@playwright/test';

async function openExtensions(page: Page, theme: 'light' | 'dark') {
    const settingsButton = page.locator('button[title="Settings"]').first();
    await expect(settingsButton).toBeVisible({ timeout: 15000 });
    await settingsButton.click();

    const globalTab = page.getByRole('button', { name: 'Global', exact: true });
    await expect(globalTab).toBeVisible({ timeout: 10000 });
    await globalTab.click();
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await page.getByRole('button', { name: theme === 'dark' ? /Dark/ : /Light/ }).click();

    const extensionsTab = page.getByRole('button', { name: 'Extensions', exact: true });
    await expect(extensionsTab).toBeVisible({ timeout: 10000 });
    await extensionsTab.click();
    await expect(page.getByTestId('extensions-master-detail')).toBeVisible({ timeout: 10000 });
}

for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 1920] as const) {
        test(`${theme} theme: Extensions rail and detail divide ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/');
            await page.waitForLoadState('domcontentloaded');
            await openExtensions(page, theme);

            const devDisclosure = page.locator('button[aria-controls="extensions-dev-mods"]').first();
            if (await devDisclosure.count() > 0 && await devDisclosure.getAttribute('aria-expanded') !== 'true') {
                await devDisclosure.click();
            }

            // Open the in-pane guide so the detail scroller has real overflow.
            await page.getByRole('button', { name: /guide to making a mod/i }).click();

            const geometry = await page.evaluate(() => {
                const rail = document.querySelector<HTMLElement>('[data-testid="extensions-rail"]');
                const detail = document.querySelector<HTMLElement>('[data-testid="extensions-detail"]');
                if (!rail || !detail) throw new Error('Extensions master-detail columns are missing');

                const railRect = rail.getBoundingClientRect();
                const detailRect = detail.getBoundingClientRect();
                const railMaxScroll = rail.scrollHeight - rail.clientHeight;
                const detailMaxScroll = detail.scrollHeight - detail.clientHeight;

                rail.scrollTop = railMaxScroll;
                const railPosition = rail.scrollTop;
                const detailAfterRailScroll = detail.scrollTop;
                detail.scrollTop = detailMaxScroll;

                return {
                    railWidth: railRect.width,
                    railHeight: railRect.height,
                    detailHeight: detailRect.height,
                    railScrollable: railMaxScroll > 0,
                    detailScrollable: detailMaxScroll > 0,
                    railMoved: railPosition > 0,
                    detailMoved: detail.scrollTop > 0,
                    railStayedPut: Math.abs(rail.scrollTop - railPosition) < 1,
                    detailStayedPut: Math.abs(detailAfterRailScroll) < 1,
                };
            });

            expect(geometry.railWidth).toBeCloseTo(320, 0);
            expect(geometry.railHeight).toBeGreaterThan(0);
            expect(geometry.detailHeight).toBeGreaterThan(0);
            expect(Math.abs(geometry.railHeight - geometry.detailHeight)).toBeLessThanOrEqual(1);
            expect(geometry.railScrollable).toBe(true);
            expect(geometry.detailScrollable).toBe(true);
            expect(geometry.railMoved).toBe(true);
            expect(geometry.detailMoved).toBe(true);
            expect(geometry.railStayedPut).toBe(true);
            expect(geometry.detailStayedPut).toBe(true);
        });
    }
}
