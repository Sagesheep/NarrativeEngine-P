/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { hydrateCampaign } from '../campaignHydrator';
import type { ArcRecord } from '../../types/arc';

// Mock the location table loader (hydrator imports it directly, see enemyHydration.test.ts).
vi.mock('../../services/tables/locationTable', () => ({
    locationTableDescriptor: { name: 'locations', fileSuffix: '.locations.json', recordShape: 'array' },
    loadLocationTable: vi.fn().mockResolvedValue([]),
}));

// Mock the campaignStore accessors the hydrator uses. The arc migration also calls
// `saveCampaignState` to persist the cleared context — that is mocked here too.
vi.mock('../campaignStore', () => ({
    loadCampaignState: vi.fn().mockResolvedValue({ context: {}, messages: [], condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [] }),
    getLoreChunks: vi.fn().mockResolvedValue([]),
    getNPCLedger: vi.fn().mockResolvedValue([]),
    getEnemyCompendium: vi.fn().mockResolvedValue([]),
    getEnemyInstances: vi.fn().mockResolvedValue([]),
    getEnemyEncounters: vi.fn().mockResolvedValue([]),
    getEnemyResolutions: vi.fn().mockResolvedValue([]),
    getEnemyCombatConfig: vi.fn().mockResolvedValue(null),
    loadArchiveIndex: vi.fn().mockResolvedValue([]),
    loadTimeline: vi.fn().mockResolvedValue([]),
    loadChapters: vi.fn().mockResolvedValue([]),
    loadEntities: vi.fn().mockResolvedValue([]),
    loadDivergenceRegister: vi.fn().mockResolvedValue(null),
    saveDivergenceRegister: vi.fn().mockResolvedValue(undefined),
    saveChapters: vi.fn().mockResolvedValue(undefined),
    saveNPCLedger: vi.fn().mockResolvedValue(undefined),
    saveCampaignState: vi.fn().mockResolvedValue(undefined),
}));

// Mock the mod client so `hydrateModTablesFromServer` returns our canned modTables
// map instead of hitting a real server. `fetchMods` is what the hydrator calls
// first; `hydrateModTables` is called second with the returned mods. We only need
// `hydrateModTables` to return the namespaced map the test scenario wants, so
// `fetchMods` returns an empty mods array (the hydrator passes it through).
vi.mock('../../services/mods/modClient', () => ({
    fetchMods: vi.fn().mockResolvedValue({ mods: [], faults: [] }),
}));

// Mock the mod-tables module so the migration's `saveModTable` call can be observed.
// The hydrator uses `hydrateModTables` (returns the namespaced map) and `saveModTable`
// (the migration persists the moved arcs). Both are mocked here.
vi.mock('../../services/mods/modTables', () => ({
    hydrateModTables: vi.fn().mockResolvedValue({}),
    saveModTable: vi.fn().mockResolvedValue(undefined),
    modTableName: (modId: string, name: string) => `mod.${modId}.${name}`,
    getModTable: vi.fn(),
    collectDeclaredModTables: vi.fn(),
}));

import * as campaignStore from '../campaignStore';
import * as modTables from '../../services/mods/modTables';

function makeArc(overrides: Partial<ArcRecord> = {}): ArcRecord {
    return {
        id: 'arc-1',
        type: 'economic',
        title: 'Grain Crisis',
        seed: 'Wheat harvest failed.',
        ladder: [
            { label: 'Prices rise', surface: 'ambient' },
            { label: 'Riots', surface: 'direct' },
        ],
        currentRung: 0,
        tickDC: 35,
        stance: 'unaware',
        status: 'active',
        bornScene: '001',
        lastTickScene: '001',
        ...overrides,
    };
}

function resetStore(): void {
    useAppStore.setState({
        context: {} as any,
        messages: [],
        condenser: { condensedUpToIndex: -1 } as any,
        activeCampaignId: null,
        npcLedger: [],
        archiveIndex: [],
        locationLedger: [],
        loreChunks: [],
        timeline: [],
        chapters: [],
        entities: [],
        divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 } as any,
        inventoryItems: [],
        characterProfileData: null,
        playerCharacter: null,
        pinnedExcerpts: [],
        modTables: {},
    } as any);
}

