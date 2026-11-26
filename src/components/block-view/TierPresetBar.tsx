import { RotateCcw } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { AiTier } from '../../types';

/**
 * WO-P5-02 §6 — the lite / pro / max preset switcher.
 *
 * Selecting a preset writes the preset's positions into `moduleEnabled` as EXPLICIT values
 * — it does not silently change `aiTier`. Rationale (the work order): after WO-P5-01 an
 * explicit entry beats the preset, so writing them explicitly is what makes the view's
 * display match what the turn will actually do. The active `aiTier` is shown read-only.
 */
interface TierPresetBarProps {
    aiTier: AiTier;
    onApply: (tier: AiTier) => void;
    onClear: () => void;
    hasOverrides: boolean;
}

const TIERS: AiTier[] = ['lite', 'pro', 'max'];

export function TierPresetBar({ aiTier, onApply, onClear, hasOverrides }: TierPresetBarProps) {
    const { t } = useTranslation();

    return (
        <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
                    {t('blockview.tier.label')}
                </span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-terminal px-1.5 py-0.5 border border-terminal/40 bg-terminal/10 rounded">
                    {aiTier}
                </span>
                <span className="text-[9px] text-text-dim/70 italic">
                    {t('blockview.tier.help')}
                </span>
            </div>

            <div className="flex items-center gap-2 ml-auto">
                <span className="font-mono text-[9px] uppercase tracking-wider text-text-dim">
                    {t('blockview.preset.label')}
                </span>
                <div className="flex items-center gap-1">
                    {TIERS.map((tier) => (
                        <button
                            key={tier}
                            type="button"
                            onClick={() => onApply(tier)}
                            title={t('blockview.preset.help')}
                            className={`font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${aiTier === tier ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim bg-void-lighter hover:border-terminal hover:text-terminal'}`}
                        >
                            {t(`blockview.preset.${tier}`)}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={onClear}
                    disabled={!hasOverrides}
                    title={t('blockview.preset.reset.help')}
                    className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-border text-text-dim bg-void-lighter hover:border-terminal hover:text-terminal disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                >
                    <RotateCcw size={10} />
                    {t('blockview.preset.reset')}
                </button>
            </div>
        </div>
    );
}