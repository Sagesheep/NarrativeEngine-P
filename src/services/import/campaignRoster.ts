import type { NPCEntry, LoreChunk } from '../../types';
import { routeQuickAddFile, describeQuickAddFailure, planQuickAdd } from './ledgerQuickAdd';

export type CampaignRosterEntry = {
    npc: NPCEntry;
    loreChunks: LoreChunk[];
    characterSheets: LoreChunk[];
    includeLore: boolean;
    portraitFile?: File;
    preview?: string;
};

export async function prepareRosterFile(file: File, matureMode: boolean): Promise<CampaignRosterEntry> {
    if (file.size > 20 * 1024 * 1024) throw new Error('Character cards must be smaller than 20 MB.');
    const png = /\.png$/i.test(file.name);
    const routed = routeQuickAddFile(file.name, png ? 'png' : 'json', png ? await file.arrayBuffer() : await file.text());
    if (routed.kind === 'failed') throw new Error(`${file.name}: ${describeQuickAddFailure(routed.reason)}`);
    if (routed.kind !== 'card') throw new Error('Choose a SillyTavern character card. Import existing ledger exports from the NPC roster inside a campaign.');
    const plan = planQuickAdd([routed], [], { userName: 'You', matureMode });
    const addition = plan.additions[0];
    return { npc: addition.npc, loreChunks: addition.loreChunks.filter(c => c.category !== 'character'), characterSheets: addition.loreChunks.filter(c => c.category === 'character'), includeLore: false, portraitFile: png ? file : undefined };
}
