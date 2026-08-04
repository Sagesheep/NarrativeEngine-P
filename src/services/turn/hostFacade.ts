import type {
    AiTier,
    ArchiveIndexEntry,
    CharacterProfile,
    InventoryItem,
    LocationEntry,
    LocationSuggestion,
    ChatMessage,
    CondenserState,
    DivergenceRegister,
    EnemyCombatConfig,
    EnemyEntry,
    EnemySuggestion,
    GameContext,
    LoreChunk,
    NPCEntry,
    PlayerCharacter,
    ProviderConfig,
    EndpointConfig,
    SemanticFact,
    TimelineEvent,
} from '../../types';
import { llmCall, type LLMCallPriority } from '../../utils/llmCall';
import { extractJson } from '../infrastructure/jsonExtract';
import type { TurnCallbacks, TurnState } from './turnOrchestrator';
import { createReactiveReadHub, disposeCampaignSubscriptions, type ReactiveReadHub, type ReactiveStoreLike } from '../mods/reactiveReads';

export type ModelRole = 'story' | 'utility' | 'auxiliary' | 'summariser' | 'raw-auxiliary' | 'raw-summariser';
export const MODEL_ROLES: readonly ModelRole[] = [
    'story',
    'utility',
    'auxiliary',
    'summariser',
    'raw-auxiliary',
    'raw-summariser',
];
export const MODEL_JSON_RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

export type ModelRequest = {
    prompt: string;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    priority?: LLMCallPriority;
    trackingLabel?: string;
    timeoutMs?: number;
};

export type ModelResponse = {
    content: string;
};
/** Completed responses are sufficient for every measured consumer; incremental model.stream chunks have no consumer. */
export type ModelJsonOptions = {
    retries?: number;
};
export type ModelCall = (role: ModelRole, request: ModelRequest) => Promise<ModelResponse>;
export async function callModelJson(
    role: ModelRole,
    request: ModelRequest,
    call: ModelCall,
    options: ModelJsonOptions = {},
): Promise<unknown> {
    const requestedRetries = typeof options.retries === 'number' && Number.isFinite(options.retries) ? Math.floor(options.retries) : 1;
    const retries = Math.min(1, Math.max(0, requestedRetries));
    let response = await call(role, request);
    try {
        return JSON.parse(extractJson(response.content));
    } catch (firstError) {
        if (retries === 0) throw firstError;
        response = await call(role, {
            ...request,
            prompt: request.prompt + '\n\n' + response.content + MODEL_JSON_RETRY_SUFFIX,
        });
        return JSON.parse(extractJson(response.content));
    }
}

export interface FacadeData {
    readonly archiveIndex: ArchiveIndexEntry[];
    readonly context: GameContext;
    readonly npcLedger: NPCEntry[];
    readonly messages: ChatMessage[];
    readonly activeCampaignId: string | null;
    readonly input: string;
    readonly loreChunks: LoreChunk[];
    readonly onStageNpcIds: string[];
    readonly enemyCompendium: EnemyEntry[];
    readonly enemyCombatConfig: EnemyCombatConfig | undefined;
    readonly divergenceRegister: DivergenceRegister;
    readonly timeline: TimelineEvent[];
    readonly condenser: CondenserState;
    readonly semanticFacts: SemanticFact[];
}

export interface FacadeConfig {
    readonly aiTier: AiTier | undefined;
    readonly contextLimit: number;
    readonly archiveRecallDepth: 'lean' | 'standard' | 'deep';
    readonly autoArchiveStaleNPCsTurns: number;
    readonly divergenceScanBudget: number;
    readonly enableArchivePlanner: boolean;
    readonly lodElevateScenes: number;
    readonly lodImportanceBonus: number;
    readonly lodSlottedMaxPerScene: number;
    readonly lodSummaryChapters: number;
}

