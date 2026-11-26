import type { SceneImageContextInput, SceneImageCompositionResponse, SceneImagePromptPackage, SceneImageAttachment } from '../types';
import { useAppStore } from '../store/useAppStore';
import { API_BASE as API } from '../lib/apiBase';

export async function composeSceneImageAPI(
    campaignId: string,
    contextInput: SceneImageContextInput
): Promise<SceneImageCompositionResponse> {
    const state = useAppStore.getState();
    const storyConfig = state.getActiveStoryEndpoint ? state.getActiveStoryEndpoint() : undefined;

    const res = await fetch(`${API}/scene-images/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId, contextInput, llmConfig: storyConfig }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Composition failed (${res.status})`);
    }

    const data = await res.json();
    return data.promptPackage;
}

export async function generateSceneImageAPI(params: {
    campaignId: string;
    sourceMessageId: string;
    selectedText: string;
    promptPackage: SceneImagePromptPackage;
    selectionStart?: number;
    selectionEnd?: number;
}): Promise<SceneImageAttachment> {
    const state = useAppStore.getState();
    const imageConfig = state.getActiveImageEndpoint ? state.getActiveImageEndpoint() : undefined;

    const res = await fetch(`${API}/scene-images/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, imageConfig }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Image generation failed (${res.status})`);
    }

    const data = await res.json();
    return data.attachment;
}

export async function deleteSceneImageAPI(params: {
    campaignId: string;
    attachmentId: string;
    imageUrl?: string;
}): Promise<boolean> {
    const res = await fetch(`${API}/scene-images/attachment`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    if (!res.ok) {
        return false;
    }

    const data = await res.json();
    return !!data.ok;
}
