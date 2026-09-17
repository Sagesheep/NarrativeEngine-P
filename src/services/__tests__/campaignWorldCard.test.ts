import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCampaignState } from '../campaignInit';
import { createWorldCard } from '../lore/worldCard';
import { saveLoreChunks, loadCampaignState, saveCampaignState, getNPCLedger } from '../../store/campaignStore';
import { extractEngineSeeds } from '../lore/loreEngineSeeder';
import { parseNPCsFromLore } from '../lore/loreNPCParser';
import { chunkLoreFile } from '../lore/loreChunker';

vi.mock('../../store/campaignStore', () => ({ saveLoreChunks: vi.fn(), loadCampaignState: vi.fn(), saveCampaignState: vi.fn(), getNPCLedger: vi.fn(), saveNPCLedger: vi.fn() }));
vi.mock('../lore/loreChunker', () => ({ chunkLoreFile: vi.fn(() => []) }));
vi.mock('../lore/loreEngineSeeder', () => ({ extractEngineSeeds: vi.fn() }));
vi.mock('../lore/loreNPCParser', () => ({ parseNPCsFromLore: vi.fn() }));
vi.mock('../lore/loreLocationParser', () => ({ parseLocationsFromLoreDetailed: vi.fn() }));
vi.mock('../tables/locationTable', () => ({ locationTableDescriptor: {}, loadLocationTable: vi.fn() }));
vi.mock('../../store/slices/campaignSlice', () => ({ dedupeNPCLedger: vi.fn() }));
vi.mock('../../store/slices/settingsSlice', () => ({ DEFAULT_SURPRISE_TYPES: [], DEFAULT_SURPRISE_TONES: [], DEFAULT_ENCOUNTER_TYPES: [], DEFAULT_ENCOUNTER_TONES: [], DEFAULT_WORLD_WHO: [], DEFAULT_WORLD_WHERE: [], DEFAULT_WORLD_WHY: [], DEFAULT_WORLD_WHAT: [] }));
vi.mock('../../store/useAppStore', () => { throw new Error('World imports must not load AI enrichment'); });

beforeEach(() => vi.clearAllMocks());
describe('campaign world-file initialization', () => {
    it('loads authored lore without creating characters, seeding engines or rechunking', async () => {
        const card = createWorldCard('Persona 3', [{ id: 'p3', header: 'Tartarus', content: 'A labyrinth.', tokens: 0, alwaysInclude: false,
            triggerKeywords: ['Tartarus'], scanDepth: 5, category: 'location', linkedEntities: [], priority: 6, disabled: false, ragMode: 'keyword' }]);
        vi.mocked(loadCampaignState).mockResolvedValue(null);
        await initializeCampaignState({ campaignId: 'test-only', loreFile: new File([''], 'p3.png'), rulesFile: null,
            preparedWorld: { card, source: 'native', warnings: [] } });
        expect(saveLoreChunks).toHaveBeenCalledWith('test-only', card.world.chunks);
        expect(chunkLoreFile).not.toHaveBeenCalled();
        expect(parseNPCsFromLore).not.toHaveBeenCalled();
        expect(getNPCLedger).not.toHaveBeenCalled();
        expect(extractEngineSeeds).not.toHaveBeenCalled();
        expect(saveCampaignState).toHaveBeenCalledWith('test-only', expect.objectContaining({ messages: [] }));
    });
    it('rejects damaged imports before any writes', async () => {
        await expect(initializeCampaignState({ campaignId: 'test-only', loreFile: { name: 'bad.json', size: 2, text: async () => '{}' } as File, rulesFile: null })).rejects.toThrow(/lorebook/);
        expect(saveLoreChunks).not.toHaveBeenCalled();
        expect(saveCampaignState).not.toHaveBeenCalled();
    });
});
