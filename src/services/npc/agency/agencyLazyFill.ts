import type { NPCEntry } from '../../../types';
import { deriveKeywordHex } from '../../import/keywordHex';
import { drawShortWants, drawMediumWants } from './agencyWantDraw';
import { RUNG_DEFAULT, RUNG_CEILING_DEFAULT } from './agencyConstants';
import { affinityToPcRelation } from './agencyBands';
import { isAgencyEligible } from './agencyLifecycle';

/**
 * Lazy agency fill for NPCs that predate the agency system — desktop's counterpart of
 * mobile's `populateAgencyFields` (`mobileApp/src/services/npc/npcAgencyFill.ts`), which
 * was never ported (desktop comments referenced it as if it existed).
 *
 * Off-screen agency only ticks `populated` NPCs (`agencyHeartbeat.ts`), and only the LLM
 * generator (`npc-generation/profile.ts`) and the ST importer set `populated`. Every NPC
 * created before the agency system — all ~170 in the Spirit Card World campaigns — never
 * took part, and the prompt fell back to the legacy `drives` for their motivation.
 *
 * Done the desktop way, mechanically, with the non-LLM helpers the importer uses
 * (`import/populateImportedNPC.ts`, WO-C §3.4): a keyword hexagon from the NPC's own
 * personality text, pool-drawn wants (`wantsProvenance: 'pool'`), the long want from the
 * NPC's existing goal text. The NPC updater refines wants from play afterwards.
 *
 * Returns only the fields to add; every field already set is preserved.
 */
export function needsAgencyFill(npc: NPCEntry): boolean {
    return !npc.populated && isAgencyEligible(npc);
}

const topUp = (seed: string[], draws: string[], n: number): string[] =>
    [...seed, ...draws.filter(d => !seed.includes(d))].slice(0, n);

export function agencyFillPatch(npc: NPCEntry, opts: { matureMode: boolean; rng?: () => number }): Partial<NPCEntry> {
    const rng = opts.rng ?? Math.random;
    const patch: Partial<NPCEntry> = { populated: true };

    // rng consumption order is fixed: hex first, then short wants, then medium.
    if (!npc.personalityHex) {
        patch.personalityHex = deriveKeywordHex([npc.personality, npc.disposition, npc.voice], rng).hex;
    }

    const wants = npc.wants;
    if (!wants || (!wants.short?.length && !wants.medium?.length && !wants.long)) {
        // Carry an existing drive over rather than lose it (mobile does the same).
        const drives = npc.drives;
        const traits = npc.traits ?? [];
        patch.wants = {
            short: topUp(drives?.sceneWant ? [drives.sceneWant] : [], drawShortWants({ matureMode: opts.matureMode, traits, rng }), 4),
            medium: topUp(drives?.sessionWant ? [drives.sessionWant] : [], drawMediumWants({ matureMode: opts.matureMode, traits, rng }), 3),
            long: drives?.coreWant?.trim() || npc.goals?.trim() || '',
        };
        patch.wantsProvenance = 'pool';
    }

    if (npc.pcRelation === undefined) patch.pcRelation = affinityToPcRelation(npc.affinity ?? 50);
    if (npc.skillRung === undefined) patch.skillRung = RUNG_DEFAULT;
    if (npc.rungCeiling === undefined) patch.rungCeiling = RUNG_CEILING_DEFAULT;
    if (npc.region === undefined) patch.region = '';
    return patch;
}
