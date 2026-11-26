import { Flame, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { generateTroubleOptions } from '../services/npc/troublemaker';
import { toast } from './Toast';
import type { EndpointConfig, ProviderConfig } from '../types';

type Props = {
    provider?: EndpointConfig | ProviderConfig;
};

export function CreateTroubleButton({ provider }: Props) {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const troubleLoading = useAppStore(s => s.troubleLoading);
    const openTroubleModal = useAppStore(s => s.openTroubleModal);
    const closeTroubleModal = useAppStore(s => s.closeTroubleModal);

    const isStreaming = pipelinePhase !== 'idle';

    const handleClick = async () => {
        const state = useAppStore.getState();

        const activeProvider = provider || state.getActiveStoryEndpoint();
        if (!activeProvider) {
            toast.error('No AI provider configured. Set one in Settings.');
            return;
        }

        useAppStore.setState({ troubleModalOpen: true, troubleLoading: true, troubleOptions: [] });

        try {
            const ctx = state.context;
            const sceneNote = ctx?.sceneNoteActive ? ctx.sceneNote : undefined;
            const options = await generateTroubleOptions(
                activeProvider,
                state.messages,
                state.archiveIndex ?? [],
                state.chapters ?? [],
                state.npcLedger ?? [],
                sceneNote,
            );
            openTroubleModal(options);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to generate trouble options');
            closeTroubleModal();
        }
    };

    const disabled = isStreaming || troubleLoading;

    return (
        <button
            onClick={handleClick}
            disabled={disabled}
            className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-amber-500/30 text-amber-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-amber-500/5 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
            {troubleLoading ? <Loader2 size={13} className="animate-spin" /> : <Flame size={13} />} TROUBLE
        </button>
    );
}
