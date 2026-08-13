import type { NPCEntry, PlayerCharacter, RelationshipMemoryFault, RelationshipMemoryImpact, RelationshipMemoryMood, RelationshipMemoryRecord } from '../../types';
import { RELATIONSHIP_MEMORY_IMPACTS, RELATIONSHIP_MEMORY_MOODS } from '../../types';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

export const RELATIONSHIP_MEMORY_PROMPT = `You are recording what happened between people in one scene of an ongoing story —
as each of them would remember it, not as a narrator would summarise it.

[SCENE]
{committed scene text}

[PRESENT]
{names; mark the player character}

Emit one record per DIRECTED pair that something actually passed through.
A record is one person's memory OF another. The same moment is often
triumphant for one of them and humbling for the other — record each side
separately when both are present.

If nothing passed between two people, emit nothing for that pair. Being in
the same room is not a memory. Most pairs in most scenes produce nothing,
and emitting nothing is the correct answer, not a failure.

For each record:

mood — the emotional register. Exactly one of:
  tender         intimacy, care, closeness
  companionable  easy, warm, ordinary — friendship, not intimacy
  triumphant     victory, pride, vindication
  humbling       defeat, shame, being seen at your lowest
  hostile        anger, violence, open confrontation
  fraught        tension without open conflict — suspicion, things unsaid
  grave          grief, loss, solemnity
  logistical     nothing emotional passed — business, travel, information

impact — how much this will weigh on them. Answer the tests, in order:
  passing        they would never think of this again
  remembered     they would bring this up
  formative      it changed how they read the other person
  carried        they will carry this for the rest of their life

  Most moments are \`passing\`. That is not a flat scene — ordinary life is
  mostly passing, and a story where everything is formative has no shape.
  Reach past \`remembered\` only when the test is plainly met.

  \`carried\` also requires you to name what they carry, in one short clause.
  If you cannot finish that sentence, it is not carried — say \`formative\`.

event — what the OTHER person did, or what happened to them. Eight words or
  fewer. This is the part both people in the room would agree on. "put a hand
  on her head", "burned the supply train", "spared her students". Concrete and
  visual — a later writer has only this line to work from.

outcome — what THIS person VISIBLY did in response. Eight words or fewer. What
  an observer saw, never what they felt inside. "went silent and left", not
  "felt betrayed".

  event and outcome are two different facts. Do not put the reaction in
  \`event\`, and do not restate the event in \`outcome\`.

GOOD: {"subject":"Edelgard","target":"Byleth","mood":"humbling",
       "impact":"carried","carried":"that he chose which of her students lived",
       "event":"spared some of her students, killed others",
       "outcome":"asked him to be quick"}
GOOD: {"subject":"Edelgard","target":"Byleth","mood":"tender",
       "impact":"formative","event":"put a hand on her head",
       "outcome":"went red and said nothing"}
BAD:  {"subject":"Edelgard","target":"Byleth","mood":"hostile",
       "impact":"formative","event":"she felt humiliated",
       "outcome":"felt her world collapse"}
      — \`event\` holds a feeling instead of the other person's action, \`outcome\`
        describes an interior state no observer could see, and the moment is
        plainly \`carried\` but no clause was offered.

Return JSON only:
{"records":[ ... ]}`;

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

const capOutcome = (value: unknown): string => {
    const words = splitWords(normalise(value)).slice(0, 8);
    return words.join(' ').slice(0, 60).trim();
};

/** `event` shares outcome's 8-word / 60-char cap — reuse the helper, do not write a second one. */
const capEvent = capOutcome;

const MC_TARGETS = new Set(['mc', 'player', 'the player', 'player character', 'the player character', 'protagonist', 'the protagonist']);

export function extractPresentNames(assistantText: string): string[] {
    const match = assistantText.match(/\[Present\]\s*([^\r\n]+)/i);
    if (!match) return [];
    return match[1].split(',').map(normalise).filter(Boolean);
}

export function getRelationshipMemoryParticipants(
    assistantText: string,
    npcLedger: NPCEntry[],
    playerCharacter: PlayerCharacter | null | undefined,
): RelationshipMemoryParticipants {
    const presentNames = extractPresentNames(assistantText);
    const present = new Set(presentNames.map(name => name.toLowerCase()));
    const onStageNpcs = npcLedger.filter(npc =>
        !npc.isPC &&
        !npc.archived &&
        aliasesFor(npc).some(alias => present.has(alias.toLowerCase()))
    );
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
    return RELATIONSHIP_MEMORY_PROMPT
        .replace('{committed scene text}', sceneText)
        .replace('{names; mark the player character}', present);
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
            ...(finalImpact === 'carried' && carriedNote ? { carriedNote: carriedNote.slice(0, 60) } : {}),
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
    const merge = (existing: RelationshipMemoryRecord[], incoming: RelationshipMemoryRecord[]) => {
        const key = (record: RelationshipMemoryRecord) => record.sceneId + '|' + record.subject + '|' + record.target;
        const keys = new Set(existing.map(key));
        return [...existing, ...incoming.filter(record => !keys.has(key(record)))];
    };
    return {
        npcToMc: merge(existingNpcToMc, fresh.npcToMc),
        npcToNpc: merge(existingNpcToNpc, fresh.npcToNpc),
    };
}
