import type {
    RelationshipMemoryImpact,
    RelationshipMemoryMood,
    RelationshipMemoryRecord,
} from '../../types';

/** A scene number may be supplied in its persisted, zero-padded string form. */
export type RelationshipMemoryScene = string | number;

/** The situational inputs used by the injection score. */
export type RelationshipMemoryReadingContext = {
    currentScene: RelationshipMemoryScene;
    sceneMood: RelationshipMemoryMood;
    presentParticipants: readonly string[];
};

/** A relationship edge is normally the flat record array written by WO-1. */
export type RelationshipMemoryEdge = readonly RelationshipMemoryRecord[];

/** Also accept an object wrapper so later readers can attach edge identity without reworking this API. */
export type RelationshipMemoryEdgeLike = RelationshipMemoryEdge | {
    records: RelationshipMemoryEdge;
};

export type RelationshipMemoryClash = readonly [RelationshipMemoryRecord, RelationshipMemoryRecord];

export type RelationshipMemoryTier = 'deep' | 'cheap';

export type RelationshipMemoryTierSelection<T extends RelationshipMemoryEdgeLike> = {
    edge: T;
    tier: RelationshipMemoryTier;
    score: number;
    clashCount: number;
    pinCount: number;
    forcedDeep: boolean;
};

/**
 * The only table of tunable reading-layer numbers. Keep playtest tuning here so the scoring
 * behaviour can change without hunting through the arithmetic below.
 */
export const RELATIONSHIP_MEMORY_READING_WEIGHTS = {
    impact: {
        passing: 0.25, // Passing moments retain a non-zero memory floor before situational lifts.
        remembered: 1, // A remembered moment is the baseline unit of relational weight.
        formative: 2.5, // Formative moments change how the other person is read.
        carried: 4, // Carried moments are the strongest ordinary injection memories.
    },
    recency: {
        distanceScale: 8, // Unpinned decay is steep nearby and flat in the distant past.
        pinnedDistanceScale: 24, // Pinned memories decay three times more slowly than ordinary ones.
        carriedFloor: 0.25, // Carried memories never decay below this hard-continuity floor.
    },
    theme: {
        chargeScale: 2, // Situational theme lift is additive and cannot erase the base score.
    },
    participant: {
        weightPerParty: 0.5, // Each party present in both the memory and room adds shared-context lift.
    },
    tier: {
        clashWeight: 100, // A single contradiction dominates accumulated pin count.
        pinWeight: 1, // Pins are secondary evidence of an edge worth thinking about.
    },
    moods: {
        // WO-3.5 §4.3: tender/triumphant are both {1, 1} and hostile/humbling both {-1, 1}.
        // Scoring cannot distinguish them — only the label reaching the model can. That is
        // acceptable for v1; do not tune against a resolution this function does not have.
        tender: { valence: 1, intensity: 1 }, // Warm, high-intensity intimacy and care.
        companionable: { valence: 1, intensity: 0.35 }, // Warm, low-intensity ordinary closeness.
        triumphant: { valence: 1, intensity: 1 }, // Warm, high-intensity victory and pride.
        humbling: { valence: -1, intensity: 1 }, // Hostile, high-intensity defeat and exposure.
        hostile: { valence: -1, intensity: 1 }, // Hostile, high-intensity confrontation.
        fraught: { valence: -1, intensity: 0.35 }, // Hostile, low-intensity tension and suspicion.
        grave: { valence: 0, intensity: 1 }, // Neutral-valence, high-intensity grief and solemnity.
        logistical: { valence: 0, intensity: 0 }, // Emotionally neutral business, travel, or information.
    },
} as const;

/** The mood coordinate table is exported by name for stance and mod readers. */
export const RELATIONSHIP_MEMORY_MOOD_PROFILES = RELATIONSHIP_MEMORY_READING_WEIGHTS.moods;

const impactWeight = (impact: RelationshipMemoryImpact): number =>
    RELATIONSHIP_MEMORY_READING_WEIGHTS.impact[impact];

const sceneNumber = (scene: RelationshipMemoryScene): number => {
    const numeric = typeof scene === 'number' ? scene : Number.parseInt(scene, 10);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.trunc(numeric));
};

/** The global scene-clock distance. Future-stamped records are treated as current, never negative. */
export function sceneDistance(currentScene: RelationshipMemoryScene, recordScene: RelationshipMemoryScene): number {
    return Math.max(0, sceneNumber(currentScene) - sceneNumber(recordScene));
}

/** Pins resist decay; carried memories additionally receive the hard floor. */
export function isPinned(recordOrImpact: RelationshipMemoryRecord | RelationshipMemoryImpact): boolean {
    if (typeof recordOrImpact !== 'string' && recordOrImpact.source === 'user') return true;
    const impact = typeof recordOrImpact === 'string' ? recordOrImpact : recordOrImpact.impact;
    return impact === 'formative' || impact === 'carried';
}

