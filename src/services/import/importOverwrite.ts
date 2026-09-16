/**
 * WO-C §9.4 / §10.10 — the pure core of the existing-character overwrite.
 *
 * Re-importing a card must refresh what the *card* owns and touch nothing the
 * *campaign* owns: the row keeps its stable `id` (divergence subject links and
 * relation edges point at it), its relationship history, its status, its location,
 * its gear and its whole agency arc.
 *
 * The whitelist is structural, not a checklist: the result is built as
 * `{ ...existing, ...pick(incoming, CARD_OWNED_FIELDS) }` and the patch is typed
 * `Partial<Pick<NPCEntry, CardOwnedField>>`, so there is no code path — and no
 * future edit short of changing the const — that can write a campaign-owned key.
 *
 * Pure: no store, no network, no mutation of either argument.
 */

import type { LoreChunk, NPCEntry, NPCVisualProfile } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';

/** Normalized name comparison: trimmed, internal whitespace collapsed, lowercased. */
export function normalizeName(s: string): string {
    return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Provenance group stamped on every chunk a card produces (§8). */
export function cardLoreGroup(cardName: string): string {
    return `ST:${cardName}`;
}

/**
 * The ONLY fields an overwrite may replace. Everything absent from this list is
 * campaign-owned and survives untouched.
 */
export const CARD_OWNED_FIELDS = [
    'personality',
    'storyRelevance',
    'exampleOutput',
    'portrait',
    'aliases',
    'appearance',
    'visualProfile',
] as const;

export type CardOwnedField = (typeof CARD_OWNED_FIELDS)[number];

function isDefaultVisualProfile(vp: NPCVisualProfile | undefined): boolean {
    if (!vp) return true;
    return (Object.keys(DEFAULT_VISUAL_PROFILE) as (keyof NPCVisualProfile)[])
        .every(k => (vp[k] ?? '') === DEFAULT_VISUAL_PROFILE[k]);
}

/**
 * Per-field replacement rules (§10.10). `personality` / `storyRelevance` /
 * `exampleOutput` are always card-owned; the rest replace only when the card
 * actually carries something and the campaign has not already written its own.
 */
const CARD_OWNED_RULES: { [K in CardOwnedField]: (existing: NPCEntry, incoming: NPCEntry) => boolean } = {
    personality: () => true,
    storyRelevance: () => true,
    exampleOutput: () => true,
    // A card without a usable PNG must not blank a portrait the user already has.
    portrait: (_existing, incoming) => !!incoming.portrait && incoming.portrait.trim() !== '',
    aliases: (_existing, incoming) => !!incoming.aliases && incoming.aliases.trim() !== '',
    // Appearance drifts in play (wounds, changes of dress) — only fill a blank.
    appearance: existing => !existing.appearance || existing.appearance.trim() === '',
    // Only seed a visual profile the user (or the portrait generator) never customized.
    visualProfile: (existing, incoming) => incoming.visualProfile !== undefined && isDefaultVisualProfile(existing.visualProfile),
};

/**
 * Overwrite an existing ledger row from a freshly converted card.
 *
 * Card-owned: `personality`, `storyRelevance`, `exampleOutput`, and conditionally
 * `portrait` / `aliases` / `appearance` / `visualProfile`.
 * Campaign-owned (never written here): `id`, `name` — the existing casing is the one
 * the player has been reading — plus `pcRelation`, `affinity`, `relationMeter`,
 * `relations`, `status`, `condition`, `region`, `haunt`, `faction`, `wants`,
 * `goalRecords`, `signatureKit`, `pressure`, `agencyActivity`, `skillRung`,
 * `rungCeiling`, `traits`, `personalityHex`, `archived*`, `lastUpdateScene`,
 * `fieldTags`, `primaryGroup`, `secondaryGroup`, `repressionPressure`,
 * `behavioralTriggers`, `hardBoundaries`, `softBoundaries`, `populated`, `tier`,
 * `drives`, `goals`, `disposition`, `voice`, `transmigrated`, `agencyLocked`.
 */
export function overwriteImportedNPC(existing: NPCEntry, incoming: NPCEntry): NPCEntry {
    const patch: Partial<Pick<NPCEntry, CardOwnedField>> = {};

    for (const field of CARD_OWNED_FIELDS) {
        if (!CARD_OWNED_RULES[field](existing, incoming)) continue;
        switch (field) {
            case 'personality': patch.personality = incoming.personality; break;
            case 'storyRelevance': patch.storyRelevance = incoming.storyRelevance; break;
            case 'exampleOutput': patch.exampleOutput = incoming.exampleOutput; break;
            case 'portrait': patch.portrait = incoming.portrait; break;
            case 'aliases': patch.aliases = incoming.aliases; break;
            case 'appearance': patch.appearance = incoming.appearance; break;
            case 'visualProfile': patch.visualProfile = incoming.visualProfile; break;
        }
    }

    return { ...existing, ...patch };
}

/** The card name a chunk's `ST:` provenance group refers to, or `null` for any other group. */
function groupCardName(group: string | undefined): string | null {
    if (!group) return null;
    const m = /^st:(.*)$/i.exec(group.trim());
    return m ? normalizeName(m[1]) : null;
}

/**
 * Replace a card's whole source-lore group rather than appending an incompatible
 * second copy (§9.4). Chunks with no group, or with a different `ST:` group, or with
 * a campaign-created group, are preserved in their original order; the new chunks are
 * appended at the end.
 */
export function replaceCardLoreGroup(chunks: LoreChunk[], cardName: string, newChunks: LoreChunk[]): LoreChunk[] {
    const target = normalizeName(cardName);
    const kept = chunks.filter(c => groupCardName(c.group) !== target);
    return [...kept, ...newChunks];
}

/** Find the ledger row a card collides with, by normalized name (§9.4). */
export function findExistingByName(ledger: NPCEntry[], name: string): NPCEntry | undefined {
    const target = normalizeName(name);
    if (!target) return undefined;
    return ledger.find(n => normalizeName(n.name) === target);
}
