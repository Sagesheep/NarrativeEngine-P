import { Edit2, Trash2, Loader2, Check, X, Volume2, Square, RotateCw, Play, Pause, RefreshCw, Rewind } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { hasSwipeSet } from '../../services/turn/pendingCommit';
import { MessageActionsOverlay } from './MessageActionsOverlay';

/**
 * Hover action rail beside a message bubble: edit/save, swipe-sheet, rewind,
 * TTS speak/pause, delete. Sticky-centered; hidden until hover on desktop.
 *
 * Phase 4.4 — the rail is now the `message.actions` mount region
 * (`MOUNTS.md` §2.5). The built-in buttons render as before (each with its
 * own bespoke markup, byte-identical to the pre-4.4 rail); mod entries that
 * have claimed `message.actions` render through the generic chrome renderer
 * in `MessageActionsOverlay`, appended after the built-ins. There is no
 * trailing group on this region (`MOUNTS.md` §3.3) — mod entries sort after
 * every built-in, including delete.
 *
 * Zero-mod rule (`MOUNTS.md` §2.8): `MessageActionsOverlay` renders `null`
 * when no mod has claimed the region, so the rail's DOM is byte-identical
 * to the pre-4.4 rail with zero mods installed.
 *
 * Mod entries never appear in the editing state (§2.5): while `isEditing`
 * the rail is save/cancel only; `MessageActionsOverlay` returns `null` when
 * `isEditing` is true.
 */
export function MessageActionRail({
    msg,
    isEditing,
    canSpeak,
    ttsLoading,
    ttsPlaying,
    ttsPaused,
    ttsFinished,
    onInlineSubmit,
    onInlineCancel,
    onStartEdit,
    onOpenSwipeSheet,
    onRegenerate,
    onSpeak,
    onPauseResume,
    onDelete,
}: {
    msg: ChatMessage;
    isEditing?: boolean;
    canSpeak: boolean;
    ttsLoading: boolean;
    ttsPlaying: boolean;
    ttsPaused: boolean;
    ttsFinished: boolean;
    onInlineSubmit?: () => void;
    onInlineCancel?: () => void;
    onStartEdit: (message: ChatMessage) => void;
    onOpenSwipeSheet?: (messageId: string) => void;
    onRegenerate: (id: string) => void;
    onSpeak: () => void;
    onPauseResume: () => void;
    onDelete: (id: string) => void;
}) {
    return (
        <div className="flex flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-1 rounded-md self-start sticky top-1/2 -translate-y-1/2 z-10">
            {isEditing ? (
                <>
                    <button title="Save edit (Enter)" onClick={() => onInlineSubmit?.()} className="text-terminal hover:text-terminal p-1.5 bg-void-lighter rounded">
                        <Check size={14} />
                    </button>
                    <button title="Cancel (Esc)" onClick={() => onInlineCancel?.()} className="text-text-dim hover:text-red-400 p-1.5 bg-void-lighter rounded">
                        <X size={14} />
                    </button>
                </>
            ) : (
                <>
                    {msg.role !== 'system' && (
                        <button title="Edit" onClick={() => onStartEdit(msg)} className="text-text-dim hover:text-terminal p-1.5 bg-void-lighter rounded">
                            <Edit2 size={14} />
                        </button>
                    )}
                    {msg.role === 'assistant' && hasSwipeSet(msg) && onOpenSwipeSheet && (
                        <button
                            title="Browse variants (swipe)"
                            onClick={() => onOpenSwipeSheet(msg.id)}
                            className="text-text-dim hover:text-terminal p-1.5 bg-void-lighter rounded"
                        >
                            <RefreshCw size={14} />
                        </button>
                    )}
                    {msg.role === 'assistant' && !hasSwipeSet(msg) && (
                        <button
                            title="Rewind to here (destructive — regenerates from this point)"
                            onClick={() => {
                                if (window.confirm('Rewind to this message? This regenerates the turn from here — the current GM reply and everything after it is discarded.')) {
                                    onRegenerate(msg.id);
                                }
                            }}
                            className="text-text-dim hover:text-amber-400 p-1.5 bg-void-lighter rounded"
                        >
                            <Rewind size={14} />
                        </button>
                    )}
                    {canSpeak && (
                        <button
                            title={ttsPlaying ? 'Stop' : ttsFinished ? 'Replay' : 'Read aloud'}
                            onClick={onSpeak}
                            className={`p-1.5 bg-void-lighter rounded ${ttsPlaying ? 'text-terminal' : 'text-text-dim hover:text-terminal'}`}
                        >
                            {ttsLoading ? <Loader2 size={14} className="animate-spin" /> : ttsPlaying ? <Square size={14} /> : ttsFinished ? <RotateCw size={14} /> : <Volume2 size={14} />}
                        </button>
                    )}
                    {canSpeak && ttsPlaying && (
                        <button
                            title={ttsPaused ? 'Resume' : 'Pause'}
                            onClick={onPauseResume}
                            className="p-1.5 bg-void-lighter rounded text-text-dim hover:text-terminal"
                        >
                            {ttsPaused ? <Play size={14} /> : <Pause size={14} />}
                        </button>
                    )}
                    <button title="Delete" onClick={() => onDelete(msg.id)} className="text-text-dim hover:text-red-400 p-1.5 bg-void-lighter rounded">
                        <Trash2 size={14} />
                    </button>
                    {/* Phase 4.4 — mod entries that claimed `message.actions`.
                        Renders `null` when no mod has claimed the region or
                        while editing (MOUNTS.md §2.5/§2.8). Mod entries sort
                        after every built-in — no trailing group on this
                        region (§3.3). */}
                    <MessageActionsOverlay isEditing={isEditing} />
                </>
            )}
        </div>
    );
}
