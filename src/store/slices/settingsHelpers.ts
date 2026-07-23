import type { AppSettings, LLMProvider, AIPreset, ApiFormat, AiTier } from '../../types';
import { set as idbSet } from 'idb-keyval';
import { encryptSettingsProviders } from '../../services/infrastructure/settingsCrypto';
import { uid } from '../../utils/uid';
import { toast } from '../../components/Toast';
import { applyLocale, detectLocale, isLocaleCode } from '../../i18n';

import { API_BASE as API } from '../../lib/apiBase';

// ── DEFAULT constants ──────────────────────────────────────────────────

export const DEFAULT_SURPRISE_TYPES = [
    "WEATHER_SHIFT", "ODD_SOUND", "NPC_QUIRK", "EQUIPMENT_HICCUP",
    "SCENERY_CHANGE", "ANIMAL_BEHAVIOR", "RUMOR_OVERHEARD",
    "STRANGE_SENSATION", "MINOR_MISHAP", "UNEXPECTED_KINDNESS"
];

export const DEFAULT_SURPRISE_TONES = [
    "CURIOUS", "UNSETTLING", "AMUSING", "EERIE",
    "MUNDANE", "WHOLESOME", "OMINOUS", "BIZARRE"
];

export const DEFAULT_ENCOUNTER_TYPES = [
    "AMBUSH", "RIVAL_APPEARANCE", "RESOURCE_CRISIS", "MORAL_DILEMMA",
    "UNEXPECTED_ALLY", "TRAP_TRIGGERED", "FACTION_CONFRONTATION",
    "BOUNTY_HUNTER", "SUPPLY_SHORTAGE", "BETRAYAL_HINT"
];

export const DEFAULT_ENCOUNTER_TONES = [
    "TENSE", "DESPERATE", "MYSTERIOUS", "AGGRESSIVE",
    "CHAOTIC", "CALCULATED", "GROTESQUE", "EPIC"
];

export const DEFAULT_WORLD_WHO = [
    "a major faction/organization", "a rogue splinter group", "a powerful leader/executive",
    "a dangerous anomaly", "a fanatic cult/extremist group", "a prominent conglomerate/merchant guild",
    "a desperate individual", "a completely random nobody", "an ancient/forgotten entity", "a chaotic force of nature"
];

export const DEFAULT_WORLD_WHERE = [
    "in a neighboring city/sector", "across the nearest border", "deep underground/in the lower levels",
    "in a remote outpost/village", "in the capital/central hub", "in a forgotten ruin/abandoned zone",
    "along a main trade/travel route", "in an uncharted area", "in a highly secure/restricted area", "in the wilderness/wasteland"
];

export const DEFAULT_WORLD_WHY = [
    "to seize power/control", "for brutal vengeance", "to protect a dangerous secret",
    "driven by a radical ideology/prophecy", "for untold wealth/resources", "due to an escalating misunderstanding",
    "out of pure desperation", "because someone dumb got lucky and found a legendary asset", "acting on an old grudge", "to reclaim lost glory/territory"
];

export const DEFAULT_WORLD_WHAT = [
    "declared open hostilities/war", "formed an unexpected alliance", "destroyed an important landmark/facility",
    "discovered a game-changing asset/relic", "assassinated/eliminated a key figure", "triggered a massive disaster",
    "monopolized a critical resource", "initiated a complete blockade/lockdown", "caused a mass exodus/evacuation", "staged a violent coup/takeover"
];

// ── Internal helpers ───────────────────────────────────────────────────

export const defaultProvider: LLMProvider = {
    id: uid(),
    label: 'Default',
    endpoint: 'http://localhost:11434/v1',
    apiKey: '',
    modelName: 'llama3',
    apiFormat: 'openai',
    streamingEnabled: true,
};

export const defaultPreset: AIPreset = {
    id: uid(),
    name: 'Default Setting',
    storyAIProviderId: defaultProvider.id,
    summarizerAIProviderId: defaultProvider.id,
    utilityAIProviderId: '',
    auxiliaryAIProviderId: '',
    imageAIProviderId: '',
};

