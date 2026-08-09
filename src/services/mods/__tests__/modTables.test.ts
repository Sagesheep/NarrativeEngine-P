import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modTableName, collectDeclaredModTables, hydrateModTables, getModTable, saveModTable, clearModData } from '../modTables';
import type { ValidatedMod } from '../modTypes';

const mod = (overrides: Partial<ValidatedMod> = {}): ValidatedMod => ({
    id: 'compendium',
    name: 'Compendium',
    version: '1.0.0',
    description: 'A test mod.',
    file: 'compendium.mod.json',
    contributions: [{ id: 'tone', order: 250, text: 'Tone.' }],
    tables: [],
    ...overrides,
});

describe('modTableName', () => {
    it('produces mod.<modId>.<name>', () => {
        expect(modTableName('compendium', 'powers')).toBe('mod.compendium.powers');
    });
});

describe('collectDeclaredModTables', () => {
    it('returns an empty array when no mods declare tables', () => {
        expect(collectDeclaredModTables([mod()])).toEqual([]);
    });

    it('collects every declared table across all mods', () => {
        const mods = [
            mod({ id: 'a', tables: [{ name: 'powers', recordShape: 'array' }, { name: 'cfg', recordShape: 'single-object' }] }),
            mod({ id: 'b', tables: [{ name: 'items', recordShape: 'array' }] }),
            mod({ id: 'c' }),
        ];
        const result = collectDeclaredModTables(mods);
        expect(result).toEqual([
            { modId: 'a', table: { name: 'powers', recordShape: 'array' } },
            { modId: 'a', table: { name: 'cfg', recordShape: 'single-object' } },
            { modId: 'b', table: { name: 'items', recordShape: 'array' } },
        ]);
    });
});

describe('getModTable', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches the table through the /mod-tables/ route', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [{ id: 'fireball' }] }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await getModTable('c1', { name: 'powers', recordShape: 'array' }, 'compendium');
        expect(result).toEqual([{ id: 'fireball' }]);
        expect(fetchMock).toHaveBeenCalledWith('/api/campaigns/c1/mod-tables/mod.compendium.powers');
    });

    it('returns [] for an array table on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })));
        const result = await getModTable('c1', { name: 'powers', recordShape: 'array' }, 'compendium');
        expect(result).toEqual([]);
    });

    it('returns null for a single-object table on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
        const result = await getModTable('c1', { name: 'cfg', recordShape: 'single-object' }, 'compendium');
        expect(result).toBeNull();
    });
});

describe('saveModTable', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('PUTs the body to the /mod-tables/ route', async () => {
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        await saveModTable('c1', { name: 'powers', recordShape: 'array' }, 'compendium', [{ id: 'a' }]);
        expect(fetchMock).toHaveBeenCalledWith('/api/campaigns/c1/mod-tables/mod.compendium.powers', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ id: 'a' }]),
        });
    });
});

// Phase 6.4 / `DATA_POLICY.md` §3 — the client half of the clean action.
describe('clearModData', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('DELETEs the mod-data route and returns the removed names', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ ok: true, removed: ['mod.compendium.powers'] }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        const removed = await clearModData('c1', 'compendium');
        expect(removed).toEqual(['mod.compendium.powers']);
        expect(fetchMock).toHaveBeenCalledWith('/api/campaigns/c1/mod-data/compendium', { method: 'DELETE' });
    });

    it('rejects on a non-ok response rather than reporting an empty clear', async () => {
        // A save that silently fails costs one edit; a clear that silently
        // fails leaves the user believing data is gone when it is not.
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
        await expect(clearModData('c1', 'compendium')).rejects.toThrow('Mod data clear failed: 500');
    });
});

describe('hydrateModTables', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns an empty object when no mods declare tables', async () => {
        const result = await hydrateModTables('c1', [mod()]);
        expect(result).toEqual({});
    });

    it('returns an empty object for an empty mods array', async () => {
        const result = await hydrateModTables('c1', []);
        expect(result).toEqual({});
    });

    it('hydrates all declared tables in parallel, keyed by namespaced name', async () => {
        const mods = [
            mod({ id: 'compendium', tables: [
                { name: 'powers', recordShape: 'array' },
                { name: 'cfg', recordShape: 'single-object' },
            ]}),
        ];
        // Two fetches: one per table. Return different data for each.
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            call++;
            if (call === 1) return { ok: true, json: async () => [{ id: 'fireball' }] };
            return { ok: true, json: async () => ({ enabled: true }) };
        }));

        const result = await hydrateModTables('c1', mods);
        expect(result).toEqual({
            'mod.compendium.powers': [{ id: 'fireball' }],
            'mod.compendium.cfg': { enabled: true },
        });
    });

    it('never throws — a failed fetch yields the default, not a rejection', async () => {
        const mods = [
            mod({ id: 'compendium', tables: [{ name: 'powers', recordShape: 'array' }] }),
        ];
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

        const result = await hydrateModTables('c1', mods);
        // The failed fetch yields [] (array default), not a rejection.
        expect(result).toEqual({ 'mod.compendium.powers': [] });
    });

    it('a failed single-object table yields null', async () => {
        const mods = [
            mod({ id: 'cfgmod', tables: [{ name: 'config', recordShape: 'single-object' }] }),
        ];
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

        const result = await hydrateModTables('c1', mods);
        expect(result).toEqual({ 'mod.cfgmod.config': null });
    });
});