import type {
    Archetype, AugmentId, CombatEvent, CombatState, CombatTier, EffectId, FormId, GlyphAbility, MapSpec, ParleyEffect, ParleyIntent,
    ParleyRating, StuntDifficulty, StuntSpec,
} from '@narrative/engine';
import { isBuiltinId } from '@narrative/engine';

export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget, CombatSheet, DerivedSheet,
    Combatant, CombatState, CombatEvent, CombatAction, CombatOutcome, Side as CombatSide,
    Grid as CombatGrid, Pos as CombatPos, Tile as CombatTile, AttackRange, TemplateOverlay,
    AreaType as CombatAreaType, MapDensity as CombatMapDensity, HazardKind as CombatHazardKind,
    TerrainLabels as CombatTerrainLabels, ResolvedMapSpec as CombatResolvedMap,
    GlyphAbility, FormId, EffectId, AugmentId, CombatCondition,
    ParleyIntent, ParleyRating, ParleyEffect, ParleyRecord, FateRecord,
    StuntOutcome, StuntDifficulty, StuntPart, StuntSpec,
} from '@narrative/engine';

export type CombatPartyControl = 'solo' | 'engine' | 'player';
export type CombatDefeatMode = 'knockout' | 'hardcore' | 'ironman';
export type CombatNarrationCadence = 'action' | 'side' | 'round' | 'end';
export type CombatMpRecovery = 'fight';
export type CombatNarrationLength = 'brief' | 'standard' | 'rich';

export type CombatSettings = {
    partyControl: CombatPartyControl;
    defeatMode: CombatDefeatMode;
    narrationCadence: CombatNarrationCadence;
    narrationLength: CombatNarrationLength;
    confirmStart: boolean;
    offerOnDangerous: boolean;
    resourceLabel: string;
    maxChainLength: number;
    maxEquippedAbilities: number;
    maxSummons: number;
    mpRecovery: CombatMpRecovery;
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
    manner?: string;
    attack?: ProposedAttackStyle;
    included?: boolean;
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
    excluded?: string[];
    parley?: PendingParley;
    parleyLines?: ParleyLine[];
    flourishes?: CombatFlourish[];
    stunt?: PendingStunt;
};

export type PendingStunt = {
    attemptId: string;
    actorId: string;
    words: string;
    stage: 'rating' | 'verdict';
    spec?: StuntSpec;
    difficulty?: Exclude<StuntDifficulty, 'impossible'>;
};

export type StuntResultKind = 'judged' | 'impossible' | 'invalid' | 'unjudged';

export type CombatFlourish = {
    seq: number;
    text: string;
};

export const COMBAT_FLOURISH_MAX = 200;
export const COMBAT_MANNER_MAX = 40;

export type ParleyRatingSource = 'tool' | 'json' | 'default' | 'engine';

export type PendingParley = {
    attemptId: string;
    words: string;
    lineMessageId: string;
    stage: 'rating' | 'rolled';
    intent?: ParleyIntent;
    rating?: ParleyRating;
    speakerId?: string;
    source?: ParleyRatingSource;
    eventSeq?: number;
};

export type ParleyLine = {
    attemptId: string;
    words: string;
    intent?: ParleyIntent;
    rating?: ParleyRating;
    success?: boolean;
};

export type CombatTurnNote = {
    id: string;
    text: string;
    createdAt: number;
};

export type CombatTelemetry = {
    dangerousCommits: number;
    dangerousWithoutProposal: number;
    parleyRatings?: Partial<Record<ParleyRating, number>>;
    parleyIntents?: Partial<Record<ParleyIntent, number>>;
    parleyOutcomes?: Partial<Record<ParleyEffect | 'success', number>>;
    parleySources?: Partial<Record<ParleyRatingSource, number>>;
    stuntDifficulties?: Partial<Record<StuntDifficulty, number>>;
    stuntResults?: Partial<Record<StuntResultKind, number>>;
};