export interface FacadeWrites {
    readonly updateContext: (patch: Partial<GameContext>) => void;
    readonly updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    readonly addMessage: (msg: ChatMessage) => void;
    readonly addEnemySuggestions: (suggestions: Array<Omit<EnemySuggestion, 'id' | 'firstSeen' | 'context'>>, context?: string) => void;
    readonly setDivergenceRegister: (register: DivergenceRegister) => void;
    readonly addNpcSuggestions: (names: string[], context?: string) => void;
    readonly archiveNPC: (id: string, turn: number, reason: string) => void;
    readonly restoreNPC: (id: string) => void;
    readonly onDirectorBriefPhase: (phase: 'running' | 'done') => void;
    readonly updatePlayerCharacter: (patch: Partial<PlayerCharacter>) => void;
    readonly setCharacterProfileData: (profile: CharacterProfile) => void;
    readonly setInventoryItems: (items: InventoryItem[]) => void;
    readonly setLocationLedger: (locations: LocationEntry[]) => void;
    readonly addLocationSuggestions: (suggestions: LocationSuggestion[]) => void;
}

export interface HostFacade {
    readonly data: FacadeData;
    readonly config: FacadeConfig;
    readonly write: FacadeWrites;
    readonly model: {
        call(role: ModelRole, req: ModelRequest): Promise<ModelResponse>;
        callJson(role: ModelRole, req: ModelRequest, options?: ModelJsonOptions): Promise<unknown>;
        available(role: ModelRole): boolean;
    };
    readonly table: {
        read(name: string): Promise<unknown>;
        write(name: string, rows: unknown): Promise<void>;
        subscribe?(name: string, listener: (rows: unknown) => void): () => void;
    };
    readonly subscribe?: (key: string, listener: (value: unknown) => void) => () => void;
    readonly signal: AbortSignal;
    refresh(): HostFacade;
    log(...args: unknown[]): void;
}

export interface HostFacadeTableAdapter {
    read(name: string): Promise<unknown>;
    write(name: string, rows: unknown): Promise<void>;
    subscribe?(name: string, listener: (rows: unknown) => void): () => void;
}

export interface HostFacadeBuildOptions {
    signal?: AbortSignal;
    getState?: () => TurnState;
    getCallbacks?: () => TurnCallbacks;
    updatePlayerCharacter?: (patch: Partial<PlayerCharacter>) => void;
    modelCall?: (role: ModelRole, request: ModelRequest, endpoint: EndpointConfig | ProviderConfig | undefined) => Promise<ModelResponse>;
    table?: HostFacadeTableAdapter;
    reactiveStore?: ReactiveStoreLike;
    getLocationState?: () => {
        readonly currentPlaceId: string | null;
        readonly currentFeature: string | null;
        readonly ledger: readonly LocationEntry[];
    };
}

type FacadeSettings = {
    aiTier?: AiTier;
    contextLimit: number;
    archiveRecallDepth?: 'lean' | 'standard' | 'deep';
    autoArchiveStaleNPCsTurns?: number;
    divergenceScanBudget?: number;
    enableArchivePlanner?: boolean;
    lodElevateScenes?: number;
    lodImportanceBonus?: number;
    lodSlottedMaxPerScene?: number;
    lodSummaryChapters?: number;
};

const facadeModelAvailability = new WeakMap<object, ReadonlySet<ModelRole>>();

const TABLE_ROUTES: Record<string, string> = {
    archive: 'archive/index',
    divergence: 'divergence',
    enemies: 'enemies',
    locations: 'locations',
    npcs: 'npcs',
};

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
    if (value === null || typeof value !== 'object') return value;
    const objectValue = value as object;
    const existing = seen.get(objectValue);
    if (existing) return existing as T;

    const clone: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    seen.set(objectValue, clone);
    if (Array.isArray(value)) {
        const arrayClone = clone as unknown[];
        for (const item of value) arrayClone.push(cloneAndFreeze(item, seen));
    } else {
        const objectClone = clone as Record<string, unknown>;
        for (const [key, item] of Object.entries(value)) {
            objectClone[key] = cloneAndFreeze(item, seen);
        }
    }
    Object.freeze(clone);
    return clone as T;
}

function readFacadeSettings(settings: FacadeSettings): FacadeConfig {
    return Object.freeze({
        aiTier: settings.aiTier,
        contextLimit: settings.contextLimit,
        archiveRecallDepth: settings.archiveRecallDepth ?? 'standard',
        autoArchiveStaleNPCsTurns: settings.autoArchiveStaleNPCsTurns ?? 0,
        divergenceScanBudget: settings.divergenceScanBudget ?? 0,
        enableArchivePlanner: settings.enableArchivePlanner ?? false,
        lodElevateScenes: settings.lodElevateScenes ?? 2,
        lodImportanceBonus: settings.lodImportanceBonus ?? 2,
        lodSlottedMaxPerScene: settings.lodSlottedMaxPerScene ?? 2,
        lodSummaryChapters: settings.lodSummaryChapters ?? 7,
    });
}