export const defaultSettings: AppSettings = {
    presets: [defaultPreset],
    activePresetId: defaultPreset.id,
    providers: [defaultProvider],
    contextLimit: 4096,
    debugMode: false,
    theme: 'light',
    // Seeded from the browser so a first-run Korean user gets Korean chrome
    // without hunting for the setting. Overridden by any stored value.
    locale: detectLocale(),
    showReasoning: true,
    deepContextSearch: false,
    autoExtractDivergences: true,
    divergenceTokenBudget: 2000,
    divergenceScanBudget: 0,
    autoCondenseEnabled: true,
    condenseAggressiveness: 'smart',
    autoArchiveStaleNPCsTurns: 0,
    rulesBudgetPct: 0.10,
    autoGenerateRuleKeywords: true,
    utilityTimeoutSeconds: 45,
    enableArchivePlanner: false,
    retrievalAlgorithm: 'idf-rrf',
    archiveRecallDepth: 'standard',
    uiScale: 1.0,
    imageStylePrompt: '',
    imageNegativePrompt: '',
    showPcTab: true,
    indexingSpeed: 'balanced',
    ttsEnabled: false,
    ttsVoice: 'af_heart',
    lodSummaryChapters: 7,
    lodImportanceBonus: 2,
    lodElevateScenes: 2,
    lodSlottedMaxPerScene: 2,
};

export function applyTheme(theme: 'light' | 'dark' | 'system') {
    const resolved = theme === 'system' ? systemTheme() : theme;
    document.documentElement.setAttribute('data-theme', resolved);
}

export function systemTheme(): 'light' | 'dark' {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Re-exported so callers reach every "apply a global preference to the document"
// helper from one place. Implementation lives in src/i18n (it must stay free of
// store imports — see the note at the top of that file).
export { applyLocale };

export function applyUIScale(scale: number): void {
    const html = document.documentElement;
    html.style.setProperty('--ui-scale', String(scale));
    html.style.zoom = scale !== 1 ? String(scale) : '';
}

// Re-apply theme when the OS preference changes (only meaningful while theme === 'system').
if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        try {
            // Lazy import avoids a circular dependency with useAppStore.
            import('../useAppStore').then(({ useAppStore }) => {
                const current = useAppStore.getState()?.settings?.theme ?? 'light';
                if (current === 'system') applyTheme('system');
            });
        } catch { /* store not ready — ignore */ }
    });
}

/**
 * Migrate settings to the two-tier (providers[] + presets with *AIProviderId) model.
 * Handles three input shapes:
 *  1. Already two-tier (has providers[] + presets with *AIProviderId) — pass through.
 *  2. Old inline-config presets (presets with storyAI/imageAI EndpointConfig objects) —
 *     extract unique configs into providers[] and rewrite presets to reference by id.
 *  3. Pre-preset legacy (providers?/endpoint/apiKey/modelName) — synthesize one provider + preset.
 */
