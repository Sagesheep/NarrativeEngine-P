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
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
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
