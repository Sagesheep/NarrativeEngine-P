import {
    ArrowLeftRight, ArrowRightToLine, ArrowUpFromLine, BrickWall, ChevronsRight, ChevronsUp, Cone, Crosshair, Droplet, Expand,
    FastForward, Flame, Ghost, Hand, HandHelping, Heart, Magnet, MoveRight, Rabbit, Ruler, Shield, ShieldHalf, Snail, Sparkle, Split,
    Swords, UnfoldHorizontal, User, Wind, Zap, ArrowBigUpDash,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AugmentId, EffectId, FormId } from '../../types';

export type GlyphKind = 'form' | 'effect' | 'augment';

export const FORM_ICONS: Readonly<Record<FormId, LucideIcon>> = {
    touch: Hand,
    projectile: Crosshair,
    self: User,
    line: MoveRight,
    cone: Cone,
    burst: Expand,
    dash: ChevronsRight,
};

export const EFFECT_ICONS: Readonly<Record<EffectId, LucideIcon>> = {
    damage: Flame,
    heal: Heart,
    shield: Shield,
    push: ArrowUpFromLine,
    pull: Magnet,
    stun: Zap,
    slow: Snail,
    haste: Rabbit,
    blink: Sparkle,
    swap: ArrowLeftRight,
    barrier: BrickWall,
    drain: Droplet,
    summon: Ghost,
    weapon: Swords,
    guard: ShieldHalf,
    sprint: Wind,
    leap: ArrowBigUpDash,
    rally: HandHelping,
};

export const AUGMENT_ICONS: Readonly<Record<AugmentId, LucideIcon>> = {
    amplify: ChevronsUp,
    widen: UnfoldHorizontal,
    extend: Ruler,
    pierce: ArrowRightToLine,
    split: Split,
    quicken: FastForward,
};

export function iconFor(kind: GlyphKind, id: string): LucideIcon {
    const map: Readonly<Record<string, LucideIcon>> = kind === 'form' ? FORM_ICONS : kind === 'effect' ? EFFECT_ICONS : AUGMENT_ICONS;
    return map[id] ?? Flame;
}

export const KIND_COLOR_VARS: Readonly<Record<GlyphKind, string>> = {
    form: 'var(--glyph-form)',
    effect: 'var(--glyph-effect)',
    augment: 'var(--glyph-augment)',
};
