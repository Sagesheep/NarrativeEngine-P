import { useState } from 'react';
import { Swords, Loader2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { requestManualCombat } from '../../services/combat/combatManualStart';

function useManualStart() {
    const [loading, setLoading] = useState(false);
    const run = async () => {
        if (loading) return;
        setLoading(true);
        try {
            await requestManualCombat();
        } finally {
            setLoading(false);
        }
    };
    return { loading, run };
}

function useCombatAllocationPending(): boolean {
    return useAppStore(s => s.context.combatModeActive === true && s.context.combatSheet?.needsAllocation !== false);
}

function openCharacterSheet(): void {
    const s = useAppStore.getState();
    if (!s.pcPanelOpen) s.togglePCPanel();
}

export function CombatAllocationHint({ variant }: { variant: 'notice' | 'note' }) {
    const { t } = useTranslation();
    const pending = useCombatAllocationPending();
    const hasSession = useAppStore(s => !!s.combatSession);
    if (!pending) return null;
    if (variant === 'note') {
        return (
            <p data-testid="combat-alloc-note" className="text-[12px] text-amber-400 leading-relaxed">
                {t('combat.allocPending.text')}{' '}
                <button type="button" onClick={openCharacterSheet} className="underline underline-offset-2 hover:text-amber-300">
                    {t('combat.allocPending.action')}
                </button>
            </p>
        );
    }
    if (hasSession) return null;
    return (
        <div data-testid="combat-alloc-hint" className="px-4 py-1 flex items-center gap-2 text-[11px] font-mono text-amber-300 border-b border-amber-500/20">
            <Swords size={12} className="shrink-0" />
            <span className="flex-1 min-w-0 truncate">{t('combat.allocPending.text')}</span>
            <button type="button" onClick={openCharacterSheet} className="shrink-0 underline-offset-2 hover:underline hover:text-amber-200">
                {t('combat.allocPending.action')}
            </button>
        </div>
    );
}

export function StartCombatButton({ isStreaming }: { isStreaming: boolean }) {
    const { t } = useTranslation();
    const active = useAppStore(s => s.context.combatModeActive === true && s.context.combatSheet?.needsAllocation === false);
    const hasSession = useAppStore(s => !!s.combatSession);
    const hasProposal = useAppStore(s => !!s.combatProposal);
    const { loading, run } = useManualStart();
    if (!active || hasSession || hasProposal) return null;
    return (
        <button
            type="button"
            data-testid="start-combat-button"
            onClick={() => void run()}
            disabled={isStreaming || loading}
            aria-label={t('combat.strip.start')}
            title={t('combat.strip.startHelp')}
            className="h-[32px] w-[32px] mb-[4px] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 hover:bg-[color:var(--combat-target)]"
            style={{ color: 'var(--combat-enemy)' }}
        >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Swords size={15} />}
        </button>
    );
}

export function CombatOfferChip({ onDismiss }: { onDismiss: () => void }) {
    const { t } = useTranslation();
    const { loading, run } = useManualStart();
    return (
        <div data-testid="combat-offer-chip" className="mb-6 px-3 py-1.5 flex items-center gap-2 rounded-sm border text-[11px] font-mono" style={{ borderColor: 'var(--combat-enemy)', background: 'var(--combat-target)' }}>
            <Swords size={12} className="shrink-0" style={{ color: 'var(--combat-enemy)' }} />
            <button type="button" onClick={() => void run()} disabled={loading} className="underline-offset-2 hover:underline text-left flex-1 text-text-primary disabled:opacity-50">
                {t('combat.offer.text')}
            </button>
            {loading && <Loader2 size={12} className="animate-spin text-text-dim" />}
            <button type="button" onClick={onDismiss} aria-label={t('combat.offer.dismiss')} title={t('combat.offer.dismiss')} className="text-text-dim hover:text-text-primary p-0.5">
                <X size={12} />
            </button>
        </div>
    );
}

export function CombatProposalChip({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-1.5 border-b border-border">
            <button
                type="button"
                data-testid="combat-proposal-chip"
                onClick={onOpen}
                className="flex items-center gap-2 border rounded-sm px-2.5 py-1 text-[11px] font-mono text-text-primary hover:bg-void-lighter"
                style={{ borderColor: 'var(--combat-enemy)' }}
            >
                <Swords size={12} style={{ color: 'var(--combat-enemy)' }} />
                {t('combat.proposal.minimised')}
            </button>
        </div>
    );
}
