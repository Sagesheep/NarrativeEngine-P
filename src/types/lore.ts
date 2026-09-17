// ─── Lore / Rules / World Lore Types ─────────────────────────────────────

export type LoreCategory =
    | 'world_overview'
    | 'faction'
    | 'location'
    | 'character'
    | 'power_system'
    | 'economy'
    | 'event'
    | 'relationship'
    | 'rules'
    | 'culture'
    | 'misc';

export type LoreChunk = {
    id: string;
    header: string;
    content: string;
    tokens: number;
    alwaysInclude: boolean;
    triggerKeywords: string[];
    secondaryKeywords?: string[];                // AND-gate filter from <!-- rag: --> hint; chunk only matches if a secondary keyword also hits
    ragMode?: 'always' | 'keyword' | 'vector';  // explicit mode from <!-- rag: --> hint; authoritative over heuristics
    disabled?: boolean;                          // when true, never retrieved by any path
    keywordsEnriched?: boolean;                  // keywords enriched via LLM
    enrichedVersion?: number;                    // LLM keywords enricher version
    scanDepth: number;
    category: LoreCategory;
    linkedEntities: string[];
    parentSection?: string;
    priority: number;
    summary?: string;
    group?: string;
    groupWeight?: number;
};

export type RuleChunkMeta = {
    id: string;
    activationModes: ('vector' | 'keyword' | 'always')[];
    triggerKeywords?: string[];
    secondaryKeywords?: string[];
    priority?: number;
    keywordsUserEdited?: boolean;
    activationModesUserEdited?: boolean;
    hasEmbedding?: boolean;
    modelId?: string;
    version?: number;
};

export type WorldLoreItem = {
    id: string;
    title: string;
    body: string;
};

export type WorldLoreDraft = {
    id: string;
    name: string;
    background: string;
    languages: string;
    powerSystem: string;
    techEconomy: string;
    timeline: string;
    toneBoundaries: string;
    houseRules: string;
    locations: WorldLoreItem[];
    cultures: WorldLoreItem[];
    factions: WorldLoreItem[];
    threats: WorldLoreItem[];
    npcs: WorldLoreItem[];
    characterCreationQuestions: string;
    rawSource?: string;
    /** Imported world entries retain their retrieval metadata. */
    importedLoreChunks?: LoreChunk[];
    worldCardMetadata?: { author: string; description: string };
    createdAt: number;
    updatedAt: number;
};
