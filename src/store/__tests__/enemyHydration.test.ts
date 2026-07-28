/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { hydrateCampaign } from '../campaignHydrator';

vi.mock('../campaignStore', () => ({
    loadCampaignState: vi.fn().mockResolvedValue({ context: {}, messages: [], condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [] }),
    getLoreChunks: vi.fn().mockResolvedValue([]),
    getNPCLedger: vi.fn().mockResolvedValue([]),
    getEnemyCompendium: vi.fn().mockResolvedValue([]),
    getEnemyInstances: vi.fn().mockResolvedValue([]),
    getEnemyEncounters: vi.fn().mockResolvedValue([]),
    getEnemyResolutions: vi.fn().mockResolvedValue([]),
    getEnemyCombatConfig: vi.fn().mockResolvedValue(null),
    getLocationLedger: vi.fn().mockResolvedValue([]),
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

import * as campaignStore from '../campaignStore';

describe('enemy hydration integrity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useAppStore.setState({
            context: {} as any,
            messages: [],
            condenser: { condensedUpToIndex: -1 } as any,
            enemyCompendium: [],
            enemyInstances: [],
            enemyEncounters: [],
            enemyResolutions: [],
            enemyCombatConfig: { promptContextEnabled: true, enemyDiscoveryEnabled: false, enabled: false } as any,
            activeCampaignId: null,
            npcLedger: [],
            archiveIndex: [],
            locationLedger: [],
            loreChunks: [],
            timeline: [],
            chapters: [],
            entities: [],
            divergenceRegister: { entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 } as any,
            inventoryItems: [],
            characterProfileData: null,
            playerCharacter: null,
            pinnedExcerpts: [],
        } as any);
    });

    it('normalizes malformed enemy templates, dropping records without a name', async () => {
        vi.mocked(campaignStore.getEnemyCompendium).mockResolvedValueOnce([
            { id: 'orc-1', name: 'Orc' },
            { name: '' },
            { id: 'broken' },
            null,
        ] as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyCompendium).toHaveLength(1);
        expect(state.enemyCompendium[0]).toMatchObject({ id: 'orc-1', name: 'Orc', tags: [] });
    });

    it('normalizes malformed enemy instances with safe defaults', async () => {
        vi.mocked(campaignStore.getEnemyInstances).mockResolvedValueOnce([
            { id: 'i-1', templateId: 'orc-1', displayName: 'Orc #1', currentHp: 20, maxHp: 20 },
        ] as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyInstances).toHaveLength(1);
        expect(state.enemyInstances[0]).toMatchObject({
            id: 'i-1',
            templateId: 'orc-1',
            displayName: 'Orc #1',
            currentHp: 20,
            maxHp: 20,
            conditions: [],
            cooldowns: [],
            resources: [],
        });
        // A missing templateSnapshot backfills a default with the displayName.
        expect(state.enemyInstances[0].templateSnapshot).toMatchObject({ name: 'Orc #1' });
    });

    it('normalizes malformed encounters with safe defaults', async () => {
        vi.mocked(campaignStore.getEnemyEncounters).mockResolvedValueOnce([
            { id: 'enc-1', name: 'Ambush', status: 'invalid-status', waves: 'not-an-array' },
        ] as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyEncounters).toHaveLength(1);
        expect(state.enemyEncounters[0]).toMatchObject({
            id: 'enc-1',
            name: 'Ambush',
            status: 'active',
            waves: [],
        });
    });

    it('normalizes malformed resolutions with safe defaults', async () => {
        vi.mocked(campaignStore.getEnemyResolutions).mockResolvedValueOnce([
            { id: 'res-1', outcome: 'invalid', xpAwarded: 'not-a-number' },
        ] as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyResolutions).toHaveLength(1);
        expect(state.enemyResolutions[0]).toMatchObject({
            id: 'res-1',
            outcome: 'other',
            xpAwarded: 0,
            encounterName: 'Encounter',
            summary: 'Encounter ended.',
            instanceDisposition: 'archive',
        });
    });

    it('normalizes malformed enemy combat config and keeps enemyDiscoveryEnabled off by default', async () => {
        vi.mocked(campaignStore.getEnemyCombatConfig).mockResolvedValueOnce({
            enabled: 'not-a-boolean',
            weaknessMultiplier: 'oops',
            initiativeMode: 'invalid',
        } as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyCombatConfig).toMatchObject({
            enabled: false,
            enemyDiscoveryEnabled: false,
            initiativeMode: 'manual',
            barrierMode: 'absorb-first',
            weaknessMultiplier: 2,
            resistanceMultiplier: 0.5,
        });
    });

    it('does not silently enable enemyDiscovery for a legacy campaign missing the flag', async () => {
        // A legacy config that predates the discovery feature has no enemyDiscoveryEnabled field.
        vi.mocked(campaignStore.getEnemyCombatConfig).mockResolvedValueOnce({
            enabled: true,
            initiativeMode: 'd20',
        } as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyCombatConfig.enemyDiscoveryEnabled).toBe(false);
    });

    it('preserves an explicit enemyDiscoveryEnabled opt-in from a Pro/Max campaign', async () => {
        vi.mocked(campaignStore.getEnemyCombatConfig).mockResolvedValueOnce({
            enabled: true,
            enemyDiscoveryEnabled: true,
        } as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyCombatConfig.enemyDiscoveryEnabled).toBe(true);
    });

    it('handles a completely missing enemy dataset without crashing', async () => {
        vi.mocked(campaignStore.getEnemyCompendium).mockResolvedValueOnce(null as any);
        vi.mocked(campaignStore.getEnemyInstances).mockResolvedValueOnce(null as any);
        vi.mocked(campaignStore.getEnemyEncounters).mockResolvedValueOnce(null as any);
        vi.mocked(campaignStore.getEnemyResolutions).mockResolvedValueOnce(null as any);
        vi.mocked(campaignStore.getEnemyCombatConfig).mockResolvedValueOnce(null as any);
        await hydrateCampaign('campaign-1');
        const state = useAppStore.getState();
        expect(state.enemyCompendium).toEqual([]);
        expect(state.enemyInstances).toEqual([]);
        expect(state.enemyEncounters).toEqual([]);
        expect(state.enemyResolutions).toEqual([]);
        expect(state.enemyCombatConfig).toMatchObject({ enemyDiscoveryEnabled: false });
    });
});