function readFacadeData(state: TurnState): FacadeData {
    return cloneAndFreeze({
        archiveIndex: state.archiveIndex,
        context: state.context,
        npcLedger: state.npcLedger,
        messages: state.messages,
        activeCampaignId: state.activeCampaignId,
        input: state.input,
        loreChunks: state.loreChunks,
        onStageNpcIds: state.onStageNpcIds ?? [],
        enemyCompendium: state.enemyCompendium ?? [],
        enemyCombatConfig: state.enemyCombatConfig,
        divergenceRegister: state.divergenceRegister ?? { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        timeline: state.timeline ?? [],
        condenser: state.condenser,
        semanticFacts: state.semanticFacts ?? [],
    });
}

function hasConfiguredRole(state: TurnState, role: ModelRole): boolean {
    switch (role) {
        case 'story':
            return Boolean(state.provider || typeof state.getFreshProvider === 'function');
        case 'utility':
            return typeof state.getUtilityEndpoint === 'function';
        case 'auxiliary':
            return Boolean(typeof state.getFreshAuxiliaryProvider === 'function' || typeof state.getFreshProvider === 'function' || state.provider);
        case 'summariser':
            return Boolean(typeof state.getRawSummariserProvider === 'function' || typeof state.getFreshProvider === 'function' || state.provider);
        case 'raw-auxiliary':
            return typeof state.getRawAuxiliaryProvider === 'function';
        case 'raw-summariser':
            return typeof state.getRawSummariserProvider === 'function';
    }
}

function resolveEndpoint(state: TurnState, role: ModelRole): EndpointConfig | ProviderConfig | undefined {
    const story = () => state.getFreshProvider?.() ?? state.provider;
    switch (role) {
        case 'story':
            return story();
        case 'utility':
            return state.getUtilityEndpoint?.();
        case 'auxiliary':
            return state.getFreshAuxiliaryProvider?.() ?? story();
        case 'summariser':
            return state.getRawSummariserProvider?.() ?? story();
        case 'raw-auxiliary':
            return state.getRawAuxiliaryProvider?.();
        case 'raw-summariser':
            return state.getRawSummariserProvider?.();
    }
}

function buildDefaultTableAdapter(activeCampaignId: string | null, reactiveStore?: ReactiveStoreLike): HostFacadeTableAdapter {
    const routeFor = (name: string): string => {
        const route = TABLE_ROUTES[name];
        if (!route) throw new Error(`[facade] unknown table: ${name}`);
        if (!activeCampaignId) throw new Error('[facade] no active campaign');
        return `/api/campaigns/${activeCampaignId}/${route}`;
    };

    return {
        async read(name) {
            const storeState = reactiveStore?.getState() as { modTables?: Record<string, unknown> } | undefined;
            if (name.startsWith('mod.') && storeState?.modTables && Object.prototype.hasOwnProperty.call(storeState.modTables, name)) {
                return storeState.modTables[name];
            }
            const response = await fetch(routeFor(name));
            if (!response.ok) throw new Error(`[facade] table read failed: ${name} (${response.status})`);
            return response.json();
        },
        async write(name, rows) {
            const storeState = reactiveStore?.getState() as { setModTable?: (tableName: string, data: unknown) => void } | undefined;
            if (name.startsWith('mod.') && typeof storeState?.setModTable === 'function') {
                storeState.setModTable(name, rows);
                return;
            }
            const response = await fetch(routeFor(name), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rows),
            });
            if (!response.ok) throw new Error(`[facade] table write failed: ${name} (${response.status})`);
        },
    };
}

