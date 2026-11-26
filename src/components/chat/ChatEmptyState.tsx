import { useAppStore } from '../../store/useAppStore';

/**
 * Empty-chat placeholder shown before the first message: the "Awaiting
 * transmission" banner plus the Create Character entry point.
 *
 * WO-A rewrite 2 §2: the PC lives at `context.playerCharacter`, not as an
 * `isPC` row in `npcLedger`. The legacy `npcLedger.some(n => n.isPC)` check
 * always returns false post-migration (the hydrator strips any `isPC` row
 * into `context.playerCharacter`), so we read `playerCharacter` directly.
 */
export function ChatEmptyState({ onCreateCharacter }: { onCreateCharacter: () => void }) {
    const hasPC = useAppStore(s => s.playerCharacter != null);

    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
                <div className="text-4xl">⚔</div>
                <p className="text-text-dim text-xs uppercase tracking-widest">
                    Awaiting transmission...
                </p>
                <div className="space-y-2">
                    {!hasPC && (
                        <button
                            onClick={onCreateCharacter}
                            className="block w-full px-6 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
                        >
                            Create Character
                        </button>
                    )}
                    <p className="text-text-dim/50 text-[10px]">
                        {!hasPC 
                            ? "Or paste your lore in the context drawer, configure your LLM, and begin."
                            : "Paste your lore in the context drawer, configure your LLM, and begin."}
                    </p>
                </div>
            </div>
        </div>
    );
}
