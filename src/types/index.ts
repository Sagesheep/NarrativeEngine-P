export type AppSettings = {
    endpoint: string;
    apiKey: string;
    modelName: string;
    contextLimit: number;
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    saveFormat1: string;
    saveFormat2: string;
    saveInstruction: string;
    saveStateMacro: string;
    // Toggles: whether each template field is appended to save state output
    saveFormat1Active: boolean;
    saveFormat2Active: boolean;
    saveInstructionActive: boolean;
    saveStateMacroActive: boolean;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
};
