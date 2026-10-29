import { useEffect, useRef, useState } from 'react';
import { Zap, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { ONE_SHOT_EVENT_TYPES, type OneShotEventId } from '../services/oneshot/oneShotEvents';
import { toast } from './Toast';

/**
 * One-Shot Event Injector v1 — the little sibling of the Arc Injector.
 *
 * An arc is a slow systemic pressure. A one-shot is "something happens NOW,
 * in this scene." The player picks an event type from a dropdown and presses
 * FIRE; this arms a directive (`armedOneShot` in the store). On the player's
 * NEXT sent message, the orchestrator appends the directive to the LLM input
 * for that single turn (after the historyInput capture, so it steers one
 * generation but never persists in chat history) and clears it. Fires once,
 * vanishes — no storage, no lifecycle, no tool calls, no extra LLM calls.
 *
 * Mirrors `ArcInjectorButton` (size/tracking classes, pipelinePhase streaming
 * guard) but uses a violet/purple accent for visual distinction from the amber
 * arc button. The modal follows the codebase's existing pattern (backdrop +
 * click-outside ghost-click guard, same styling tokens as `LootRollModal`).
 *
 * When `armedOneShot` is non-null the button shows `ARMED — <label>`; clicking
 * while armed opens the modal with a `DISARM` option that clears the store.
 * Arming again simply replaces the prior id.
 *
 * The modal is split into a child component (`OneShotModal`) that mounts fresh
 * each time it opens, so its `useState` initializer reads the live armed id —
 * no reset effect needed (avoids the react-hooks/set-state-in-effect rule).
 */
export function OneShotInjectorButton() {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const armedOneShot = useAppStore(s => s.armedOneShot);
    const setArmedOneShot = useAppStore(s => s.setArmedOneShot);

    const [modalOpen, setModalOpen] = useState(false);

    const isStreaming = pipelinePhase !== 'idle';

    const armedType = armedOneShot
        ? ONE_SHOT_EVENT_TYPES.find(t => t.id === armedOneShot) ?? null
        : null;

    return (
        <>
            <button
                onClick={() => setModalOpen(true)}
                disabled={isStreaming}
                title={
                    armedOneShot
                        ? `Event armed (${armedType?.label ?? armedOneShot}) — click to change or disarm`
                        : 'Inject a one-shot event — fires on your next message'
                }
                className={`shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:cursor-not-allowed whitespace-nowrap ${
                    armedOneShot
                        ? 'border-violet-500 text-violet-400 bg-violet-500/10 hover:bg-violet-500/20 animate-pulse'
                        : 'border-violet-500/50 text-violet-400 hover:bg-violet-500/5'
                }`}
            >
                <Zap size={13} />
                <span className="hidden xs:inline">
                    {armedOneShot ? `ARMED — ${armedType?.label ?? armedOneShot}` : 'INJECT EVENT'}
                </span>
                <span className="inline xs:hidden">
                    {armedOneShot ? `ARMED` : 'EVENT'}
                </span>
            </button>

            {modalOpen && !isStreaming && (
                <OneShotModal
                    initialSelectedId={armedOneShot ?? 'combat'}
                    alreadyArmed={armedOneShot}
                    onClose={() => setModalOpen(false)}
                    onFire={(id) => {
                        setArmedOneShot(id);
                        setModalOpen(false);
                        toast.success('Event armed — it fires on your next message.');
                    }}
                    onDisarm={() => {
                        setArmedOneShot(null);
                        setModalOpen(false);
                    }}
                />
            )}
        </>
    );
}

function OneShotModal({
    initialSelectedId,
    alreadyArmed,
    onClose,
    onFire,
    onDisarm,
}: {
    initialSelectedId: OneShotEventId;
    alreadyArmed: OneShotEventId | null;
    onClose: () => void;
    onFire: (id: OneShotEventId) => void;
    onDisarm: () => void;
}) {
    const [selectedId, setSelectedId] = useState<OneShotEventId>(initialSelectedId);
    const openedAtRef = useRef(0);
    // Stamp the open time on mount (effects are the sanctioned place for this
    // impure side effect; assigning Date.now() during render is flagged by the
    // react-hooks/purity rule). The modal mounts fresh each open, so this runs
    // once per open — mirroring LootRollModal's openedAtRef reset.
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        // Ignore the ghost-click that follows the touchstart/mousedown which
        // opened this modal — otherwise it lands on the backdrop and closes us.
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const selectedType = ONE_SHOT_EVENT_TYPES.find(t => t.id === selectedId) ?? ONE_SHOT_EVENT_TYPES[0];
    const armedType = alreadyArmed
        ? ONE_SHOT_EVENT_TYPES.find(t => t.id === alreadyArmed) ?? null
        : null;

    return (
        <div
            data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60"
            onClick={handleBackdropClick}
        >
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-sm mx-4 flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-violet-400 text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Zap size={14} /> Inject Event
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-text-dim hover:text-text-primary"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">
                            Event Type
                        </div>
                        <select
                            value={selectedId}
                            onChange={e => setSelectedId(e.target.value as OneShotEventId)}
                            className="w-full bg-void border border-border focus:border-violet-500 text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                        >
                            {ONE_SHOT_EVENT_TYPES.map(t => (
                                <option key={t.id} value={t.id}>{t.label}</option>
                            ))}
                        </select>
                        <p className="text-[11px] text-text-dim/80 mt-1.5 leading-relaxed">
                            {selectedType.blurb}
                        </p>
                    </div>

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Confirm to arm the event. On your next send, the GM is directed to
                        introduce it diegetically within this scene — once, then the directive
                        is gone.
                    </p>

                    {alreadyArmed && (
                        <p className="text-[10px] text-violet-400/80 leading-relaxed">
                            An event is already armed ({armedType?.label ?? alreadyArmed}).
                            Firing again replaces it; DISARM clears it.
                        </p>
                    )}
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded"
                    >
                        Cancel
                    </button>
                    {alreadyArmed && (
                        <button
                            onClick={onDisarm}
                            className="px-3 py-1.5 text-xs font-semibold border border-border text-text-dim hover:text-text-primary rounded"
                        >
                            Disarm
                        </button>
                    )}
                    <button
                        onClick={() => onFire(selectedId)}
                        className="px-3 py-1.5 text-xs font-semibold bg-violet-500/20 text-violet-400 rounded hover:bg-violet-500/30"
                    >
                        Fire
                    </button>
                </div>
            </div>
        </div>
    );
}