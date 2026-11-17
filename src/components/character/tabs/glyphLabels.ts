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
    sigil: 'combat.glyph.form.sigil',
    mantle: 'combat.glyph.form.mantle',
    chain: 'combat.glyph.form.chain',
    wall: 'combat.glyph.form.wall',
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
    weapon: 'combat.glyph.effect.weapon',
    guard: 'combat.glyph.effect.guard',
    sprint: 'combat.glyph.effect.sprint',
    leap: 'combat.glyph.effect.leap',
    rally: 'combat.glyph.effect.rally',
    hurl: 'combat.glyph.effect.hurl',
    snare: 'combat.glyph.effect.snare',
    dispel: 'combat.glyph.effect.dispel',
    gravity: 'combat.glyph.effect.gravity',
    fear: 'combat.glyph.effect.fear',
    decay: 'combat.glyph.effect.decay',
    vanish: 'combat.glyph.effect.vanish',
    rewind: 'combat.glyph.effect.rewind',
};

export const AUGMENT_LABEL_KEYS: Readonly<Record<AugmentId, TranslationKey>> = {
    amplify: 'combat.glyph.augment.amplify',
    widen: 'combat.glyph.augment.widen',
    extend: 'combat.glyph.augment.extend',
    pierce: 'combat.glyph.augment.pierce',
    split: 'combat.glyph.augment.split',
    quicken: 'combat.glyph.augment.quicken',
    dampen: 'combat.glyph.augment.dampen',
    sustain: 'combat.glyph.augment.sustain',
    delay: 'combat.glyph.augment.delay',
};

export const CONDITION_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
    stunned: 'combat.cond.stunned',
    slowed: 'combat.cond.slowed',
    hasted: 'combat.cond.hasted',
    shielded: 'combat.cond.shielded',
    defending: 'combat.cond.defending',
    burning: 'combat.cond.burning',
    soaked: 'combat.cond.soaked',
    staggered: 'combat.cond.staggered',
    revealed: 'combat.cond.revealed',
    blinded: 'combat.cond.blinded',
    coated: 'combat.cond.coated',
    dazed: 'combat.cond.dazed',
    confused: 'combat.cond.confused',
    snared: 'combat.cond.snared',
    feared: 'combat.cond.feared',
    vanished: 'combat.cond.vanished',
    chilled: 'combat.cond.chilled',
    stuck: 'combat.cond.stuck',
};

export const FORM_DESC_KEYS: Readonly<Record<FormId, TranslationKey>> = {
    touch: 'combat.glyph.desc.form.touch',
    projectile: 'combat.glyph.desc.form.projectile',
    self: 'combat.glyph.desc.form.self',
    line: 'combat.glyph.desc.form.line',
    cone: 'combat.glyph.desc.form.cone',
    burst: 'combat.glyph.desc.form.burst',
    dash: 'combat.glyph.desc.form.dash',
    sigil: 'combat.glyph.desc.form.sigil',
    mantle: 'combat.glyph.desc.form.mantle',
    chain: 'combat.glyph.desc.form.chain',
    wall: 'combat.glyph.desc.form.wall',
};

export const EFFECT_DESC_KEYS: Readonly<Record<EffectId, TranslationKey>> = {
    damage: 'combat.glyph.desc.effect.damage',
    heal: 'combat.glyph.desc.effect.heal',
    shield: 'combat.glyph.desc.effect.shield',
    push: 'combat.glyph.desc.effect.push',
    pull: 'combat.glyph.desc.effect.pull',
    stun: 'combat.glyph.desc.effect.stun',
    slow: 'combat.glyph.desc.effect.slow',
    haste: 'combat.glyph.desc.effect.haste',
    blink: 'combat.glyph.desc.effect.blink',
    swap: 'combat.glyph.desc.effect.swap',
    barrier: 'combat.glyph.desc.effect.barrier',
    drain: 'combat.glyph.desc.effect.drain',
    summon: 'combat.glyph.desc.effect.summon',
    weapon: 'combat.glyph.desc.effect.weapon',
    guard: 'combat.glyph.desc.effect.guard',
    sprint: 'combat.glyph.desc.effect.sprint',
    leap: 'combat.glyph.desc.effect.leap',
    rally: 'combat.glyph.desc.effect.rally',
    hurl: 'combat.glyph.desc.effect.hurl',
    snare: 'combat.glyph.desc.effect.snare',
    dispel: 'combat.glyph.desc.effect.dispel',
    gravity: 'combat.glyph.desc.effect.gravity',
    fear: 'combat.glyph.desc.effect.fear',
    decay: 'combat.glyph.desc.effect.decay',
    vanish: 'combat.glyph.desc.effect.vanish',
    rewind: 'combat.glyph.desc.effect.rewind',
};

export const AUGMENT_DESC_KEYS: Readonly<Record<AugmentId, TranslationKey>> = {
    amplify: 'combat.glyph.desc.augment.amplify',
    widen: 'combat.glyph.desc.augment.widen',
    extend: 'combat.glyph.desc.augment.extend',
    pierce: 'combat.glyph.desc.augment.pierce',
    split: 'combat.glyph.desc.augment.split',
    quicken: 'combat.glyph.desc.augment.quicken',
    dampen: 'combat.glyph.desc.augment.dampen',
    sustain: 'combat.glyph.desc.augment.sustain',
    delay: 'combat.glyph.desc.augment.delay',
};

export function glyphLabelKey(glyph: { kind: 'form' | 'effect' | 'augment'; id: string }): TranslationKey {
    if (glyph.kind === 'form') return FORM_LABEL_KEYS[glyph.id as FormId];
    if (glyph.kind === 'effect') return EFFECT_LABEL_KEYS[glyph.id as EffectId];
    return AUGMENT_LABEL_KEYS[glyph.id as AugmentId];
}

export function glyphDescriptionKey(glyph: { kind: 'form' | 'effect' | 'augment'; id: string }): TranslationKey {
    if (glyph.kind === 'form') return FORM_DESC_KEYS[glyph.id as FormId];
    if (glyph.kind === 'effect') return EFFECT_DESC_KEYS[glyph.id as EffectId];
    return AUGMENT_DESC_KEYS[glyph.id as AugmentId];
}
