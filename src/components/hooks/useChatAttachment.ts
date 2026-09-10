import { useState, useCallback, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { uploadImageToLocal } from '../../services/infrastructure/assetService';
import { loadImageForVision } from '../../services/vision/imageSource';
import { captionImage } from '../../services/vision/describeImage';
import { supportsVision } from '../../services/vision/visionRequest';

/**
 * Vision v1.5 — one image attached to the next chat message.
 *
 * Captioning happens at ATTACH time, not at send time. Two reasons: the turn
 * doesn't pay the latency, and — the important one — you get to read what the
 * model actually saw and fix it before it goes anywhere. The caption is
 * prepended to your message and then lives in the archive permanently, so the
 * edit box in the chip is the last chance to catch "she carries three swords".
 *
 * One image at a time, deliberately. Multi-image needs interleaved labelling
 * ("Image 1: … Image 2: …") to be legible to the model, and that is a different
 * feature from "paste a picture into the chat".
 */

export type AttachmentStatus = 'idle' | 'uploading' | 'captioning' | 'ready' | 'error';

export type ChatAttachment = {
    /** Object URL for instant local preview (revoked on clear). */
    previewUrl: string;
    /** Server-side asset path, once uploaded. Empty until then. */
    localPath: string;
    /** What the vision model saw. Editable by the user before send. */
    caption: string;
    status: AttachmentStatus;
    error?: string;
};

export function useChatAttachment() {
    const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
    const previewUrlRef = useRef<string | null>(null);

    const clear = useCallback(() => {
        if (previewUrlRef.current) {
            URL.revokeObjectURL(previewUrlRef.current);
            previewUrlRef.current = null;
        }
        setAttachment(null);
    }, []);

    const setCaption = useCallback((caption: string) => {
        setAttachment(prev => (prev ? { ...prev, caption } : prev));
    }, []);

    /** Attach an image file and kick off upload + captioning. */
    const attach = useCallback(async (file: File, userNote?: string) => {
        if (!file.type.startsWith('image/')) {
            toast.warning('Only images can be attached.');
            return;
        }

        const provider = useAppStore.getState().getActiveVisionEndpoint();
        if (!provider || !provider.endpoint) {
            toast.warning('No Vision AI configured. Add one in Settings → Presets → Vision AI.');
            return;
        }
        if (!supportsVision(provider)) {
            toast.error('The configured Vision AI is an image generator, not a vision model.');
            return;
        }

        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const previewUrl = URL.createObjectURL(file);
        previewUrlRef.current = previewUrl;
        setAttachment({ previewUrl, localPath: '', caption: '', status: 'uploading' });

        let localPath = '';
        try {
            localPath = await uploadImageToLocal(file, 'attachment');
        } catch (err) {
            console.error('[Attachment] upload failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            setAttachment(prev => (prev ? { ...prev, status: 'error', error: msg } : prev));
            toast.error(`Could not save the image: ${msg}`);
            return;
        }

        setAttachment(prev => (prev ? { ...prev, localPath, status: 'captioning' } : prev));

        try {
            const image = await loadImageForVision(file);
            const caption = await captionImage(provider, image, { userNote });
            setAttachment(prev => (prev ? { ...prev, caption, status: 'ready' } : prev));
        } catch (err) {
            console.error('[Attachment] caption failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            // The upload survived — keep the attachment so the user can write
            // their own caption rather than losing the image entirely.
            setAttachment(prev => (prev ? { ...prev, status: 'error', error: msg } : prev));
            toast.error(`Vision read failed: ${msg}. You can describe it yourself instead.`);
        }
    }, []);

    /** Pull the first image out of a paste/drop payload, if there is one. */
    const attachFromDataTransfer = useCallback((data: DataTransfer | null, userNote?: string): boolean => {
        if (!data) return false;
        const items = Array.from(data.items ?? []);
        const imageItem = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
        const file = imageItem?.getAsFile()
            ?? Array.from(data.files ?? []).find(f => f.type.startsWith('image/'));
        if (!file) return false;
        void attach(file, userNote);
        return true;
    }, [attach]);

    return {
        attachment,
        /** True once there is something worth sending (caption written or user-authored). */
        isBusy: attachment?.status === 'uploading' || attachment?.status === 'captioning',
        attach,
        attachFromDataTransfer,
        setCaption,
        clear,
    };
}
