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
    who?: string[]; // The custom 'who' table
    where?: string[]; // The custom 'where' table
    why?: string[]; // The custom 'why' table
    what?: string[]; // The custom 'what' table
};

export type WorldEventConfig = {
    initialDC: number; // Starting DC (default: 198)
    dcReduction: number; // Amount DC drops per turn (default: 3)
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
    worldEngineActive: boolean;
    diceFairnessActive: boolean;
    surpriseConfig?: SurpriseConfig;
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

export type ArchiveChunk = {
    id: string;                   // unique ID (uid())
    sceneRange: string;           // e.g. "SCENE 012–018" or scene ID from Header Index
    timestamp: number;            // Date.now() when this chunk was created
    summary: string;              // the condensed bullet-point text (from T3 promotion)
    keywords: string[];           // extracted proper nouns for retrieval matching
    tokens: number;               // estimated token count of summary field
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type LoreChunk = {
    id: string;
    header: string;
    content: string;
    tokens: number;
    alwaysInclude: boolean;
    triggerKeywords: string[];  // exact keywords that activate this chunk
    scanDepth: number;          // how many recent messages to scan (default: 3)
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
