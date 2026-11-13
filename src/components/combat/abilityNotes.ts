import type { TranslateKey, TranslateVars } from '../../i18n';
import type { Combatant } from '../../types';
import { CONDITION_LABEL_KEYS } from '../character/tabs/glyphLabels';

type T = (key: TranslateKey, vars?: TranslateVars) => string;

function conditionLabel(id: string, t: T): string {
    const k = CONDITION_LABEL_KEYS[id];
    return k ? t(k) : id;
}

export function combatantNotes(c: Combatant, label: string, t: T): string[] {
    const notes: string[] = [];
    if (typeof c.maxMp === 'number') notes.push(t('combat.bar.mp', { label, current: c.mp ?? 0, max: c.maxMp }));
    if ((c.tempHp ?? 0) > 0) notes.push(t('combat.board.tempHp', { temp: c.tempHp as number }));
    for (const cond of c.conditions) {
        if (typeof cond.turns === 'number') notes.push(t('combat.cond.turns', { name: conditionLabel(cond.id, t), turns: cond.turns }));
    }
    if (c.summonerId && typeof c.expiresRound === 'number') notes.push(t('combat.board.summon', { round: c.expiresRound }));
    return notes;
}
