import type { AbilityKey, AugmentId, CombatTier, EffectId, FormId, GlyphTier } from '../types';

export const FORM_IDS: readonly FormId[] = ['touch', 'projectile', 'self', 'line', 'cone', 'burst', 'dash', 'sigil', 'mantle', 'chain', 'wall'];

export const EFFECT_IDS: readonly EffectId[] = [
    'damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'blink', 'swap', 'barrier', 'drain', 'summon',
    'snare', 'dispel', 'leap', 'gravity', 'fear', 'decay', 'vanish', 'rewind',
];

export const AUGMENT_IDS: readonly AugmentId[] = ['amplify', 'widen', 'extend', 'pierce', 'split', 'quicken', 'dampen', 'sustain', 'delay'];

export type FormRoll = 'attack' | 'save' | 'none';

export type FormSpec = {
    cost: number;
    tier: GlyphTier;
    roll: FormRoll;
    area: boolean;
    augments: readonly AugmentId[];
    effects: readonly EffectId[];
    placed?: boolean;
};

export type EffectSpec = {
    cost: number;
    tier: GlyphTier;
    augments: readonly AugmentId[];
    save?: AbilityKey;
    helpful?: boolean;
    tile?: boolean;
    builtin?: boolean;
    hostile?: boolean;
    either?: boolean;
};

export const FORMS: Readonly<Record<FormId, FormSpec>> = {
    touch: {
        cost: 0, tier: 1, roll: 'attack', area: false, augments: ['split', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'barrier', 'drain', 'summon', 'snare', 'dispel', 'fear', 'decay'],
    },
    projectile: {
        cost: 1, tier: 1, roll: 'attack', area: false, augments: ['extend', 'pierce', 'split', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'drain', 'summon', 'snare', 'dispel', 'fear', 'decay'],
    },
    self: {
        cost: 0, tier: 1, roll: 'none', area: false, augments: ['quicken'],
        effects: ['heal', 'shield', 'haste', 'blink', 'leap', 'dispel', 'vanish', 'rewind'],
    },
    line: {
        cost: 2, tier: 2, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'barrier', 'drain', 'snare', 'dispel', 'fear', 'decay'],
    },
    cone: {
        cost: 2, tier: 2, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'drain', 'snare', 'dispel', 'fear', 'decay'],
    },
    burst: {
        cost: 3, tier: 3, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'drain', 'snare', 'dispel', 'gravity', 'fear', 'decay'],
    },
    dash: {
        cost: 1, tier: 2, roll: 'attack', area: false, augments: ['extend', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'drain', 'snare', 'fear', 'decay'],
    },
    sigil: {
        cost: 2, tier: 3, roll: 'save', area: false, augments: ['extend', 'sustain', 'quicken'], placed: true,
        effects: ['damage', 'push', 'pull', 'stun', 'slow', 'drain', 'snare', 'fear', 'decay'],
    },
    mantle: {
        cost: 3, tier: 3, roll: 'save', area: true, augments: ['widen', 'sustain', 'quicken'], placed: true,
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'slow', 'drain', 'gravity', 'decay', 'dispel'],
    },
    chain: {
        cost: 2, tier: 3, roll: 'attack', area: false, augments: ['extend', 'widen', 'quicken', 'delay'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'drain', 'snare', 'dispel', 'fear', 'decay'],
    },
    wall: {
        cost: 3, tier: 3, roll: 'save', area: true, augments: ['extend', 'widen', 'sustain', 'quicken'], placed: true,
        effects: ['damage', 'push', 'pull', 'slow', 'decay'],
    },
};

export const EFFECTS: Readonly<Record<EffectId, EffectSpec>> = {
    damage: { cost: 1, tier: 1, augments: ['amplify', 'dampen'], save: 'DEX', hostile: true },
    heal: { cost: 2, tier: 1, augments: ['amplify', 'dampen'], helpful: true },
    shield: { cost: 1, tier: 1, augments: ['amplify', 'extend', 'dampen'], helpful: true },
    push: { cost: 1, tier: 1, augments: ['amplify', 'dampen'], save: 'DEX', hostile: true },
    pull: { cost: 1, tier: 2, augments: ['amplify', 'dampen'], save: 'DEX', hostile: true },
    stun: { cost: 3, tier: 2, augments: ['extend'], save: 'CON', hostile: true },
    slow: { cost: 1, tier: 1, augments: ['extend'], save: 'CON', hostile: true },
    haste: { cost: 4, tier: 2, augments: ['extend'], helpful: true },
    blink: { cost: 2, tier: 2, augments: ['extend'], helpful: true },
    swap: { cost: 2, tier: 3, augments: [], save: 'WIS', hostile: true },
    barrier: { cost: 2, tier: 2, augments: ['extend'], tile: true },
    drain: { cost: 2, tier: 2, augments: ['amplify', 'dampen'], save: 'DEX', hostile: true },
    summon: { cost: 4, tier: 3, augments: ['amplify', 'extend'], tile: true },
    snare: { cost: 2, tier: 2, augments: ['sustain'], save: 'STR', hostile: true },
    dispel: { cost: 2, tier: 2, augments: [], save: 'WIS', either: true },
    leap: { cost: 2, tier: 2, augments: ['extend'], helpful: true },
    gravity: { cost: 2, tier: 3, augments: ['amplify', 'dampen'], save: 'STR', hostile: true },
    fear: { cost: 3, tier: 3, augments: ['sustain'], save: 'WIS', hostile: true },
    decay: { cost: 2, tier: 3, augments: ['amplify', 'dampen'], save: 'CON', hostile: true },
    vanish: { cost: 3, tier: 3, augments: [], helpful: true },
    rewind: { cost: 3, tier: 3, augments: [], helpful: true },
    weapon: { cost: 0, tier: 1, augments: [], builtin: true },
    guard: { cost: 0, tier: 1, augments: [], helpful: true, builtin: true },
    sprint: { cost: 0, tier: 1, augments: [], helpful: true, builtin: true },
    rally: { cost: 0, tier: 1, augments: [], helpful: true, builtin: true },
    hurl: { cost: 0, tier: 1, augments: [], builtin: true },
};

