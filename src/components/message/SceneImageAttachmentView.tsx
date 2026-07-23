import { useState } from 'react';
import { Loader2, AlertCircle, Maximize2, RotateCw, Trash2, X, Sparkles } from 'lucide-react';
import type { SceneImageAttachment } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { generateSceneImageAPI, deleteSceneImageAPI } from '../../services/sceneImagesClient';
import { ASSET_BASE } from '../../lib/apiBase';
import { toast } from '../Toast';

interface SceneImageAttachmentViewProps {
    attachment: SceneImageAttachment;
    messageId: string;
}

export function SceneImageAttachmentView({ attachment, messageId }: SceneImageAttachmentViewProps) {
    const campaignId = useAppStore(s => s.activeCampaignId);
    const updateAttachment = useAppStore(s => s.updateMessageAttachment);
    const deleteAttachment = useAppStore(s => s.deleteMessageAttachment);

    const [isLightboxOpen, setIsLightboxOpen] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [imageLoadError, setImageLoadError] = useState(false);

    const imageSrc = attachment.imageUrl?.startsWith('http')
        ? attachment.imageUrl
        : `${ASSET_BASE}${attachment.imageUrl ?? ''}`;

    const handleRegenerate = async () => {
        if (!campaignId || isRegenerating) return;
        setIsRegenerating(true);
        setImageLoadError(false);
        updateAttachment(messageId, attachment.id, { status: 'generating', error: undefined });

        try {
            const updated = await generateSceneImageAPI({
                campaignId,
                sourceMessageId: messageId,
                selectedText: attachment.selectedText,
                selectionStart: attachment.selectionStart,
                selectionEnd: attachment.selectionEnd,
                promptPackage: attachment.promptPackage,
            });

            updateAttachment(messageId, attachment.id, {
                status: 'complete',
                imageUrl: updated.imageUrl,
                generatedAt: updated.generatedAt,
            });
            toast.success('Scene image regenerated!');
        } catch (err) {
            console.error('[SceneImage] Regenerate failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            updateAttachment(messageId, attachment.id, {
                status: 'failed',
                error: msg,
            });
            toast.error(`Regeneration failed: ${msg}`);
        } finally {
            setIsRegenerating(false);
        }
    };

    const handleDelete = async () => {
        if (!campaignId || isDeleting) return;
        if (!window.confirm('Delete this scene image attachment?')) return;
        setIsDeleting(true);

        try {
            await deleteSceneImageAPI({
                campaignId,
                attachmentId: attachment.id,
                imageUrl: attachment.imageUrl,
            });
            deleteAttachment(messageId, attachment.id);
            toast.success('Scene image attachment deleted.');
        } catch (err) {
            console.error('[SceneImage] Delete failed:', err);
            deleteAttachment(messageId, attachment.id);
        } finally {
            setIsDeleting(false);
        }
    };

    const aspectClasses = attachment.promptPackage?.aspectRatio === '9:16'
        ? 'aspect-[9/16] max-w-[280px]'
        : attachment.promptPackage?.aspectRatio === '1:1'
            ? 'aspect-square max-w-[380px]'
            : 'aspect-[16/9] w-full max-w-[540px]';

    const isFailedState = attachment.status === 'failed' || imageLoadError;

    return (
        <div className="mt-3 overflow-hidden rounded border border-cyan-500/30 bg-void-darker/80 p-2.5 shadow-lg select-none font-mono">
            {/* Caption */}
            <div className="mb-2 flex items-center justify-between text-[10px] text-cyan-300/80 tracking-wide">
                <span className="truncate flex-1 pr-2">
                    <Sparkles size={11} className="inline mr-1 text-cyan-400" />
                    Scene inspired by: <span className="italic text-text-primary">“{attachment.selectedText}”</span>
                </span>
                {attachment.generator && (
                    <span className="text-[9px] text-text-dim uppercase tracking-wider shrink-0">
                        [{attachment.generator.provider}]
                    </span>
                )}
            </div>

            {/* Status: Generating */}
            {(attachment.status === 'generating' || isRegenerating) && (
                <div className={`flex flex-col items-center justify-center rounded border border-cyan-500/20 bg-void-lighter/40 ${aspectClasses} p-4`}>
                    <Loader2 size={24} className="animate-spin text-cyan-400 mb-2" />
                    <span className="text-[11px] font-bold uppercase tracking-widest text-cyan-300 animate-pulse">
                        Rendering Scene Image…
                    </span>
                </div>
            )}

            {/* Status: Failed or Load Error */}
            {isFailedState && !isRegenerating && attachment.status !== 'generating' && (
                <div className="flex flex-col gap-2 rounded border border-red-500/30 bg-red-950/20 p-3 text-red-300">
                    <div className="flex items-center gap-2 text-[11px] font-bold">
                        <AlertCircle size={14} className="shrink-0" />
                        <span>{imageLoadError ? 'Image Could Not Be Loaded' : 'Image Generation Failed'}</span>
                    </div>
                    {attachment.error && (
                        <div className="text-[10px] opacity-80">{attachment.error}</div>
                    )}
                    {imageLoadError && (
                        <div className="text-[10px] opacity-80">The image asset could not be fetched from the backend server.</div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                        <button
                            onClick={handleRegenerate}
                            className="flex items-center gap-1 rounded border border-red-500/50 bg-red-900/30 px-2.5 py-1 text-[10px] uppercase tracking-wider hover:bg-red-500/20 transition-colors"
                        >
                            <RotateCw size={11} /> Retry
                        </button>
                        <button
                            onClick={handleDelete}
                            className="flex items-center gap-1 rounded border border-terminal/40 px-2.5 py-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors"
                        >
                            <Trash2 size={11} /> Remove
                        </button>
                    </div>
                </div>
            )}

            {/* Status: Complete */}
            {attachment.status === 'complete' && attachment.imageUrl && !isFailedState && !isRegenerating && (
                <div className="relative group">
                    <div className={`overflow-hidden rounded border border-cyan-500/20 bg-black ${aspectClasses}`}>
                        <img
                            src={imageSrc}
                            alt={attachment.selectedText}
                            className="h-full w-full object-cover cursor-pointer transition-transform duration-200 group-hover:scale-[1.01]"
                            onClick={() => setIsLightboxOpen(true)}
                            onError={() => setImageLoadError(true)}
                        />
                    </div>

                    {/* Action Overlay Bar */}
                    <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-void-darker/90 p-1 border border-cyan-500/40 backdrop-blur-md opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                            onClick={() => setIsLightboxOpen(true)}
                            title="Expand view"
                            className="rounded p-1 text-cyan-300 hover:bg-cyan-500/20 hover:text-white transition-colors"
                        >
                            <Maximize2 size={13} />
                        </button>
                        <button
                            onClick={handleRegenerate}
                            title="Regenerate image"
                            className="rounded p-1 text-cyan-300 hover:bg-cyan-500/20 hover:text-white transition-colors"
                        >
                            <RotateCw size={13} />
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={isDeleting}
                            title="Delete attachment"
                            className="rounded p-1 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors"
                        >
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>
            )}

            {/* Lightbox Modal */}
            {isLightboxOpen && attachment.imageUrl && (
                <div
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md animate-[fadeIn_0.15s_ease-out]"
                    onClick={() => setIsLightboxOpen(false)}
                >
                    <div
                        className="relative max-h-[95vh] max-w-[95vw] flex flex-col items-center"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setIsLightboxOpen(false)}
                            className="absolute -top-10 right-0 rounded p-1 text-text-dim hover:text-white transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <img
                            src={imageSrc}
                            alt={attachment.selectedText}
                            className="max-h-[85vh] max-w-[90vw] rounded object-contain border border-cyan-500/40 shadow-2xl"
                        />
                        <div className="mt-3 max-w-xl text-center text-xs text-cyan-200/90 bg-void-darker/80 px-4 py-2 rounded border border-cyan-500/30">
                            “{attachment.selectedText}”
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
