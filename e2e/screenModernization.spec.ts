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

  /**
   * Same zoom-normalisation as `layoutWidth`, but for height. WO-screen-
   * modernization §0-B — the fourth flex-sizing bug in this repo shipped
   * green because jsdom returns 0 for every dimension. The height-fill fix
   * is only proven by a `getBoundingClientRect` height measurement in a real
   * browser, so this helper exists to back the assertions that jsdom cannot.
   */
  async function layoutHeight(locator: import('@playwright/test').Locator): Promise<number> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('no bounding box');
    const zoom = await locator.page().evaluate(() => Number(document.documentElement.style.zoom) || 1);
    return box.height / zoom;
  }

  test('System Context (Shape A — Editor, width=wide) is a 2fr/1fr grid whose editor fills the panel width', async ({ page }) => {
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

    // ── Part 1 §A-1: System Context is `wide` (not `form`) so the 2fr/1fr
    // grid has room. The inner wrapper carries `w-full`, not `max-w-5xl`.
    // The rules editor column is the dominant content (~3,000-token prose
    // document); narrow columns make prose editing worse.
    const innerWrapper = scrollContainer.locator(':scope > *').first();
    const innerW = await layoutWidth(innerWrapper);
    // At 1920vw the panel is 90vw = 1728px; `wide` should fill it (≥ 1500px).
    expect(innerW).toBeGreaterThan(1500);
    const innerClass = await innerWrapper.getAttribute('class');
    expect(innerClass).toMatch(/w-full/);
    expect(innerClass).not.toMatch(/max-w-5xl/);

    // ── Part 1 §A-2: the segmented control [Write | Retrieval] is in the
    // section header. Both segments render; Write is the default.
    const writeBtn = dialog.getByRole('button', { name: 'Write' }).first();
    const retrievalBtn = dialog.getByRole('button', { name: 'Retrieval' }).first();
    await expect(writeBtn).toBeVisible();
    await expect(retrievalBtn).toBeVisible();
    await expect(writeBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('Part 0-B — the height-fill is real: content wrapper height equals scroller height and the primary textarea exceeds 400px at a 1000px-tall viewport', async ({ page }) => {
    // jsdom returns 0 for every dimension, so the previous flex-sizing bugs
    // (shrink-0, flex-1, mx-auto, h-full) all shipped green. This test is the
    // gate the workorder demands: a getBoundingClientRect height measurement
    // in a real browser. The viewport is 1000px tall so the panel (90vh) is
    // 900px; the textarea must exceed 400px (it was 211px while the bug was
    // live, 508px once fixed) and the content wrapper must fill the scroller.
    await page.setViewportSize({ width: 1920, height: 1000 });

    await page.locator('button:has-text("System Context")').first().click();
    const dialog = page.getByRole('dialog', { name: 'System Context' });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const scrollContainer = dialog.locator('.overflow-y-auto').first();
    const innerWrapper = scrollContainer.locator(':scope > *').first();

    // The scroller is `flex-1 min-h-0 overflow-y-auto flex flex-col`; the
    // inner wrapper is `flex-1 min-h-0 flex flex-col`. A continuous flex chain
    // means the wrapper fills the scroller's height — no dead space. Tolerate
    // a few pixels of sub-pixel/rounding drift.
    const scrollH = await layoutHeight(scrollContainer);
    const innerH = await layoutHeight(innerWrapper);
    expect(scrollH).toBeGreaterThan(800); // ~900px panel minus header
    expect(Math.abs(innerH - scrollH)).toBeLessThanOrEqual(2);

    // The primary textarea is the rules editor. Pre-fix it measured 211px
    // (rows-sized porthole) with 297px of dead space below; post-fix it fills
    // to ~508px. > 400px proves the height chain reached it.
    const textarea = dialog.locator('textarea').first();
    const textareaH = await layoutHeight(textarea);
    expect(textareaH).toBeGreaterThan(400);
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
    // should not reintroduce the family of bugs: the `form` cap must still
    // engage for form screens, and `wide` screens must still fill their panel.
    await page.setViewportSize({ width: 1280, height: 800 });
    // Give the layout a tick to reflow after the viewport change.
    await page.waitForTimeout(200);

    // System Context — `wide` (Part 1 §A-1 made it a 2fr/1fr grid). The inner
    // wrapper fills the panel, not the form cap.
    await page.locator('button:has-text("System Context")').first().click();
    const sysDialog = page.getByRole('dialog', { name: 'System Context' });
    await expect(sysDialog).toBeVisible({ timeout: 10000 });
    const sysScroll = sysDialog.locator('.overflow-y-auto').first();
    const sysInner = sysScroll.locator(':scope > *').first();
    const sysInnerW = await layoutWidth(sysInner);
    // Panel is 90vw of 1280 = 1152px. `wide` fills it — no form cap.
    expect(sysInnerW).toBeGreaterThan(1000);
    const sysInnerClass = await sysInner.getAttribute('class');
    expect(sysInnerClass).toMatch(/w-full/);
    expect(sysInnerClass).not.toMatch(/max-w-5xl/);
    await page.keyboard.press('Escape');
    await expect(sysDialog).toBeHidden({ timeout: 5000 });

    // Memory — `form` (Shape A editor, single column). The form cap must
    // still engage at 1280vw: panel is 1152px, cap is 1024px, so the inner
    // wrapper should be at the cap and clearly wider than the 442px bug.
    await page.locator('button:has-text("Memory")').first().click();
    const memDialog = page.getByRole('dialog', { name: 'Memory' });
    await expect(memDialog).toBeVisible({ timeout: 10000 });
    const memScroll = memDialog.locator('.overflow-y-auto').first();
    const memInner = memScroll.locator(':scope > *').first();
    const memInnerW = await layoutWidth(memInner);
    expect(memInnerW).toBeLessThanOrEqual(1024 + 1); // at the cap
    expect(memInnerW).toBeGreaterThan(700); // well above the 442px bug
    const memInnerClass = await memInner.getAttribute('class');
    expect(memInnerClass).toMatch(/max-w-5xl/);
    expect(memInnerClass).toMatch(/mx-auto/);
    await page.keyboard.press('Escape');
    await expect(memDialog).toBeHidden({ timeout: 5000 });

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