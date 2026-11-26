import { useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../components/Toast';
import type { NPCReviewAction } from '../../components/NPCReviewModal';
import { runNPCReview, type NPCReviewCandidate, type NPCReviewCancelled } from '../../services/npc/npcReview';

type ReviewProgress = { msg: string; done: number; total: number };

export type UseNpcReview = {
    reviewOpen: boolean;
    reviewRunning: boolean;
    reviewProgress: ReviewProgress | null;
    reviewCandidates: NPCReviewCandidate[] | null;
    reviewFailedBatches: number;
    reviewActions: Record<string, NPCReviewAction>;
    reviewError: string | null;
    startReview: () => void;
    stopReview: () => void;
    closeReview: () => void;
    setReviewAction: (id: string, action: NPCReviewAction) => void;
    applyReview: (opts: {
        selectedId: string | null;
        onClearedSelection: () => void;
    }) => void;
};

export function useNpcReview(): UseNpcReview {
    const [reviewOpen, setReviewOpen] = useState(false);
    const [reviewRunning, setReviewRunning] = useState(false);
    const [reviewProgress, setReviewProgress] = useState<ReviewProgress | null>(null);
    const [reviewCandidates, setReviewCandidates] = useState<NPCReviewCandidate[] | null>(null);
    const [reviewFailedBatches, setReviewFailedBatches] = useState(0);
    const [reviewActions, setReviewActions] = useState<Record<string, NPCReviewAction>>({});
    const [reviewError, setReviewError] = useState<string | null>(null);
    const reviewCancelRef = useRef<NPCReviewCancelled>({ cancelled: false });

    const startReview = () => {
        const state = useAppStore.getState();
        const provider = state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint();
        if (!provider) {
            setReviewError('No AI endpoint configured.');
            setReviewOpen(true);
            return;
        }
        setReviewOpen(true);
        setReviewRunning(true);
        setReviewProgress(null);
        setReviewCandidates(null);
        setReviewFailedBatches(0);
        setReviewActions({});
        setReviewError(null);
        reviewCancelRef.current = { cancelled: false };

        runNPCReview(state.npcLedger, provider, reviewCancelRef.current, (msg, done, total) => {
            setReviewProgress({ msg, done, total });
        }).then(result => {
            setReviewCandidates(result.candidates);
            setReviewFailedBatches(result.failedBatches);
            const defaults: Record<string, NPCReviewAction> = {};
            for (const c of result.candidates) defaults[c.id] = 'archive';
            setReviewActions(defaults);
            setReviewRunning(false);
            setReviewProgress(null);
        }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'NPC review cancelled.') {
                setReviewOpen(false);
                setReviewRunning(false);
                setReviewProgress(null);
            } else {
                setReviewError(msg);
                setReviewRunning(false);
                setReviewProgress(null);
            }
        });
    };

    const stopReview = () => {
        reviewCancelRef.current.cancelled = true;
        setReviewOpen(false);
        setReviewRunning(false);
        setReviewProgress(null);
    };

    const closeReview = () => {
        if (reviewRunning) return;
        setReviewOpen(false);
        setReviewCandidates(null);
        setReviewActions({});
        setReviewError(null);
    };

    const setReviewAction = (id: string, action: NPCReviewAction) => {
        setReviewActions(prev => ({ ...prev, [id]: action }));
    };

    const applyReview = ({ selectedId, onClearedSelection }: { selectedId: string | null; onClearedSelection: () => void }) => {
        const cands = reviewCandidates ?? [];
        const archiveIds = cands.filter(c => reviewActions[c.id] === 'archive').map(c => c.id);
        const deleteIds = cands.filter(c => reviewActions[c.id] === 'delete').map(c => c.id);

        const store = useAppStore.getState();
        const currentTurn = store.archiveIndex.length;
        for (const id of archiveIds) {
            const cand = cands.find(c => c.id === id);
            store.archiveNPC(id, currentTurn, cand?.reason || 'Flagged by NPC review');
        }
        for (const id of deleteIds) {
            store.removeNPC(id);
        }

        if (selectedId && (archiveIds.includes(selectedId) || deleteIds.includes(selectedId))) {
            onClearedSelection();
        }

        const removedCount = archiveIds.length + deleteIds.length;
        if (removedCount) {
            toast.success(`NPC review: removed ${removedCount} NPC(s)`);
        }

        setReviewOpen(false);
        setReviewCandidates(null);
        setReviewActions({});
        setReviewError(null);
    };

    return {
        reviewOpen,
        reviewRunning,
        reviewProgress,
        reviewCandidates,
        reviewFailedBatches,
        reviewActions,
        reviewError,
        startReview,
        stopReview,
        closeReview,
        setReviewAction,
        applyReview,
    };
}