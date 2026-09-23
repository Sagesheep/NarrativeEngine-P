import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from '../components/Toast';
import { openArchive as openArchiveFn } from '../services/archive-memory/archiveManager';

/**
 * Manual campaign persistence, extracted from ChatArea: the save-now button
 * and the archive viewer opener.
 *
 * "Save campaign" means "fire every pending debounced save at the server now",
 * which is the only durable store. It previously wrote three IndexedDB keys
 * instead: two that nothing ever read, and `nn_settings` with the provider
 * list in PLAINTEXT — overwriting the encrypted record that `loadSettings`
 * reads back at launch, so the button leaked API keys to disk and reported
 * success without persisting anything.
 */
export function useChatPersistence() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const [isSaving, setIsSaving] = useState(false);

    const handleForceSave = async () => {
        if (!useAppStore.getState().activeCampaignId) return;
        setIsSaving(true);
        try {
            await flushAllPendingSaves();
            toast.success('Campaign saved');
        } catch (e) {
            console.error('[Save] Failed to flush pending campaign saves:', e);
            toast.error('Save failed');
        } finally {
            setIsSaving(false);
        }
    };

    const handleOpenArchive = () => {
        if (activeCampaignId) openArchiveFn(activeCampaignId);
    };

    return { isSaving, handleForceSave, handleOpenArchive };
}