export const AUGMENT_COSTS: Readonly<Record<AugmentId, number>> = {
    amplify: 2,
    widen: 2,
    extend: 1,
    pierce: 1,
    split: 2,
    quicken: 3,
    dampen: -1,
    sustain: 1,
    delay: 1,
};

export const AUGMENT_TIERS: Readonly<Record<AugmentId, GlyphTier>> = {
    amplify: 1,
    widen: 2,
    extend: 1,
    pierce: 2,
    split: 3,
    quicken: 2,
    dampen: 2,
    sustain: 2,
    delay: 3,
};

export const DAMPENED_COST_FLOOR = 1;

export const DELAY_REFUSED_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['barrier', 'summon', 'swap']);

export const TELEPORT_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['blink', 'leap']);

export const DISPEL_HARMFUL: readonly string[] = [
    'stunned', 'slowed', 'snared', 'feared', 'burning', 'soaked', 'staggered', 'revealed', 'blinded', 'coated', 'dazed', 'confused',
];

export const DISPEL_HELPFUL: readonly string[] = ['hasted', 'shielded', 'defending', 'vanished'];

export const GLYPH_NUMBERS = {
    touchRange: 1,
    projectileRange: 12,
    lineLength: 6,
    coneLength: 3,
    burstRange: 8,
    burstRadius: 1,
    dashLength: 4,
    blinkRange: 6,
    blinkExtend: 3,
    splitRange: 3,
    extendFactor: 0.5,
    pushDistance: 2,
    shieldTurns: 3,
    slowTurns: 2,
    hasteTurns: 2,
    stunTurns: 1,
    barrierRounds: 3,
    barrierLineTiles: 4,
    summonRounds: 3,
    enemyCooldownRounds: 2,
    maxEffects: 4,
    maxSameAugment: 2,
    throwDie: 4,
    throwLightRange: 4,
    throwMediumRange: 2,
    throwHeavyRange: 1,
    throwLightMin: 2,
    throwMediumMin: 2,
    throwHeavyMin: 1,
    throwHeavyCount: 2,
    throwHeavySides: 6,
    throwMediumSides: 8,
    throwLandingSides: 6,
    jumpBase: 2,
    stuntDie: 6,
    stuntAreaDie: 4,
    stuntReach: 6,
    stuntMove: 4,
    stuntCoverRange: 2,
    stuntCoverTiles: 2,
    stuntAreaRange: 4,
    stuntSlowTurns: 1,
    nameMax: 40,
    defaultDamageType: 'force',
    sigilRange: 6,
    sigilRounds: 5,
    sigilSustain: 2,
    sigilSight: 2,
    maxSigils: 3,
    mantleRadius: 1,
    mantleRounds: 2,
    chainRange: 8,
    chainJumps: 2,
    chainJumpRange: 2,
    chainFalloff: 0.5,
    wallRange: 6,
    wallLength: 3,
    wallRounds: 2,
    snareTurns: 1,
    leapGlyphRange: 4,
    leapExtend: 2,
    gravitySquares: 2,
    fearTurns: 1,
    decaySides: 4,
    decayDrop: 1,
    decayFloor: 0.5,
    delayBoost: 1,
} as const;

export const SUMMON_TIERS: readonly CombatTier[] = ['minion', 'grunt', 'elite'];

export const UNSTUNNABLE_TIERS: ReadonlySet<CombatTier> = new Set<CombatTier>(['boss', 'legendary']);

export const MP_BASE = 4;
export const MP_PER_LEVEL = 2;
export const MP_PER_CASTING_MOD = 2;
export const MP_MIN = 4;

export const SINGLE_TARGET_FORMS: ReadonlySet<FormId> = new Set<FormId>(['touch', 'projectile', 'dash']);
