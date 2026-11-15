import type { ThrowPlan } from '@narrative/engine';
import type { TranslateKey, TranslateVars } from '../../i18n';
import type { TranslationKey } from '../../i18n/locales/en';
import type { CombatState } from '../../types';

export const THROW_REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
    'too heavy to lift': 'combat.throw.tooHeavy',
    'nothing to throw there': 'combat.throw.nothing',
    'no square to throw it to': 'combat.throw.noLanding',
    'a willing ally cannot be thrown onto a hazard': 'combat.throw.allyHazard',
    'the thrower is stunned': 'combat.throw.stunned',
    'out of range': 'combat.throw.outOfRange',
    'no line of sight': 'combat.throw.noSight',
    'the square is not open ground': 'combat.throw.notOpen',
    'out of reach': 'combat.throw.nothing',
    'that item is not carried': 'combat.throw.nothing',
};

export function throwReasonKey(reason: string | undefined): TranslationKey {
    return (reason && THROW_REASON_KEYS[reason]) || 'combat.throw.notOpen';
}

type Translate = (key: TranslateKey, vars?: TranslateVars) => string;

export function describeThrowPlan(plan: ThrowPlan, state: CombatState, t: Translate): string {
    const target = plan.struckId ? state.combatants[plan.struckId]?.name ?? '' : '';
    const parts = [
        target ? t('combat.throw.landHit', { name: plan.name, target }) : t('combat.throw.landPreview', { name: plan.name }),
    ];
    if (plan.displaced) parts.push(t('combat.throw.landNear'));
    if (plan.hazard) parts.push(t('combat.throw.landHazard'));
    if (plan.terrain.some(c => c.to === 'difficult')) parts.push(t('combat.throw.landRubble'));
    return parts.join(' ');
}
