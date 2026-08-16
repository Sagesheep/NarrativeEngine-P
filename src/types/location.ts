// ─── Location Ledger Types ────────────────────────────────────────────────
// Place-analogue of the NPC Ledger. Structured entries for places the story
// has visited, populated automatically by the location estimator
// (services/locationParser.ts) and editable by the player in the
// LocationLedgerModal. One pointer (currentPlaceId + optional currentFeature)
// on GameContext tracks where the PC is right now.

import type { DistanceBand } from '../services/location/distance';

export type LocationConnection = {
    toId: string;                          // id of another LocationEntry
    band?: DistanceBand;
    note?: string;                         // "locked at night", "guarded gate"
};

export type LocationEntry = {
    id: string;                            // `loc_${Date.now()}_${rand}` (mirror inventory id style)
    name: string;                          // "Ninja Academy"
    aliases: string;                       // comma-separated, same convention as NPCEntry.aliases
    broadLocation: string;                 // parent region as plain string v1, e.g. "Konoha"
    features: string[];                    // ["Class A","Class B","training yard","teacher lounge"]
    connections: LocationConnection[];
    description: string;                   // 1–2 sentences of texture; injected
    status?: string;                       // "burned down in ch. 12" — optional, injected when set
    firstSeenScene: string;
    lastSeenScene: string;
    source: 'llm' | 'manual';
};

/** A place the estimator noticed but did NOT add — the player decides. (Mirrors NpcSuggestion.) */
export type LocationSuggestion = {
    name: string;
    connectedTo?: string;
    context?: string;
    firstSeen: number;
};