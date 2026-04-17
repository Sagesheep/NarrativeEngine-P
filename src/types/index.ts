export type ApiFormat = 'openai' | 'ollama';

export type PipelinePhase =
    | 'idle'
    | 'rolling-dice'
    | 'ai-intervention'
    | 'gathering-context'
    | 'building-prompt'
    | 'generating'
    | 'checking-notes'
    | 'post-processing';

export type StreamingStats = {
    tokens: number;
    elapsed: number;
    speed: number;
};

export type EndpointConfig = {
    endpoint: string;
    apiKey: string;
    modelName: string;
    apiFormat?: ApiFormat;
};

export type SamplingConfig = {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    dry_multiplier?: number;
    dry_base?: number;
    dry_allowed_length?: number;
};

export type AIPreset = {
    id: string;
    name: string;
    storyAI: EndpointConfig;
    imageAI: EndpointConfig;
    summarizerAI: EndpointConfig;
    utilityAI?: EndpointConfig;
    enemyAI?: EndpointConfig;
    neutralAI?: EndpointConfig;
    allyAI?: EndpointConfig;
    sampling?: SamplingConfig;
};

export type ProviderConfig = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type AppSettings = {
    presets: AIPreset[];
    activePresetId: string;
    contextLimit: number;
    debugMode?: boolean; // Toggles inline payload viewer
    theme?: 'light' | 'dark'; // UI theme
    showReasoning?: boolean; // Toggles visibility of LLM thinking blocks

    // Legacy fields kept for migration only
    providers?: ProviderConfig[];
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
    imageApiEndpoint?: string;
    imageApiKey?: string;
    imageApiModel?: string;
};

export type CondenserState = {
    condensedSummary: string;
    condensedUpToIndex: number;
    isCondensing: boolean;
};

export type DiceConfig = {
    catastrophe: number; // e.g. 2 (1-2 is catastrophe)
    failure: number;     // e.g. 6 (3-6 is failure)
    success: number;     // e.g. 15 (7-15 is success)
    triumph: number;     // e.g. 19 (16-19 is triumph)
    crit: number;        // e.g. 20 (20 is crit)
};

export type SurpriseConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type EncounterConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type WorldEventConfig = {
    initialDC: number; // Starting DC (default: 498)
    dcReduction: number; // Amount DC drops per turn (default: 2)
    who?: string[]; // The custom 'who' table
    where?: string[]; // The custom 'where' table
    why?: string[]; // The custom 'why' table
    what?: string[]; // The custom 'what' table
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    canonState: string;
    headerIndex: string;
    starter: string;
    continuePrompt: string;
    inventory: string;
    inventoryLastScene: string;
    characterProfile: string;
    characterProfileLastScene: string;
    surpriseDC?: number;
    encounterDC?: number;
    worldEventDC?: number;
    diceConfig?: DiceConfig;
    worldEventConfig?: WorldEventConfig;
    // Toggles: whether each field is appended to context
    canonStateActive: boolean;
    headerIndexActive: boolean;
    starterActive: boolean;
    continuePromptActive: boolean;
    inventoryActive: boolean;
    characterProfileActive: boolean;
    surpriseEngineActive: boolean;
    encounterEngineActive: boolean;
    worldEngineActive: boolean;
    diceFairnessActive: boolean;
    sceneNote: string;
    sceneNoteActive: boolean;
    sceneNoteDepth: number;
    surpriseConfig?: SurpriseConfig;
    encounterConfig?: EncounterConfig;
    // --- AI Players (Enemy, Neutral, Ally) ---
    worldVibe: string; // Global genre constraints (e.g. "Low fantasy, no magic")
    enemyPlayerActive: boolean;
    neutralPlayerActive: boolean;
    allyPlayerActive: boolean;
    enemyPlayerPrompt: string;
    neutralPlayerPrompt: string;
    allyPlayerPrompt: string;
    interventionChance: number; // 0-100%
    enemyCooldown: number;
    neutralCooldown: number;
    allyCooldown: number;
    interventionQueue: ('enemy' | 'neutral' | 'ally')[];
    notebook: NotebookNote[];
    notebookActive: boolean;
};

export type NotebookNote = {
    id: string;
    text: string;
    timestamp: number;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string;
    timestamp: number;
    debugPayload?: unknown;
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
    ephemeral?: boolean;
};

