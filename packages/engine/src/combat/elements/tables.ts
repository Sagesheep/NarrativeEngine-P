import type { ElementId, ElementPresetId, TileMarkId } from '../types';

export const ELEMENT_IDS: readonly ElementId[] = [
    'fire', 'water', 'earth', 'kinetic', 'lightning', 'ice', 'steel', 'light', 'darkness', 'slime', 'mental', 'lava', 'madness', 'almighty',
];

export const BURNING = 'burning';
export const SOAKED = 'soaked';
export const STAGGERED = 'staggered';
export const REVEALED = 'revealed';
export const BLINDED = 'blinded';
export const COATED = 'coated';
export const DAZED = 'dazed';
export const CONFUSED = 'confused';

export const ELEMENT_CONDITIONS: readonly string[] = [BURNING, SOAKED, STAGGERED, REVEALED, BLINDED, COATED, DAZED, CONFUSED];

export type ElementRiderId =
    | 'burning' | 'soaked' | 'shove' | 'staggered' | 'kinetic' | 'arc' | 'chilled' | 'revealed' | 'blinded' | 'sticky' | 'coated'
    | 'dazed' | 'confused';

export type ElementRow = {
    tier: 1 | 2 | 3;
    cost: number;
    riders: readonly ElementRiderId[];
    mark: TileMarkId | null;
    clears: TileMarkId | null;
    ignoresArmour?: number;
    saveAgainst?: 'WIS';
    dcBonus?: number;
    neutral?: boolean;
    mindlessImmune?: boolean;
};

export const ELEMENTS: Readonly<Record<ElementId, ElementRow>> = {
    fire: { tier: 1, cost: 1, riders: ['burning'], mark: 'flames', clears: null },
    water: { tier: 1, cost: 1, riders: ['soaked', 'shove'], mark: null, clears: 'flames' },
    earth: { tier: 1, cost: 1, riders: ['staggered'], mark: 'rubble', clears: null },
    kinetic: { tier: 1, cost: 1, riders: ['kinetic'], mark: null, clears: null },
    lightning: { tier: 2, cost: 1, riders: ['arc'], mark: null, clears: null },
    ice: { tier: 2, cost: 1, riders: ['chilled'], mark: 'slick', clears: null },
    steel: { tier: 2, cost: 1, riders: [], mark: null, clears: null, ignoresArmour: 2 },
    light: { tier: 2, cost: 1, riders: ['revealed'], mark: null, clears: 'dim' },
    darkness: { tier: 2, cost: 1, riders: ['blinded'], mark: 'dim', clears: null },
    slime: { tier: 2, cost: 1, riders: ['sticky', 'coated'], mark: 'sticky', clears: null },
    mental: { tier: 2, cost: 1, riders: ['dazed'], mark: null, clears: null, saveAgainst: 'WIS', dcBonus: 3, mindlessImmune: true },
    lava: { tier: 3, cost: 2, riders: ['burning', 'staggered'], mark: 'molten', clears: null },
    madness: { tier: 3, cost: 1, riders: ['confused'], mark: null, clears: null, mindlessImmune: true },
    almighty: { tier: 3, cost: 2, riders: [], mark: null, clears: null, neutral: true },
};

export const ELEMENT_NUMBERS = {
    weakFactor: 1.5,
    resistFactor: 0.5,
    burnTurns: 2,
    burnDamage: 1,
    soakedTurns: 2,
    shoveSquares: 1,
    staggerTurns: 1,
    staggerLoss: 2,
    kineticSquares: 1,
    impactDie: 4,
    arcShare: 0.5,
    chillTurns: 1,
    revealTurns: 2,
    coverShare: 0.5,
    blindTurns: 2,
    blindPenalty: 2,
    stickyTurns: 1,
    coatTurns: 2,
    coatPenalty: 1,
    dazeTurns: 1,
    confuseTurns: 1,
} as const;

export const SOAKED_WEAK_TO: readonly ElementId[] = ['lightning', 'ice'];

