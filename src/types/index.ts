export type ProviderConfig = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type AppSettings = {
    providers: ProviderConfig[];
    activeProviderId: string;
    contextLimit: number;
    autoCondenseEnabled: boolean;
    debugMode?: boolean; // Toggles inline payload viewer
    // Legacy fields kept for migration only
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
};

export type CondenserState = {
    condensedSummary: string;
    condensedUpToIndex: number;
    isCondensing: boolean;
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    saveFormat1: string;
    saveFormat2: string;
    saveInstruction: string;
    canonState: string;
    headerIndex: string;
    starter: string;
    continuePrompt: string;
    surpriseDC?: number;
    // Toggles: whether each field is appended to context
    saveFormat1Active: boolean;
    saveFormat2Active: boolean;
    saveInstructionActive: boolean;
    canonStateActive: boolean;
    headerIndexActive: boolean;
    starterActive: boolean;
    continuePromptActive: boolean;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
    debugPayload?: any; // Stores the exact JSON LLM payload
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
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
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    disposition: string;
    status: string;
    goals: string;
    nature: number;   // 1-10
    training: number; // 1-10
    emotion: number;  // 1-10
    social: number;   // 1-10
    belief: number;   // 1-10
    ego: number;      // 1-10
};


export type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, any>;
            required?: string[];
        };
    };
};
