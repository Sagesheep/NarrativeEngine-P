/**
 * WO-C §4 Step 4 + §10.3 — what the wizard decides, and what hits the disk.
 *
 * Two halves, deliberately split:
 *
 *   `buildImportPlan`          PURE. Shelf tiles + the user's four answers →
 *                              every record the campaign will be born with. No
 *                              store, no network, no LLM, no `Date.now()` of
 *                              its own (the converter stamps the opening
 *                              message). Injectable `rng` / `makeId` so a plan
 *                              is reproducible in a test.
 *
 *   `createCampaignFromImport` The write sequence, with every store call and
 *                              the two browser-only helpers injected. It is the
 *                              *shape* of `initializeCampaignState` (write, then
 *                              hydrate) and never that function itself:
 *                              `campaignInit.ts` runs the lore-file parsers and
 *                              fires a background LLM keyword-enrichment call,
 *                              and nothing in this round may make an LLM call
 *                              (§10.1).
 *
 * The plan is inert data. Nothing here touches the app store, so the wizard can
 * build a plan, show it on the Review step, and only then commit it.
 */

import type {
    Campaign,
    ChatMessage,
    CharacterCreationDraft,
    GameContext,
    LoreChunk,
    NPCEntry,
    PlayerCharacter,
} from '../../types';
import type { CampaignState } from '../../store/campaignStore';
import type { STCard } from './stCardTypes';
import type { ShelfTile } from './shelf';
import { findDuplicateGroups, personaNameCollides, rosterFromTiles } from './shelf';
import {
    buildPcContextPatch,
    cardToNPC,
    cardToPC,
    seedCardToCampaignParts,
    type CardToNPCFlags,
    type SeedCampaignParts,
} from './stCardConvert';
import { populateImportedNPC } from './populateImportedNPC';
import { overwriteImportedNPC, replaceCardLoreGroup } from './importOverwrite';
import { DEFAULT_CONDENSER, DEFAULT_CONTEXT } from '../campaignInit';
import { countTokens } from '../infrastructure/tokenizer';
import { uid } from '../../utils/uid';

/** §10.2 — the player's stand-in name when they never typed one. */
export const DEFAULT_PLAYER_NAME = 'You';
/** §4 — the campaign name when the drop carries no ★ seed to name it after. */
export const NPCS_ONLY_CAMPAIGN_NAME = 'Imported cast';

// ─── Choices (what the four wizard steps produce) ────────────────────────────

export type ImportWho =
    | { kind: 'build-own'; playerName: string }
    | { kind: 'persona'; tileId: string };

export type ImportChoices = {
    /** `npcs-only` is the Step 1 ghost button: roster only, no premise, no opening. */
    mode: 'seeded' | 'npcs-only';
    /** 0 = `first_mes`; n = `alternate_greetings[n-1]` (§3.3). */
    greetingIndex: number;
    who: ImportWho;
    campaignName: string;
    /** §9.2 — edited Campaign Premise. `undefined` or blank keeps the card's own. */
    premiseOverride?: string;
    /** §9.2 — edited Opening Scene. `undefined` or blank keeps the card's own. */
    openingOverride?: string;
    /** §9.4 intra-drop duplicates, keyed by the LATER tile's id. */
    duplicateResolutions: Record<string, 'overwrite' | 'skip'>;
};

// ─── Plan ────────────────────────────────────────────────────────────────────

export type ImportRosterEntry = {
    tileId: string;
    card: STCard;
    npc: NPCEntry;
    loreChunks: LoreChunk[];
    flags: CardToNPCFlags;
    /** The card's own PNG, uploaded as the portrait at create time. */
    pngFile: File | null;
};

export type ImportSummary = {
    /** §9.6.4(c) — personality came from tags, never presented as authored. */
    inferredFromTags: string[];
    /** §3.1 W++ guard fired — `storyRelevance` is a fallback, not the description. */
    structuredDescriptions: string[];
    /** §9.6.6 — constant lore entries routed to searchable memory. */
    constantDemoted: number;
    skippedDuplicates: string[];
    overwrittenDuplicates: string[];
    /** §4 Step 4 — a roster card shares the player's name. */
    personaNameCollision: boolean;
};

