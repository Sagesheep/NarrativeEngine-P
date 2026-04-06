export type EndpointConfig = {
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type AIPreset = {
    id: string;
    name: string;
    storyAI: EndpointConfig;
    imageAI: EndpointConfig;
    summarizerAI: EndpointConfig;
    utilityAI?: EndpointConfig; // Context recommender — optional, fallback to substring scan if empty
    enemyAI?: EndpointConfig;
    neutralAI?: EndpointConfig;
    allyAI?: EndpointConfig;
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
    autoCondenseEnabled: boolean;
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
    characterProfile: string;
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
    coreMemorySlots?: CoreMemorySlot[];
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string; // Clean text for UI (without dice/surprise blocks)
    timestamp: number;
    debugPayload?: unknown; // Stores the exact JSON LLM payload
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
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

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string; // Legacy fallback or raw notes
    visualProfile?: NPCVisualProfile; // Structured AI-ready fields
    faction: string;
    storyRelevance: string;
    disposition: string;
    status: string;
    goals: string;
    nature: number;   // 1-10
    training: number; // 1-10
    emotion: number;  // 1-10
    social: number;   // 1-10
    belief: number;   // 1-10
    ego: number;      // 1-10
    affinity: number; // 0-100
    portrait?: string; // Image path or base64
    previousAxes?: { nature?: number; training?: number; emotion?: number; social?: number; belief?: number; ego?: number; affinity?: number; };
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

export type PayloadTrace = {
    source: string;
    classification: ContextSourceClassification;
    tokens: number;
    reason: string;
    preview?: string;
    included: boolean;
    position?: string;
};

export type CoreMemorySlot = {
    key: string;
    value: string;
    priority: number;
    sceneId: string;
};

export type SemanticFact = {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    importance: number;
    sceneId: string;
    timestamp: number;
};

