import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const src = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/**
 * WO-A2 §4.1 — ledger parity. Every control that existed in the old `BOOK`
 * and `PC` drawer tabs still exists and still works, in its new home. The
 * ContextDrawer exposes exactly 5 tabs and no character data.
 *
 * WO-screen-modernization §A-2 — the count dropped from 6 to 5 when Rules
 * Manager merged into System Context as the [Write | Retrieval] segmented
 * control. The `rules-mgr` tab is intentionally gone.
 */
describe('WO-A2 §4.1 — ledger parity (source files preserved + ContextDrawer has 5 tabs)', () => {
    it('ContextDrawer TABS has exactly 5 tabs and no pc/book keys', () => {
        const s = src('src/components/ContextDrawer.tsx');
        expect(s).not.toMatch(/key:\s*'pc'/);
        expect(s).not.toMatch(/key:\s*'book'/);
        expect(s).not.toMatch(/CharacterProfileEditor/);
        expect(s).not.toMatch(/BookkeepingTab/);
        expect(s).not.toMatch(/key:\s*'rules-mgr'/);
        const tabKeys = s.match(/key:\s*'([^']+)'/g) ?? [];
        expect(tabKeys.length).toBe(5);
    });

    it('the CharacterLedgerModal is mounted in App.tsx (PCPanelModal removed)', () => {
        const s = src('src/App.tsx');
        expect(s).toMatch(/CharacterLedgerModal/);
        expect(s).not.toMatch(/PCPanelModal/);
    });

    it('the InventoryTab still has the Check Inventory button + InventoryRow', () => {
        const s = src('src/components/character/tabs/InventoryTab.tsx');
        expect(s).toMatch(/Check Inventory/);
        expect(s).toMatch(/InventoryRow/);
    });

    it('the StatsTab still has the Populate Profile button', () => {
        const s = src('src/components/character/tabs/StatsTab.tsx');
        expect(s).toMatch(/Populate Profile/);
    });

    it('the RecordTab still has the Identity ON/OFF toggle and Bonds section', () => {
        const s = src('src/components/character/tabs/RecordTab.tsx');
        expect(s).toMatch(/characterProfileActive/);
        expect(s).toMatch(/Bonds/);
        expect(s).toMatch(/selectPcBonds/);
    });

    it('the EnginesTab absorbed TokenGauge + Smart Injection + auto-update', () => {
        const s = src('src/components/context-drawer/EnginesTab.tsx');
        expect(s).toMatch(/BookkeepingBudgetSection/);
        expect(s).toMatch(/smartBookkeepingActive/);
        expect(s).toMatch(/autoBookkeepingInterval/);
        expect(s).toMatch(/minifyBookkeepingStub/);
    });

    it('the old BookkeepingTab.tsx is deleted', () => {
        let exists = true;
        try { readFileSync(resolve(ROOT, 'src/components/context-drawer/BookkeepingTab.tsx'), 'utf8'); } catch { exists = false; }
        expect(exists).toBe(false);
    });

    it('the old pc/ directory is gone (PCPanelModal removed)', () => {
        let exists = true;
        try { readFileSync(resolve(ROOT, 'src/components/pc/PCPanelModal.tsx'), 'utf8'); } catch { exists = false; }
        expect(exists).toBe(false);
    });

    it('the SheetTab still hosts PCEditForm', () => {
        const s = src('src/components/character/tabs/SheetTab.tsx');
        expect(s).toMatch(/PCEditForm/);
        expect(s).toMatch(/setPlayerCharacter/);
        expect(s).toMatch(/updatePlayerCharacter/);
    });

    it('the CharacterLedgerModal has a 4-tab bar (Sheet/Record/Inventory/Stats)', () => {
        const s = src('src/components/character/CharacterLedgerModal.tsx');
        expect(s).toMatch(/'sheet'/);
        expect(s).toMatch(/'record'/);
        expect(s).toMatch(/'inventory'/);
        expect(s).toMatch(/'stats'/);
    });
});