import { Sparkles, Check, Pencil, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { toast } from '../Toast';
import { acceptAbilityProposal, dismissAbilityProposal, editAbilityProposal } from '../../services/combat/abilityProposal';
import { configOf, sheetCasterStats } from '../../services/combat/spellbook';
import { AbilityCard } from '../spellbook/AbilityCard';

const actionClass = 'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border outline-none focus-visible:ring-2 focus-visible:ring-terminal';

export function AbilityProposalBar() {
    const { t } = useTranslation();
    const proposal = useAppStore(s => s.abilityProposal);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const context = useAppStore(s => s.context);
    if (!proposal || (proposal.campaignId && proposal.campaignId !== activeCampaignId)) return null;
    const ability = proposal.ability;
    const accept = () => {
        const added = acceptAbilityProposal();
        if (added) toast.success(t('combat.abilityProposal.added', { name: added.name }));
    };
    return (
        <div data-testid="ability-proposal" className="border-b border-terminal/40 bg-terminal/10 px-4 py-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-xs text-text-primary">
                <Sparkles size={14} aria-hidden="true" className="text-terminal shrink-0" />
                <span>{t('combat.abilityProposal.title', { name: ability.name })}</span>
            </div>
            <div className="max-w-xl">
                <AbilityCard
                    ability={ability}
                    stats={sheetCasterStats(context.combatSheet)}
                    label={configOf(context).resourceLabel}
                    showRules
                    testId="ability-proposal-card"
                    actions={(
                        <>
                            <button type="button" onClick={accept} className={`${actionClass} border-terminal/60 text-terminal hover:bg-terminal/10`}>
                                <Check size={14} aria-hidden="true" /> {t('combat.abilityProposal.accept')}
                            </button>
                            <button type="button" onClick={editAbilityProposal} className={`${actionClass} border-border text-text-primary hover:bg-void-lighter`}>
                                <Pencil size={14} aria-hidden="true" /> {t('combat.abilityProposal.edit')}
                            </button>
                            <button type="button" onClick={dismissAbilityProposal} className={`${actionClass} border-border text-text-dim hover:text-text-primary`}>
                                <X size={14} aria-hidden="true" /> {t('combat.abilityProposal.dismiss')}
                            </button>
                        </>
                    )}
                />
            </div>
        </div>
    );
}