export type ImportPlan = {
    campaign: { name: string; coverFile: File | null };
    roster: ImportRosterEntry[];
    /** `null` in `npcs-only` mode — no premise, no opening, no quarantine. */
    seedParts: SeedCampaignParts | null;
    /** §4 Step 3 — the persona's full description (and any lorebook) still lands as lore. */
    persona: { pc: PlayerCharacter; pngFile: File | null; loreChunks: LoreChunk[] } | null;
    /** The name `{{user}}` was baked against (§8). */
    playerName: string;
    /** §10.2 — seeded for the "build my own" path so the PC wizard opens pre-filled. */
    creationDraft: CharacterCreationDraft | null;
    summary: ImportSummary;
};

export type BuildPlanOpts = {
    /** `AppSettings.matureMode`, read at the UI call site (§10.6). */
    matureMode: boolean;
    rng?: () => number;
    makeId?: () => string;
    now?: () => number;
};

/**
 * The tiles that become NPCs, in roster order: parsed, non-persona, ★ seed
 * first. Exported so the wizard's duplicate pass and `buildImportPlan` index
 * the exact same array — a Review dialog keyed to one ordering and a plan built
 * from another would resolve the wrong card.
 *
 * `npcs-only` ignores the star (§4): there is no seed, so nothing jumps the
 * queue and the roster keeps drop order.
 */
export function rosterTilesForImport(
    tiles: ShelfTile[],
    mode: ImportChoices['mode'],
    personaTileId: string | null,
): ShelfTile[] {
    const normalized = tiles.map(t => ({
        ...t,
        persona: personaTileId !== null && t.id === personaTileId,
        star: mode === 'npcs-only' ? false : t.star,
    }));
    return rosterFromTiles(normalized);
}

/** The persona tile id this run actually uses — `null` outside the seeded persona path. */
function personaTileIdOf(choices: ImportChoices): string | null {
    if (choices.mode !== 'seeded') return null;
    return choices.who.kind === 'persona' ? choices.who.tileId : null;
}

/**
 * §8 — `{{user}}` is baked at import against the name the player typed (or the
 * persona card's own name). `'You'` covers the blank input and the NPCs-only
 * path, where the player is not named yet at all.
 */
function resolvePlayerName(tiles: ShelfTile[], choices: ImportChoices): string {
    if (choices.mode === 'npcs-only') return DEFAULT_PLAYER_NAME;
    if (choices.who.kind === 'build-own') {
        return choices.who.playerName.trim() || DEFAULT_PLAYER_NAME;
    }
    const personaId = choices.who.tileId;
    const name = tiles.find(t => t.id === personaId)?.card?.name.trim();
    return name || DEFAULT_PLAYER_NAME;
}

function retokenize(chunk: LoreChunk, content: string): LoreChunk {
    return { ...chunk, content, tokens: countTokens(`${chunk.header}\n${content}`) };
}

/**
 * §9.2 — the edited Campaign Premise. A blank override (after trim) keeps the
 * card's own text: the textarea is prefilled from the source, so "cleared it"
 * reads as "did not want to write one", not "wanted an empty premise".
 *
 * Deviation, reasoned: when the seed card has no `scenario` at all the source
 * premise is `null` and the textarea starts empty. Text typed there still has
 * to land somewhere, so a chunk is minted in the same shape
 * `seedCardToCampaignParts` would have produced. Silently dropping what the
 * user wrote on the Review step would be the worse behaviour.
 */