/** @deprecated — replaced by ArchiveIndexEntry + ArchiveScene. Kept for backwards-compat migration. */
export type ArchiveChunk = {
    id: string;
    sceneRange: string;
    timestamp: number;
    summary: string;
    keywords: string[];
    tokens: number;
};

/** Search index entry — one per scene, auto-built by server on every turn. */
export type ArchiveIndexEntry = {
    sceneId: string;
    timestamp: number;
    keywords: string[];
    npcsMentioned: string[];
    witnesses: string[];
    userSnippet: string;
    keywordStrengths?: Record<string, number>;
    npcStrengths?: Record<string, number>;
    importance?: number;
};

/** Full verbatim scene content fetched from .archive.md for recall injection. */
export type ArchiveScene = {
    sceneId: string;
    content: string;
    tokens: number;
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type LoreCategory = 
    | 'world_overview'
    | 'faction'
    | 'location'
    | 'character'
    | 'power_system'
    | 'economy'
    | 'event'
    | 'relationship'
    | 'rules'
    | 'culture'
    | 'misc';

export type LoreChunk = {
    id: string;
    header: string;
    content: string;
    tokens: number;
    alwaysInclude: boolean;
    triggerKeywords: string[];  // exact keywords that activate this chunk
    scanDepth: number;          // how many recent messages to scan (default: 3)
    category: LoreCategory;
    linkedEntities: string[];   // Names of NPCs, factions, locations referenced
    parentSection?: string;     // The ## parent header this ### belongs under
    priority: number;           // 0-10, higher = more important
    summary?: string;           // One-line auto-summary for recommender index
};

export type EngineSeed = {
    surpriseTypes: string[];
    surpriseTones: string[];
    encounterTypes: string[];
    encounterTones: string[];
    worldWho: string[];
    worldWhere: string[];
    worldWhy: string[];
    worldWhat: string[];
};

export type NPCVisualProfile = {
    race: string;
    gender: string;
    ageRange: string;
    build: string;
    symmetry: string; // ugly / pretty / handsome etc.
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    gait: string;
    distinctMarks: string;
    clothing: string;
    artStyle: string;
};

export const DEFAULT_VISUAL_PROFILE: NPCVisualProfile = {
    race: '', gender: '', ageRange: '', build: '', symmetry: '',
    hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '', artStyle: 'Anime',
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    visualProfile?: NPCVisualProfile;
    faction: string;
    storyRelevance: string;
    disposition: string;
    status: string;
    goals: string;
    voice: string;
    personality: string;
    exampleOutput: string;
    affinity: number;
    portrait?: string;
    previousSnapshot?: {
        personality: string;
        voice: string;
        affinity: number;
    };
    shiftNote?: string;
    shiftTurnCount?: number;
};


export type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
};

export type ContextSourceClassification = 'stable_truth' | 'summary' | 'world_context' | 'volatile_state' | 'scene_local';

export type DebugSection = {
    label: string;
    role: string;
    tokens?: number;
    content: string;
    classification?: ContextSourceClassification;
};

export type PayloadTrace = {
    source: string;
    classification: ContextSourceClassification;
    tokens: number;
    reason: string;
    preview?: string;
    included: boolean;
    position?: string;
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

/** Soft cap: open chapters auto-seal when they reach this many scenes. */
export const CHAPTER_SCENE_SOFT_CAP = 25;

export type ArchiveChapter = {
    chapterId: string;            // "CH01"
    title: string;                // Auto-generated or user-edited
    sceneRange: [string, string]; // ["001", "023"] — inclusive
    summary: string;              // LLM-generated on seal (empty if unsealed)
    keywords: string[];           // Aggregated + deduped from child scenes
    npcs: string[];               // Aggregated from child scenes
    majorEvents: string[];        // Key beats from header index
    unresolvedThreads: string[];  // Carried from header index Section 2
    tone: string;                 // "combat-heavy", "exploration", "social", etc.
    themes: string[];             // Thematic tags
    sceneCount: number;           // Number of scenes in range
    sealedAt?: number;            // undefined = open chapter
    invalidated?: boolean;        // true = summary stale due to rollback, needs re-gen
    _lastSeenSessionId?: string;  // Internal: for auto-seal session boundary detection
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
