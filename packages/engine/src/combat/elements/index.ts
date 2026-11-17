export {
    ELEMENT_IDS, ELEMENTS, ELEMENT_NUMBERS, ELEMENT_PRESETS, ELEMENT_PRESET_IDS, DEFAULT_ELEMENT_PRESET, ELEMENT_WORDS, MINDLESS_KINDS,
    SOAKED_WEAK_TO, CONDITION_RIDERS, RIDER_VALUE, ELEMENT_EVENT_TYPES, ELEMENT_CONDITIONS,
    BURNING, SOAKED, STAGGERED, REVEALED, BLINDED, COATED, DAZED, CONFUSED,
} from './tables';
export type { ElementRow, ElementRiderId, ConditionRiderId, ConditionRiderSpec } from './tables';
export {
    isElementId, elementOfWord, normalizePreset, elementsFor, inPreset, checkElement, filterElements, abilityElement, abilityDamageType,
    stripElement, setElement, elementCost, isSoaked, weakSet, resistSet, isMindless, isImmune, elementMultiplier, blindPenalty, revealedCover,
    scaleDamage, describeElement,
} from './rules';
export type { ElementFactor, ElementDropReason, ElementFilter } from './rules';
export { undoElementEvent } from './undo';
export {
    TILE_MARK_IDS, TILE_MARKS, MARK_FORMS, MARK_EVENT_TYPES, REACTIONS, markRow, tileReactions, conditionReactions,
} from './marks';
export type { MarkRow, MarkHarm, ReactionRow, ReactionEffect, ReactionTrigger } from './marks';