describe('WO-P5-12 §7 Step 1 — Arc state migration (context.arcs → mod.arc.arcs)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetStore();
    });

    it('moves context.arcs into mod.arc.arcs when the arc mod is installed and the mod table is empty', async () => {
        const legacyArcs = [makeArc({ id: 'arc-1' }), makeArc({ id: 'arc-2', title: 'Faction War' })];
        vi.mocked(campaignStore.loadCampaignState).mockResolvedValueOnce({
            context: { arcs: legacyArcs } as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            pinnedExcerpts: [],
        });
        // arc mod installed → modTables has the (empty) arcs table key
        vi.mocked(modTables.hydrateModTables).mockResolvedValueOnce({ 'mod.arc.arcs': [] });

        await hydrateCampaign('campaign-1');

        const state = useAppStore.getState();
        // Arcs moved to the mod table in the store.
        expect(state.modTables['mod.arc.arcs']).toEqual(legacyArcs);
        // context.arcs cleared.
        expect((state.context as any).arcs).toBeUndefined();
        // saveModTable was called with the moved arcs.
        expect(modTables.saveModTable).toHaveBeenCalledWith(
            'campaign-1',
            { name: 'arcs', recordShape: 'array' },
            'arc',
            legacyArcs,
        );
        // saveCampaignState was called to persist the cleared context.
        expect(campaignStore.saveCampaignState).toHaveBeenCalled();
        const lastSave = vi.mocked(campaignStore.saveCampaignState).mock.calls.at(-1)![1];
        expect((lastSave.context as any).arcs).toBeUndefined();
    });

    it('preserves existing arcs when the mod table is already populated (no clobber)', async () => {
        const legacyArcs = [makeArc({ id: 'arc-1' })];
        const existingModArcs = [makeArc({ id: 'arc-migrated-before' })];
        vi.mocked(campaignStore.loadCampaignState).mockResolvedValueOnce({
            context: { arcs: legacyArcs } as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            pinnedExcerpts: [],
        });
        vi.mocked(modTables.hydrateModTables).mockResolvedValueOnce({ 'mod.arc.arcs': existingModArcs });

        await hydrateCampaign('campaign-1');

        const state = useAppStore.getState();
        // The existing mod table arcs are preserved.
        expect(state.modTables['mod.arc.arcs']).toEqual(existingModArcs);
        // context.arcs is LEFT UNTOUCHED — do not clobber either side.
        expect((state.context as any).arcs).toEqual(legacyArcs);
        // No saveModTable call (migration did not fire).
        expect(modTables.saveModTable).not.toHaveBeenCalled();
    });

    it('leaves context.arcs untouched when the arc mod is NOT installed', async () => {
        const legacyArcs = [makeArc({ id: 'arc-1' })];
        vi.mocked(campaignStore.loadCampaignState).mockResolvedValueOnce({
            context: { arcs: legacyArcs } as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            pinnedExcerpts: [],
        });
        // arc mod NOT installed → modTables has no mod.arc.arcs key
        vi.mocked(modTables.hydrateModTables).mockResolvedValueOnce({});

        await hydrateCampaign('campaign-1');

        const state = useAppStore.getState();
        // context.arcs is preserved (no migration).
        expect((state.context as any).arcs).toEqual(legacyArcs);
        // No saveModTable call.
        expect(modTables.saveModTable).not.toHaveBeenCalled();
    });

    it('leaves context.arcs untouched when context.arcs is empty', async () => {
        vi.mocked(campaignStore.loadCampaignState).mockResolvedValueOnce({
            context: { arcs: [] } as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            pinnedExcerpts: [],
        });
        vi.mocked(modTables.hydrateModTables).mockResolvedValueOnce({ 'mod.arc.arcs': [] });

        await hydrateCampaign('campaign-1');

        // No saveModTable call (nothing to migrate).
        expect(modTables.saveModTable).not.toHaveBeenCalled();
    });

    it('does NOT clear context.arcs when saveModTable fails (no half-written migration)', async () => {
        const legacyArcs = [makeArc({ id: 'arc-1' })];
        vi.mocked(campaignStore.loadCampaignState).mockResolvedValueOnce({
            context: { arcs: legacyArcs } as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            pinnedExcerpts: [],
        });
        vi.mocked(modTables.hydrateModTables).mockResolvedValueOnce({ 'mod.arc.arcs': [] });
        vi.mocked(modTables.saveModTable).mockRejectedValueOnce(new Error('disk full'));

        await hydrateCampaign('campaign-1');

        const state = useAppStore.getState();
        // context.arcs is PRESERVED — the migration failed, so we do not clear it.
        expect((state.context as any).arcs).toEqual(legacyArcs);
        // The mod table is NOT populated with the legacy arcs (migration aborted).
        expect(state.modTables['mod.arc.arcs']).toEqual([]);
    });
});