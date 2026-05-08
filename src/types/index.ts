export type ApiFormat = 'openai' | 'ollama' | 'claude' | 'gemini';

export type InventoryItemCategory = 'weapon' | 'armor' | 'consumable' | 'currency' | 'key' | 'misc' | 'equipped';

export type InventoryItem = {
    id: string;
    name: string;
    qty: number;
    category: InventoryItemCategory;
    keywords: string[];
    equipped: boolean;
    lastUsedScene: string;
    importance: number;
    notes: string;
    status?: string;
};

export type CharacterProfile = {
    name: string;
    race: string;
    class: string;
    level: number;
    hp: { current: number; max: number };
    mp?: { current: number; max: number };
    stats: Record<string, number>;
    skills: string[];
    abilities: string[];
    traits: string[];
    notes: string;
};

export type PipelinePhase =
    | 'idle'
    | 'rolling-dice'
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

export type LoreCheckCategory = 'wrong-fact' | 'contradicts-lore' | 'wrong-entity' | 'tone-voice' | 'out-of-character';
export type LoreCheckVerdict = 'consistent' | 'unsupported' | 'contradicts';
export type LoreCheckCitation = { ref: string; label: string };
export type LoreCheckResult = {
    verdict: LoreCheckVerdict;
    issues: string[];
    citations: LoreCheckCitation[];
    suggestedRewrite: string | null;
    originalText: string;
    rawResponse?: string;
};
export type LoreCheckSelection = {
    messageId: string;
    selectedText: string;
    start: number;
    end: number;
    surroundingContext: string;
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
    sampling?: SamplingConfig;
};

export type ProviderConfig = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type DivergenceCategory =
    | 'canon_override'
    | 'world_change'
    | 'entity_state'
    | 'player_state'
    | 'obligation';

export type DivergenceEntry = {
    id: string;
    category: DivergenceCategory;
    subject: string;
    divergence: string;
    sceneRef: string;
    linkedSceneIds: string[];
    importance: number;
    supersedes?: string;
    resolved?: boolean;
    source: 'auto' | 'manual';
    parseError?: boolean;
    reviewFlag?: boolean;
};

export type PrunedEntry = {
    originalEntry: DivergenceEntry;
    prunedAt: number;
    chapterId: string;
    verdict: 'auto_pruned' | 'user_deleted_review';
    reason: string;
};

export type DivergenceRegister = {
    entries: DivergenceEntry[];
    prunedLog: PrunedEntry[];
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: number;
};

export type AppSettings = {
    presets: AIPreset[];
    activePresetId: string;
    contextLimit: number;
    debugMode?: boolean;
    theme?: 'light' | 'dark';
    showReasoning?: boolean;
    deepContextSearch?: boolean;
    autoExtractDivergences?: boolean;
    divergenceTokenBudget?: number;

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
    inventory: string; // @deprecated — legacy plain-text. Prefer inventoryItems.
    inventoryLastScene: string;
    characterProfile: string; // @deprecated — legacy plain-text. Prefer characterProfileData.
    characterProfileLastScene: string;
    // --- Structured replacements ---
    inventoryItems: InventoryItem[];
    characterProfileData: CharacterProfile;
    // --- Smart injection toggle ---
    smartBookkeepingActive: boolean;
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
    worldVibe: string;
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
    reasoning_content?: string;
    ephemeral?: boolean;
    divergenceIds?: string[];
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
    triggerKeywords: string[];
    scanDepth: number;
    category: LoreCategory;
    linkedEntities: string[];
    parentSection?: string;
    priority: number;
    summary?: string;
    group?: string;
    groupWeight?: number;
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

export type NPCBehavioralTrigger = {
    keyword: string;
    shift: string;
};

export type NPCPressureHistory = {
    turn: number;
    type: 'ignored' | 'engaged';
    delta: number;
    reason: string;
};

export type NPCDrives = {
    coreWant: string;
    sessionWant: string;
    sceneWant: string;
};

export type NPCPressure = {
    ignored: number;
    engaged: number;
    lastDecayTurn: number;
    history: NPCPressureHistory[];
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
    drives?: NPCDrives;
    behavioralTriggers?: NPCBehavioralTrigger[];
    hardBoundaries?: string[];
    softBoundaries?: string[];
    pressure?: NPCPressure;
    archived?: boolean;
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

// ─── World Map System ─────────────────────────────────────────────────

export type BiomeDefinition = {
    id: string;
    label: string;
    color: string;
    registry: string;
    travelCost?: number;
    tags?: string[];
};

export type WorldAnchor = {
    name: string;
    type: 'capital' | 'city' | 'town' | 'dungeon' | 'landmark' | 'natural';
    biome: string;
    position: 'center' | 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest';
    tags: string[];
    footprint: number;
};

export type MapPin = {
    id: string;
    x: number;
    y: number;
    label: string;
    color: string;
    createdAt: number;
};

export type WorldCell = {
    x: number;
    y: number;
    biome: string;
    elevation: number;
    isOcean: boolean;
    anchorName?: string | null;
};

export type BiomeZone = {
    biome: string;
    position: 'center' | 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest';
};

export type WorldMap = {
    width: number;
    height: number;
    cells: WorldCell[];
    anchors: WorldAnchor[];
    biomeZones: BiomeZone[];
    pins: MapPin[];
    seed: number;
    worldType: 'single_continent' | 'two_continents' | 'archipelago' | 'coastal_kingdom';
    generatedAt: number;
};

export type WorldMapGenerateResult = {
    worldType: WorldMap['worldType'];
    anchors: WorldAnchor[];
    biomeZones: BiomeZone[];
};

export type TravelState = {
    playerPosition: { x: number; y: number };
    travelMethod: string;
    destination?: { x: number; y: number };
};

// ─── Bookkeeping Defaults & Migration ──────────────────────────────────

export const DEFAULT_CHARACTER_PROFILE: CharacterProfile = {
    name: '',
    race: '',
    class: '',
    level: 1,
    hp: { current: 20, max: 20 },
    stats: {},
    skills: [],
    abilities: [],
    traits: [],
    notes: '',
};

export const DEFAULT_INVENTORY: InventoryItem[] = [];

function parsePlainInventory(text: string): InventoryItem[] {
    const items: InventoryItem[] = [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const clean = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '');
        if (!clean) continue;
        const nameMatch = clean.match(/^(.*?)(?:\s*\((\d+)\s*x\s*(.+)\))?\s*$/i);
        const name = nameMatch ? nameMatch[1].trim() : clean;
        const qtyMatch = clean.match(/(?:x\s*(\d+))|(\d+)x/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1] || qtyMatch[2], 10) : 1;
        const lower = name.toLowerCase();
        let category: InventoryItemCategory = 'misc';
        if (lower.includes('gold') || lower.includes('coin') || lower.includes('silver') || lower.includes('copper')) category = 'currency';
        else if (lower.includes('potion') || lower.includes('elixir') || lower.includes('antidote')) category = 'consumable';
        else if (lower.includes('sword') || lower.includes('dagger') || lower.includes('bow') || lower.includes('axe') || lower.includes('mace') || lower.includes('staff') || lower.includes('blade')) category = 'weapon';
        else if (lower.includes('armor') || lower.includes('shield') || lower.includes('helm') || lower.includes('gauntlet') || lower.includes('boot') || lower.includes('plate')) category = 'armor';
        else if (lower.includes('key') || lower.includes('seal') || lower.includes('tome')) category = 'key';
        items.push({
            id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            qty,
            category,
            keywords: name.toLowerCase().split(/\s+/).filter(w => w.length > 2),
            equipped: false,
            lastUsedScene: '000',
            importance: 5,
            notes: '',
        });
    }
    return items;
}