function applyPremiseOverride(
    parts: SeedCampaignParts,
    override: string | undefined,
    seedName: string,
    makeId: () => string,
): LoreChunk | null {
    const text = (override ?? '').trim();
    if (!text) return parts.premiseChunk;
    if (parts.premiseChunk) return retokenize(parts.premiseChunk, text);
    const header = `Premise — ${seedName}`;
    return {
        id: makeId(),
        header,
        content: text,
        tokens: countTokens(`${header}\n${text}`),
        alwaysInclude: true,
        ragMode: 'always',
        triggerKeywords: seedName ? [seedName] : [],
        scanDepth: 3,
        category: 'world_overview',
        linkedEntities: seedName ? [seedName] : [],
        priority: 10,
        group: `ST:${seedName}`,
    };
}

/** §9.2 — same rule for the Opening Scene, which is a `ChatMessage`, not a chunk. */
function applyOpeningOverride(
    parts: SeedCampaignParts,
    override: string | undefined,
    makeId: () => string,
    now: () => number,
): ChatMessage | null {
    const text = (override ?? '').trim();
    if (!text) return parts.opening;
    if (parts.opening) return { ...parts.opening, content: text };
    return { id: makeId(), role: 'assistant', content: text, timestamp: now() };
}

/**
 * Shelf + answers → every record the new campaign is born with. Pure.
 *
 * The ★ seed card is BOTH the premise/opening source and an ordinary NPC (§8:
 * it is the central character, never the player), which is why it leads the
 * roster rather than being consumed by the seed.
 */
/**
 * Only a PNG can carry a portrait. A `.json` card has no image to upload, so
 * it must not be handed to `uploadImageToLocal` (which rejects non-images and
 * would then be reported as a portrait *failure* for a card that never had one).
 */
function pngFileFor(files: Map<string, File>, tileId: string): File | null {
    const f = files.get(tileId);
    if (!f) return null;
    const isPng = f.type === 'image/png' || /\.png$/i.test(f.name);
    return isPng ? f : null;
}

