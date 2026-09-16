/**
 * WO-C §5 / §10.4 — the NPC-Ledger quick-add, as pure planning logic.
 *
 * The ledger's Import button used to accept exactly one thing: a JSON array
 * exported from another campaign's ledger. That array still routes to the
 * Full/Strip/Isekai chooser (`prepareImportedNpcs` + `ImportChoiceDialog`) —
 * it carries origin-campaign baggage that has to be triaged. A SillyTavern
 * card carries none of that: it is a fresh character, so §10.4 sends it
 * straight past the chooser into the current campaign.
 *
 * Everything here is pure — no store, no network, no React, no `Date.now()`.
 * The modal reads files, uploads portraits and drives the overwrite dialog;
 * this module decides *what* should happen, so that decision is testable
 * without mounting anything.
 */

import type { LoreChunk, NPCEntry } from '../../types';
import type { STCard, STPngFailure } from './stCardTypes';
import type { CardToNPCFlags } from './stCardConvert';
import { parseJsonCard, parsePngCard } from './stCardParser';
import { cardToNPC } from './stCardConvert';
import { populateImportedNPC } from './populateImportedNPC';
import { CARD_OWNED_FIELDS, findExistingByName, normalizeName, overwriteImportedNPC } from './importOverwrite';

/* ------------------------------------------------------------------ *
 * Routing (§10.4)
 * ------------------------------------------------------------------ */

export type QuickAddFileKind = 'png' | 'json';

/** Why one dropped file produced nothing (§9.5 — the parser's reason is kept verbatim). */
export type QuickAddFailureReason = STPngFailure | 'not-json' | 'not-card';

export type QuickAddRouted =
    /** A ledger export from another campaign — the pre-existing chooser path, untouched. */
    | { kind: 'legacy-npc-array'; fileName: string; entries: Partial<NPCEntry>[] }
    | { kind: 'card'; fileName: string; card: STCard }
    | { kind: 'failed'; fileName: string; reason: QuickAddFailureReason };

/**
 * Decide what a single dropped file is. Total — never throws, never blocks the
 * other files in the drop (§9.5).
 *
 * PNG: straight to the chunk walk, which reports *why* it failed.
 * JSON: an array is the legacy NPC export (that shape predates cards and has
 * its own committed behaviour); anything else gets one chance to be a card.
 */
export function routeQuickAddFile(
    fileName: string,
    kind: QuickAddFileKind,
    payload: ArrayBuffer | string,
): QuickAddRouted {
    if (kind === 'png') {
        if (typeof payload === 'string') return { kind: 'failed', fileName, reason: 'not-png' };
        const result = parsePngCard(payload);
        return result.ok
            ? { kind: 'card', fileName, card: result.card }
            : { kind: 'failed', fileName, reason: result.reason };
    }

    const text = typeof payload === 'string' ? payload : '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        return { kind: 'failed', fileName, reason: 'not-json' };
    }

    if (Array.isArray(parsed)) {
        return { kind: 'legacy-npc-array', fileName, entries: parsed as Partial<NPCEntry>[] };
    }

    const card = parseJsonCard(text);
    if (!card) return { kind: 'failed', fileName, reason: 'not-card' };
    return { kind: 'card', fileName, card };
}

/** §9.5 — one sentence per failure mode, written for the person who dropped the file. */
const FAILURE_TEXT: Record<QuickAddFailureReason, string> = {
    'not-png': 'not a PNG (a renamed WebP or JPEG?)',
    'no-card-payload': 'no character data embedded — this looks like a re-saved preview; download the original card file',
    'malformed-payload': 'the embedded character data was malformed',
    truncated: 'the file is truncated or incomplete',
    'not-json': 'not valid JSON',
    'not-card': 'valid JSON, but not a character card',
};

export function describeQuickAddFailure(reason: QuickAddFailureReason): string {
    return FAILURE_TEXT[reason];
}

/* ------------------------------------------------------------------ *
 * Planning (§5, §9.4)
 * ------------------------------------------------------------------ */

export type QuickAddAddition = {
    fileName: string;
    card: STCard;
    npc: NPCEntry;
    loreChunks: LoreChunk[];
    flags: CardToNPCFlags;
};

export type QuickAddCollision = {
    fileName: string;
    card: STCard;
    /** The row that already owns this name — a ledger entry, or an earlier addition in this same drop. */
    existing: NPCEntry;
    incoming: NPCEntry;
    loreChunks: LoreChunk[];
    flags: CardToNPCFlags;
};

export type QuickAddPlan = {
    additions: QuickAddAddition[];
    collisions: QuickAddCollision[];
    failures: { fileName: string; reason: QuickAddFailureReason }[];
    /** Concatenated across every legacy export file in the drop. */
    legacyEntries: Partial<NPCEntry>[];
};

export type QuickAddOpts = {
    /** Bakes `{{user}}` — the live PC's name, else `'You'` (§5). */
    userName: string;
    /** `AppSettings.matureMode`, read at the call site and passed in (§10.6). */
    matureMode: boolean;
    rng?: () => number;
    makeId?: () => string;
};

/**
 * Turn a routed drop into the exact set of writes the ledger should perform.
 *
 * Every card runs `cardToNPC` then `populateImportedNPC` — the populate is not
 * optional (§3.4: an imported NPC left `populated: false` never wanders).
 *
 * §9.4 collision rule, applied uniformly: a card whose normalized name matches
 * an existing ledger row is a collision against that row. A *second* card with
 * the name of an earlier addition in this same drop is a collision against that
 * addition — so the drop never silently keeps the first, and one dialog serves
 * both cases. The modal writes additions before draining the collision queue,
 * which is what makes the intra-drop `existing` a real ledger row by the time
 * its dialog resolves.
 */
