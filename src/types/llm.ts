// ─── LLM / AI Configuration ───────────────────────────────────────────────

import type { LocaleCode } from '../i18n/types';

export type ApiFormat = 'openai' | 'ollama' | 'claude' | 'gemini' | 'comfyui';

/**
 * Native ComfyUI image-generation settings (scene images only). Attached to an
 * image-role LLMProvider whose apiFormat is 'comfyui'. When customWorkflowJson is
 * blank the server falls back to a built-in basic txt2img graph. The provider's
 * modelName is the checkpoint name substituted into that built-in graph (%model%).
 */
export type ComfyUiSettings = {
    customWorkflowJson?: string;
    steps?: number;
    cfgScale?: number;
    sampler?: string;
    scheduler?: string;
    denoisingStrength?: number;
};

export type AiTier = 'lite' | 'pro' | 'max';

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export type EndpointConfig = {
    endpoint: string;
    apiKey: string;
    modelName: string;
    apiFormat?: ApiFormat;
    thinkingEffort?: ThinkingEffort;
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
    max_tokens?: number;
};

/**
 * Reusable LLM provider (two-tier model, ported from mobile). A preset references
 * one of these by id for each role (story / summarizer / image / utility / auxiliary).
 * Structurally a superset of EndpointConfig, so it can be passed to llmCall/testConnection
 * unchanged. The optional legacy `*AI` EndpointConfig fields are kept ONLY for migration;
 * new code reads providers via `*AIProviderId`.
 */
export type LLMProvider = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    /** For apiFormat 'comfyui' this is the checkpoint name fed into the built-in txt2img graph. */
    modelName: string;
    streamingEnabled?: boolean;
    apiFormat?: ApiFormat;
    thinkingEffort?: ThinkingEffort;
    /** Present only when apiFormat === 'comfyui'. Native ComfyUI image-generation config. */
    comfyUi?: ComfyUiSettings;
};

export type AIPreset = {
    id: string;
    name: string;
    // Two-tier (new) — references into settings.providers
    storyAIProviderId: string;
    summarizerAIProviderId?: string;
    utilityAIProviderId?: string;
    auxiliaryAIProviderId?: string;
    imageAIProviderId?: string;
    sampling?: SamplingConfig;
    // Legacy inline endpoint configs — kept ONLY for one-time migration; ignored after migration runs.
    storyAI?: EndpointConfig;
    imageAI?: EndpointConfig;
    summarizerAI?: EndpointConfig;
    utilityAI?: EndpointConfig;
    auxiliaryAI?: EndpointConfig;
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
    debugMode?: boolean;
    theme?: 'light' | 'dark' | 'system';
    locale?: LocaleCode;             // UI chrome language. Defaults to the browser language on first run, then never auto-changes. Independent of narration language (Phase 3).
    showReasoning?: boolean;
    deepContextSearch?: boolean;
    autoExtractDivergences?: boolean;
    divergenceTokenBudget?: number;
    divergenceScanBudget?: number;
    autoCondenseEnabled?: boolean;
    condenseAggressiveness?: 'tight' | 'smart' | 'deep';
    autoArchiveStaleNPCsTurns?: number;
    rulesBudgetPct?: number;               // fraction of context limit for rules RAG, default 0.10
    autoGenerateRuleKeywords?: boolean;    // default true; false = header+bold extraction only
    utilityTimeoutSeconds?: number;        // soft deadline for utility AI calls (default 45)
    verboseUtilityLogging?: boolean;
    enableArchivePlanner?: boolean;
    retrievalAlgorithm?: 'classic' | 'idf-rrf';
    archiveRecallDepth?: 'lean' | 'standard' | 'deep';  // archive recall ceiling; default 'standard' (desktop). 'lean' = mobile parity (3/4/5)
    matureMode?: boolean;            // default false; gates mature-tier NPC traits/wants (NPC Agency Phase 2)
    aiTier?: AiTier;                 // 'lite' | 'pro' | 'max' — gates which turn stages run (Phase 4)
    uiScale?: number;                // 0.7–1.3, default 1.0 — global UI zoom (ported from mobile settings)
    embeddingModel?: 'standard' | 'high';  // kept for type parity with mobile; mainApp runs a single server-side embedder, so this is informational only
    indexingSpeed?: 'eco' | 'balanced' | 'aggressive';  // governs lore/rules bulk-embed batch size + throttle; default 'balanced'. Higher = faster import but heavier CPU
    indexingSpeedPrompted?: boolean;       // true once the one-time first-run hardware suggestion has been shown
    imageStylePrompt?: string;       // prepended to every image generation prompt
    imageNegativePrompt?: string;    // negative prompt for image models that support it
    showPcTab?: boolean;             // default true; hides/shows Character Profile tab in Context Drawer

    // Kokoro TTS (local text-to-speech for GM narration)
    ttsEnabled?: boolean;            // master toggle; default false
    ttsVoice?: string;               // kokoro voice id, e.g. 'af_heart'; default 'af_heart'

    // LOD history rendering (WO-09). Optional with migrated defaults — old campaigns
    // hydrate undefined and the payload builder falls back to the defaults below.
    lodSummaryChapters?: number;     // how many recent sealed chapters render at summary tier; default 7
    lodImportanceBonus?: number;     // effective-age bonus when a chapter has any importance ≥ 8 scene; default 2

    // WO-11: Dynamic Elevation — when the player references a synopsis-tier memory,
    // its scenes surface verbatim below the cache boundary for that turn only.
    // Optional with migrated default; old campaigns hydrate undefined → 2.
    lodElevateScenes?: number;       // max synopsis-tier scenes to elevate per turn; default 2

    // WO-12: Slotted RAG — synopsis-tier scenes with search hits that did NOT get
    // elevated contribute one-line verbatim snippets, witness-filtered. Optional
    // with migrated default; old campaigns hydrate undefined → 2.
    lodSlottedMaxPerScene?: number;  // max snippet lines per slotted-RAG scene; default 2

    // Two-tier providers (new) — reusable endpoint configs referenced by preset *AIProviderId
    providers: LLMProvider[];

    // Legacy fields kept for migration only
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
    imageApiEndpoint?: string;
    imageApiKey?: string;
    imageApiModel?: string;
};
