import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { ABSOLUTE_COMMAND_MAX_CHARS, clampAbsoluteCommand } from '../services/turn/absoluteCommand';
import { CommandSealIcon } from './icons/CommandSealIcon';
import { toast } from './Toast';

/**
 * Absolute Command v1 — the one-turn escape hatch.
 *
 * A toggle-style ⛔ ABSOLUTE button in the chat action strip. When armed, the
 * next send runs with the Director Brief, watchdog nudge, and GM_REMINDER
 * suppressed, and the player's OOC instruction placed LAST in the prompt
 * (after the user message) at maximum recency, explicitly outranking every
 * other directive. Fires on the next send, then clears — exactly like
 * `armedOneShot`. See WORKORDER-absolute-command.md.
 *
 * Mirrors `OneShotInjectorButton` (size/tracking classes, pipelinePhase
 * streaming guard, modal-mounts-fresh pattern so the textarea initialiser
 * reads the live armed value with no reset effect). Differences from the
 * one-shot modal: a `<textarea>` instead of a `<select>`, and a red accent
 * (`command-*` tokens) instead of violet.
 *
 * Two-segment control — deliberately unlike the other armed controls in the
 * strip (which replace their own label). This one grows a second, flush
 * segment when armed. The two segments share an edge (no gap, no margin);
 * only the outer corners are rounded. `animate-pulse` goes on the ARMED
 * segment only, not the whole control — pulsing the label makes it hard to
 * read. See WO §3.2.
 */
export function AbsoluteCommandButton() {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const armedAbsoluteCommand = useAppStore(s => s.armedAbsoluteCommand);
    const setArmedAbsoluteCommand = useAppStore(s => s.setArmedAbsoluteCommand);

    const [modalOpen, setModalOpen] = useState(false);

    const isStreaming = pipelinePhase !== 'idle';
    const armed = armedAbsoluteCommand !== null;

    return (
        <>
            <div className="inline-flex shrink-0 h-[32px] whitespace-nowrap">
                <button
                    onClick={() => setModalOpen(true)}
                    disabled={isStreaming}
                    title={
                        armed
                            ? 'Absolute command armed — click to change or disarm'
                            : 'Issue a binding out-of-character instruction — fires on your next message'
                    }
                    className={`shrink-0 flex items-center gap-1.5 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] transition-all disabled:cursor-not-allowed border ${
                        armed
                            ? 'rounded-l-sm rounded-r-none border-r-0 bg-command-fill text-command-label border-command-accent hover:bg-command-fill/90'
                            : 'rounded-sm bg-command-fill text-command-label border-command-accent hover:bg-command-fill/90'
                    }`}
                >
                    {/* size is HEIGHT; the traced seal is 3.11:1, so 14 -> ~44px wide. */}
                    <CommandSealIcon size={14} />
                    <span className="hidden xs:inline">Absolute: Command</span>
                    <span className="inline xs:hidden">Absolute</span>
                </button>
                {armed && (
                    <button
                        onClick={() => setModalOpen(true)}
                        disabled={isStreaming}
                        className="shrink-0 flex items-center gap-1.5 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-r-sm bg-command-accent text-command-fill border border-command-accent transition-all animate-pulse disabled:cursor-not-allowed"
                    >
                        Armed
                    </button>
                )}
            </div>

            {modalOpen && !isStreaming && (
                <AbsoluteCommandModal
                    initialText={armedAbsoluteCommand ?? ''}
                    onClose={() => setModalOpen(false)}
                    onArm={(text) => {
                        setArmedAbsoluteCommand(text);
                        setModalOpen(false);
                        toast.success('Absolute command armed — it fires on your next message.');
                    }}
                    onDisarm={() => {
                        setArmedAbsoluteCommand(null);
                        setModalOpen(false);
                    }}
                />
            )}
        </>
    );
}

function AbsoluteCommandModal({
    initialText,
    onClose,
    onArm,
    onDisarm,
}: {
    initialText: string;
    onClose: () => void;
    onArm: (text: string) => void;
    onDisarm: () => void;
}) {
    const [text, setText] = useState(initialText);
    const openedAtRef = useRef(0);
    // Stamp the open time on mount (effects are the sanctioned place for this
    // impure side effect; assigning Date.now() during render is flagged by the
    // react-hooks/purity rule). The modal mounts fresh each open, so this runs
    // once per open — mirroring OneShotModal's openedAtRef reset.
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        // Ignore the ghost-click that follows the touchstart/mousedown which
        // opened this modal — otherwise it lands on the backdrop and closes us.
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const trimmed = text.trim();
    const canArm = trimmed.length > 0;
    const charCount = clampAbsoluteCommand(text).length;

    return (
        <div
            data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60"
            onClick={handleBackdropClick}
        >
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-md mx-4 flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-command-label text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <CommandSealIcon size={16} /> Absolute Command
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-text-dim hover:text-text-primary"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <p className="text-[11px] text-text-dim leading-relaxed">
                        Speak to the GM directly. This turn only. No character hears this.
                    </p>

                    <textarea
                        aria-label="Absolute command text"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        maxLength={ABSOLUTE_COMMAND_MAX_CHARS}
                        placeholder="Elara has known him for years — stop writing her as hostile."
                        className="w-full min-h-28 resize-y bg-void border border-border focus:border-command-accent text-[13px] text-text-primary rounded px-2 py-1.5 outline-none leading-relaxed"
                    />
                    <div className="flex justify-end">
                        <span className="text-[10px] text-text-dim tabular-nums">
                            {charCount} / {ABSOLUTE_COMMAND_MAX_CHARS}
                        </span>
                    </div>

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Director Brief, stage notes and the GM push-back reminder are suppressed for this turn.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded"
                    >
                        Cancel
                    </button>
                    {initialText && (
                        <button
                            onClick={onDisarm}
                            className="px-3 py-1.5 text-xs font-semibold border border-border text-text-dim hover:text-text-primary rounded"
                        >
                            Disarm
                        </button>
                    )}
                    <button
                        onClick={() => { if (canArm) onArm(trimmed); }}
                        disabled={!canArm}
                        className="px-3 py-1.5 text-xs font-semibold bg-command-accent/20 text-command-label rounded hover:bg-command-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Arm
                    </button>
                </div>
            </div>
        </div>
    );
}