export function migrateSettings(data: Record<string, unknown>): AppSettings {
    const raw = (data.settings || data) as Record<string, unknown>;

    const providers: LLMProvider[] = [];
    const providerIdMap = new Map<string, string>();

    function normalizeProviderConfig(config: any): LLMProvider | null {
        if (!config || typeof config !== 'object') return null;
        const endpoint = (config.endpoint ?? '').trim();
        if (!endpoint) return null;
        return {
            id: config.id || uid(),
            label: config.label || config.modelName || 'Provider',
            endpoint,
            apiKey: config.apiKey ?? '',
            modelName: (config.modelName ?? '').trim() || 'model',
            streamingEnabled: config.streamingEnabled ?? true,
            apiFormat: config.apiFormat || 'openai',
            thinkingEffort: config.thinkingEffort,
            // Preserve native ComfyUI config; the reconstruction above would otherwise
            // silently drop it and every ComfyUI provider would fall back to the built-in graph.
            ...(config.comfyUi && typeof config.comfyUi === 'object' ? { comfyUi: config.comfyUi } : {}),
        };
    }

    function providerKey(p: LLMProvider): string {
        // Include the Comfy config so two workflows aimed at the same endpoint/model
        // (e.g. built-in vs a pasted API workflow) are not collapsed into one provider.
        const comfy = p.comfyUi ? JSON.stringify(p.comfyUi) : '';
        return `${p.endpoint}|${p.modelName}|${p.apiKey}|${p.apiFormat || 'openai'}|${comfy}`;
    }

    function getOrAddProvider(config: any): string {
        if (!config || typeof config !== 'object') return '';
        const endpoint = (config.endpoint ?? '').trim();
        if (!endpoint) return '';
        const normalized = normalizeProviderConfig(config)!;
        const key = providerKey(normalized);
        const existingId = providerIdMap.get(key);
        if (existingId) return existingId;
        const provider: LLMProvider = { ...normalized, id: config.id || uid() };
        providers.push(provider);
        providerIdMap.set(key, provider.id);
        return provider.id;
    }

    function getOrAddProvidersFromRawList(rawProviders: any[]): void {
        for (const p of rawProviders) {
            if (!p || typeof p !== 'object') continue;
            const endpoint = (p.endpoint ?? '').trim();
            if (!endpoint) continue;
            const normalized = normalizeProviderConfig(p)!;
            const key = providerKey(normalized);
            if (providerIdMap.has(key)) continue;
            const provider: LLMProvider = { ...normalized, id: p.id || uid() };
            providers.push(provider);
            providerIdMap.set(key, provider.id);
        }
    }

    // Seed providers from a legacy raw.providers[] if present (old ProviderConfig shape)
    if (Array.isArray(raw.providers) && (raw.providers as any[]).length > 0) {
        getOrAddProvidersFromRawList(raw.providers as any[]);
    }

    let presets: AIPreset[];

    if (Array.isArray(raw.presets) && (raw.presets as any[]).length > 0) {
        presets = (raw.presets as any[]).map((p: any) => {
            let storyAIProviderId = p.storyAIProviderId || getOrAddProvider(p.storyAI);
            if (!storyAIProviderId && providers.length > 0) storyAIProviderId = providers[0].id;

            const summarizerAIProviderId = p.summarizerAIProviderId || getOrAddProvider(p.summarizerAI) || '';
            const utilityAIProviderId = p.utilityAIProviderId || getOrAddProvider(p.utilityAI) || '';
            const auxiliaryAIProviderId = p.auxiliaryAIProviderId || getOrAddProvider(p.auxiliaryAI) || '';
            const imageAIProviderId = p.imageAIProviderId || getOrAddProvider(p.imageAI) || '';

            // Strip legacy inline endpoint configs; keep everything else (id, name, sampling, etc.)
            const { storyAI, summarizerAI, utilityAI, auxiliaryAI, imageAI, ...presetRest } = p;
            void storyAI; void summarizerAI; void utilityAI; void auxiliaryAI; void imageAI;
            return {
                ...presetRest,
                storyAIProviderId,
                summarizerAIProviderId,
                utilityAIProviderId,
                auxiliaryAIProviderId,
                imageAIProviderId,
            } as AIPreset;
        });
    } else {
        let storyProvider: LLMProvider;
        if (Array.isArray(raw.providers) && (raw.providers as any[]).length > 0) {
            const oldActive = (raw.providers as any[]).find((p: any) => p.id === raw.activeProviderId) || (raw.providers as any[])[0];
            storyProvider = normalizeProviderConfig(oldActive) || { ...defaultProvider, id: uid() };
        } else {
            storyProvider = {
                id: uid(),
                label: 'Default',
                endpoint: (raw.endpoint as string) || defaultProvider.endpoint,
                apiKey: (raw.apiKey as string) || '',
                modelName: (raw.modelName as string) || defaultProvider.modelName,
                apiFormat: (raw.apiFormat as ApiFormat) || 'openai',
                streamingEnabled: true,
            };
        }

        const key = providerKey(storyProvider);
        let providerId = providerIdMap.get(key);
        if (!providerId) {
            providers.push(storyProvider);
            providerIdMap.set(key, storyProvider.id);
            providerId = storyProvider.id;
        }

        const migratedPresetId = uid();
        presets = [{
            id: migratedPresetId,
            name: 'Default Preset',
            storyAIProviderId: providerId,
            summarizerAIProviderId: providerId,
            utilityAIProviderId: '',
            auxiliaryAIProviderId: '',
            imageAIProviderId: '',
        }];

        // Carry over legacy image endpoint config into its own provider if present
        if (raw.imageApiEndpoint || raw.imageApiKey || raw.imageApiModel) {
            const imgId = getOrAddProvider({
                endpoint: raw.imageApiEndpoint,
                apiKey: raw.imageApiKey,
                modelName: raw.imageApiModel,
            });
            if (imgId) presets[0].imageAIProviderId = imgId;
        }
    }

    if (providers.length === 0) {
        const fallback: LLMProvider = { ...defaultProvider, id: uid() };
        providers.push(fallback);
    }

    if (presets.length === 0) {
        presets = [{ ...defaultPreset, id: uid(), storyAIProviderId: providers[0].id, summarizerAIProviderId: providers[0].id }];
    }

    for (const preset of presets) {
        if (!preset.storyAIProviderId && providers.length > 0) {
            preset.storyAIProviderId = providers[0].id;
        }
    }

    return {
        presets,
        activePresetId: (raw.activePresetId as string) || presets[0].id,
        providers,
        contextLimit: (raw.contextLimit as number) ?? 4096,
        debugMode: (raw.debugMode as boolean) ?? false,
        theme: (raw.theme as 'light' | 'dark' | 'system') ?? 'light',
        // First run only: seed from the browser. Once a locale is stored — even
        // 'en' — it is an explicit choice and is never auto-changed again.
        locale: isLocaleCode(raw.locale) ? raw.locale : detectLocale(),
        showReasoning: (raw.showReasoning as boolean) ?? true,
        deepContextSearch: (raw.deepContextSearch as boolean) ?? false,
        autoExtractDivergences: (raw.autoExtractDivergences as boolean) ?? true,
        divergenceTokenBudget: (raw.divergenceTokenBudget as number) ?? 2000,
        divergenceScanBudget: (raw.divergenceScanBudget as number) ?? 0,
        autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
        condenseAggressiveness: (raw.condenseAggressiveness as 'tight' | 'smart' | 'deep') ?? 'smart',
        autoArchiveStaleNPCsTurns: (raw.autoArchiveStaleNPCsTurns as number) ?? 0,
        rulesBudgetPct: (raw.rulesBudgetPct as number) ?? 0.10,
        autoGenerateRuleKeywords: (raw.autoGenerateRuleKeywords as boolean) ?? true,
        utilityTimeoutSeconds: (raw.utilityTimeoutSeconds as number) ?? 45,
        verboseUtilityLogging: raw.verboseUtilityLogging as boolean,
        enableArchivePlanner: (raw.enableArchivePlanner as boolean) ?? false,
        retrievalAlgorithm: (raw.retrievalAlgorithm as 'classic' | 'idf-rrf') ?? 'idf-rrf',
        archiveRecallDepth: (raw.archiveRecallDepth as 'lean' | 'standard' | 'deep') ?? 'standard',
        matureMode: (raw.matureMode as boolean) ?? false,
        aiTier: raw.aiTier as AiTier | undefined,
        uiScale: (raw.uiScale as number) ?? 1.0,
        embeddingModel: raw.embeddingModel as ('standard' | 'high') | undefined,
        imageStylePrompt: (raw.imageStylePrompt as string) ?? '',
        imageNegativePrompt: (raw.imageNegativePrompt as string) ?? '',
        showPcTab: (raw.showPcTab as boolean) ?? true,
        indexingSpeed: (raw.indexingSpeed as 'eco' | 'balanced' | 'aggressive') ?? 'balanced',
        indexingSpeedPrompted: (raw.indexingSpeedPrompted as boolean) ?? false,
        ttsEnabled: (raw.ttsEnabled as boolean) ?? false,
        ttsVoice: (raw.ttsVoice as string) ?? 'af_heart',
        lodSummaryChapters: (raw.lodSummaryChapters as number) ?? 7,
        lodImportanceBonus: (raw.lodImportanceBonus as number) ?? 2,
        lodElevateScenes: (raw.lodElevateScenes as number) ?? 2,
        lodSlottedMaxPerScene: (raw.lodSlottedMaxPerScene as number) ?? 2,
    };
}

// Debounced save to avoid hammering the API on rapid changes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedProviders = await encryptSettingsProviders(settings.providers);
        const encryptedSettings = { ...settings, providers: encryptedProviders };

        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e) => { console.error(e); toast.error('Failed to save settings to browser storage'); });

        fetch(`${API}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings, activeCampaignId }),
        }).catch((e) => { console.error(e); toast.warning('Settings saved locally but server backup failed'); });
    }, 500);
}