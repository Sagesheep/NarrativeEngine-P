// ─── Scene Image Attachment Types (V1) ──────────────────────────────────────

export type SceneImageAspect = '1:1' | '16:9' | '9:16';

export type SceneImagePromptPackage = {
    focus: string;
    positivePrompt: string;
    negativePrompt?: string;
    style: string;
    framing?: string;
    aspectRatio: SceneImageAspect;
};

export type SceneImageAttachment = {
    id: string;
    kind: 'scene-image';
    status: 'generating' | 'complete' | 'failed';

    sourceMessageId: string;
    selectedText: string;
    selectionStart?: number;
    selectionEnd?: number;

    imageUrl?: string;
    error?: string;

    sceneContext: {
        currentScene?: string;
        presentCharacters: string[];
        recentMessageIds: string[];
    };

    promptPackage: SceneImagePromptPackage;

    generatedAt?: string;
    generator?: {
        provider: string;
        model: string;
    };
};

export type SceneImageContextInput = {
    campaignId: string;
    sourceMessageId: string;
    selectedText: string;
    selectionStart?: number;
    selectionEnd?: number;
    activeScene: {
        location?: string;
        time?: string;
        weather?: string;
        tone?: string;
    };
    presentCharacters: string[];
    recentNarrative: Array<{
        messageId: string;
        text: string;
    }>;
    campaignVisualStyle?: string;
};

export type SceneImageCompositionResponse = {
    focus: string;
    sceneContextSummary: string;
    positivePrompt: string;
    negativePrompt: string;
    style: string;
    framing?: string;
    aspectRatio: SceneImageAspect;
    warnings?: string[];
};

export type SceneImageDraft = {
    campaignId: string;
    sourceMessageId: string;
    selectedText: string;
    selectedTextOffsets?: { start: number; end: number };
    contextInput: SceneImageContextInput;
    promptPackage?: SceneImagePromptPackage;
    sceneContextSummary?: string;
    isComposing: boolean;
    isGenerating: boolean;
    error?: string;
};
