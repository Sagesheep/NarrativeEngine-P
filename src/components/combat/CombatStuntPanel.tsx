import { useState } from 'react';
import type { FormEvent } from 'react';
import { Dices, Loader2 } from 'lucide-react';
import type { TranslationKey } from '../../i18n/locales/en';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatSession, StuntDifficulty, StuntOutcome } from '../../types';
import {
    backFromStunt, cancelStunt, canStunt, rollStunt, STUNT_WORDS_MAX, stuntParts, submitStunt,
} from '../../services/combat/combatStunt';
import type { StuntPartView } from '../../services/combat/combatStunt';

const OUTCOME_KEYS: Readonly<Record<StuntOutcome, TranslationKey>> = {
    hurt: 'combat.stunt.part.hurt',
    push: 'combat.stunt.part.push',
    pull: 'combat.stunt.part.pull',
    slow: 'combat.stunt.part.slow',
    stun: 'combat.stunt.part.stun',
    move: 'combat.stunt.part.move',
    cover: 'combat.stunt.part.cover',
    hurt_area: 'combat.stunt.part.hurtArea',
};

const DIFFICULTY_KEYS: Readonly<Record<StuntDifficulty, TranslationKey>> = {
    easy: 'combat.stunt.difficulty.easy',
    moderate: 'combat.stunt.difficulty.moderate',
    hard: 'combat.stunt.difficulty.hard',
    very_hard: 'combat.stunt.difficulty.veryHard',
    impossible: 'combat.stunt.difficulty.impossible',
};

const buttonClass = 'flex items-center gap-1 border border-border text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-sm text-text-primary hover:bg-void-lighter disabled:opacity-40 disabled:cursor-not-allowed';

function partText(t: ReturnType<typeof useTranslation>['t'], p: StuntPartView): string {
    return t(OUTCOME_KEYS[p.outcome], {
        target: p.target ?? '',
        squares: p.squares ?? 0,
        count: p.count ?? 0,
        caught: (p.caught ?? []).join(', '),
        type: p.damageType ?? '',
    });
}

export function CombatStuntPanel({ session, busy, open, onClose }: { session: CombatSession; busy: boolean; open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const pending = session.stunt;

    if (pending?.stage === 'rating') {
        return (
            <div data-testid="combat-stunt-rating" className="basis-full flex items-center gap-2 text-[11px] font-mono text-text-dim">
                <Loader2 size={12} className="animate-spin" /> {t('combat.stunt.rating')}
                <button type="button" data-testid="combat-stunt-cancel" onClick={cancelStunt} className={`${buttonClass} ml-2`}>{t('combat.stunt.cancel')}</button>
            </div>
        );
    }

    if (pending?.stage === 'verdict' && pending.spec) {
        const parts = stuntParts(session.state, pending.actorId, pending.spec);
        return (
            <div data-testid="combat-stunt-verdict" role="group" aria-label={t('combat.stunt.verdictTitle')} className="basis-full flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
                <span className="text-[11px] uppercase tracking-wider text-text-dim">{t('combat.stunt.verdictTitle')}</span>
                <ul className="text-[12px] text-text-primary list-disc pl-4">
                    {parts.map((p, i) => <li key={`${p.outcome}-${i}`}>{partText(t, p)}</li>)}
                </ul>
                <span data-testid="combat-stunt-odds" className="text-[12px] text-text-primary">
                    {t('combat.stunt.odds', { ability: pending.spec.ability, difficulty: t(DIFFICULTY_KEYS[pending.difficulty ?? 'hard']) })}
                </span>
                {parts.length > 1 && <span className="text-[11px] text-text-dim">{t('combat.stunt.combined')}</span>}
                <div className="flex items-center gap-2">
                    <button type="button" data-testid="combat-stunt-roll" onClick={() => { void rollStunt(); onClose(); }} className={`${buttonClass} border-terminal/50 text-terminal`}>
                        <Dices size={12} /> {t('combat.stunt.roll')}
                    </button>
                    <button type="button" data-testid="combat-stunt-back" onClick={backFromStunt} className={buttonClass}>{t('combat.stunt.back')}</button>
                </div>
            </div>
        );
    }

    if (!open || !canStunt(session, busy)) return null;

    const send = (e?: FormEvent) => {
        e?.preventDefault();
        const words = text.trim();
        if (!words) return;
        void submitStunt(words);
    };

    return (
        <form data-testid="combat-stunt-form" onSubmit={send} className="basis-full flex flex-col gap-1.5">
            <span className="text-[11px] text-text-dim">{t('combat.stunt.help')}</span>
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    data-testid="combat-stunt-input"
                    value={text}
                    maxLength={STUNT_WORDS_MAX}
                    autoFocus
                    onChange={(e) => setText(e.target.value.replace(/[\r\n]+/g, ' '))}
                    onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
                    placeholder={t('combat.stunt.placeholder')}
                    aria-label={t('combat.stunt.label')}
                    className="flex-1 min-w-[12rem] bg-surface border border-border px-2 py-1 text-[12px] text-text-primary rounded-sm focus:border-terminal outline-none"
                />
                <button type="submit" data-testid="combat-stunt-send" disabled={!text.trim()} className={buttonClass}>{t('combat.stunt.send')}</button>
                <button type="button" onClick={onClose} className={buttonClass}>{t('combat.stunt.close')}</button>
            </div>
        </form>
    );
}
