// ─── Archive / Timeline / Scene Types ────────────────────────────────────

/** @deprecated — replaced by ArchiveIndexEntry + ArchiveScene. Kept for backwards-compat migration. */
export type ArchiveChunk = {
    id: string;
    sceneRange: string;
    timestamp: number;
    summary: string;
    keywords: string[];
    tokens: number;
};

export type SceneEventType =
    | 'combat' | 'discovery' | 'item_acquired' | 'item_lost'
    | 'relationship_shift' | 'travel' | 'promise' | 'betrayal'
    | 'death' | 'revelation' | 'quest_milestone' | 'other';

export type SceneEvent = {
    eventType: SceneEventType;
    importance: number;       // 1–10
    text: string;             // short summary line
    characters?: string[];
    locations?: string[];
    items?: string[];
    concepts?: string[];
    cause?: string;
    result?: string;
};

/** Search index entry — one per scene, auto-built by server on every turn. */
export type ArchiveIndexEntry = {
    sceneId: string;
    timestamp: number;
    keywords: string[];
    npcsMentioned: string[];
    witnesses: string[];
    witnessSource?: 'header' | 'aux' | 'body' | 'pending' | 'seal_correction' | 'none';
    userSnippet: string;
    keywordStrengths?: Record<string, number>;
    npcStrengths?: Record<string, number>;
    importance?: number;
    events?: SceneEvent[];
};

/** Full verbatim scene content fetched from .archive.md for recall injection. */
export type ArchiveScene = {
    sceneId: string;
    content: string;
    tokens: number;
};

/** Soft cap: open chapters auto-seal when they reach this many scenes. */
export const CHAPTER_SCENE_SOFT_CAP = 25;

export type ArchiveChapter = {
    chapterId: string;
    title: string;
    // WO-06: optional synopsis/title-variant fields. Old campaigns hydrate with
    // these undefined and fall back to `title`/`summary` rendering (WO-08 owns UI).
    synopsis?: string;
    abstractTitle?: string;
    literalTitle?: string;
    sceneRange: [string, string];
    sceneIds: string[];
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
    sceneCount: number;
    sealedAt?: number;
    invalidated?: boolean;
    _lastSeenSessionId?: string;
};

/**
 * What a chapter refit would cost, without performing it.
 *
 * The expensive part of a refit is not the boundary rewrite — that is free —
 * but `changedCount`, the number of chapter summaries it invalidates. Each one
 * is an LLM call, so the user is shown this number before committing.
 */
export type ChapterRefitPreview = {
    wouldChange: boolean;
    /** Index of the first chapter whose window moves; -1 when nothing moves. */
    firstChangedIndex: number;
    /** Chapters needing regeneration — everything from firstChangedIndex on. */
    changedCount: number;
    removedChapterIds: string[];
    totalScenes: number;
    chapterCountBefore: number;
    chapterCountAfter: number;
    target: number;
};

export type ChapterRefitResult = {
    ok: boolean;
    changed: boolean;
    changedCount: number;
    firstChangedIndex?: number;
    removedChapterIds: string[];
    divergenceRepointed: number;
    timelineRepointed: number;
    chapters: ArchiveChapter[];
};

export type BackupMeta = {
    timestamp: number;
    label: string;
    trigger: string;
    hash: string;
    fileCount: number;
    isAuto: boolean;
    campaignName: string;
};

export type SemanticFact = {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    importance: number;
    sceneId: string;
    timestamp: number;
    source?: 'regex' | 'llm';
    confidence?: number;
};

export type EntityEntry = {
    id: string;
    name: string;
    type: 'npc' | 'location' | 'object' | 'concept' | 'faction' | 'event';
    aliases: string[];
    firstSeen?: string;
    factCount?: number;
};

// ─── Timeline System ───────────────────────────────────────────────────

export const TIMELINE_PREDICATES = [
    'status',          // alive, dead, injured, imprisoned, missing
    'located_in',      // current location
    'holds',           // items, artifacts, titles, territory
    'allied_with',     // faction/person allegiance
    'enemy_of',        // faction/person hostility
    'killed_by',       // cause/agent of death
    'controls',        // governs, commands
    'relationship_to', // parent_of, lover_of, servant_of (object contains relation + target)
    'seeks',           // current goal/motivation
    'knows_about',     // information they possess
    'destroyed',       // for places/objects
    'misc',            // escape hatch — appended but never overwritten in resolution
] as const;

export type TimelinePredicate = typeof TIMELINE_PREDICATES[number];

/** When a killer predicate is resolved for a subject, its victims are suppressed from output. */
export const SUPERSEDE_RULES: Record<string, string[]> = {
    killed_by:  ['status', 'located_in', 'seeks', 'allied_with'],
    destroyed:  ['located_in', 'controls', 'holds'],
    status:     [],  // status alone doesn't supersede anything (only killed_by does)
};

export type TimelineEvent = {
    id: string;           // "tl_0001" — monotonic counter
    sceneId: string;      // "001" — zero-padded, links to scene
    chapterId: string;    // "CH01" — auto-linked to open chapter at extraction time
    subject: string;      // "Aldric"
    predicate: TimelinePredicate;
    object: string;       // "dead", "castle", "Queen Mira"
    summary: string;      // "Aldric was slain by the Goblin King"
    importance: number;   // 1-10
    source: 'regex' | 'llm' | 'manual';
};