export type ConditionRiderSpec = { condition: string; turns: number; word: string; tag?: ElementId };

export type ConditionRiderId = 'burning' | 'soaked' | 'staggered' | 'chilled' | 'revealed' | 'blinded' | 'sticky' | 'coated' | 'dazed' | 'confused';

export const CONDITION_RIDERS: Readonly<Record<ConditionRiderId, ConditionRiderSpec>> = {
    burning: { condition: BURNING, turns: ELEMENT_NUMBERS.burnTurns, word: 'burning' },
    soaked: { condition: SOAKED, turns: ELEMENT_NUMBERS.soakedTurns, word: 'soaked' },
    staggered: { condition: STAGGERED, turns: ELEMENT_NUMBERS.staggerTurns, word: 'staggered' },
    chilled: { condition: 'slowed', turns: ELEMENT_NUMBERS.chillTurns, word: 'chilled', tag: 'ice' },
    revealed: { condition: REVEALED, turns: ELEMENT_NUMBERS.revealTurns, word: 'revealed' },
    blinded: { condition: BLINDED, turns: ELEMENT_NUMBERS.blindTurns, word: 'blinded' },
    sticky: { condition: 'slowed', turns: ELEMENT_NUMBERS.stickyTurns, word: 'stuck fast', tag: 'slime' },
    coated: { condition: COATED, turns: ELEMENT_NUMBERS.coatTurns, word: 'coated in slime' },
    dazed: { condition: DAZED, turns: ELEMENT_NUMBERS.dazeTurns, word: 'dazed' },
    confused: { condition: CONFUSED, turns: ELEMENT_NUMBERS.confuseTurns, word: 'confused' },
};

export const ELEMENT_PRESETS: Readonly<Record<ElementPresetId, readonly ElementId[]>> = {
    all: ELEMENT_IDS,
    fantasy: ['fire', 'water', 'earth', 'lightning', 'ice', 'lava', 'steel', 'darkness', 'light', 'almighty', 'slime'],
    modern: ['kinetic', 'fire', 'lightning', 'ice', 'steel', 'slime', 'mental', 'madness'],
};

export const ELEMENT_PRESET_IDS: readonly ElementPresetId[] = ['all', 'fantasy', 'modern'];

export const DEFAULT_ELEMENT_PRESET: ElementPresetId = 'all';

export const ELEMENT_WORDS: Readonly<Record<string, ElementId>> = {
    fire: 'fire', flame: 'fire', flames: 'fire', heat: 'fire',
    water: 'water', wet: 'water',
    earth: 'earth', stone: 'earth',
    kinetic: 'kinetic', impact: 'kinetic',
    lightning: 'lightning', electric: 'lightning', electricity: 'lightning', shock: 'lightning', thunder: 'lightning',
    ice: 'ice', cold: 'ice', frost: 'ice',
    steel: 'steel',
    light: 'light', radiant: 'light',
    darkness: 'darkness', dark: 'darkness', shadow: 'darkness', necrotic: 'darkness',
    slime: 'slime', ooze: 'slime',
    mental: 'mental', psychic: 'mental',
    lava: 'lava', magma: 'lava',
    madness: 'madness',
    almighty: 'almighty',
};

export const MINDLESS_KINDS: ReadonlySet<string> = new Set([
    'construct', 'golem', 'undead', 'zombie', 'skeleton', 'robot', 'machine', 'drone', 'automaton', 'turret', 'mech', 'ooze', 'slime', 'jelly',
]);

export const RIDER_VALUE: Readonly<Record<ElementRiderId, number>> = {
    burning: 4,
    soaked: 1.5,
    shove: 0.5,
    staggered: 1,
    kinetic: 1,
    arc: 0,
    chilled: 1.5,
    revealed: 1,
    blinded: 2,
    sticky: 1.5,
    coated: 1.5,
    dazed: 1.5,
    confused: 2.5,
};

export const ELEMENT_EVENT_TYPES: readonly string[] = ['element_rider', 'burn', 'confused'];
