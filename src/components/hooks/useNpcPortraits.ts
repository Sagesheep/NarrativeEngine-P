import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { generateNPCPortrait } from '../../services/chatEngine';
import { downloadImageToLocal, uploadImageToLocal } from '../../services/infrastructure/assetService';
import { buildPortraitPrompt } from '../../services/npc/portraitPrompt';
import type { NPCEntry } from '../../types';

type PopulatingState = { done: number; total: number } | null;

export type UseNpcPortraits = {
    isGeneratingImage: boolean;
    populating: PopulatingState;
    generateForForm: (form: Partial<NPCEntry>, formId: string | undefined, isEditing: boolean, onFormPatch: (patch: Partial<NPCEntry>) => void) => Promise<void>;
    uploadForForm: (file: File, formName: string, formId: string | undefined, isEditing: boolean, onFormPatch: (patch: Partial<NPCEntry>) => void) => Promise<void>;
    populateAll: (
        npcs: NPCEntry[],
        selectedId: string | null,
        onFormPatch: (patch: Partial<NPCEntry>) => void,
    ) => Promise<void>;
};

export function useNpcPortraits(): UseNpcPortraits {
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);
    const [populating, setPopulating] = useState<PopulatingState>(null);

    const generateForForm = async (
        form: Partial<NPCEntry>,
        formId: string | undefined,
        isEditing: boolean,
        onFormPatch: (patch: Partial<NPCEntry>) => void,
    ) => {
        const state = useAppStore.getState();
        const imageConfig = state.getActiveImageEndpoint();
        if (!imageConfig || !imageConfig.endpoint) { alert('Image AI endpoint is not configured in Settings.'); return; }

        setIsGeneratingImage(true);
        try {
            const prompt = buildPortraitPrompt(form.visualProfile, form.name || '', form.appearance);
            const url = await generateNPCPortrait(imageConfig, prompt);
            const localPath = await downloadImageToLocal(url, form.name || 'Unknown');
            onFormPatch({ portrait: localPath });
            if (!isEditing && formId) state.updateNPC(formId, { portrait: localPath });
        } catch (error: unknown) {
            console.error(error);
            const msg = error instanceof Error ? error.message : String(error);
            toast.error(`Portrait generation failed: ${msg}`);
        } finally {
            setIsGeneratingImage(false);
        }
    };

    const uploadForForm = async (
        file: File,
        formName: string,
        formId: string | undefined,
        isEditing: boolean,
        onFormPatch: (patch: Partial<NPCEntry>) => void,
    ) => {
        setIsGeneratingImage(true);
        try {
            const localPath = await uploadImageToLocal(file, formName || 'Unknown');
            onFormPatch({ portrait: localPath });
            if (!isEditing && formId) {
                useAppStore.getState().updateNPC(formId, { portrait: localPath });
            }
            toast.success('Portrait uploaded');
        } catch (error: unknown) {
            console.error(error);
            const msg = error instanceof Error ? error.message : String(error);
            toast.error(`Portrait upload failed: ${msg}`);
        } finally {
            setIsGeneratingImage(false);
        }
    };

    const populateAll = async (
        npcs: NPCEntry[],
        selectedId: string | null,
        onFormPatch: (patch: Partial<NPCEntry>) => void,
    ) => {
        const state = useAppStore.getState();
        const imageConfig = state.getActiveImageEndpoint();
        if (!imageConfig || !imageConfig.endpoint) {
            toast.warning('No Image Generation AI configured. Add one in Settings → Presets.');
            return;
        }
        const targets = npcs.filter(n => !n.portrait && n.appearance?.trim());
        const skipped = npcs.filter(n => !n.portrait && !n.appearance?.trim()).length;
        if (targets.length === 0) {
            toast.warning(skipped > 0 ? `No portraits generated — ${skipped} NPC(s) need an appearance description first.` : 'All NPCs already have a portrait.');
            return;
        }

        setPopulating({ done: 0, total: targets.length });
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            try {
                const prompt = buildPortraitPrompt(target.visualProfile, target.name || 'Unknown', target.appearance);
                const url = await generateNPCPortrait(imageConfig, prompt);
                const localPath = await downloadImageToLocal(url, target.name || 'Unknown');
                useAppStore.getState().updateNPC(target.id, { portrait: localPath });
                if (selectedId === target.id) {
                    onFormPatch({ portrait: localPath });
                }
                ok++;
            } catch (err) {
                console.error(`Failed to generate portrait for ${target.name}:`, err);
                failed++;
            }
            setPopulating({ done: i + 1, total: targets.length });
        }
        setPopulating(null);

        const parts = [`generated ${ok}`];
        if (failed) parts.push(`${failed} failed`);
        if (skipped) parts.push(`${skipped} skipped (no appearance)`);
        if (failed) toast.warning(`Portraits: ${parts.join(', ')}`);
        else toast.success(`Portraits: ${parts.join(', ')}`);
    };

    return { isGeneratingImage, populating, generateForForm, uploadForForm, populateAll };
}