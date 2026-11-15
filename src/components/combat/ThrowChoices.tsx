import { useTranslation } from '../../i18n/useTranslation';
import type { ThrowAim } from './useAbilityAim';

const chip = 'border border-border bg-surface text-text-primary text-[11px] font-mono px-2 py-1 rounded-sm hover:bg-void-lighter outline-none focus-visible:ring-1 focus-visible:ring-terminal';

export function ThrowChoices({
    throwing,
    itemsOpen,
    onItems,
    onBack,
}: {
    throwing: ThrowAim;
    itemsOpen: boolean;
    onItems: (open: boolean) => void;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    if (throwing.step === 2) {
        return (
            <div data-testid="combat-throw-choices" role="group" aria-label={t('combat.throw.step2Label', { name: throwing.payloadName ?? '' })} className="absolute left-2 bottom-2 z-10 flex items-center gap-2">
                <span className="text-[11px] font-mono text-text-dim">{t('combat.throw.holding', { name: throwing.payloadName ?? '' })}</span>
                <button type="button" data-testid="combat-throw-back" onClick={onBack} className={chip}>{t('combat.throw.back')}</button>
            </div>
        );
    }
    const hand = throwing.hand;
    return (
        <div data-testid="combat-throw-choices" role="group" aria-label={t('combat.throw.step1Label')} className="absolute left-2 bottom-2 z-10 flex flex-col items-start gap-1">
            {itemsOpen && (
                <div data-testid="combat-throw-item-list" role="group" aria-label={t('combat.throw.itemsLabel')} className="flex flex-col items-start gap-1">
                    {throwing.items.map((item, index) => (
                        <button
                            key={item.payload.kind === 'item' ? item.payload.itemId : item.name}
                            type="button"
                            data-testid={`combat-throw-item-${item.payload.kind === 'item' ? item.payload.itemId : index}`}
                            autoFocus={index === 0}
                            onClick={() => {
                                throwing.choose(item.payload);
                                onItems(false);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onItems(false);
                                }
                            }}
                            className={chip}
                        >
                            {item.name}
                        </button>
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    data-testid="combat-throw-items"
                    aria-expanded={itemsOpen}
                    aria-keyshortcuts="I"
                    disabled={throwing.items.length === 0}
                    title={throwing.items.length === 0 ? t('combat.throw.noItems') : undefined}
                    onClick={() => onItems(!itemsOpen)}
                    className={`${chip} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                    {t('combat.throw.items')}
                </button>
                {hand && (
                    <button
                        type="button"
                        data-testid="combat-throw-hand"
                        aria-keyshortcuts="W"
                        onClick={() => throwing.choose(hand.payload)}
                        className={chip}
                    >
                        {t('combat.throw.hand')}
                    </button>
                )}
            </div>
        </div>
    );
}
