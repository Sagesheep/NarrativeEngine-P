// ─── Character / NPC Types ────────────────────────────────────────────────

export type InventoryItemCategory = 'weapon' | 'armor' | 'consumable' | 'currency' | 'key' | 'misc' | 'equipped';

export type InventoryItem = {
    id: string;
    name: string;
    qty: number;
    category: InventoryItemCategory;
    keywords: string[];
    equipped: boolean;
    lastUsedScene: string;
    importance: number;
    notes: string;
    status?: string;
};

// Staged inventory change proposed by the GM via the `propose_inventory_change`
// tool. Bounded labels only — the engine (Phase 7) owns all numbers (damage dice,
// bonus, AC). `quality` rarity is inlined here rather than referencing the Phase 7
// `ItemDef['rarity']` so this type stays self-contained until combat lands.
export type InventoryProposal = {
    name: string;
    op: 'grant' | 'remove' | 'equip';
    kind: 'weapon' | 'armor' | 'consumable' | 'misc';
    quality: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
    scalingStat: 'PWR' | 'SPD' | 'WIL';
    range: 'Close' | 'Reach' | 'Ranged';
    properties: string[];
    equip: boolean;
    description: string;
};

export type CharacterProfile = {
    name: string;
    race: string;
    class: string;
    level: number;
    hp: { current: number; max: number };
    mp?: { current: number; max: number };
    stats: Record<string, number>;
    skills: string[];
    abilities: string[];
    traits: string[];
    notes: string;
};

// ── Structured PC profile (WO-G — scene-tagged smart injection) ──
// Replaces the legacy flat-string `characterProfile` blob with a bounded,
// supersession-aware trait list. Lives alongside `CharacterProfile` (the sheet)
// — `CharacterProfileState` is the narrative-trait view, `CharacterProfile`
// is the stat-block view.

import type { DivergenceCategory } from './divergence';
import type { SceneEventType } from './archive';

/**
 * A single structured narrative fact about the player character.
 * - `category` reuses DivergenceCategory (party_facts is the natural home for
 *   most PC narrative state).
 * - `eventTags` drives scene-aware retrieval: the planner emits eventTypes per
 *   turn; traits whose tags don't intersect the planner's set are dropped from
 *   the extended tier. Core-tier traits (see CORE_FLOOR_TRAITS) bypass this.
 * - `superseded: true` marks a trait replaced by a newer one with the same
 *   `subject` + `category`. The parser sets this instead of appending, fixing
 *   the append-only trait bloat bug.
 */
export type CharacterTrait = {
    id: string;
    subject: string;                  // PC name (or entity name for PC-adjacent traits)
    category: DivergenceCategory;     // which kind of fact this is
    text: string;                     // the narrative fact, one short sentence
    importance: number;                // 1-10 narrative weight; drives retrieval scoring
    eventTags: SceneEventType[];       // which scene types this trait is relevant to
    sceneEstablished: string;          // sceneId where this trait was first recorded
    superseded: boolean;               // true if a newer trait with same subject+category replaced this
    source: 'llm' | 'manual' | 'seed'; // origin: parser / user edit / wizard seed
};

/**
 * Core identity fields ALWAYS injected for the PC, regardless of scene tags.
 * These live outside the trait list because they're structural (name/race/class
 * don't change per scene and aren't subject to supersession).
 */
export type CharacterIdentity = {
    name?: string;
    race?: string;
    class?: string;
    archetype?: string;
    level?: number;
};

/**
 * Structured replacement for the flat `characterProfile: string` field.
 * - `identity` is always injected (Tier 1 core).
 * - `activeTraits` are scored + scene-filtered + budget-capped at injection
 *   time by `queryTraits` (the PC analogue of `queryFacts`).
 * - `legacyNotes` is a frozen read-only blob from the old flat-string profile.
 *   NEVER injected into the prompt — kept only so users don't lose data on
 *   upgrade. The parser rebuilds `activeTraits` over a few turns.
 */
export type CharacterProfileState = {
    identity: CharacterIdentity;
    stats?: Record<string, number>;
    activeTraits: CharacterTrait[];
    legacyNotes?: string;
};

/** Number of PC traits always injected regardless of scene tags. */
export const CORE_FLOOR_TRAITS = 5;

export type NPCVisualProfile = {
    race: string;
    gender: string;
    ageRange: string;
    build: string;
    symmetry: string; // ugly / pretty / handsome etc.
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    gait: string;
    distinctMarks: string;
    clothing: string;
    artStyle: string;
};

export const DEFAULT_VISUAL_PROFILE: NPCVisualProfile = {
    race: '', gender: '', ageRange: '', build: '', symmetry: '',
    hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '', artStyle: 'Stylized Game Realism',
};

export type NPCBehavioralTrigger = {
    keyword: string;
    shift: string;
};

export type NPCPressureHistory = {
    turn: number;
    type: 'ignored' | 'engaged';
    delta: number;
    reason: string;
};

export type NPCDrives = {
    coreWant: string;
    sessionWant: string;
    sceneWant: string;
};

export type NPCPressure = {
    ignored: number;
    engaged: number;
    lastDecayTurn: number;
    lastActiveTurn?: number;
    history: NPCPressureHistory[];
};

/** A name the auto-detector noticed but did NOT add — the player decides. (WO-11.3) */
export type NpcSuggestion = { name: string; context?: string; firstSeen: number };

/**
 * NPC Signature Kit — the durable, bounded loadout that keeps an NPC's gear and
 * powers consistent across the campaign (the anti-drift analogue of personalityHex).
 * Bounded on purpose: this is a signature, not an inventory. Seeded at generation,
 * injected every turn in the CORE tier, and changed ONLY on a narrated gain/loss/
 * transformation by the NPC updater (supersede-in-place, never append/re-roll).
 */