export function planQuickAdd(
    routed: QuickAddRouted[],
    ledger: NPCEntry[],
    opts: QuickAddOpts,
): QuickAddPlan {
    const rng = opts.rng ?? Math.random;
    const plan: QuickAddPlan = { additions: [], collisions: [], failures: [], legacyEntries: [] };

    for (const item of routed) {
        if (item.kind === 'failed') {
            plan.failures.push({ fileName: item.fileName, reason: item.reason });
            continue;
        }
        if (item.kind === 'legacy-npc-array') {
            plan.legacyEntries.push(...item.entries);
            continue;
        }

        const { card } = item;
        const converted = cardToNPC(card, { userName: opts.userName, makeId: opts.makeId });
        const npc = populateImportedNPC(converted.npc, card, { rng, matureMode: opts.matureMode });

        const key = normalizeName(card.name);
        const existing =
            findExistingByName(ledger, card.name) ??
            (key ? plan.additions.find(a => normalizeName(a.npc.name) === key)?.npc : undefined);

        const common = {
            fileName: item.fileName,
            card,
            loreChunks: converted.loreChunks,
            flags: converted.flags,
        };
        if (existing) plan.collisions.push({ ...common, existing, incoming: npc });
        else plan.additions.push({ ...common, npc });
    }

    return plan;
}

/* ------------------------------------------------------------------ *
 * Overwrite patch (§9.4, §10.10)
 * ------------------------------------------------------------------ */

/**
 * The `updateNPC` patch for an accepted overwrite: the card-owned fields of
 * `overwriteImportedNPC`'s result and nothing else.
 *
 * `id` can never appear — the loop only ever visits `CARD_OWNED_FIELDS`, and
 * that const is the whitelist §10.10 makes structural. Updating in place (never
 * delete-and-re-add) is what preserves divergence subject links and relation
 * edges pointing at the row.
 *
 * Fields `overwriteImportedNPC` declined to replace come back identical to the
 * existing row, so they are dropped: the patch carries only what actually
 * changed. That matters for `portrait` in particular — a card with no usable
 * PNG must not re-write (or blank) a portrait the campaign already has.
 */
export function applyOverwrite(existing: NPCEntry, incoming: NPCEntry): Partial<NPCEntry> {
    const merged = overwriteImportedNPC(existing, incoming);
    const patch: Partial<NPCEntry> = {};

    for (const field of CARD_OWNED_FIELDS) {
        if (merged[field] === existing[field]) continue;
        switch (field) {
            case 'personality': patch.personality = merged.personality; break;
            case 'storyRelevance': patch.storyRelevance = merged.storyRelevance; break;
            case 'exampleOutput': patch.exampleOutput = merged.exampleOutput; break;
            case 'portrait': patch.portrait = merged.portrait; break;
            case 'aliases': patch.aliases = merged.aliases; break;
            case 'appearance': patch.appearance = merged.appearance; break;
            case 'visualProfile': patch.visualProfile = merged.visualProfile; break;
        }
    }

    return patch;
}

/* ------------------------------------------------------------------ *
 * Completion summary (§9.5, §9.6.4, §9.6.6)
 * ------------------------------------------------------------------ */

export type QuickAddDecision = 'overwrite' | 'skip';

export type QuickAddDecisions = {
    /** One entry per `plan.collisions`, in order. A missing entry counts as skipped. */
    collisions: QuickAddDecision[];
    /** Card names whose portrait upload failed — the import still landed (§9.5). */
    portraitFailures?: string[];
};

function list(names: string[]): string {
    return names.join(', ');
}

/**
 * The completion toast.
 *
 * Says out loud everything the WO refuses to let happen silently: which NPCs
 * got a personality inferred from tags rather than authored (§9.6.4c), how many
 * always-on lore entries were routed to searchable memory (§9.6.6), which
 * portraits did not land, and why each rejected file was rejected (§9.5).
 */
export function summarizeQuickAdd(plan: QuickAddPlan, decisions: QuickAddDecisions): string {
    const overwritten = plan.collisions.filter((_c, i) => decisions.collisions[i] === 'overwrite');
    const skipped = plan.collisions.length - overwritten.length;
    const landed = [...plan.additions, ...overwritten];

    const cardCount = landed.length;
    const loreCount = landed.reduce((sum, entry) => sum + entry.loreChunks.length, 0);

    const head = [`Imported ${cardCount} card(s), ${loreCount} lore entries`];
    if (overwritten.length > 0) head.push(`${overwritten.length} overwritten`);
    if (skipped > 0) head.push(`${skipped} skipped`);

    const sentences = [`${head.join('; ')}.`];

    const inferred = landed.filter(e => e.flags.personalityInferredFromTags).map(e => e.card.name);
    if (inferred.length > 0) sentences.push(`Personality inferred from tags for: ${list(inferred)}.`);

    const demoted = landed.reduce((sum, entry) => sum + entry.flags.constantDemoted, 0);
    if (demoted > 0) sentences.push(`${demoted} always-on lore entr${demoted === 1 ? 'y' : 'ies'} routed to searchable memory.`);

    const portraitFailures = decisions.portraitFailures ?? [];
    if (portraitFailures.length > 0) sentences.push(`No portrait for: ${list(portraitFailures)}.`);

    for (const failure of plan.failures) {
        sentences.push(`Skipped ${failure.fileName}: ${describeQuickAddFailure(failure.reason)}.`);
    }

    return sentences.join(' ');
}
