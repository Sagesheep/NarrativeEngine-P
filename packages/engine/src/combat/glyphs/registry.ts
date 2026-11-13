import type { AbilityKey, AugmentId, CombatTier, EffectId, FormId } from '../types';

export const FORM_IDS: readonly FormId[] = ['touch', 'projectile', 'self', 'line', 'cone', 'burst', 'dash'];

export const EFFECT_IDS: readonly EffectId[] = [
    'damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'blink', 'swap', 'barrier', 'drain', 'summon',
];

export const AUGMENT_IDS: readonly AugmentId[] = ['amplify', 'widen', 'extend', 'pierce', 'split', 'quicken'];

export type FormRoll = 'attack' | 'save' | 'none';

export type FormSpec = {
    cost: number;
    roll: FormRoll;
    area: boolean;
    augments: readonly AugmentId[];
    effects: readonly EffectId[];
};

export type EffectSpec = {
    cost: number;
    augments: readonly AugmentId[];
    save?: AbilityKey;
    helpful?: boolean;
    tile?: boolean;
};

export const FORMS: Readonly<Record<FormId, FormSpec>> = {
    touch: {
        cost: 0, roll: 'attack', area: false, augments: ['split', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'barrier', 'drain', 'summon'],
    },
    projectile: {
        cost: 1, roll: 'attack', area: false, augments: ['extend', 'pierce', 'split', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'drain', 'summon'],
    },
    self: {
        cost: 0, roll: 'none', area: false, augments: ['quicken'],
        effects: ['heal', 'shield', 'haste', 'blink'],
    },
    line: {
        cost: 2, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'barrier', 'drain'],
    },
    cone: {
        cost: 2, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'drain'],
    },
    burst: {
        cost: 3, roll: 'save', area: true, augments: ['extend', 'widen', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'drain'],
    },
    dash: {
        cost: 1, roll: 'attack', area: false, augments: ['extend', 'quicken'],
        effects: ['damage', 'heal', 'shield', 'push', 'pull', 'stun', 'slow', 'haste', 'swap', 'drain'],
    },
};

export const EFFECTS: Readonly<Record<EffectId, EffectSpec>> = {
    damage: { cost: 1, augments: ['amplify'], save: 'DEX' },
    heal: { cost: 2, augments: ['amplify'], helpful: true },
    shield: { cost: 1, augments: ['amplify', 'extend'], helpful: true },
    push: { cost: 1, augments: ['amplify'], save: 'DEX' },
    pull: { cost: 1, augments: ['amplify'], save: 'DEX' },
    stun: { cost: 3, augments: ['extend'], save: 'CON' },
    slow: { cost: 1, augments: ['extend'], save: 'CON' },
    haste: { cost: 4, augments: ['extend'], helpful: true },
    blink: { cost: 2, augments: ['extend'], helpful: true },
    swap: { cost: 2, augments: [], save: 'WIS' },
    barrier: { cost: 2, augments: ['extend'], tile: true },
    drain: { cost: 2, augments: ['amplify'], save: 'DEX' },
    summon: { cost: 4, augments: ['amplify', 'extend'], tile: true },
};

export const AUGMENT_COSTS: Readonly<Record<AugmentId, number>> = {
    amplify: 2,
    widen: 2,
    extend: 1,
    pierce: 1,
    split: 2,
    quicken: 3,
};

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
    nameMax: 40,
    defaultDamageType: 'force',
} as const;

export const SUMMON_TIERS: readonly CombatTier[] = ['minion', 'grunt', 'elite'];

export const UNSTUNNABLE_TIERS: ReadonlySet<CombatTier> = new Set<CombatTier>(['boss', 'legendary']);

export const MP_BASE = 4;
export const MP_PER_LEVEL = 2;
export const MP_PER_CASTING_MOD = 2;
export const MP_MIN = 4;

export const SINGLE_TARGET_FORMS: ReadonlySet<FormId> = new Set<FormId>(['touch', 'projectile', 'dash']);
