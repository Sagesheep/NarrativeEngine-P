import { useState } from 'react';
import type { ChatMessage } from '../../types';
import { api } from '../../services/llm/apiClient';
import type { ArchiveManagerDeps } from '../../services/archive-memory/archiveManager';
import { findPendingCommitMessage, findRetryableMessage, clearPendingTurnSnapshot } from '../../services/turn/pendingCommit';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';

interface UseMessageEditorDeps {
    messages: ChatMessage[];
    rollbackArchive: (timestamp: number) => Promise<void>;
    deleteMessagesFrom: (id: string) => void;
    updateMessageContent: (id: string, content: string) => void;
    onAfterEdit: (text: string) => void;
    onAfterRegenerate: (text: string) => void;
    // WO-F (2be3ad5) — surgical scene delete + edit-sync deps.
    activeCampaignId: string | null;
    deleteMessage: (id: string) => void;
    archiveDeps: Pick<ArchiveManagerDeps, 'setArchiveIndex' | 'setTimeline' | 'setChapters'>;
    // WO-12.6 — purges the client-side divergence register for a scene (preserves manual entries).
    deleteDivergenceChapter: (sceneId: string) => void;
}

/**
 * WO-F (2be3ad5) — map an on-screen message to its archived sceneId. Main stamps the sceneId
 * directly onto the assistant message in the post-turn pipeline (see postTurnPipeline.ts), so
 * this is a direct read. Returns null for user messages, pre-WO-F saves, and un-archived turns.
 */
export function findSceneIdForMessage(messages: ChatMessage[], messageId: string): string | null {
    const msg = messages.find(m => m.id === messageId);
    return msg?.sceneId ?? null;
}