export function isFloored(recordOrImpact: RelationshipMemoryRecord | RelationshipMemoryImpact): boolean {
    const impact = typeof recordOrImpact === 'string' ? recordOrImpact : recordOrImpact.impact;
    return impact === 'carried';
}

/**
 * Steep-then-flat decay. A pin changes the curve's scale, while a carried record stops at its
 * floor. This is decay, not a window: distant memories become quiet rather than disappearing.
 */
export function recencyWeight(
    record: RelationshipMemoryRecord,
    currentScene: RelationshipMemoryScene,
): number {
    const distance = sceneDistance(currentScene, record.sceneId);
    const scale = isPinned(record)
        ? RELATIONSHIP_MEMORY_READING_WEIGHTS.recency.pinnedDistanceScale
        : RELATIONSHIP_MEMORY_READING_WEIGHTS.recency.distanceScale;
    const decayed = 1 / (1 + distance / scale);
    return isFloored(record)
        ? Math.max(RELATIONSHIP_MEMORY_READING_WEIGHTS.recency.carriedFloor, decayed)
        : decayed;
}

const normaliseParticipant = (value: string): string => value.trim().toLowerCase();

type MemoryWithParticipants = RelationshipMemoryRecord & {
    participants?: readonly string[];
};

function memoryParties(record: RelationshipMemoryRecord): string[] {
    const extended = record as MemoryWithParticipants;
    const explicit = extended.participants?.filter(Boolean).map(normaliseParticipant);
    if (explicit && explicit.length > 0) return Array.from(new Set(explicit));
    return Array.from(new Set([record.subject, record.target].map(normaliseParticipant).filter(Boolean)));
}

/** Count how many distinct parties to the memory are present in the current scene. */
export function participantOverlap(
    record: RelationshipMemoryRecord,
    presentParticipants: readonly string[],
): number {
    const present = new Set(presentParticipants.map(normaliseParticipant).filter(Boolean));
    return memoryParties(record).filter(party => present.has(party)).length;
}

/**
 * Theme charge is high for both resonance and contradiction. Valence distance 0 and 2 peak;
 * distance 1 sags to zero. Intensity zero (logistical) therefore stays approximately silent.
 *
 * WO-3.5 Fix C: a neutral-valence room (grave, logistical) is permeable to everything rather
 * than orthogonal to everything. Guard the `endDistanceCharge` term so it is 1 (full charge)
 * when either side is neutral, instead of the blind `Math.abs(valenceDistance - 1)` which
 * zeroed every neutral pair. Verify: grave × tender → 1×1×1×2 = 2; logistical × anything →
 * intensity 0 → 0; grave × logistical → 0; every non-neutral pair → unchanged.
 *
 * Keep the guard rather than deleting the term. Valence has only three values today, but
 * WO-1 §4.2 allows modules to add moods; a mod introducing an intermediate valence needs the
 * intended shape to still be there.
 */
export function themeCharge(sceneMood: RelationshipMemoryMood, memoryMood: RelationshipMemoryMood): number {
    const scene = RELATIONSHIP_MEMORY_MOOD_PROFILES[sceneMood];
    const memory = RELATIONSHIP_MEMORY_MOOD_PROFILES[memoryMood];
    if (!scene || !memory) return 0;

    const valenceDistance = Math.abs(scene.valence - memory.valence);
    const neutral = scene.valence === 0 || memory.valence === 0;
    const endDistanceCharge = neutral ? 1 : Math.abs(valenceDistance - 1);
    return scene.intensity
        * memory.intensity
        * endDistanceCharge
        * RELATIONSHIP_MEMORY_READING_WEIGHTS.theme.chargeScale;
}

/** The mixed injection formula: impact × recency, plus situational theme and participant lifts. */
export function injectionScore(
    record: RelationshipMemoryRecord,
    context: RelationshipMemoryReadingContext,
): number {
    const base = impactWeight(record.impact) * recencyWeight(record, context.currentScene);
    const theme = themeCharge(context.sceneMood, record.mood);
    const participants = participantOverlap(record, context.presentParticipants)
        * RELATIONSHIP_MEMORY_READING_WEIGHTS.participant.weightPerParty;
    return base + theme + participants;
}

/** Snake-case aliases mirror the design vocabulary while the camel-case names fit project style. */
export const theme_charge = themeCharge;
export const injection_score = injectionScore;

function recordsForEdge(edge: RelationshipMemoryEdgeLike): RelationshipMemoryEdge {
    return 'records' in edge ? edge.records : edge;
}