export type CombatFallen = {
    name: string;
    pcId?: string;
    mode: 'hardcore' | 'ironman';
    at: number;
    stage: 'fallen' | 'creating';
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
export const COMBAT_NARRATION_LENGTHS: readonly CombatNarrationLength[] = ['brief', 'standard', 'rich'];

export const COMBAT_RESOURCE_LABEL_MAX = 24;

export const DEFAULT_COMBAT_CONFIG: Readonly<CombatSettings> = Object.freeze({
    partyControl: 'engine',
    defeatMode: 'knockout',
    narrationCadence: 'side',
    narrationLength: 'standard',
    confirmStart: true,
    offerOnDangerous: true,
    resourceLabel: 'MP',
    maxChainLength: 6,
    maxEquippedAbilities: 6,
    maxSummons: 2,
    mpRecovery: 'fight',
});

export const COMBAT_MP_RECOVERIES: readonly CombatMpRecovery[] = ['fight'];

export type Spellbook = {
    abilities: GlyphAbility[];
    equippedIds: string[];
};

export type AbilityProposal = {
    id: string;
    messageId: string;
    campaignId?: string;
    ability: GlyphAbility;
};

export const SPELLBOOK_MAX_ABILITIES = 200;

const FORM_KEYS: readonly FormId[] = ['touch', 'projectile', 'self', 'line', 'cone', 'burst', 'dash'];
const EFFECT_KEYS: readonly EffectId[] = ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'blink', 'swap', 'barrier', 'drain', 'summon'];
const AUGMENT_KEYS: readonly AugmentId[] = ['amplify', 'widen', 'extend', 'pierce', 'split', 'quicken'];
const ABILITY_SOURCES: readonly GlyphAbility['source'][] = ['player', 'ai', 'preset'];

function cleanAugments(raw: unknown): AugmentId[] {
    return Array.isArray(raw) ? raw.filter((a): a is AugmentId => typeof a === 'string' && (AUGMENT_KEYS as readonly string[]).includes(a)) : [];
}

function cleanString(raw: unknown, max: number): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.replace(/\s+/g, ' ').trim().slice(0, max);
    return trimmed || undefined;
}

export function normalizeGlyphAbility(raw: unknown): GlyphAbility | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const id = cleanString(r.id, 80);
    const name = cleanString(r.name, 40);
    const form = r.form && typeof r.form === 'object' ? r.form as Record<string, unknown> : null;
    if (!id || isBuiltinId(id) || !name || !form || typeof form.id !== 'string' || !(FORM_KEYS as readonly string[]).includes(form.id)) return null;
    if (!Array.isArray(r.effects)) return null;
    const effects = r.effects
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string'
            && (EFFECT_KEYS as readonly string[]).includes((e as Record<string, unknown>).id as string))
        .map(e => ({ id: e.id as EffectId, augments: cleanAugments(e.augments) }));
    const description = cleanString(r.description, 400);
    const damageType = cleanString(r.damageType, 24);
    const source = typeof r.source === 'string' && (ABILITY_SOURCES as readonly string[]).includes(r.source) ? r.source as GlyphAbility['source'] : 'player';
    return {
        id,
        name,
        ...(description ? { description } : {}),
        ...(damageType ? { damageType } : {}),
        form: { id: form.id as FormId, augments: cleanAugments(form.augments) },
        effects,
        source,
    };
}

export function emptySpellbook(): Spellbook {
    return { abilities: [], equippedIds: [] };
}

export function normalizeSpellbook(raw: unknown): Spellbook {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySpellbook();
    const r = raw as Record<string, unknown>;
    const seen = new Set<string>();
    const abilities: GlyphAbility[] = [];
    for (const item of Array.isArray(r.abilities) ? r.abilities : []) {
        const ability = normalizeGlyphAbility(item);
        if (!ability || seen.has(ability.id)) continue;
        seen.add(ability.id);
        abilities.push(ability);
        if (abilities.length >= SPELLBOOK_MAX_ABILITIES) break;
    }
    const equippedIds = Array.isArray(r.equippedIds)
        ? [...new Set(r.equippedIds.filter((id): id is string => typeof id === 'string' && seen.has(id)))]
        : [];
    return { abilities, equippedIds };
}

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
        narrationLength: pickEnum(raw.narrationLength, COMBAT_NARRATION_LENGTHS, d.narrationLength),
        confirmStart: pickBool(raw.confirmStart, d.confirmStart),
        offerOnDangerous: pickBool(raw.offerOnDangerous, d.offerOnDangerous),
        resourceLabel: pickLabel(raw.resourceLabel, d.resourceLabel),
        maxChainLength: pickCount(raw.maxChainLength, d.maxChainLength, 1),
        maxEquippedAbilities: pickCount(raw.maxEquippedAbilities, d.maxEquippedAbilities, 1),
        maxSummons: pickCount(raw.maxSummons, d.maxSummons, 0),
        mpRecovery: pickEnum(raw.mpRecovery, COMBAT_MP_RECOVERIES, d.mpRecovery),
    };
    if (typeof raw.mookJitterRange === 'number' && Number.isFinite(raw.mookJitterRange)) out.mookJitterRange = raw.mookJitterRange;
    if (typeof raw.defaultWeaponDie === 'number' && Number.isFinite(raw.defaultWeaponDie)) out.defaultWeaponDie = raw.defaultWeaponDie;
    return out;
}
