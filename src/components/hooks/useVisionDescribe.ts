import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { loadImageForVision } from '../../services/vision/imageSource';
import { describeImage, VisionParseError, type VisionDescription } from '../../services/vision/describeImage';
import { supportsVision } from '../../services/vision/visionRequest';

/**
 * "Read Image" — hand a portrait to the Vision AI and get back a draft
 * visual profile + appearance prose for the user to review.
 *
 * Returns the description rather than writing it anywhere. The caller decides
 * what to do with it, and the caller is always a form the user must still
 * save — see the draft note in `describeImage.ts`.
 */
export function useVisionDescribe() {
    const [isDescribing, setIsDescribing] = useState(false);
    const visionProvider = useAppStore(s => s.getActiveVisionEndpoint?.());

    const describe = async (
        source: File | Blob | string,
        subjectName?: string,
    ): Promise<VisionDescription | null> => {
        const provider = useAppStore.getState().getActiveVisionEndpoint();
        if (!provider || !provider.endpoint) {
            toast.warning('No Vision AI configured. Add one in Settings → Presets → Vision AI.');
            return null;
        }
        if (!supportsVision(provider)) {
            toast.error('The configured Vision AI is an image generator, not a vision model.');
            return null;
        }

        setIsDescribing(true);
        try {
            const image = await loadImageForVision(source);
            const description = await describeImage(provider, image, { subjectName });
            const filled = Object.keys(description.visualProfile).length;
            toast.success(`Vision AI filled ${filled} field${filled === 1 ? '' : 's'} — review before saving.`);
            return description;
        } catch (err) {
            console.error('[Vision] describe failed:', err);
            if (err instanceof VisionParseError) {
                toast.error('The vision model replied but not in the expected format. Is this model multimodal?');
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                toast.error(`Vision read failed: ${msg}`);
            }
            return null;
        } finally {
            setIsDescribing(false);
        }
    };

    return {
        isDescribing,
        /** True when a Vision AI is configured on the active preset. */
        visionConfigured: !!visionProvider?.endpoint,
        describe,
    };
}
