import { api } from './apiClient';
import { API_BASE as API } from '../lib/apiBase';
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, CondenserState } from '../types';

export interface ArchiveManagerDeps {
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setTimeline: (events: any[]) => void;
    setChapters: (chapters: ArchiveChapter[]) => void;
    clearArchive: () => void;
    setCondenser: (state: CondenserState) => void;
    getActiveCampaignId: () => string | null;
    getArchiveIndex: () => ArchiveIndexEntry[];
    getChapters: () => ArchiveChapter[];
    getCondenser: () => CondenserState;
    getMessages: () => ChatMessage[];
}

export async function rollbackArchiveFrom(deps: ArchiveManagerDeps, fromTimestamp: number): Promise<void> {
    const campaignId = deps.getActiveCampaignId();
    if (!campaignId) return;
    const currentIndex = deps.getArchiveIndex();
    const currentChapters = deps.getChapters();
    if (!currentIndex.length) return;

    const sorted = [...currentIndex].sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));
    const target = sorted.find(e => e.timestamp >= fromTimestamp);
    if (!target) return;

    try {
        await fetch(`${API}/campaigns/${campaignId}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'pre-rollback', isAuto: true }),
        });
    } catch (e) {
        console.warn('[Archive] Pre-rollback backup failed — proceeding anyway:', e);
    }

    try {
        await api.archive.deleteFrom(campaignId, target.sceneId);

        const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
            api.archive.getIndex(campaignId),
            api.timeline.get(campaignId),
            api.chapters.list(campaignId)
        ]);

        deps.setArchiveIndex(freshIndex);
        deps.setTimeline(freshTimeline);

        const chaptersChanged = freshChapters.length !== currentChapters.length ||
            freshChapters.some((c, i) => c.sceneRange[0] !== currentChapters[i]?.sceneRange[0]);

        if (chaptersChanged) {
            deps.setChapters(freshChapters);
            console.log('[Archive] Chapters repaired during rollback');
        }

        const currentCondenser = deps.getCondenser();
        const currentMessages = deps.getMessages();
        const lastCondensedMsg = currentCondenser.condensedUpToIndex >= 0
            ? currentMessages[currentCondenser.condensedUpToIndex]
            : null;
        const rollbackAffectsCondensed = !lastCondensedMsg || fromTimestamp <= lastCondensedMsg.timestamp;
        if (rollbackAffectsCondensed) {
            deps.setCondenser({
                condensedSummary: '',
                condensedUpToIndex: -1,
                isCondensing: false,
            });
            console.log('[Archive] Condenser reset — rollback affected condensed portion');
        } else {
            console.log('[Archive] Condenser preserved — rollback was after condensed portion');
        }

        console.log(`[Archive] Rolled back from scene #${target.sceneId}`);
    } catch (err) {
        console.warn('[Archive] Rollback failed:', err);
    }
}

export async function openArchive(campaignId: string): Promise<void> {
    await api.archive.open(campaignId);
}

export async function clearArchive(deps: ArchiveManagerDeps): Promise<void> {
    const campaignId = deps.getActiveCampaignId();
    if (!campaignId) return;
    await fetch(`${API}/campaigns/${campaignId}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'pre-clear-archive', isAuto: true }),
    }).catch(() => {});
    try {
        await api.archive.clear(campaignId);
        deps.clearArchive();
        deps.setChapters([]);
        deps.setCondenser({
            condensedSummary: '',
            condensedUpToIndex: -1,
            isCondensing: false,
        });
        console.log('[Archive] Cleared successfully');
    } catch (err) {
        console.warn('[Archive] Failed to clear:', err);
    }
}