function defaultClashContext(edge: RelationshipMemoryEdgeLike): RelationshipMemoryReadingContext {
    const records = recordsForEdge(edge);
    const currentScene = records.reduce<RelationshipMemoryScene>(
        (latest, record) => Math.max(sceneNumber(latest), sceneNumber(record.sceneId)),
        0,
    );
    const presentParticipants = Array.from(new Set(records.flatMap(memoryParties)));
    return { currentScene, sceneMood: 'logistical', presentParticipants };
}

function hasOpposingValence(a: RelationshipMemoryRecord, b: RelationshipMemoryRecord): boolean {
    const aValence = RELATIONSHIP_MEMORY_MOOD_PROFILES[a.mood].valence;
    const bValence = RELATIONSHIP_MEMORY_MOOD_PROFILES[b.mood].valence;
    return aValence * bValence < 0;
}

/**
 * Enumerate every pair of pinned records with opposing valence. Pair ordering uses the combined
 * injection score for the supplied scene context, with stable source-order tie breaks.
 */
export function clashes(
    edge: RelationshipMemoryEdgeLike,
    context: RelationshipMemoryReadingContext = defaultClashContext(edge),
): RelationshipMemoryClash[] {
    const records = recordsForEdge(edge);
    const found: Array<{ pair: RelationshipMemoryClash; score: number; index: number }> = [];
    let index = 0;

    for (let left = 0; left < records.length; left++) {
        for (let right = left + 1; right < records.length; right++) {
            const a = records[left];
            const b = records[right];
            if (!isPinned(a) || !isPinned(b) || !hasOpposingValence(a, b)) continue;
            found.push({
                pair: [a, b],
                score: injectionScore(a, context) + injectionScore(b, context),
                index: index++,
            });
        }
    }

    found.sort((a, b) => b.score - a.score || a.index - b.index);
    return found.map(item => item.pair);
}

export function clashCount(edge: RelationshipMemoryEdgeLike): number {
    return clashes(edge).length;
}

/** Tier score deliberately excludes event count and recency. Carried history forces deep tier. */
export function tierScore(edge: RelationshipMemoryEdgeLike): number {
    const records = recordsForEdge(edge);
    if (records.some(record => record.impact === 'carried')) return Number.POSITIVE_INFINITY;
    return clashes(edge).length * RELATIONSHIP_MEMORY_READING_WEIGHTS.tier.clashWeight
        + records.filter(isPinned).length * RELATIONSHIP_MEMORY_READING_WEIGHTS.tier.pinWeight;
}

function edgeHasCarried(edge: RelationshipMemoryEdgeLike): boolean {
    return recordsForEdge(edge).some(record => record.impact === 'carried');
}

/**
 * Rank present edges against a budget. Forced carried edges are always deep; the budget chooses
 * the remaining deep edges by score, and the returned array preserves caller order for stability.
 */
export function selectTiers<T extends RelationshipMemoryEdgeLike>(
    presentEdges: readonly T[],
    budget: number,
): RelationshipMemoryTierSelection<T>[] {
    const details = presentEdges.map((edge, index) => ({
        edge,
        index,
        score: tierScore(edge),
        clashCount: clashCount(edge),
        pinCount: recordsForEdge(edge).filter(isPinned).length,
        forcedDeep: edgeHasCarried(edge),
    }));
    const forced = details.filter(detail => detail.forcedDeep);
    const availableBudget = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
    const remaining = Math.max(0, availableBudget - forced.length);
    const rankedOptional = details
        .filter(detail => !detail.forcedDeep)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, remaining);
    const deep = new Set([...forced, ...rankedOptional].map(detail => detail.index));

    return details.map(detail => ({
        edge: detail.edge,
        tier: deep.has(detail.index) ? 'deep' : 'cheap',
        score: detail.score,
        clashCount: detail.clashCount,
        pinCount: detail.pinCount,
        forcedDeep: detail.forcedDeep,
    }));
}

/** Truncation permanence is impact-only; situation never enters this score. */
export function truncationRank(record: RelationshipMemoryRecord): number {
    return impactWeight(record.impact);
}

export const truncation_rank = truncationRank;

export function isTruncatable(record: RelationshipMemoryRecord): boolean {
    return !isPinned(record);
}

/** Lowest impact first; equal impact breaks toward the oldest scene. Pinned records are omitted. */
export function orderForTruncation(records: readonly RelationshipMemoryRecord[]): RelationshipMemoryRecord[] {
    return records
        .filter(isTruncatable)
        .slice()
        .sort((a, b) => truncationRank(a) - truncationRank(b)
            || sceneNumber(a.sceneId) - sceneNumber(b.sceneId));
}