export type NPCSignatureKit = {
    equipment: string[];   // signature gear; <=8 entries; each a short noun phrase, e.g. "Excalibur (holy longsword)"
    abilities: string[];   // signature powers/techniques; <=8 entries, e.g. "fire magic", "regeneration"
    element?: string;      // optional single affinity/damage-type tag, e.g. "fire"
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    visualProfile?: NPCVisualProfile;
    faction: string;
    storyRelevance: string;
    disposition: string;
    status: string;
    goals: string;
    voice: string;
    personality: string;
    exampleOutput: string;
    affinity: number;
    portrait?: string;
    // ---- Agency-engine referenced fields (Phase 2 port; all optional → lazy migration) ----
    isPC?: boolean;
    tier?: 'recurring' | 'oneshot' | 'walkon';
    condition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    previousSnapshot?: {
        personality: string;
        voice: string;
        affinity: number;
        personalityHex?: PersonalityHex;
        pcRelation?: number;
        skillRung?: number;
    };
    shiftNote?: string;
    shiftTurnCount?: number;
    drives?: NPCDrives;
    behavioralTriggers?: NPCBehavioralTrigger[];
    hardBoundaries?: string[];
    softBoundaries?: string[];
    pressure?: NPCPressure;
    archived?: boolean;
    archivedAtTurn?: number;
    archivedReason?: string;
    // ---- NPC Agency fields (Phase 1, all optional → lazy migration) ----
    wants?: NPCWants;
    personalityHex?: PersonalityHex;
    // ---- NPC Signature Kit (v1) — durable loadout; anti-drift for gear + powers ----
    signatureKit?: NPCSignatureKit;
    // ---- PC-only meta (set by the Character module; ignored for NPCs) ----
    pcMeta?: {
        archetype?: string;
        combatTier?: string;           // Phase 7 wiring; display-only today
        stats?: Record<string, number>;
    };
    traits?: string[];            // <=5, controlled vocab (see services/npc/agencyPools.ts)
    region?: string;              // coarse location: 'academy' | 'Ryuten' | ...
    haunt?: string;               // flavor only, for reports ('the garden')
    relations?: RelationGraph;    // NPC->NPC sparse directed edges
    pcRelation?: number;          // -3..+3 — dedicated NPC->PC slot (re-homed from affinity)
    populated?: boolean;          // false/undefined = not yet generated (Phase-2 lazy fill)
    agencyLocked?: boolean;       // true = player authors this NPC; skip agency updates
    goalRecords?: Goal[];         // Phase-3 engine layer (hidden cols); seeded from wants.medium/long
    // ---- NPC Agency Phase 4: power-rung ladder ----
    skillRung?: number;           // 0..4 ladder position; undefined = not yet set (default Novice=0 on fill)
    rungCeiling?: number;         // 0..4 talent cap; LLM-set once, default 3
    // ---- NPC Agency Phase 4: promotion / audition ----
    agencyActivity?: { value: number; tick: number };
    // ---- NPC Inner Repression (peaceful social masking) — WO-D ----
    repressionPressure?: number;
    // ---- Relationship meter (engine-owned affinity accumulator) — WO-C ----
    relationMeter?: number;
    // ---- NPC Generation Refit (Phase 1) — SOCIAL/disposition groups — WO-A ----
    primaryGroup?: string;
    secondaryGroup?: string;
    /**
     * Scene-type tags per profile field, used for smart context injection.
     * Key = field name (e.g. 'voice'), value = SceneEventType[] indicating which scene
     * types this field is relevant to. Fields not in the map (or NPCs without fieldTags)
     * always inject — preserving the backward-compatible default.
     */
    fieldTags?: Partial<Record<string, import('./archive').SceneEventType[]>>;
    // ---- AI Tier gating: last scene this NPC received an LLM profile update ----
    lastUpdateScene?: number;
};

// ---- NPC Agency (Phase 1: schema only — no dice/heat/karma/tick logic) ----

// Personality hexagon: 6 spectrum axes, each stored -3..+3 (0 = neutral center).
export type HexAxis = 'drive' | 'diligence' | 'boldness' | 'warmth' | 'empathy' | 'composure';
export type PersonalityHex = Record<HexAxis, number>;

// Tiered wants. Sits beside the legacy NPCDrives (seeded from it in Phase 2; not deleted).
export type NPCWants = {
    short: string[];   // needs/flavor pool draws; repeats allowed; no LLM
    medium: string[];  // goal templates (pool); LLM-updated in Phase 2
    long: string;      // single long goal; LLM-generated at creation (Phase 2)
};

// Scene danger gradient (Phase 3). Gates which goal tiers may tick: `dangerous` blocks
// long-goals + relaxing.
export type SceneStakes = 'calm' | 'tense' | 'dangerous';

// ---- NPC Agency Phase 3: Goal records (hidden columns) ----
export type GoalHorizon = 'med' | 'long';
export type GoalState = 'active' | 'achieved' | 'blocked' | 'retired';
export type Goal = {
    text: string;                 // reaches LLM (display); the only payload-visible field
    horizon: GoalHorizon;
    tier: 'default' | 'mature';   // content gate
    base_heat: number;            // Piece A
    lastAdvancedTick: number;     // Piece A: neglect = now - this
    failStreak: number;           // Piece B (karma, NEVER in payload)
    progress: number;             // Piece C
    quota: number;                // Piece C (scales with magnitude)
    state: GoalState;
    justifiedEventFlag?: boolean; // set by Crit Success, consumed by tier-cross (Piece C)
};

// Sparse, directed NPC->NPC relation graph. Key = target NPC id; absent key = Neutral (0).
// Only non-neutral edges are stored. Each value -3..+3.
export type RelationGraph = Record<string, number>;

