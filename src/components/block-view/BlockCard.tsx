import { Lock, Hand, Unplug } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { Block } from './blockModel';

/**
 * One block in the chain. Renders metadata only — no feature names are read or compared
 * here (the §4 / §8 hard failure condition). The switch is wired iff `block.switchable`;
 * locked (structural), manual (button-fired), and unwired (no call site) blocks render
 * in the same visual class with a reason badge distinguishing them.
 */
interface BlockCardProps {
    block: Block;
    enabled: boolean;
    onToggle: (id: string, enabled: boolean) => void;
}

export function BlockCard({ block, enabled, onToggle }: BlockCardProps) {
    const { t } = useTranslation();

    const isModel = block.kind === 'model';
    const locked = !block.switchable;

    // The toggle is the WRITE side — exactly the ExtensionsTab path: writes an explicit
    // entry into `moduleEnabled`, which `isBlockEnabled` resolves on the next read.
    const handleToggle = () => {
        if (locked) return;
        onToggle(block.id, !enabled);
    };

    const badge = locked
        ? block.lockReason === 'manual'
            ? t('blockview.badge.manual')
            : block.lockReason === 'unwired'
                ? t('blockview.badge.unwired')
                : t('blockview.badge.locked')
        : enabled
            ? t('blockview.badge.on')
            : t('blockview.badge.off');

    // Visual class follows the TURN_GRAPH language (WO-P5-02 §2): ENGINE = ember border,
    // MODEL = terminal border. Locked blocks get a dashed border; off blocks are dimmed.
    const borderClass = isModel
        ? 'border-terminal'
        : 'border-ember';
    const bgClass = locked
        ? 'bg-transparent'
        : enabled
            ? isModel ? 'bg-terminal-wash' : 'bg-ember-wash'
            : 'bg-surface opacity-60';
    const borderStyleClass = locked ? 'border-dashed' : 'border-solid';

    // Icon + label for the lock indicator, by reason.
    const lockIcon = block.lockReason === 'manual'
        ? <Hand size={10} />
        : block.lockReason === 'unwired'
            ? <Unplug size={10} />
            : <Lock size={10} />;
    const lockLabel = block.lockReason === 'manual'
        ? t('blockview.badge.manual')
        : block.lockReason === 'unwired'
            ? t('blockview.badge.unwired')
            : t('blockview.badge.locked');

    return (
        <div
            className={`relative flex flex-col gap-1.5 p-2.5 border ${borderClass} ${borderStyleClass} ${bgClass} rounded w-[180px] shrink-0 transition-opacity`}
            data-block-id={block.id}
            data-source={block.source}
            data-kind={block.kind}
            data-switchable={block.switchable ? 'true' : 'false'}
            data-enabled={enabled ? 'true' : 'false'}
        >
            {/* Badge row: ENGINE/MODEL + on/off/locked/manual/unwired */}
            <div className="flex items-center justify-between gap-1">
                <span className={`font-mono text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 border ${isModel ? 'border-terminal text-terminal-ink bg-terminal-wash' : 'border-ember text-ember-ink bg-ember-wash'}`}>
                    {isModel ? 'MODEL' : 'ENGINE'}
                </span>
                <span className={`font-mono text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 border ${locked ? 'border-border-strong text-text-dim' : enabled ? 'border-terminal text-terminal' : 'border-border text-text-dim'}`}>
                    {badge}
                </span>
            </div>

            {/* Name + description from registry metadata */}
            <p className="font-mono text-[11px] font-semibold text-text-primary leading-tight break-words">
                {block.name}
            </p>
            <p className="text-[9px] text-text-dim leading-tight break-words">
                {block.description}
            </p>

            {block.meta && (
                <p className="text-[8px] text-text-dim/70 font-mono leading-tight break-words">
                    {block.meta}
                </p>
            )}

            {/* Switch or lock indicator */}
            {locked ? (
                <div className="flex items-center gap-1 mt-0.5 text-[9px] text-text-dim">
                    {lockIcon}
                    <span className="font-mono uppercase tracking-wider">
                        {lockLabel}
                    </span>
                </div>
            ) : (
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={t('blockview.toggle.aria', { name: block.name })}
                    onClick={handleToggle}
                    className={`flex items-center gap-1 mt-0.5 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${enabled ? 'border-terminal text-terminal bg-terminal/10 hover:bg-terminal/20' : 'border-border text-text-dim bg-surface hover:border-terminal hover:text-terminal'}`}
                >
                    <span className={`inline-block w-2 h-2 rounded-full ${enabled ? 'bg-terminal' : 'bg-text-dim/40'}`} />
                    {enabled ? t('blockview.badge.on') : t('blockview.badge.off')}
                </button>
            )}
        </div>
    );
}