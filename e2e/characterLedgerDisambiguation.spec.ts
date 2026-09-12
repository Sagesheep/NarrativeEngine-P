import { test, expect, type Page } from '@playwright/test';

/**
 * Character Ledger — "three inventories" disambiguation.
 *
 * The ledger shows the same character's gear in three tabs on purpose:
 *
 *   Sheet > Signature Kit   bounded durable labels, injected every turn
 *   Inventory               the unbounded pack, surfaced when relevant
 *   Stats                   the stat block the GM reads for numbers
 *
 * Users read that as one list that failed to sync (and said so). The fix is
 * UI-only: each surface now states what it is, links to the others, and the
 * kit/inventory overlap is badged. None of the underlying stores changed.
 *
 * This runs in a real browser because what can break here is layout, not
 * logic: the explainer paragraphs must not shove the controls around, and the
 * SIG badge must not crush the item-name input in an already-dense row. jsdom
 * sees neither. Read-only — it opens tabs and measures, and never edits
 * campaign data, so the data-dependent assertions skip rather than fail on a
 * campaign that has no PC or no items.
 */

async function openLedger(page: Page) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const enterBtn = page.locator('button:has-text("Enter"), button:has-text("Click to enter")').first();
  if (await enterBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await enterBtn.click();
    await page.waitForLoadState('networkidle');
  }

  const nav = page.locator('nav[aria-label="Context navigation"]');
  await expect(nav).toBeVisible({ timeout: 20000 });

  await nav.getByText('Character', { exact: true }).first().click();

  // The tab bar is the signal that the ledger mounted.
  await expect(page.getByRole('button', { name: 'Inventory', exact: true }).first()).toBeVisible({ timeout: 10000 });
}

/** True when this campaign has a PC, so the Signature Kit panel is on screen. */
async function hasPlayerCharacter(page: Page): Promise<boolean> {
  await page.getByRole('button', { name: 'Sheet', exact: true }).first().click();
  return !(await page.getByText('No Character Yet').isVisible({ timeout: 3000 }).catch(() => false));
}

test.describe('Character Ledger — the three gear surfaces explain themselves', () => {
  test('Inventory tab says what it is and links to the Signature Kit', async ({ page }) => {
    await openLedger(page);
    await page.getByRole('button', { name: 'Inventory', exact: true }).first().click();

    await expect(page.getByText('Everything the character is carrying')).toBeVisible();
    await expect(page.getByText('Adding an item here does not add it there.')).toBeVisible();

    // The cross-link actually switches tabs. Assert by departure — the Sheet
    // tab's content differs depending on whether a PC exists.
    await page.getByRole('button', { name: /Sheet.*Signature Kit/ }).click();
    await expect(page.getByText('Everything the character is carrying')).toBeHidden();
  });

  test('Stats tab disambiguates its Abilities/Traits lists from the Sheet tab', async ({ page }) => {
    await openLedger(page);
    await page.getByRole('button', { name: 'Stats', exact: true }).first().click();

    await expect(page.getByText('The stat block: numbers the GM reads')).toBeVisible();
    // The label collision users actually hit: two fields both called "Abilities".
    await expect(page.getByText('not the Signature Kit powers')).toBeVisible();
    await expect(page.getByText('These lists are separate on purpose and do not sync.')).toBeVisible();

    // And its cross-links reach both other surfaces.
    await page.getByRole('button', { name: 'Inventory', exact: true }).last().click();
    await expect(page.getByText('Everything the character is carrying')).toBeVisible();
  });

  test('Signature Kit panel states its contract and caps', async ({ page }) => {
    await openLedger(page);
    test.skip(!(await hasPlayerCharacter(page)), 'campaign has no player character');

    await expect(page.getByText('The handful of things that define this character')).toBeVisible();
    await expect(page.getByText(/It is not the pack/)).toBeVisible();
    // The cap is per list, not a combined total.
    await expect(page.getByText(/Equipment\s+\d+\/8/)).toBeVisible();
    await expect(page.getByText(/Abilities \/ Powers\s+\d+\/8/)).toBeVisible();
  });

  test('the badges do not squeeze the item-name input in a dense row', async ({ page }) => {
    await openLedger(page);
    await page.getByRole('button', { name: 'Inventory', exact: true }).first().click();

    // The row name input is the flex-1 child of the row. It carries no `type`
    // attribute, so do not select on one — that matches nothing and turns this
    // into a test that always skips.
    const nameInputs = page.locator('div.space-y-1 > div input.flex-1');
    const n = await nameInputs.count();
    test.skip(n === 0, 'campaign has no inventory rows to measure');

    const box = await nameInputs.first().boundingBox();
    expect(box).not.toBeNull();
    const zoom = await page.evaluate(() => Number(document.documentElement.style.zoom) || 1);
    // The name field is the row's flex-1 child; under ~120px unscaled means the
    // badges have eaten the row.
    expect(box!.width / zoom).toBeGreaterThan(120);
  });
});
