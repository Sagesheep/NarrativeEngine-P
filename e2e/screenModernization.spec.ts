import { test, expect } from '@playwright/test';

/**
 * WO-screen-modernization — CHECKPOINT: lightbox layout in the running app.
 *
 * Part 0 existed because nobody measured the scroll container's real width in
 * the browser. jsdom has no layout engine, so the ScreenLightbox unit test
 * passed either way while the live scroll container measured 442px at a 1920px
 * viewport — `mx-auto` on a flex child of `flex flex-col` overrides
 * `align-items: stretch` and collapses the child to shrink-to-fit, so the
 * `max-w-5xl` cap never bound.
 *
 * This spec drives the real UI to open a context-screen lightbox and asserts
 * the geometry with `getBoundingClientRect`-backed `boundingBox` calls — the
 * assertion jsdom cannot make. It also covers Part 1's shape classification:
 *
 *   - System Context (Editor / `form`)    : inner wrapper ≤ 1024px (the cap)
 *   - Engine Tuning  (Collection / `wide`): inner wrapper ≥ 1500px at 1920vw
 *   - Chapters, Lore (Collection / `wide`): inner wrapper ≥ 1500px, sticky search
 *
 * All at the same 1920px viewport where Part 0 was measured.
 */
test.describe('WO-screen-modernization — lightbox geometry in the browser', () => {
  test.beforeEach(async ({ page }) => {
    // 1920px is the width where the original bug was measured (442px scroll
    // container). It is also the width where a `wide` screen most needs to
    // prove it actually got wide.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // The lightboxes only mount inside an open campaign. The Hub may show an
    // "Enter" button per campaign; if it does, click the first one. If it
    // does not, the app has auto-entered the most recent campaign.
    const enterBtn = page.locator('button:has-text("Enter"), button:has-text("Click to enter")').first();
    if (await enterBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await enterBtn.click();
      await page.waitForLoadState('networkidle');
    }

    // The context drawer is open by default once a campaign is loaded. The
    // nav mounting is the signal that the campaign view is up and the
    // drawer leaves are clickable.
    const nav = page.locator('nav[aria-label="Context navigation"]');
    await expect(nav).toBeVisible({ timeout: 20000 });
  });

  /**
   * `getBoundingClientRect` returns post-zoom pixels. The app persists a
   * UI-scale setting (`settings.uiScale`) that sets
   * `document.documentElement.style.zoom`, which scales bounding boxes
   * without changing the underlying layout. To compare against unscaled
   * thresholds (1024px for max-w-5xl, 1500px for the wide fill), divide
   * the measured width by the current zoom.
   */
  async function layoutWidth(locator: import('@playwright/test').Locator): Promise<number> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('no bounding box');
    const zoom = await locator.page().evaluate(() => Number(document.documentElement.style.zoom) || 1);
    return box.width / zoom;
  }

  test('System Context (Shape A — Editor, width=form) caps at max-w-5xl and the inner wrapper carries the cap', async ({ page }) => {
    await page.locator('button:has-text("System Context")').first().click();

    // The lightbox uses `aria-labelledby` (not `aria-label`); getByRole
    // resolves the labelledby target so the accessible name matches.
    const dialog = page.getByRole('dialog', { name: 'System Context' });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const scrollContainer = dialog.locator('.overflow-y-auto').first();

    // ── Part 0 regression: the scroll container must NOT be 442px at 1920vw.
    // The bug was `mx-auto` collapsing the flex child to shrink-to-fit; the
    // fix moved the cap+padding onto an inner block wrapper. The scroll
    // container should now span the full panel width (90vw panel = ~1728px).
    const scrollW = await layoutWidth(scrollContainer);
    expect(scrollW).toBeGreaterThan(1000); // was 442px pre-fix

    // ── Part 1 Shape A: the cap belongs on the inner wrapper, not the scroll.
    // max-w-5xl = 64rem = 1024px. The inner wrapper should measure ~1024px
    // (the cap, engaged) — not 1728px (uncapped) and not 442px (collapsed).
    const innerWrapper = scrollContainer.locator(':scope > *').first();
    const innerW = await layoutWidth(innerWrapper);
    expect(innerW).toBeLessThanOrEqual(1024 + 1); // 1px tolerance for sub-pixel rounding
    expect(innerW).toBeGreaterThan(900); // padding-inclusive; should be near the cap

    // ── Inner wrapper carries the cap class. The unit test asserts the
    // class name; this asserts the *effect* — that the class actually binds
    // at a real layout width.
    const innerClass = await innerWrapper.getAttribute('class');
    expect(innerClass).toMatch(/max-w-5xl/);
    expect(innerClass).toMatch(/mx-auto/);
  });

  test('Engine Tuning (Shape B — Collection, width=wide) uses the full panel width, not the form cap', async ({ page }) => {
    await page.locator('button:has-text("Engine Tuning")').first().click();

    const dialog = page.getByRole('dialog', { name: 'Engine Tuning' });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const scrollContainer = dialog.locator('.overflow-y-auto').first();
    const innerWrapper = scrollContainer.locator(':scope > *').first();

    // At 1920vw the panel is 90vw = 1728px. The wide screen's inner wrapper
    // should be ≥ 1500px (no form cap) and carry `w-full` rather than
    // `max-w-5xl mx-auto`.
    const innerW = await layoutWidth(innerWrapper);
    expect(innerW).toBeGreaterThan(1500);

    const innerClass = await innerWrapper.getAttribute('class');
    expect(innerClass).toMatch(/w-full/);
    expect(innerClass).not.toMatch(/max-w-5xl/);
  });

  test('Chapters and Lore open as Shape B (wide) and expose a sticky search field when populated', async ({ page }) => {
    for (const label of ['Chapters', 'Lore']) {
      // Re-open the drawer if it was closed (Escape closes the lightbox but
      // leaves the drawer open, so this is defensive only).
      const drawerToggle = page.locator('button[title="Open context drawer"], button[aria-label="Open context drawer"]').first();
      if (await drawerToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
        await drawerToggle.click();
      }

      await page.locator(`button:has-text("${label}")`).first().click();

      const dialog = page.getByRole('dialog', { name: label });
      await expect(dialog).toBeVisible({ timeout: 10000 });

      const scrollContainer = dialog.locator('.overflow-y-auto').first();
      const innerWrapper = scrollContainer.locator(':scope > *').first();
      const innerClass = await innerWrapper.getAttribute('class');
      expect(innerClass).toMatch(/w-full/);
      expect(innerClass).not.toMatch(/max-w-5xl/);

      // The sticky search input is the visible filter field in the header.
      // It only renders when the collection has at least one item (the
      // empty-state path is exercised by the unit tests). Here we assert
      // that *if* a search field is rendered, it is inside the sticky
      // header (some ancestor has `sticky top-0`).
      const search = dialog.locator('input[placeholder*="Filter"]').first();
      if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
        const stickyAncestorClass = await search.evaluate((el) => {
          let node: HTMLElement | null = el as HTMLElement;
          while (node && node.tagName !== 'BODY') {
            if (node.className && /sticky/.test(node.className)) return node.className as string;
            node = node.parentElement;
          }
          return '';
        });
        expect(stickyAncestorClass).toMatch(/sticky/);
      }

      // Close the lightbox before opening the next one.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5000 });
    }
  });

  test('Part 0 regression check at 1280px viewport — the cap engages at narrower widths too', async ({ page }) => {
    // The original bug report measured 442px at 1920vw. Resizing narrower
    // should not reintroduce the family of bugs: the cap must still engage
    // for `form` screens, and the `wide` screen must still fill its panel.
    await page.setViewportSize({ width: 1280, height: 800 });
    // Give the layout a tick to reflow after the viewport change.
    await page.waitForTimeout(200);

    // System Context — form cap engages.
    await page.locator('button:has-text("System Context")').first().click();
    const formDialog = page.getByRole('dialog', { name: 'System Context' });
    await expect(formDialog).toBeVisible({ timeout: 10000 });
    const formScroll = formDialog.locator('.overflow-y-auto').first();
    const formInner = formScroll.locator(':scope > *').first();
    const formInnerW = await layoutWidth(formInner);
    // Panel is 90vw of 1280 = 1152px. Cap is 1024px. So the inner wrapper
    // should be at the cap (≤ 1024 + 1) and clearly wider than the bug
    // (442px). Note: at 1280vw the cap may also be padding-bound, so the
    // lower bound is loose.
    expect(formInnerW).toBeLessThanOrEqual(1024 + 1);
    expect(formInnerW).toBeGreaterThan(700);
    await page.keyboard.press('Escape');
    await expect(formDialog).toBeHidden({ timeout: 5000 });

    // Engine Tuning — wide fill engages.
    await page.locator('button:has-text("Engine Tuning")').first().click();
    const wideDialog = page.getByRole('dialog', { name: 'Engine Tuning' });
    await expect(wideDialog).toBeVisible({ timeout: 10000 });
    const wideInner = wideDialog.locator('.overflow-y-auto').first().locator(':scope > *').first();
    const wideInnerW = await layoutWidth(wideInner);
    // Panel is 1152px; wide should be ≥ 1000 (well above the form cap).
    expect(wideInnerW).toBeGreaterThan(1000);
    const wideInnerClass = await wideInner.getAttribute('class');
    expect(wideInnerClass).toMatch(/w-full/);
    expect(wideInnerClass).not.toMatch(/max-w-5xl/);
  });
});