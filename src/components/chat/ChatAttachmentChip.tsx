import { useState } from 'react';
import { Loader2, X, Eye, AlertTriangle } from 'lucide-react';
import type { ChatAttachment } from '../hooks/useChatAttachment';

/**
 * The pending-image chip above the composer. Shows the thumbnail, what the
 * vision model made of it, and lets you fix that text before it is sent —
 * the caption becomes part of your message and is archived permanently.
 */
export function ChatAttachmentChip({
    attachment,
    onCaptionChange,
    onRemove,
}: {
    attachment: ChatAttachment;
    onCaptionChange: (caption: string) => void;
    onRemove: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const { previewUrl, caption, status, error } = attachment;

    const statusLine =
        status === 'uploading' ? 'Saving image…'
            : status === 'captioning' ? 'Vision AI is reading it…'
                : status === 'error' ? (error || 'Could not read the image')
                    : caption || 'No description yet — write one below.';

    const busy = status === 'uploading' || status === 'captioning';

    return (
        <div className="mx-2 sm:mx-4 mb-2 border border-border bg-void-lighter rounded-sm">
            <div className="flex items-start gap-3 p-2">
                <img
                    src={previewUrl}
                    alt="Attached"
                    className="w-14 h-14 object-cover rounded border border-border shrink-0"
                />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[9px] uppercase tracking-widest text-terminal font-bold">
                            Attached Image
                        </span>
                        {busy && <Loader2 size={10} className="animate-spin text-text-dim" />}
                        {status === 'error' && <AlertTriangle size={10} className="text-amber-400" />}
                    </div>
                    <p
                        className={`text-[11px] leading-4 line-clamp-2 ${status === 'error' ? 'text-amber-400' : 'text-text-dim'}`}
                        title={statusLine}
                    >
                        {statusLine}
                    </p>
                    <p className="text-[9px] text-text-dim/60 mt-0.5">
                        The AI reads this text, not the picture.
                    </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => setExpanded(v => !v)}
                        disabled={busy}
                        title="Review or edit what the AI will read"
                        className="p-1.5 text-text-dim hover:text-terminal transition-colors disabled:opacity-30"
                    >
                        <Eye size={13} />
                    </button>
                    <button
                        type="button"
                        onClick={onRemove}
                        title="Remove this image"
                        className="p-1.5 text-text-dim hover:text-danger transition-colors"
                    >
                        <X size={13} />
                    </button>
                </div>
            </div>

            {expanded && !busy && (
                <div className="px-2 pb-2">
                    <textarea
                        value={caption}
                        onChange={e => onCaptionChange(e.target.value)}
                        rows={4}
                        placeholder="Describe the image for the AI…"
                        className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-primary resize-none focus:outline-none focus:border-terminal"
                    />
                </div>
            )}
        </div>
    );
}
