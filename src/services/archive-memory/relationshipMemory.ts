import { parsePresentHeader, resolvePresentNpcs } from '../npc/presentHeader';
import type { NPCEntry, PlayerCharacter, RelationshipMemoryFault, RelationshipMemoryImpact, RelationshipMemoryMood, RelationshipMemoryRecord } from '../../types';
import { RELATIONSHIP_MEMORY_IMPACTS, RELATIONSHIP_MEMORY_MOODS } from '../../types';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { renderPrompt } from '../prompts/promptRegistry';
import { defaultPromptText } from '../prompts/promptCatalog';

export const RELATIONSHIP_MEMORY_PROMPT = defaultPromptText('memory.relationship');

export type RelationshipMemoryParticipants = {
    presentNames: string[];
    onStageNpcs: NPCEntry[];
    playerCharacter: PlayerCharacter | null | undefined;
};

type RawRelationshipMemoryRecord = {
    subject?: unknown;
    target?: unknown;
    mood?: unknown;
    impact?: unknown;
    event?: unknown;
    outcome?: unknown;
    carried?: unknown;
    carriedNote?: unknown;
};

export type RelationshipMemoryCollections = {
    npcToMc: RelationshipMemoryRecord[];
    npcToNpc: RelationshipMemoryRecord[];
    faults: RelationshipMemoryFault[];
};

const normalise = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const aliasesFor = (entry: NPCEntry | PlayerCharacter): string[] => [
    entry.name,
    ...(typeof entry.aliases === 'string' ? entry.aliases.split(',') : []),
].map(normalise).filter(Boolean);

const findParticipant = (value: unknown, entries: Array<NPCEntry | PlayerCharacter>): NPCEntry | PlayerCharacter | undefined => {
    const needle = normalise(value).toLowerCase();
    return entries.find(entry => aliasesFor(entry).some(alias => alias.toLowerCase() === needle));
};

const splitWords = (value: string): string[] => value.split(/\s+/).map(word => word.trim()).filter(Boolean);

// 15 words / 120 chars. The old 8 / 60 squeezed out specifics and, in languages with
// longer words (Polish), cut lines mid-clause so a negation could vanish.
export const MEMORY_LINE_WORDS = 15;
export const MEMORY_LINE_CHARS = 120;

const capOutcome = (value: unknown): string => {
    const words = splitWords(normalise(value)).slice(0, MEMORY_LINE_WORDS);
    return words.join(' ').slice(0, MEMORY_LINE_CHARS).trim();
};

/** `event` shares outcome's word / char cap — reuse the helper, do not write a second one. */
const capEvent = capOutcome;

const MC_TARGETS = new Set(['mc', 'player', 'the player', 'player character', 'the player character', 'protagonist', 'the protagonist']);

/** The 👥 header's names. Uses the shared parser: the old exact `[Present]` match read the
 *  default ruleset but none of the shapes custom rulesets write (`👥 [**Rin**], …`). */
export function extractPresentNames(assistantText: string): string[] {
    return (parsePresentHeader(assistantText) ?? []).map(normalise).filter(Boolean);
}

export function getRelationshipMemoryParticipants(
    assistantText: string,
    npcLedger: NPCEntry[],
    playerCharacter: PlayerCharacter | null | undefined,
): RelationshipMemoryParticipants {
    const presentNames = extractPresentNames(assistantText);
    const onStageNpcs = resolvePresentNpcs(presentNames, npcLedger)
        .filter(npc => !npc.isPC && !npc.archived);
    return { presentNames, onStageNpcs, playerCharacter };
}

export function buildRelationshipMemoryPrompt(
    sceneText: string,
    participants: RelationshipMemoryParticipants,
): string {
    const pcAliases = participants.playerCharacter ? aliasesFor(participants.playerCharacter) : [];
    const present = participants.presentNames.map(name => {
        const isPc = pcAliases.some(alias => alias.toLowerCase() === name.toLowerCase());
        return isPc ? name + ' (player character)' : name;
    }).join(', ');
    return renderPrompt('memory.relationship', { sceneText, present });
}

