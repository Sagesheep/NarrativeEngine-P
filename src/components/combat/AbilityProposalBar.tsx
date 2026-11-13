import { Sparkles, Check, Pencil, X } from 'lucide-react';
import { describeAbility } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { toast } from '../Toast';
import { acceptAbilityProposal, dismissAbilityProposal, editAbilityProposal } from '../../services/combat/abilityProposal';
import { sheetCasterStats } from '../../services/combat/spellbook';

export function AbilityProposalBar() {
    const { t } = useTranslation();
    const proposal = useAppStore(s => s.abilityProposal);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const sheet = useAppStore(s => s.context?.combatSheet);
    if (!proposal || (proposal.campaignId && proposal.campaignId !== activeCampaignId)) return null;
    const ability = proposal.ability;
    const accept = () => {
        const added = acceptAbilityProposal();
        if (added) toast.success(t('combat.abilityProposal.added', { name: added.name }));
    };
    return (
        <div data-testid="ability-proposal" className="bg-terminal/10 border-b border-terminal/40 px-4 py-2 flex items-center justify-between gap-3 text-[11px]">
            <div className="flex items-start gap-2 min-w-0">
                <Sparkles size={14} className="text-terminal shrink-0 mt-0.5" />
                <div className="min-w-0">
                    <div className="text-text-primary">{t('combat.abilityProposal.title', { name: ability.name })}</div>
                    <div className="text-text-dim">{describeAbility(ability, sheetCasterStats(sheet))}</div>
                    {ability.description && <div className="text-text-dim italic truncate">{ability.description}</div>}
                </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" onClick={accept} className="flex items-center gap-1 px-2 py-1 border border-terminal/60 text-terminal rounded-sm">
                    <Check size={12} /> {t('combat.abilityProposal.accept')}
                </button>
                <button type="button" onClick={editAbilityProposal} className="flex items-center gap-1 px-2 py-1 border border-border rounded-sm">
                    <Pencil size={12} /> {t('combat.abilityProposal.edit')}
                </button>
                <button type="button" onClick={dismissAbilityProposal} className="flex items-center gap-1 px-2 py-1 border border-border text-text-dim rounded-sm">
                    <X size={12} /> {t('combat.abilityProposal.dismiss')}
                </button>
            </div>
        </div>
    );
}
