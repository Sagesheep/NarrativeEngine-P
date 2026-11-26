import { useState, useCallback, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { uid } from '../../utils/uid';
import { uploadImageToLocal } from '../../services/infrastructure/assetService';
import { loadImageForVision } from '../../services/vision/imageSource';
import { captionImage } from '../../services/vision/describeImage';
import { supportsVision } from '../../services/vision/visionRequest';
import { titleForUpload } from '../../services/gallery/galleryIndex';
import type { GalleryEntry } from '../../types';

/**
 * Bulk upload straight into the gallery, bypassing the chat entirely.
 *
 * The two halves are DECOUPLED on purpose. Saving a file is local and fast;
 * captioning is a network round-trip per image. Doing them together means
 * dropping eight files and watching a spinner, so instead each entry is stored
 * the moment its bytes land — with an empty caption — and the vision call runs
 * behind you. You can close the modal, keep playing, and the descriptions
 * arrive as they arrive.
 *
 * An empty caption is the honest "not described yet" marker, and it is the ONLY
 * marker: nothing about in-flight state is persisted. If the app closes
 * mid-caption, a stored `status: 'captioning'` would reload as a permanent lie,
 * whereas an empty caption reloads as a truthful "this one still needs words"
 * with a Describe button next to it.
 *
 * Uploading works with NO vision provider configured — you get the images and
 * write the captions yourself. Only the automatic description needs one.
 */

export type GalleryUploadState = {
    /** Entry ids with a vision call in flight. In-memory only. */
    describing: Set<string>;
    /** Files saved but not yet stored as entries — drives the "Saving N images" line. */
    saving: number;
};

export function useGalleryUpload() {
    const [describing, setDescribing] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(0);
    // Mounted guard: the modal can close mid-flight and setState on an unmounted
    // component is a leak. The store writes still land; only the UI state stops.
    const aliveRef = useRef(true);

    const markDescribing = useCallback((id: string, on: boolean) => {
        if (!aliveRef.current) return;
        setDescribing(prev => {
            const next = new Set(prev);
            if (on) next.add(id); else next.delete(id);
            return next;
        });
    }, []);

    /** Run the vision call for one stored entry and write the caption back. */
    const describeEntry = useCallback(async (entry: GalleryEntry, fileName?: string) => {
        const provider = useAppStore.getState().getActiveVisionEndpoint();
        if (!provider || !provider.endpoint || !supportsVision(provider)) return false;

        markDescribing(entry.id, true);
        try {
            const image = await loadImageForVision(entry.imageUrl);
            const caption = await captionImage(provider, image);
            const store = useAppStore.getState();
            const patch: Partial<GalleryEntry> = { caption };
            // Upgrade the placeholder name now that there are words to derive one
            // from — but never clobber a title the player has already written.
            const current = (store.context.galleryUploads ?? []).find(e => e.id === entry.id);
            if (current && current.title === PLACEHOLDER_TITLE) {
                patch.title = titleForUpload(fileName, caption);
            }
            store.updateGalleryEntry(entry.id, patch);
            return true;
        } catch (err) {
            console.warn('[Gallery] caption failed for', entry.title, err);
            return false;
        } finally {
            markDescribing(entry.id, false);
        }
    }, [markDescribing]);

    /**
     * Save files into the gallery. Entries appear as soon as the bytes are
     * stored; captions follow. Resolves once the files are SAVED, not once
     * they are described — that is the whole point.
     */
    const addFiles = useCallback(async (files: File[]) => {
        const images = files.filter(f => f.type.startsWith('image/'));
        if (images.length === 0) {
            toast.warning('No images in that selection.');
            return;
        }

        const provider = useAppStore.getState().getActiveVisionEndpoint();
        const canDescribe = !!provider?.endpoint && supportsVision(provider);

        setSaving(images.length);
        const stored: { entry: GalleryEntry; fileName: string }[] = [];
        let failed = 0;

        for (const file of images) {
            try {
                const localPath = await uploadImageToLocal(file, 'gallery');
                const entry: GalleryEntry = {
                    id: uid(),
                    source: 'uploaded',
                    title: titleForUpload(file.name, '') || PLACEHOLDER_TITLE,
                    imageUrl: localPath,
                    caption: '',
                    createdAt: Date.now(),
                };
                useAppStore.getState().addGalleryUpload(entry);
                stored.push({ entry, fileName: file.name });
            } catch (err) {
                console.error('[Gallery] upload failed for', file.name, err);
                failed++;
            }
            if (aliveRef.current) setSaving(n => Math.max(0, n - 1));
        }
        if (aliveRef.current) setSaving(0);

        if (stored.length === 0) {
            toast.error('Could not save any of those images.');
            return;
        }
        if (failed > 0) {
            toast.warning(`Added ${stored.length}, ${failed} failed to save.`);
        } else {
            toast.success(`Added ${stored.length} image${stored.length === 1 ? '' : 's'}.`);
        }

        if (!canDescribe) {
            toast.warning('No Vision AI configured — add descriptions yourself, or set one in Settings → Presets.');
            return;
        }

        // Fire the captions and walk away. The per-endpoint queue in
        // llmRequestQueue paces these, so a 20-image drop does not stampede
        // the provider. Deliberately not awaited by the caller.
        void (async () => {
            let described = 0;
            for (const { entry, fileName } of stored) {
                if (await describeEntry(entry, fileName)) described++;
            }
            if (described < stored.length) {
                toast.warning(`Described ${described} of ${stored.length}. Use Describe on the rest.`);
            }
        })();
    }, [describeEntry]);

    /** Describe every stored entry that still has no caption. */
    const describeMissing = useCallback(async (entries: GalleryEntry[]) => {
        const targets = entries.filter(e => e.source === 'uploaded' && !e.caption.trim());
        if (targets.length === 0) return;
        const provider = useAppStore.getState().getActiveVisionEndpoint();
        if (!provider?.endpoint || !supportsVision(provider)) {
            toast.warning('No Vision AI configured. Add one in Settings → Presets → Vision AI.');
            return;
        }
        for (const entry of targets) await describeEntry(entry);
    }, [describeEntry]);

    const dispose = useCallback(() => { aliveRef.current = false; }, []);
    const revive = useCallback(() => { aliveRef.current = true; }, []);

    return { describing, saving, addFiles, describeEntry, describeMissing, dispose, revive };
}

/** Shown until a caption arrives to derive a real name from. */
export const PLACEHOLDER_TITLE = 'Uploaded image';
