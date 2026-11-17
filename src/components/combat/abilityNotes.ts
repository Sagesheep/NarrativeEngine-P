import type { TranslateKey, TranslateVars } from '../../i18n';
import type { ElementId } from '@narrative/engine';
import type { Combatant } from '../../types';
import { CONDITION_LABEL_KEYS } from '../character/tabs/glyphLabels';
import { elementName, isElement } from './elementText';

type T = (key: TranslateKey, vars?: TranslateVars) => string;

function conditionLabel(id: string, t: T): string {
    const k = CONDITION_LABEL_KEYS[id];
    return k ? t(k) : id;
}

export function taggedCondition(id: string, element: unknown): string {
    if (id === 'slowed' && element === 'ice') return 'chilled';
    if (id === 'slowed' && element === 'slime') return 'stuck';
    return id;
}

export function combatantNotes(c: Combatant, label: string, t: T): string[] {
    const notes: string[] = [];
    if (typeof c.maxMp === 'number') notes.push(t('combat.bar.mp', { label, current: c.mp ?? 0, max: c.maxMp }));
    if ((c.tempHp ?? 0) > 0) notes.push(t('combat.board.tempHp', { temp: c.tempHp as number }));
    for (const cond of c.conditions) {
        if (typeof cond.turns === 'number') notes.push(t('combat.cond.turns', { name: conditionLabel(taggedCondition(cond.id, cond.element), t), turns: cond.turns }));
    }
    if (c.summonerId && typeof c.expiresRound === 'number') notes.push(t('combat.board.summon', { round: c.expiresRound }));
    notes.push(...elementNotes(c, t));
    return notes;
}

export function elementNotes(c: Pick<Combatant, 'weak' | 'resist' | 'immune' | 'mindless'>, t: T): string[] {
    const notes: string[] = [];
    const list = (values: readonly ElementId[] | undefined) => (values ?? []).filter(isElement).map(e => elementName(e, t)).join(', ');
    if (c.weak && c.weak.length > 0) notes.push(t('combat.inspect.weak', { list: list(c.weak) }));
    if (c.resist && c.resist.length > 0) notes.push(t('combat.inspect.resist', { list: list(c.resist) }));
    if (c.immune && c.immune.length > 0) notes.push(t('combat.inspect.immune', { list: list(c.immune) }));
    if (c.mindless === true) notes.push(t('combat.inspect.mindless'));
    return notes;
}