export function buildImportPlan(
    tiles: ShelfTile[],
    files: Map<string, File>,
    choices: ImportChoices,
    opts: BuildPlanOpts,
): ImportPlan {
    const makeId = opts.makeId ?? uid;
    const rng = opts.rng ?? Math.random;
    const now = opts.now ?? Date.now;
    const personaTileId = personaTileIdOf(choices);
    const playerName = resolvePlayerName(tiles, choices);

    // ── Roster ──────────────────────────────────────────────────────────────
    const rosterTiles = rosterTilesForImport(tiles, choices.mode, personaTileId);
    const entries: ImportRosterEntry[] = rosterTiles.map(tile => {
        const card = tile.card as STCard;   // rosterFromTiles only returns parsed tiles
        const { npc, loreChunks, flags } = cardToNPC(card, { userName: playerName, makeId });
        return {
            tileId: tile.id,
            card,
            // §3.4 — MUST run, or the NPC is `populated: false` and never ticks agency.
            npc: populateImportedNPC(npc, card, { rng, matureMode: opts.matureMode }),
            loreChunks,
            flags,
            pngFile: pngFileFor(files, tile.id),
        };
    });

    // ── §9.4 intra-drop duplicates ──────────────────────────────────────────
    // Never a silent keep-the-first: the user answered Overwrite or Skip for
    // every later member on the Review step. An unanswered one skips, which is
    // the conservative half of the choice.
    const skippedDuplicates: string[] = [];
    const overwrittenDuplicates: string[] = [];
    const dropped = new Set<number>();
    for (const group of findDuplicateGroups(rosterTiles)) {
        const [firstIdx, ...laterIdxs] = group.indexes;
        for (const laterIdx of laterIdxs) {
            const later = entries[laterIdx];
            dropped.add(laterIdx);
            if (choices.duplicateResolutions[later.tileId] !== 'overwrite') {
                skippedDuplicates.push(later.npc.name);
                continue;
            }
            const target = entries[firstIdx];
            target.npc = overwriteImportedNPC(target.npc, later.npc);
            target.loreChunks = replaceCardLoreGroup(target.loreChunks, later.card.name, later.loreChunks);
            // The later card wins, so its PNG is the portrait and its flags are
            // what the summary should disclose (`overwriteImportedNPC` cannot
            // carry the portrait itself — nothing is uploaded yet at plan time).
            target.card = later.card;
            target.flags = later.flags;
            target.pngFile = later.pngFile ?? target.pngFile;
            overwrittenDuplicates.push(later.npc.name);
        }
    }
    const roster = entries.filter((_, i) => !dropped.has(i));

    // ── ★ Campaign Seed ─────────────────────────────────────────────────────
    const seedTile = choices.mode === 'seeded'
        ? tiles.find(t => t.star && t.card && t.id !== personaTileId) ?? null
        : null;
    let seedParts: SeedCampaignParts | null = null;
    if (seedTile?.card) {
        const raw = seedCardToCampaignParts(seedTile.card, choices.greetingIndex, playerName, makeId);
        seedParts = {
            premiseChunk: applyPremiseOverride(raw, choices.premiseOverride, seedTile.card.name.trim(), makeId),
            opening: applyOpeningOverride(raw, choices.openingOverride, makeId, now),
            quarantineChunk: raw.quarantineChunk,
        };
    }

    // ── §10.2 who the player is ─────────────────────────────────────────────
    const personaTile = personaTileId ? tiles.find(t => t.id === personaTileId) ?? null : null;
    const persona = personaTile?.card
        ? {
            pc: cardToPC(personaTile.card, { userName: playerName }),
            pngFile: pngFileFor(files, personaTile.id),
            // §4 Step 3: "full description → PC lore chunk". The NPC converter
            // already builds the character-sheet chunk (+ any lorebook); only
            // the NPC row it would have made is discarded.
            loreChunks: cardToNPC(personaTile.card, { userName: playerName, makeId }).loreChunks,
        }
        : null;
    // A null PC plus a seeded draft is the designed nudge (§10.2): WO-A2's
    // first-send intercept fires on `playerCharacter == null` and the AI-Guided
    // wizard resumes from the draft with the name already filled.
    const creationDraft: CharacterCreationDraft | null =
        choices.mode === 'seeded' && choices.who.kind === 'build-own'
            ? { name: playerName, step: 0 }
            : null;

    // ── Campaign shell ──────────────────────────────────────────────────────
    const fallbackName = seedTile?.card?.name.trim() || NPCS_ONLY_CAMPAIGN_NAME;
    const campaignName = choices.campaignName.trim() || fallbackName;

    return {
        campaign: {
            name: campaignName,
            coverFile: seedTile ? files.get(seedTile.id) ?? null : null,
        },
        roster,
        seedParts,
        persona,
        playerName,
        creationDraft,
        summary: {
            inferredFromTags: roster.filter(e => e.flags.personalityInferredFromTags).map(e => e.npc.name),
            structuredDescriptions: roster.filter(e => e.flags.structuredDescription).map(e => e.npc.name),
            constantDemoted: roster.reduce((sum, e) => sum + e.flags.constantDemoted, 0),
            skippedDuplicates,
            overwrittenDuplicates,
            personaNameCollision: personaNameCollides(
                tiles.map(t => ({ ...t, persona: personaTileId !== null && t.id === personaTileId })),
                playerName,
            ),
        },
    };
}

// ─── §10.3 write-then-hydrate ────────────────────────────────────────────────

export type CreateDeps = {
    saveCampaign: (campaign: Campaign) => Promise<void>;
    saveLoreChunks: (campaignId: string, chunks: LoreChunk[]) => Promise<void>;
    saveNPCLedger: (campaignId: string, npcs: NPCEntry[]) => Promise<void>;
    saveCampaignState: (campaignId: string, state: CampaignState) => Promise<void>;
    hydrateCampaign: (campaignId: string) => Promise<unknown>;
    uploadImageToLocal: (file: File, npcName: string) => Promise<string>;
    downscaleCover: (file: File, maxEdge?: number) => Promise<string>;
    makeId?: () => string;
    now?: () => number;
};

export type CreateResult = {
    campaignId: string;
    /** §9.5 — names whose portrait upload failed. The import still succeeded. */
    portraitFailures: string[];
};

