import { useAppStore } from '../../store/useAppStore';
import { addNpcFromSelection } from '../../services/npc/manualAdd';
import { toast } from '../Toast';

/**
 * Promote one auto-detected name into the NPC ledger (same add/update pass as
 * the toolbar button), then drop it from the suggestion list. Shared by the
 * ledger's Suggestions panel and the composer's suggestion chips.
 */
export async function acceptNpcSuggestion(name: string): Promise<boolean> {
    const state = useAppStore.getState();
    if (!state.activeCampaignId) {
        toast.warning('No active campaign.');
        return false;
    }
    const result = await addNpcFromSelection({
        rawText: name,
        ledger: state.npcLedger ?? [],
        messages: state.messages,
        campaignId: state.activeCampaignId,
        storyProvider: state.getActiveStoryEndpoint() ?? state.getActiveUtilityEndpoint(),
        updateProvider: state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
        addNPC: state.addNPC,
        updateNPC: state.updateNPC,
    });
    if (result.ok) {
        useAppStore.getState().dismissNpcSuggestion(name);
        toast.success(result.message);
        return true;
    }
    if (result.kind === 'ambiguous') toast.warning(result.message);
    else toast.error(result.message);
    return false;
}