function extractHp(str: string): { current: number; max: number } | undefined {
    const m = str.match(/HP[:\s]*?(\d+)\s*[\/]\s*(\d+)/i);
    if (m) return { current: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    return undefined;
}

function extractStat(str: string, label: string): number | undefined {
    const r = new RegExp(`${label}[:\s]*?(\\d+)`, 'i');
    const m = str.match(r);
    if (m) return parseInt(m[1], 10);
    return undefined;
}

function extractList(str: string, header: string): string[] {
    const idx = str.toLowerCase().indexOf(header.toLowerCase());
    if (idx === -1) return [];
    const block = str.slice(idx + header.length);
    const endIdx = block.search(/\n\n|^[A-Z][\w\s]+:/m);
    const sub = endIdx !== -1 ? block.slice(0, endIdx) : block;
    return sub
        .split('\n')
        .map(l => l.trim().replace(/^[-*•]+\s*/, ''))
        .filter(Boolean);
}

export function migrateLegacyContext(ctx: Partial<GameContext>): GameContext {
    const base: GameContext = {
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: '',
        characterProfileLastScene: 'Never',
        inventoryItems: DEFAULT_INVENTORY,
        characterProfileData: DEFAULT_CHARACTER_PROFILE,
        smartBookkeepingActive: true,
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        surpriseEngineActive: false,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        notebook: [],
        notebookActive: true,
        worldVibe: '',
        worldEventConfig: {
            initialDC: 498,
            dcReduction: 2,
            who: [],
            where: [],
            why: [],
            what: [],
        },
    };
    const merged: GameContext = { ...base, ...ctx };
    if (!merged.inventoryItems || merged.inventoryItems.length === 0) {
        if (merged.inventory && merged.inventory.trim()) {
            merged.inventoryItems = parsePlainInventory(merged.inventory);
        } else {
            merged.inventoryItems = DEFAULT_INVENTORY;
        }
    }
    if (!merged.characterProfileData || !merged.characterProfileData.name) {
        if (merged.characterProfile && merged.characterProfile.trim()) {
            const prof = merged.characterProfile;
            merged.characterProfileData = {
                ...DEFAULT_CHARACTER_PROFILE,
                name: (prof.match(/Name[:\s]*(.+)/i)?.[1] || '').trim(),
                race: (prof.match(/Race[:\s]*(.+)/i)?.[1] || '').trim(),
                class: (prof.match(/Class[:\s]*(.+)/i)?.[1] || '').trim(),
                level: parseInt(prof.match(/Level[:\s]*(\d+)/i)?.[1] || '1', 10),
                hp: extractHp(prof) || merged.characterProfileData.hp,
                stats: {
                    str: extractStat(prof, 'str') ?? extractStat(prof, 'strength') ?? merged.characterProfileData.stats.str,
                    dex: extractStat(prof, 'dex') ?? extractStat(prof, 'dexterity') ?? merged.characterProfileData.stats.dex,
                    con: extractStat(prof, 'con') ?? extractStat(prof, 'constitution') ?? merged.characterProfileData.stats.con,
                    int: extractStat(prof, 'int') ?? extractStat(prof, 'intelligence') ?? merged.characterProfileData.stats.int,
                    wis: extractStat(prof, 'wis') ?? extractStat(prof, 'wisdom') ?? merged.characterProfileData.stats.wis,
                    cha: extractStat(prof, 'cha') ?? extractStat(prof, 'charisma') ?? merged.characterProfileData.stats.cha,
                },
                skills: extractList(prof, 'skills'),
                abilities: extractList(prof, 'abilities'),
                traits: extractList(prof, 'traits'),
                notes: prof,
            };
        } else {
            merged.characterProfileData = DEFAULT_CHARACTER_PROFILE;
        }
    }
    return merged;
}
