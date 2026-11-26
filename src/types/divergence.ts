// ─── Divergence / Continuity Tracking Types ──────────────────────────────

export type DivergenceCategory =
    | 'locations'
    | 'npc_events'
    | 'promises_debts'
    | 'world_state'
    | 'party_facts'
    | 'rules_lore'
    | 'misc';

export type DivergenceEntry = {
    id: string;
    chapterId: string;
    category: DivergenceCategory;
    text: string;
    sceneRef: string;
    npcIds: string[];
    // Who knows this fact. Tokens: "player" | "npc:<id>" | "faction:<name-normalized>".
    // undefined = public/broadcast (common knowledge). [] = secret, no NPC knows it.
    // Bare NPC IDs (without the "npc:" prefix) are treated implicitly as "npc:<id>".
    knownBy?: string[];
    // Stable snake_case subject slug shared by ALL facts about the same subject
    // (e.g. "alex_chen.identity"). The scene number is the version axis. undefined = ungrouped.
    subjectToken?: string;
    /** Old campaigns omit this field and therefore remain active. */
    status?: 'active' | 'superseded' | 'retracted';
    supersededBy?: string;
    /** Narrow deterministic state slot, e.g. `item:moon-key:holder`. */
    stateKey?: string;
    /** Source message when a fact was extracted or entered from one message. */
    sourceMessageId?: string;
    /** Extraction-only instruction; mergeSealEntries consumes and does not persist it. */
    supersedesFactId?: string;
    pinned: boolean;
    enabled?: boolean;
    source: 'auto' | 'manual';
    reviewFlag?: boolean;
    unrecognizedNpcNames?: string[];
};

export type TopicCluster = {
    id: string;
    name: string;
    factIds: string[];
};

export type TopicClusters = {
    groups: TopicCluster[];
    generatedAt: string;
    generatedFromFactCount: number;
};

export type DivergenceRegister = {
    entries: DivergenceEntry[];
    chapterToggles: Record<string, boolean>;
    categoryToggles: Record<string, Record<DivergenceCategory, boolean>>;
    prunedLog?: DivergenceEntry[];
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: 2;
    topicClusters?: TopicClusters;
};
