import type { ArchiveIndexEntry, ChatMessage, EndpointConfig, EnemyEncounter, EnemyEntry, EnemyInstance, GameContext, LocationEntry, LoreChunk, NPCEntry, ProviderConfig, SemanticFact } from '../../types';

export type OocSourceKind = 'fact' | 'recent-story' | 'archive' | 'lore' | 'rules' | 'npc' | 'place' | 'enemy';

export type OocSource = {
    kind: OocSourceKind;
    id: string;
    label: string;
    excerpt: string;
};

export type OocMessage = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: OocSource[];
    archiveSearched?: boolean;
};

/** A deliberately read-only snapshot supplied by the chat shell. */
export type OocCampaignSnapshot = {
    campaignId: string | null;
    provider: EndpointConfig | ProviderConfig | undefined;
    context: GameContext;
    messages: ChatMessage[];
    semanticFacts: SemanticFact[];
    loreChunks: LoreChunk[];
    archiveIndex: ArchiveIndexEntry[];
    npcLedger: NPCEntry[];
    locationLedger: LocationEntry[];
    enemyCompendium: EnemyEntry[];
    enemyInstances: EnemyInstance[];
    enemyEncounters: EnemyEncounter[];
};

export type OocAnswerRequest = {
    question: string;
    snapshot: OocCampaignSnapshot;
    /** Session-local OOC transcript only; never persisted with campaign messages. */
    history?: OocMessage[];
    forceSearch?: boolean;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
};

export type OocAnswer = {
    text: string;
    sources: OocSource[];
    archiveSearched: boolean;
};
