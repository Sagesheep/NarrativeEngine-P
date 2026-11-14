import { useAppStore } from '../../store/useAppStore';
import type { AbilityProposal, GlyphAbility } from '../../types';
import { addAsNew, spellbookOf } from './spellbook';

export function stageAbilityProposal(proposal: Omit<AbilityProposal, 'campaignId'>): void {
    const store = useAppStore.getState();
    store.setAbilityProposal({ ...proposal, ...(store.activeCampaignId ? { campaignId: store.activeCampaignId } : {}) });
}

export function liveAbilityProposal(): AbilityProposal | null {
    const store = useAppStore.getState();
    const proposal = store.abilityProposal;
    if (!proposal) return null;
    if (proposal.campaignId && proposal.campaignId !== store.activeCampaignId) return null;
    return proposal;
}

export function acceptAbilityProposal(): GlyphAbility | null {
    const store = useAppStore.getState();
    const proposal = liveAbilityProposal();
    if (!proposal) return null;
    const book = addAsNew(spellbookOf(store.context), proposal.ability, 'ai');
    store.updateContext({ spellbook: book });
    store.setAbilityProposal(null);
    return book.abilities[book.abilities.length - 1] ?? null;
}

export function editAbilityProposal(): void {
    const store = useAppStore.getState();
    const proposal = liveAbilityProposal();
    if (!proposal) return;
    store.setAbilityEditDraft(proposal.ability);
    store.setAbilityProposal(null);
    store.setSpellbookOpen(true);
}

export function dismissAbilityProposal(): void {
    useAppStore.getState().setAbilityProposal(null);
}
