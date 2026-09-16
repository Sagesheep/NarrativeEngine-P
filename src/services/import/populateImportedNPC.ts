/**
 * WO-C §3.4 — mechanical agency populate for imported NPCs.
 *
 * Desktop has no lazy-fill sweep: `populated` is set only by the full LLM generator
 * (`npc-generation/profile.ts`) and it gates off-screen agency ticking
 * (`agencyHeartbeat.ts`). An imported NPC left `populated: false` would never wander.
 * So import populates the same fields the generator does — minus the LLM — using the
 * exact non-LLM helpers generation uses (§10.6).
 *
 * Pure: no store, no network, no `Math.random`. Never mutates its input.
 */

import type { NPCEntry } from '../../types';
import type { STCard } from './stCardTypes';
import { deriveKeywordHex } from './keywordHex';
import { drawShortWants, drawMediumWants } from '../npc/agency/agencyWantDraw';
import { RUNG_DEFAULT } from '../npc/agency/agencyConstants';
import { affinityToPcRelation } from '../npc/agency/agencyBands';

export type PopulateOpts = {
    /** Deterministic randomness for the hex fill and the want pool draws. */
    rng: () => number;
    /** `AppSettings.matureMode` — read at the UI call site and passed in (§10.6). */
    matureMode: boolean;
};

/**
 * Returns a NEW entry with the agency fields filled mechanically.
 *
 * - `personalityHex` — keyword heuristic over `personality` + `tags` ONLY. The card
 *   `description` is deliberately never scanned (W++ noise, §3.4).
 * - `wants` — the same pool draws generation uses; `long` stays `''` for the LLM
 *   updater to author later. `wantsProvenance: 'pool'` (§9.3) marks them mechanical,
 *   so the UI never presents a pool draw as inferred characterization.
 * - `populated: true` — with `tier: 'recurring'` this is the "boosted wandering"
 *   delivery: the NPC is a full agency participant from turn 1.
 * - `signatureKit` and `traits` are deliberately NOT set: the NPC updater seeds the kit
 *   on first narrated use, and guessing gear from card text is exactly the drift the
 *   Signature Kit exists to prevent.
 *
 * Every field already on `npc` is preserved.
 */
export function populateImportedNPC(npc: NPCEntry, card: STCard, opts: PopulateOpts): NPCEntry {
    const { rng, matureMode } = opts;

    // rng consumption order is fixed: hex fill first, then short wants, then medium.
    const { hex } = deriveKeywordHex([card.personality, card.tags.join(' ')], rng);

    return {
        ...npc,
        personalityHex: hex,
        wants: {
            short: drawShortWants({ matureMode, traits: [], rng }),
            medium: drawMediumWants({ matureMode, traits: [], rng }),
            long: '',
        },
        // §9.3 — these are mechanical pool draws, not inference. The C2 adaptation
        // pass restamps this `'inferred'` when a model actually authors the wants.
        wantsProvenance: 'pool',
        skillRung: RUNG_DEFAULT,
        rungCeiling: 3,
        // Mirrors the band-homing in profile.ts: affinity 50 → the neutral band, 0.
        pcRelation: affinityToPcRelation(npc.affinity ?? 50),
        populated: true,
        region: '',
    };
}