export function normaliseRelationshipMemoryRecords(
    sceneId: string,
    raw: unknown,
    participants: RelationshipMemoryParticipants,
): RelationshipMemoryCollections {
    const wholeFault = (message: string): RelationshipMemoryCollections => ({
        npcToMc: [],
        npcToNpc: [],
        faults: [{ sceneId, message }],
    });
    if (!Array.isArray(raw)) return wholeFault('Relationship memory response did not contain a records array.');

    const npcToMc: RelationshipMemoryRecord[] = [];
    const npcToNpc: RelationshipMemoryRecord[] = [];
    const faults: RelationshipMemoryFault[] = [];
    const pcAliases = participants.playerCharacter ? aliasesFor(participants.playerCharacter).map(value => value.toLowerCase()) : [];
    const npcIds = new Set(participants.onStageNpcs.map(npc => npc.id));
    const npcNames = new Map(participants.onStageNpcs.flatMap(npc => aliasesFor(npc).map(name => [name.toLowerCase(), npc.id] as const)));

    for (const item of raw as RawRelationshipMemoryRecord[]) {
        const subjectEntry = findParticipant(item.subject, participants.onStageNpcs);
        if (!subjectEntry || !npcIds.has(subjectEntry.id)) continue;

        const mood = normalise(item.mood) as RelationshipMemoryMood;
        const impact = normalise(item.impact) as RelationshipMemoryImpact;
        if (!RELATIONSHIP_MEMORY_MOODS.includes(mood)) return wholeFault('Relationship memory response used an invalid mood enum.');
        if (!RELATIONSHIP_MEMORY_IMPACTS.includes(impact)) return wholeFault('Relationship memory response used an invalid impact enum.');

        const rawTarget = normalise(item.target).toLowerCase();
        const isMc = MC_TARGETS.has(rawTarget) || pcAliases.includes(rawTarget);
        const targetNpcId = npcNames.get(rawTarget);
        if (!isMc && !targetNpcId) continue;
        if (targetNpcId === subjectEntry.id) continue;

        const event = capEvent(item.event);
        const outcome = capOutcome(item.outcome);
        // §6 Fix D: a new rater record with no `event` is a validation fault. The record
        // is rejected, but other records in the same response are still stored.
        if (!event) {
            faults.push({ sceneId, message: 'record rejected — no event' });
            continue;
        }
        if (!outcome) continue;

        const carriedNote = normalise(item.carriedNote ?? item.carried);
        const finalImpact = impact === 'carried' && !carriedNote ? 'formative' : impact;
        const record: RelationshipMemoryRecord = {
            sceneId,
            subject: subjectEntry.id,
            target: isMc ? 'MC' : targetNpcId!,
            mood,
            impact: finalImpact,
            event,
            outcome,
            ...(finalImpact === 'carried' && carriedNote ? { carriedNote: carriedNote.slice(0, MEMORY_LINE_CHARS) } : {}),
            source: 'recorded',
            ...(isMc && !participants.playerCharacter ? { subjectInferred: true } : {}),
        };
        if (isMc) npcToMc.push(record);
        else npcToNpc.push(record);
    }
    return { npcToMc, npcToNpc, faults };
}

export async function rateRelationshipMemory(
    sceneId: string,
    sceneText: string,
    participants: RelationshipMemoryParticipants,
    modelCall: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<RelationshipMemoryCollections> {
    try {
        const response = await modelCall({
            prompt: buildRelationshipMemoryPrompt(sceneText, participants),
            maxTokens: 1200,
            thinkingEffort: 'off',
            temperature: 0.1,
            priority: 'low',
            trackingLabel: 'relationship-memory',
        });
        const parsed = extractJsonRobust<{ records?: unknown }>(response.content, { records: [] });
        if (!parsed.parseOk) {
            return { npcToMc: [], npcToNpc: [], faults: [{ sceneId, message: 'Relationship memory response could not be parsed as JSON.' }] };
        }
        return normaliseRelationshipMemoryRecords(sceneId, parsed.value.records, participants);
    } catch (error) {
        console.warn('[RelationshipMemory] Rating failed:', error);
        return { npcToMc: [], npcToNpc: [], faults: [{ sceneId, message: 'Relationship memory rating failed.' }] };
    }
}

export function mergeRelationshipMemoryCollections(
    existingNpcToMc: RelationshipMemoryRecord[],
    existingNpcToNpc: RelationshipMemoryRecord[],
    fresh: RelationshipMemoryCollections,
): { npcToMc: RelationshipMemoryRecord[]; npcToNpc: RelationshipMemoryRecord[] } {
    // Fresh records win over stored ones for the same scene and pair. Scene numbers are
    // reused after an archive rollback, so a stored record under the same key can come
    // from a version of the scene that no longer exists; keeping it would silently drop
    // the real memory. Hand-written (`user`) records are never replaced.
    const merge = (existing: RelationshipMemoryRecord[], incoming: RelationshipMemoryRecord[]) => {
        const key = (record: RelationshipMemoryRecord) => record.sceneId + '|' + record.subject + '|' + record.target;
        const incomingKeys = new Set(incoming.map(key));
        return [
            ...existing.filter(record => record.source === 'user' || !incomingKeys.has(key(record))),
            ...incoming,
        ];
    };
    return {
        npcToMc: merge(existingNpcToMc, fresh.npcToMc),
        npcToNpc: merge(existingNpcToNpc, fresh.npcToNpc),
    };
}

/**
 * Drop the recorded memories of scenes that left the archive (rollback, surgical delete).
 * Without this they outlive their scene, and because scene numbers are reused they are
 * later read as memories of a different scene. Hand-written (`user`) records are kept.
 */
export function pruneRelationshipMemoriesForScenes(
    collections: { npcToMc: RelationshipMemoryRecord[]; npcToNpc: RelationshipMemoryRecord[] },
    isRemovedScene: (sceneNumber: number) => boolean,
): { npcToMc: RelationshipMemoryRecord[]; npcToNpc: RelationshipMemoryRecord[]; removed: number } {
    const keep = (record: RelationshipMemoryRecord) => {
        if (record.source === 'user') return true;
        const numeric = Number.parseInt(record.sceneId, 10);
        return !Number.isFinite(numeric) || !isRemovedScene(numeric);
    };
    const npcToMc = collections.npcToMc.filter(keep);
    const npcToNpc = collections.npcToNpc.filter(keep);
    const removed = collections.npcToMc.length - npcToMc.length
        + collections.npcToNpc.length - npcToNpc.length;
    return { npcToMc, npcToNpc, removed };
}
