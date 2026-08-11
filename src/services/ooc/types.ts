import type { ArchiveIndexEntry, ChatMessage, EndpointConfig, GameContext, LocationEntry, LoreChunk, NPCEntry, ProviderConfig, SemanticFact } from '../../types';

/** The kinds core's own sections and the retrieval path emit. */
export type OocCoreSourceKind = 'fact' | 'recent-story' | 'archive' | 'lore' | 'rules' | 'npc' | 'place';

/**
 * A citation's kind.
 *
 * **Phase 7.5 widened this.** It used to be a closed union that included
 * `'enemy'` — a feature name baked into a core type, which `ROLES.md` §7.1
 * flagged: when the subsystem leaves, that member becomes dead and the OOC brief
 * quietly loses its sections with nothing failing. Registered sections
 * (`sections.ts`) now declare their own kind, so no core type names a subsystem
 * and no member can go stale.
 *
 * `(string & {})` rather than a bare `string` so editors still suggest the core
 * kinds; nothing switches exhaustively on this today, and the UI treats an
 * unknown kind as an ordinary citation.
 */
export type OocSourceKind = OocCoreSourceKind | (string & {});

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
