import type { GameContext } from '../types';
import { DEFAULT_CHARACTER_PROFILE, DEFAULT_INVENTORY } from '../types';
import {
    saveLoreChunks, getNPCLedger, saveNPCLedger,
    loadCampaignState, saveCampaignState,
} from '../store/campaignStore';
import { chunkLoreFile } from './loreChunker';
import { extractEngineSeeds } from './loreEngineSeeder';
import { parseNPCsFromLore } from './loreNPCParser';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from '../store/slices/settingsSlice';
import { dedupeNPCLedger } from '../store/slices/campaignSlice';

export const DEFAULT_CONTEXT = {
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', characterProfile: '',
    inventoryItems: DEFAULT_INVENTORY,
    characterProfileData: DEFAULT_CHARACTER_PROFILE,
    smartBookkeepingActive: true,
    surpriseDC: 95, encounterDC: 198, worldEventDC: 498,
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: true, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', enemyPlayerActive: false, neutralPlayerActive: false, allyPlayerActive: false,
    enemyPlayerPrompt: '', neutralPlayerPrompt: '', allyPlayerPrompt: '',
    interventionChance: 25, enemyCooldown: 2, neutralCooldown: 2, allyCooldown: 2,
    interventionQueue: [] as ('enemy' | 'neutral' | 'ally')[],
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] },
    notebook: [],
    notebookActive: true,
};

export const DEFAULT_CONDENSER = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };

export async function initializeCampaignState(params: {
    campaignId: string;
    loreFile: File | null;
    rulesFile: File | null;
}): Promise<void> {
    const { campaignId, loreFile, rulesFile } = params;

    let seeds: ReturnType<typeof extractEngineSeeds> | null = null;
    if (loreFile) {
        const loreText = await loreFile.text();
        const chunks = chunkLoreFile(loreText);
        await saveLoreChunks(campaignId, chunks);
        const parsedNPCs = parseNPCsFromLore(chunks);
        if (parsedNPCs.length > 0) {
            const existingNPCs = await getNPCLedger(campaignId);
            await saveNPCLedger(campaignId, dedupeNPCLedger([...existingNPCs, ...parsedNPCs]));
        }
        seeds = extractEngineSeeds(chunks);
    }

    const existingState = await loadCampaignState(campaignId);
    if (!existingState || rulesFile || seeds) {
        const ctx = { ...DEFAULT_CONTEXT, ...(existingState?.context ?? {}) } as GameContext;
        if (rulesFile) ctx.rulesRaw = await rulesFile.text();
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
            condenser: { ...(existingState?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
        });
    }
}
