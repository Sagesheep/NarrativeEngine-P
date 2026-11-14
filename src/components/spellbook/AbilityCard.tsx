import type { HTMLAttributes, ReactNode } from 'react';
import { Check } from 'lucide-react';
import { abilitySlot, describeAbility } from '@narrative/engine';
import type { CasterStats } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { costOf } from '../../services/combat/spellbook';
import type { GlyphAbility } from '../../types';
import { GlyphStrip } from './GlyphStrip';

export function AbilityCard({
    ability, stats, label, selected = false, equipped = false, notice = null, showRules = false, onSelect, actions, testId, dragProps, slotKey,
    title, rulesText, costText,
}: {
    ability: GlyphAbility;
    title?: string;
    rulesText?: string;
    costText?: string;
    stats: CasterStats;
    label: string;
    selected?: boolean;
    equipped?: boolean;
    notice?: string | null;
    showRules?: boolean;
    onSelect?: () => void;
    actions?: ReactNode;
    testId?: string;
    dragProps?: HTMLAttributes<HTMLDivElement>;
    slotKey?: number;
}) {
    const { t } = useTranslation();
    const bonus = abilitySlot(ability) === 'bonus';
    const body = (
        <>
            <span className="flex items-start justify-between gap-3 w-full">
                <span className="text-sm font-bold text-text-primary break-words min-w-0">{title ?? ability.name}</span>
                <span className="shrink-0 text-xs font-mono text-terminal whitespace-nowrap">{costText ?? t('combat.spellbook.cost', { cost: costOf(ability), label })}</span>
            </span>
            <GlyphStrip ability={ability} />
            <span className="flex items-center gap-2 flex-wrap text-xs text-text-dim">
                {slotKey ? <span className="font-mono border border-border rounded px-1.5 py-0.5">{slotKey}</span> : null}
                <span>{t(bonus ? 'combat.spellbook.bonus' : 'spellbook.action')}</span>
                {equipped && <span className="inline-flex items-center gap-1 text-terminal"><Check size={12} aria-hidden="true" />{t('combat.spellbook.equip')}</span>}
            </span>
            {showRules && <span className="block text-xs text-text-dim leading-relaxed">{rulesText ?? describeAbility(ability, stats)}</span>}
            {showRules && ability.description && <span className="block text-xs text-text-dim italic leading-relaxed">{ability.description}</span>}
        </>
    );
    const frame = 'flex flex-col gap-2 w-full text-left';
    return (
        <div
            data-testid={testId}
            data-selected={selected}
            {...dragProps}
            className={`rounded-lg border p-3 flex flex-col gap-2 transition-colors ${selected ? 'border-terminal bg-terminal/10' : 'border-border bg-void hover:border-text-dim/50'}`}
        >
            {onSelect
                ? <button type="button" onClick={onSelect} aria-pressed={selected} className={`${frame} cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-terminal`}>{body}</button>
                : <div className={frame}>{body}</div>}
            {notice && <p className="text-xs text-danger leading-relaxed">{notice}</p>}
            {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
    );
}
