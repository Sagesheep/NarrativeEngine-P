import type { TranslationKey } from '../../../i18n/locales/en';
import type { AugmentId, EffectId, FormId } from '../../../types';

export const FORM_LABEL_KEYS: Readonly<Record<FormId, TranslationKey>> = {
    touch: 'combat.glyph.form.touch',
    projectile: 'combat.glyph.form.projectile',
    self: 'combat.glyph.form.self',
    line: 'combat.glyph.form.line',
    cone: 'combat.glyph.form.cone',
    burst: 'combat.glyph.form.burst',
    dash: 'combat.glyph.form.dash',
};

export const EFFECT_LABEL_KEYS: Readonly<Record<EffectId, TranslationKey>> = {
    damage: 'combat.glyph.effect.damage',
    heal: 'combat.glyph.effect.heal',
    shield: 'combat.glyph.effect.shield',
    push: 'combat.glyph.effect.push',
    pull: 'combat.glyph.effect.pull',
    stun: 'combat.glyph.effect.stun',
    slow: 'combat.glyph.effect.slow',
    haste: 'combat.glyph.effect.haste',
    blink: 'combat.glyph.effect.blink',
    swap: 'combat.glyph.effect.swap',
    barrier: 'combat.glyph.effect.barrier',
    drain: 'combat.glyph.effect.drain',
    summon: 'combat.glyph.effect.summon',
};

export const AUGMENT_LABEL_KEYS: Readonly<Record<AugmentId, TranslationKey>> = {
    amplify: 'combat.glyph.augment.amplify',
    widen: 'combat.glyph.augment.widen',
    extend: 'combat.glyph.augment.extend',
    pierce: 'combat.glyph.augment.pierce',
    split: 'combat.glyph.augment.split',
    quicken: 'combat.glyph.augment.quicken',
};

export const CONDITION_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
    stunned: 'combat.cond.stunned',
    slowed: 'combat.cond.slowed',
    hasted: 'combat.cond.hasted',
    shielded: 'combat.cond.shielded',
    defending: 'combat.cond.defending',
};
