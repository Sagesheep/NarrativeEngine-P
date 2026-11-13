import { useEffect } from 'react';
import { Skull, UserPlus } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { completeSuccession, prepareSuccession } from '../../services/combat/combatSuccession';

function openCharacterPanel(): void {
    const s = useAppStore.getState();
    if (!s.pcPanelOpen) s.togglePCPanel();
}

export function CombatFallenScreen() {
    const { t } = useTranslation();
    const fallen = useAppStore(s => s.context?.combatFallen ?? null);
    const hasPc = useAppStore(s => !!(s.context?.playerCharacter ?? s.playerCharacter));
    const panelOpen = useAppStore(s => s.pcPanelOpen);

    useEffect(() => {
        if (fallen?.stage === 'creating' && hasPc) completeSuccession();
    }, [fallen, hasPc]);

    if (!fallen || panelOpen) return null;

    const create = () => {
        if (fallen.stage === 'fallen') prepareSuccession();
        openCharacterPanel();
    };

    return (
        <div
            data-testid="combat-fallen"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="combat-fallen-title"
            className="fixed inset-0 z-50 flex items-center justify-center p-5"
            style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)' }}
        >
            <div className="bg-surface border border-border rounded-lg w-full max-w-md p-6 space-y-4 text-center">
                <Skull size={28} className="mx-auto" style={{ color: 'var(--combat-enemy)' }} />
                <h2 id="combat-fallen-title" className="text-base font-bold text-text-primary">{t('combat.fallen.title', { name: fallen.name })}</h2>
                <p className="text-[12px] text-text-dim leading-relaxed">{t('combat.fallen.body')}</p>
                {fallen.stage === 'creating' && <p className="text-[12px] text-text-dim leading-relaxed">{t('combat.fallen.creatingNote')}</p>}
                <button
                    type="button"
                    data-testid="combat-fallen-create"
                    onClick={create}
                    autoFocus
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 text-[11px] uppercase tracking-widest"
                >
                    <UserPlus size={14} /> {t(fallen.stage === 'creating' ? 'combat.fallen.continue' : 'combat.fallen.create')}
                </button>
                <p className="text-[11px] text-text-dim/70">{t('combat.fallen.takeOverSoon')}</p>
            </div>
        </div>
    );
}
