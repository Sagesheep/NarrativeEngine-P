import type { Archetype, CombatEvent, CombatState, CombatTier, MapSpec } from '@narrative/engine';

export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget, CombatSheet, DerivedSheet,
    Combatant, CombatState, CombatEvent, CombatAction, CombatOutcome, Side as CombatSide,
    Grid as CombatGrid, Pos as CombatPos, Tile as CombatTile, AttackRange, TemplateOverlay,
    AreaType as CombatAreaType, MapDensity as CombatMapDensity, HazardKind as CombatHazardKind,
    TerrainLabels as CombatTerrainLabels, ResolvedMapSpec as CombatResolvedMap,
} from '@narrative/engine';

export type CombatPartyControl = 'solo' | 'engine' | 'player';
export type CombatDefeatMode = 'knockout' | 'hardcore' | 'ironman';
export type CombatNarrationCadence = 'action' | 'side' | 'round' | 'end';

export type CombatSettings = {
    partyControl: CombatPartyControl;
    defeatMode: CombatDefeatMode;
    narrationCadence: CombatNarrationCadence;
    confirmStart: boolean;
    offerOnDangerous: boolean;
    resourceLabel: string;
    maxChainLength: number;
    maxEquippedAbilities: number;
    maxSummons: number;
    mookJitterRange?: number;
    defaultWeaponDie?: number;
};

export type ProposedCombatantSide = 'enemy' | 'ally' | 'neutral';

export type ProposedCombatant = {
    name: string;
    side: ProposedCombatantSide;
    tier: CombatTier;
    archetype?: Archetype;
    species?: string;
    npcName?: string;
    npcId?: string;
    look?: string;
    attack?: ProposedAttackStyle;
};

export type ProposedAttackStyle = 'melee' | 'ranged';

export const PROPOSED_ATTACK_STYLES: readonly ProposedAttackStyle[] = ['melee', 'ranged'];

export type CombatMapFeature = { kind: string; where: string };

export type CombatMapSpec = MapSpec & {
    theme?: string;
    features?: CombatMapFeature[];
};

export type CombatProposal = {
    id: string;
    messageId: string;
    combatants: ProposedCombatant[];
    map?: CombatMapSpec;
    reason: string;
    source: 'tool' | 'manual';
    mapSeed?: number;
};

export type CombatSession = {
    state: CombatState;
    log: CombatEvent[];
    narratedThroughSeq: number;
    startedAtMessageId: string;
    reason: string;
    map?: CombatMapSpec;
    postedThroughSeq?: number;
};

export type CombatTurnNote = {
    id: string;
    text: string;
    createdAt: number;
};

export type CombatTelemetry = {
    dangerousCommits: number;
    dangerousWithoutProposal: number;
};

export const COMBAT_TIERS: readonly CombatTier[] = ['minion', 'grunt', 'elite', 'boss', 'legendary'];
export const COMBAT_ARCHETYPES: readonly Archetype[] = ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'];
export const PROPOSED_COMBATANT_SIDES: readonly ProposedCombatantSide[] = ['enemy', 'ally', 'neutral'];
export const MAX_PROPOSED_COMBATANTS = 12;

export type CombatTableRecord = {
    session: CombatSession | null;
};

export const COMBAT_PARTY_CONTROLS: readonly CombatPartyControl[] = ['solo', 'engine', 'player'];
export const COMBAT_DEFEAT_MODES: readonly CombatDefeatMode[] = ['knockout', 'hardcore', 'ironman'];
export const COMBAT_NARRATION_CADENCES: readonly CombatNarrationCadence[] = ['action', 'side', 'round', 'end'];

export const COMBAT_RESOURCE_LABEL_MAX = 24;

export const DEFAULT_COMBAT_CONFIG: Readonly<CombatSettings> = Object.freeze({
    partyControl: 'engine',
    defeatMode: 'knockout',
    narrationCadence: 'side',
    confirmStart: true,
    offerOnDangerous: true,
    resourceLabel: 'MP',
    maxChainLength: 6,
    maxEquippedAbilities: 6,
    maxSummons: 2,
});

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function pickCount(value: unknown, fallback: number, min: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function pickLabel(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim().slice(0, COMBAT_RESOURCE_LABEL_MAX);
    return trimmed || fallback;
}

export function normalizeCombatConfig(partial?: unknown): CombatSettings {
    const raw: Record<string, unknown> = partial && typeof partial === 'object' && !Array.isArray(partial)
        ? partial as Record<string, unknown>
        : {};
    const d = DEFAULT_COMBAT_CONFIG;
    const out: CombatSettings = {
        partyControl: pickEnum(raw.partyControl, COMBAT_PARTY_CONTROLS, d.partyControl),
        defeatMode: pickEnum(raw.defeatMode, COMBAT_DEFEAT_MODES, d.defeatMode),
        narrationCadence: pickEnum(raw.narrationCadence, COMBAT_NARRATION_CADENCES, d.narrationCadence),
        confirmStart: pickBool(raw.confirmStart, d.confirmStart),
        offerOnDangerous: pickBool(raw.offerOnDangerous, d.offerOnDangerous),
        resourceLabel: pickLabel(raw.resourceLabel, d.resourceLabel),
        maxChainLength: pickCount(raw.maxChainLength, d.maxChainLength, 1),
        maxEquippedAbilities: pickCount(raw.maxEquippedAbilities, d.maxEquippedAbilities, 1),
        maxSummons: pickCount(raw.maxSummons, d.maxSummons, 0),
    };
    if (typeof raw.mookJitterRange === 'number' && Number.isFinite(raw.mookJitterRange)) out.mookJitterRange = raw.mookJitterRange;
    if (typeof raw.defaultWeaponDie === 'number' && Number.isFinite(raw.defaultWeaponDie)) out.defaultWeaponDie = raw.defaultWeaponDie;
    return out;
}
