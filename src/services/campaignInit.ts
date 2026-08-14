import type { GameContext, LootTree } from '../types';
import {
    saveLoreChunks, getNPCLedger, saveNPCLedger,
    loadCampaignState, saveCampaignState,
} from '../store/campaignStore';
import { chunkLoreFile } from './lore/loreChunker';
import { extractEngineSeeds } from './lore/loreEngineSeeder';
import { parseNPCsFromLore } from './lore/loreNPCParser';
import { parseLocationsFromLore } from './lore/loreLocationParser';
import { locationTableDescriptor, loadLocationTable } from './tables/locationTable';
import { genericSave } from './tables/genericAccessor';
import { resolvePlace } from './locationParser';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from '../store/slices/settingsSlice';
import { dedupeNPCLedger } from '../store/slices/campaignSlice';
import { loadLootTree } from './lore/lootTreeLoader';
import { buildDefaultDiceSystem } from '../types';


export const DEFAULT_CONTEXT = {
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', characterProfile: { identity: {}, activeTraits: [] },
    inventoryItems: [],
    characterProfileData: { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' },
    smartBookkeepingActive: true,
    surpriseDC: 95, encounterDC: 198, worldEventDC: 498,
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: false, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    diceSystem: buildDefaultDiceSystem(),
    worldVibe: '',
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] },
    notebook: [],
    notebookActive: true,
    relationshipMemory: false,
};

export const DEFAULT_CONDENSER = { condensedUpToIndex: -1 };

export async function initializeCampaignState(params: {
    campaignId: string;
    loreFile: File | null;
    rulesFile: File | null;
    lootFile?: File | null;
}): Promise<void> {
    const { campaignId, loreFile, rulesFile, lootFile } = params;

    let seeds: ReturnType<typeof extractEngineSeeds> | null = null;
    if (loreFile) {
        const loreText = await loreFile.text();
        // Character and location chunks are RAG-disabled on import: the parsers below turn
        // the same chunks into ledger entries, and the ledger is the authoritative injection
        // path for both (payload/world.ts drops any ledger NPC whose name collides with a
        // retrieved lore header, so leaving both on lets lore shadow the ledger; for places
        // the shadowing is the reverse — lore says "Flourishing" forever while the ledger's
        // `status` tracks that the city was sacked in ch. 12).
        // Filters on category, not disabled, so seeding is unaffected. Re-enable per chunk
        // or in bulk from the Context Bank → World tab.
        const chunks = chunkLoreFile(loreText).map(c =>
            c.category === 'character' || c.category === 'location' ? { ...c, disabled: true } : c
        );
        await saveLoreChunks(campaignId, chunks);

        // Non-blocking LLM keyword enrichment — fire and forget
        try {
            const { useAppStore } = await import('../store/useAppStore');
            const utilityEndpointForEnrichment = useAppStore.getState().getActiveUtilityEndpoint();
            if (utilityEndpointForEnrichment?.endpoint) {
                import('./lore/loreKeywordEnricher').then(({ enrichLoreKeywords }) => {
                    enrichLoreKeywords(campaignId, chunks, utilityEndpointForEnrichment)
                        .catch(err => console.warn('[LoreEnricher] Background enrichment failed:', err));
                }).catch(() => {});
            }
        } catch (err) {
            console.warn('[LoreEnricher] Failed to queue enrichment:', err);
        }

        const parsedNPCs = parseNPCsFromLore(chunks);
        if (parsedNPCs.length > 0) {
            const existingNPCs = await getNPCLedger(campaignId);
            await saveNPCLedger(campaignId, dedupeNPCLedger([...existingNPCs, ...parsedNPCs]));
        }

        // Same deal for places. Dedupe against the existing ledger by name+alias
        // (resolvePlace is the ledger's own matcher) so re-importing a lore file
        // into a campaign in progress tops up rather than duplicating.
        const parsedLocations = parseLocationsFromLore(chunks);
        if (parsedLocations.length > 0) {
            const existingLocations = await loadLocationTable(campaignId);
            const additions = parsedLocations.filter(loc => !resolvePlace(loc.name, existingLocations));
            if (additions.length > 0) {
                await genericSave(locationTableDescriptor as never, campaignId, [...existingLocations, ...additions]);
            }
        }

        seeds = extractEngineSeeds(chunks);
    }

    let lootTree: LootTree | null = null;
    if (lootFile) {
        try {
            const rawLoot = JSON.parse(await lootFile.text());
            lootTree = loadLootTree(rawLoot);
        } catch (e) {
            console.error('[LootLoader] Failed to parse lootFile:', e);
        }
    }

    const existingState = await loadCampaignState(campaignId);
    if (!existingState || rulesFile || seeds || lootTree) {
        const ctx = { ...DEFAULT_CONTEXT, ...(existingState?.context ?? {}) } as GameContext;
        if (rulesFile) ctx.rulesRaw = await rulesFile.text();
        if (lootTree) ctx.lootTree = lootTree;
        if (seeds) {
            ctx.surpriseConfig = {
                ...ctx.surpriseConfig, initialDC: ctx.surpriseConfig?.initialDC ?? 95,
                dcReduction: ctx.surpriseConfig?.dcReduction ?? 3,
                types: seeds.surpriseTypes.length > 0 ? seeds.surpriseTypes : [...DEFAULT_SURPRISE_TYPES],
                tones: seeds.surpriseTones.length > 0 ? seeds.surpriseTones : [...DEFAULT_SURPRISE_TONES],
            };
            ctx.encounterConfig = {
                ...ctx.encounterConfig, initialDC: ctx.encounterConfig?.initialDC ?? 198,
                dcReduction: ctx.encounterConfig?.dcReduction ?? 2,
                types: seeds.encounterTypes.length > 0 ? seeds.encounterTypes : [...DEFAULT_ENCOUNTER_TYPES],
                tones: seeds.encounterTones.length > 0 ? seeds.encounterTones : [...DEFAULT_ENCOUNTER_TONES],
            };
            ctx.worldEventConfig = {
                ...ctx.worldEventConfig, initialDC: ctx.worldEventConfig?.initialDC ?? 498,
                dcReduction: ctx.worldEventConfig?.dcReduction ?? 2,
                who: seeds.worldWho.length > 0 ? seeds.worldWho : [...DEFAULT_WORLD_WHO],
                where: seeds.worldWhere.length > 0 ? seeds.worldWhere : [...DEFAULT_WORLD_WHERE],
                why: seeds.worldWhy.length > 0 ? seeds.worldWhy : [...DEFAULT_WORLD_WHY],
                what: seeds.worldWhat.length > 0 ? seeds.worldWhat : [...DEFAULT_WORLD_WHAT],
            };
        }
        await saveCampaignState(campaignId, {
            context: { ...DEFAULT_CONTEXT, ...ctx }, messages: existingState?.messages ?? [],
            condenser: { ...(existingState?.condenser ?? DEFAULT_CONDENSER) },
        });
    }
}