export function buildHostFacade(
    state: TurnState,
    callbacks: TurnCallbacks,
    options: HostFacadeBuildOptions = {},
): HostFacade {
    const data = readFacadeData(state);
    const config = readFacadeSettings(state.settings);
    const reactiveStore = options.reactiveStore;
    const tableAdapter = options.table ?? buildDefaultTableAdapter(state.activeCampaignId, reactiveStore);
    const tableCache = new Map<string, unknown>();
    const tableSourceUnsubscribes = new Map<string, () => void>();
    const detachTableSources = (): void => {
        for (const unsubscribe of tableSourceUnsubscribes.values()) unsubscribe();
        tableSourceUnsubscribes.clear();
    };

    const readReactiveValue = (key: string): unknown => {
        if (key.startsWith('table:')) {
            const name = key.slice('table:'.length);
            const storeState = reactiveStore?.getState() as { modTables?: Record<string, unknown> } | undefined;
            if (storeState?.modTables && Object.prototype.hasOwnProperty.call(storeState.modTables, name)) {
                return cloneAndFreeze(storeState.modTables[name]);
            }
            return cloneAndFreeze(tableCache.get(name));
        }

        const live = reactiveStore?.getState() as Record<string, unknown> | undefined;
        const context = (live?.context ?? data.context) as GameContext;
        switch (key) {
            case 'campaignId': return live?.activeCampaignId ?? data.activeCampaignId;
            case 'playerInput': return live?.input ?? data.input;
            case 'messages': return live?.messages ?? data.messages;
            case 'archiveIndex': return live?.archiveIndex ?? data.archiveIndex;
            case 'timeline': return live?.timeline ?? data.timeline;
            case 'npcLedger': return live?.npcLedger ?? data.npcLedger;
            case 'onStageNpcIds': return live?.onStageNpcIds ?? data.onStageNpcIds;
            case 'loreChunks': return live?.loreChunks ?? data.loreChunks;
            case 'divergenceRegister': return live?.divergenceRegister ?? data.divergenceRegister;
            case 'playerCharacter': return live?.playerCharacter ?? context.playerCharacter ?? null;
            case 'characterSheet': return live?.characterProfileData ?? context.characterProfileData;
            case 'inventory': return live?.inventoryItems ?? context.inventoryItems;
            case 'location': {
                const fresh = options.getLocationState?.();
                return {
                    currentPlaceId: context.currentPlaceId ?? fresh?.currentPlaceId ?? null,
                    currentFeature: context.currentFeature ?? fresh?.currentFeature ?? null,
                    ledger: live?.locationLedger ?? fresh?.ledger ?? [],
                };
            }
            default: return undefined;
        }
    };

    const hub: ReactiveReadHub | undefined = reactiveStore
        ? createReactiveReadHub({
            store: reactiveStore,
            getValue: (key) => cloneAndFreeze(readReactiveValue(key)),
            getCampaignId: () => {
                const current = reactiveStore.getState().activeCampaignId;
                return typeof current === 'string' ? current : null;
            },
            onCampaignChange: (campaignId) => {
                disposeCampaignSubscriptions(campaignId);
                detachTableSources();
            },
        })
        : undefined;

    const notifyForWrite = (keys: readonly string[]): void => {
        for (const key of keys) hub?.invalidate(key);
    };
    const writeAfter = <T extends (...args: never[]) => unknown>(
        fn: T,
        keys: readonly string[],
    ): T => {
        const wrapped = (...args: Parameters<T>): ReturnType<T> => {
            const result = fn(...args) as ReturnType<T>;
            notifyForWrite(keys);
            return result;
        };
        return wrapped as T;
    };
    const write: FacadeWrites = Object.freeze({
        updateContext: writeAfter(callbacks.updateContext, ['location', 'playerCharacter', 'characterSheet', 'inventory']) as FacadeWrites['updateContext'],
        updateNPC: writeAfter(callbacks.updateNPC, ['npcLedger']) as FacadeWrites['updateNPC'],
        addMessage: writeAfter(callbacks.addMessage, ['messages']) as FacadeWrites['addMessage'],
        addEnemySuggestions: callbacks.addEnemySuggestions ?? (() => undefined),
        setDivergenceRegister: writeAfter(callbacks.setDivergenceRegister ?? (() => undefined), ['divergenceRegister']) as FacadeWrites['setDivergenceRegister'],
        addNpcSuggestions: callbacks.addNpcSuggestions ?? (() => undefined),
        archiveNPC: writeAfter(callbacks.archiveNPC, ['npcLedger']) as FacadeWrites['archiveNPC'],
        restoreNPC: writeAfter(callbacks.restoreNPC, ['npcLedger']) as FacadeWrites['restoreNPC'],
        onDirectorBriefPhase: callbacks.onDirectorBriefPhase ?? (() => undefined),
        updatePlayerCharacter: writeAfter(options.updatePlayerCharacter ?? (() => undefined), ['playerCharacter']) as FacadeWrites['updatePlayerCharacter'],
        setCharacterProfileData: writeAfter(callbacks.setCharacterProfileData, ['characterSheet']) as FacadeWrites['setCharacterProfileData'],
        setInventoryItems: writeAfter(callbacks.setInventoryItems, ['inventory']) as FacadeWrites['setInventoryItems'],
        setLocationLedger: writeAfter(callbacks.setLocationLedger, ['location']) as FacadeWrites['setLocationLedger'],
        addLocationSuggestions: callbacks.addLocationSuggestions,
    });
    const call: ModelCall = async (role: ModelRole, request: ModelRequest): Promise<ModelResponse> => {
        const endpoint = resolveEndpoint(state, role);
        if (!endpoint) throw new Error('[sandbox] model role not configured: ' + role);
        if (options.modelCall) return options.modelCall(role, request, endpoint);
        const content = await llmCall(endpoint, request.prompt, {
            signal: request.signal,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            priority: request.priority,
            trackingLabel: request.trackingLabel,
            timeoutMs: request.timeoutMs,
        });
        return { content };
    };
    const model = Object.freeze({
        call,
        callJson: (role: ModelRole, request: ModelRequest, jsonOptions?: ModelJsonOptions): Promise<unknown> =>
            callModelJson(role, request, call, jsonOptions),
        available: (role: ModelRole): boolean => hasConfiguredRole(state, role),
    });
    const tableRead = async (name: string): Promise<unknown> => {
        const value = await tableAdapter.read(name);
        tableCache.set(name, cloneAndFreeze(value));
        return cloneAndFreeze(value);
    };
    const tableWrite = async (name: string, rows: unknown): Promise<void> => {
        await tableAdapter.write(name, rows);
        tableCache.set(name, cloneAndFreeze(rows));
        hub?.invalidate(`table:${name}`, cloneAndFreeze(rows));
    };
    const tableSubscribe = (name: string, listener: (rows: unknown) => void): (() => void) => {
        if (!hub) throw new Error('[facade] reactive table subscriptions require a live store');
        if (!tableSourceUnsubscribes.has(name) && tableAdapter.subscribe) {
            tableSourceUnsubscribes.set(name, tableAdapter.subscribe(name, (rows) => {
                tableCache.set(name, cloneAndFreeze(rows));
                hub.invalidate(`table:${name}`, cloneAndFreeze(rows));
            }));
        }
        const unsubscribe = hub.subscribe(`table:${name}`, listener, cloneAndFreeze(readReactiveValue(`table:${name}`)));
        return () => {
            unsubscribe();
            if (hub.getListenerCount(`table:${name}`) === 0) {
                tableSourceUnsubscribes.get(name)?.();
                tableSourceUnsubscribes.delete(name);
            }
        };
    };
    const table: HostFacade['table'] = Object.freeze(hub
        ? { read: tableRead, write: tableWrite, subscribe: tableSubscribe }
        : { read: tableRead, write: tableWrite });
    const signal = options.signal ?? new AbortController().signal;
    const refresh = (): HostFacade => buildHostFacade(
        options.getState?.() ?? state,
        options.getCallbacks?.() ?? callbacks,
        { ...options, reactiveStore, table: tableAdapter },
    );
    const facade: HostFacade = Object.freeze({
        data,
        config,
        write,
        model,
        table,
        ...(hub ? {
            subscribe: (key: string, listener: (value: unknown) => void): (() => void) =>
                hub.subscribe(key, listener, cloneAndFreeze(readReactiveValue(key))),
        } : {}),
        signal,
        refresh,
        log: (...args: unknown[]) => console.log(...args),
    });
    facadeModelAvailability.set(facade, new Set<ModelRole>(
        MODEL_ROLES.filter((role) => hasConfiguredRole(state, role)),
    ));
    return facade;
}

export function hasHostModelRole(facade: HostFacade, role: ModelRole): boolean {
    return facadeModelAvailability.get(facade)?.has(role) === true;
}

export const createHostFacade = buildHostFacade;