/**
 * §10.3 — create the campaign on disk in the order the per-campaign persistence
 * expects, then hydrate it. `hydrateCampaign` sets `activeCampaignId`, which is
 * what routes `App.tsx` out of the hub and into chat.
 *
 * Deliberately NOT `initializeCampaignState`: that runs the lore-file parsers
 * and fires a background LLM enrichment call. Import is offline (§10.1).
 *
 * One card's portrait failing must never take the import down (§9.5), so every
 * upload is caught individually and reported instead.
 */
export async function createCampaignFromImport(plan: ImportPlan, deps: CreateDeps): Promise<CreateResult> {
    const makeId = deps.makeId ?? uid;
    const now = deps.now ?? Date.now;
    const campaignId = makeId();

    // 1 ── Campaign row. Cover is browser-only; jsdom and a failed decode both
    //      land on `''`, which is a valid empty cover.
    let coverImage = '';
    if (plan.campaign.coverFile) {
        try {
            coverImage = await deps.downscaleCover(plan.campaign.coverFile);
        } catch (err) {
            console.warn('[STImport] Cover downscale failed:', err);
            coverImage = '';
        }
    }
    await deps.saveCampaign({
        id: campaignId,
        name: plan.campaign.name,
        coverImage,
        createdAt: now(),
        lastPlayedAt: now(),
    });

    // 2 ── Portraits. Requires the asset server; a 404 costs a portrait, not the import.
    const portraitFailures: string[] = [];
    const npcs: NPCEntry[] = [];
    for (const entry of plan.roster) {
        const npc: NPCEntry = { ...entry.npc };
        if (entry.pngFile) {
            try {
                npc.portrait = await deps.uploadImageToLocal(entry.pngFile, npc.name);
            } catch (err) {
                console.warn(`[STImport] Portrait upload failed for ${npc.name}:`, err);
                delete npc.portrait;
                portraitFailures.push(npc.name);
            }
        }
        npcs.push(npc);
    }

    let pc: PlayerCharacter | null = null;
    if (plan.persona) {
        pc = { ...plan.persona.pc };
        if (plan.persona.pngFile) {
            try {
                pc.portrait = await deps.uploadImageToLocal(plan.persona.pngFile, pc.name);
            } catch (err) {
                console.warn(`[STImport] Portrait upload failed for ${pc.name}:`, err);
                delete pc.portrait;
                portraitFailures.push(pc.name);
            }
        }
    }

    // 3 ── Lore: premise and quarantine first, then every card's own group.
    const chunks: LoreChunk[] = [];
    if (plan.seedParts?.premiseChunk) chunks.push(plan.seedParts.premiseChunk);
    if (plan.seedParts?.quarantineChunk) chunks.push(plan.seedParts.quarantineChunk);
    for (const entry of plan.roster) chunks.push(...entry.loreChunks);
    if (plan.persona) chunks.push(...plan.persona.loreChunks);
    await deps.saveLoreChunks(campaignId, chunks);

    // 4 ── Ledger.
    await deps.saveNPCLedger(campaignId, npcs);

    // 5 ── State. `rulesRaw` stays '' — the app's own ruleset is authoritative.
    //      DEFAULT_CONTEXT is a partial literal (campaignInit casts it the same
    //      way); the cast is the established shape, not a shortcut.
    const context = {
        ...DEFAULT_CONTEXT,
        playerCharacter: pc,
        creationDraft: plan.creationDraft,
        ...(pc ? buildPcContextPatch(pc, DEFAULT_CONTEXT as Partial<GameContext>) : {}),
    } as GameContext;
    await deps.saveCampaignState(campaignId, {
        context,
        messages: plan.seedParts?.opening ? [plan.seedParts.opening] : [],
        condenser: { ...DEFAULT_CONDENSER },
    });

    // 6 ── Hydrate: sets `activeCampaignId` and leaves the hub.
    await deps.hydrateCampaign(campaignId);

    return { campaignId, portraitFailures };
}