export function useMessageEditor(deps: UseMessageEditorDeps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    // WO-EDIT — inline draft text for the message currently being edited. Kept here so the
    // bubble itself becomes the editor (mobile-style) instead of hijacking the composer textarea.
    const [inlineDraft, setInlineDraft] = useState<string>('');

    /**
     * WO-12.6 — collect the archived sceneIds of all assistant messages being dropped by a
     * delete-from / regenerate (everything from `fromId` onwards). Used to purge the client
     * divergence register to match the server-side archive purge (mobile parity).
     */
    const collectDroppedSceneIds = (fromId: string): string[] => {
        const idx = deps.messages.findIndex(m => m.id === fromId);
        if (idx === -1) return [];
        return deps.messages
            .slice(idx)
            .map(m => m.sceneId)
            .filter((id): id is string => !!id);
    };

    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        setInlineDraft(msg.displayContent || msg.content);
    };

    const cancelEditing = () => {
        setEditingMessageId(null);
        setInlineDraft('');
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = deps.messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        const trimmed = inlineDraft.trim();
        if (!trimmed) {
            cancelEditing();
            return;
        }

        if (msg.role === 'user') {
            const droppedSceneIds = collectDroppedSceneIds(msg.id);
            deps.rollbackArchive(msg.timestamp);
            // Smart Retry v1 — clear the snapshot if a retryable bubble is being
            // dropped by this edit (the user msg's rollback deletes everything
            // from here onward, including any failed-turn assistant bubble).
            const retryableForEdit = findRetryableMessage(deps.messages);
            if (retryableForEdit) {
                const retryableIdx = deps.messages.findIndex(m => m.id === retryableForEdit.id);
                const editIdx = deps.messages.findIndex(m => m.id === msg.id);
                if (retryableIdx !== -1 && editIdx !== -1 && retryableIdx >= editIdx) {
                    clearPendingTurnSnapshot();
                }
            }
            deps.deleteMessagesFrom(msg.id);
            // WO-12.6 — purge client divergence facts for every archived scene being dropped.
            for (const sid of droppedSceneIds) deps.deleteDivergenceChapter(sid);
            setEditingMessageId(null);
            setInlineDraft('');
            setTimeout(() => {
                deps.onAfterEdit(trimmed);
            }, 50);
        } else if (msg.pendingCommit && msg.swipeSet) {
            // Swipe Generation v1 — pre-commit edit of the visible variant only.
            // Update the variant's text in swipeSet (so commit reads the edited
            // text) and the message content/displayContent (so the bubble renders
            // it). No archive-sync needed: a pending turn has no sceneId yet.
            const activeIdx = msg.swipeActiveIndex ?? 0;
            const updatedSwipeSet = msg.swipeSet.map((v, i) =>
                i === activeIdx ? { ...v, text: trimmed } : v
            );
            const idx = deps.messages.findIndex(m => m.id === editingMessageId);
            if (idx !== -1) {
                const updated = [...deps.messages];
                updated[idx] = {
                    ...msg,
                    content: trimmed,
                    displayContent: trimmed,
                    swipeSet: updatedSwipeSet,
                };
                useAppStore.setState({ messages: updated });
                debouncedSaveCampaignState();
            }
            setEditingMessageId(null);
            setInlineDraft('');
        } else {
            deps.updateMessageContent(msg.id, trimmed);
            // WO-F — sync the edited GM text into long-term memory so the AI stops recalling the
            // old version. Fire-and-forget; non-fatal if it fails (the on-screen edit still holds).
            syncEditedSceneText(msg.id, trimmed);
            setEditingMessageId(null);
            setInlineDraft('');
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = deps.messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        // Swipe Generation v1 — if the pending message is at or after the
        // rewind target, discard the pending snapshot so nothing commits.
        const pendingMsg = findPendingCommitMessage(msgs);
        if (pendingMsg) {
            const pendingIdx = msgs.findIndex(m => m.id === pendingMsg.id);
            if (pendingIdx !== -1 && pendingIdx >= idx) {
                clearPendingTurnSnapshot();
            }
        }
        // Smart Retry v1 — a retryable bubble being rolled back also discards the
        // cached precontext (the snapshot was captured pre-story-AI for retry).
        // Same leak-prevention as the pending path above.
        const retryable = findRetryableMessage(msgs);
        if (retryable) {
            const retryableIdx = msgs.findIndex(m => m.id === retryable.id);
            if (retryableIdx !== -1 && retryableIdx >= idx) {
                clearPendingTurnSnapshot();
            }
        }

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            const droppedSceneIds = collectDroppedSceneIds(lastUser.id);
            deps.rollbackArchive(lastUser.timestamp);
            deps.deleteMessagesFrom(lastUser.id);
            // WO-12.6 — purge client divergence facts for every archived scene being dropped.
            for (const sid of droppedSceneIds) deps.deleteDivergenceChapter(sid);
            setTimeout(() => {
                deps.onAfterRegenerate(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };

    // WO-F — surgical scene delete. Removes the GM/user bubble from chat AND deletes the
    // underlying archived scene (re-threading chapters, no full rebuild), so the AI stops
    // recalling deleted text. Falls back to a plain on-screen delete when the message has no
    // sceneId (un-archived turn / pre-WO-F save).
    const handleDeleteOutput = async (id: string) => {
        // Swipe Generation v1 — if the deleted message IS the pending-commit
        // message, discard the snapshot so nothing commits. No sceneId exists
        // for a pending turn, so skip the archive delete below.
        const pendingMsg = findPendingCommitMessage(deps.messages);
        if (pendingMsg?.id === id) {
            clearPendingTurnSnapshot();
        }
        // Smart Retry v1 — if the deleted message is retryable (story AI failed/
        // aborted), clear the in-memory snapshot so the orphaned precontext
        // payload doesn't linger. Also handles the case where the deleted message
        // is a user msg whose paired assistant carries precontext (deleting the
        // user prompt orphans the precontext — clear it from the next assistant).
        const retryableMsg = findRetryableMessage(deps.messages);
        if (retryableMsg?.id === id) {
            clearPendingTurnSnapshot();
        } else if (retryableMsg) {
            // Maybe the deleted message is a user msg BEFORE the retryable assistant.
            // Check if the retryable assistant would be orphaned by this delete.
            const deleteIdx = deps.messages.findIndex(m => m.id === id);
            const retryableIdx = deps.messages.findIndex(m => m.id === retryableMsg.id);
            if (deleteIdx !== -1 && retryableIdx !== -1 && deleteIdx < retryableIdx) {
                // Deleting a message before the retryable bubble — the retryable's
                // paired user prompt may be the one being deleted. Clear the snapshot
                // + the retryable flags so the button doesn't survive orphaned.
                clearPendingTurnSnapshot();
                useAppStore.getState().updateLastAssistantMessage?.({ retryable: undefined, precontext: undefined });
            }
        }
        deps.deleteMessage(id);
        const sceneId = findSceneIdForMessage(deps.messages, id);
        if (!sceneId || !deps.activeCampaignId) return;
        try {
            await api.backups.create(deps.activeCampaignId, { trigger: 'pre-scene-delete', isAuto: true }).catch(() => { });
            await api.archive.deleteScene(deps.activeCampaignId, sceneId);
            const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
                api.archive.getIndex(deps.activeCampaignId),
                api.timeline.get(deps.activeCampaignId),
                api.chapters.list(deps.activeCampaignId).catch(() => []),
            ]);
            deps.archiveDeps.setArchiveIndex(freshIndex);
            deps.archiveDeps.setTimeline(freshTimeline);
            deps.archiveDeps.setChapters(freshChapters);
            // WO-12.6 — purge client divergence facts for the deleted scene (mobile parity).
            deps.deleteDivergenceChapter(sceneId);
            console.log(`[Archive] Surgically deleted scene #${sceneId}`);
        } catch (err) {
            console.warn('[Archive] Scene delete failed (on-screen message still removed):', err);
        }
    };

    // WO-F — sync an edited GM reply into the archive (rewrite scene text + rebuild index + re-embed).
    const syncEditedSceneText = async (messageId: string, newAssistant: string) => {
        if (!deps.activeCampaignId) return;
        const sceneId = findSceneIdForMessage(deps.messages, messageId);
        if (!sceneId) return;
        try {
            await api.archive.updateSceneAssistant(deps.activeCampaignId, sceneId, newAssistant);
            const freshIndex = await api.archive.getIndex(deps.activeCampaignId);
            deps.archiveDeps.setArchiveIndex(freshIndex);
        } catch (err) {
            console.warn('[Archive] Scene edit-sync failed (on-screen edit still holds):', err);
        }
    };

    return {
        editingMessageId,
        inlineDraft,
        setInlineDraft,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
        handleDeleteOutput,
    };
}