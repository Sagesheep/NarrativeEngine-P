import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, SETTINGS_FILE, readJson, validateCampaignId } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import { serverError } from '../lib/serverError.js';
import { composeSceneImagePrompt } from '../services/sceneImageComposerService.js';
import { generateSceneImage, getCampaignSceneImagesDir } from '../services/imageProvider.js';

export function createSceneImagesRouter(vault) {
    const router = Router();

    const getSettings = () => {
        const settings = readJson(SETTINGS_FILE, {});
        let keys = {};
        try {
            if (vault && typeof vault.getKeys === 'function') {
                keys = vault.getKeys() || {};
            }
        } catch {
            keys = {};
        }
        return { settings, keys };
    };

    const getActiveStoryConfig = (overrideConfig) => {
        if (overrideConfig && overrideConfig.endpoint) {
            return overrideConfig;
        }

        const { settings } = getSettings();
        let vaultData = null;
        try {
            if (vault && typeof vault.isUnlocked === 'function' && vault.isUnlocked()) {
                vaultData = vault.getData();
            }
        } catch {
            vaultData = null;
        }

        const presets = vaultData?.presets?.length ? vaultData.presets : (settings.presets || []);
        const providers = vaultData?.providers?.length ? vaultData.providers : (settings.providers || []);

        const activePresetId = settings.activePresetId;
        const activePreset = presets.find(p => p.id === activePresetId) || presets[0];

        let targetProvider = null;
        if (activePreset && activePreset.storyAIProviderId) {
            targetProvider = providers.find(p => p.id === activePreset.storyAIProviderId);
        }

        if (!targetProvider) {
            targetProvider = providers.find(p => p.type === 'story' || p.type === 'chat') || providers[0];
        }

        if (!targetProvider || !targetProvider.endpoint) {
            return null;
        }

        return {
            endpoint: targetProvider.endpoint,
            apiKey: targetProvider.apiKey || '',
            modelName: targetProvider.modelName,
        };
    };

    const getActiveImageConfig = (overrideConfig) => {
        if (overrideConfig && overrideConfig.endpoint) {
            return overrideConfig;
        }

        const { settings } = getSettings();
        let vaultData = null;
        try {
            if (vault && typeof vault.isUnlocked === 'function' && vault.isUnlocked()) {
                vaultData = vault.getData();
            }
        } catch {
            vaultData = null;
        }

        const presets = vaultData?.presets?.length ? vaultData.presets : (settings.presets || []);
        const providers = vaultData?.providers?.length ? vaultData.providers : (settings.providers || []);

        const activePresetId = settings.activePresetId;
        const activePreset = presets.find(p => p.id === activePresetId) || presets[0];

        let targetProvider = null;
        if (activePreset && activePreset.imageAIProviderId) {
            targetProvider = providers.find(p => p.id === activePreset.imageAIProviderId);
        }

        if (!targetProvider) {
            targetProvider = providers.find(p => p.type === 'image' || p.id === 'image' || (p.name && p.name.toLowerCase().includes('image')));
        }

        if (!targetProvider && settings.imageConfig) {
            targetProvider = settings.imageConfig;
        }

        if (!targetProvider || !targetProvider.endpoint) {
            return null;
        }

        return {
            endpoint: targetProvider.endpoint,
            apiKey: targetProvider.apiKey || '',
            modelName: targetProvider.modelName,
            // Carry the format + native ComfyUI config so the image provider can route
            // to the ComfyUI branch instead of the default OpenAI-compatible one.
            apiFormat: targetProvider.apiFormat,
            comfyUi: targetProvider.comfyUi,
        };
    };

    router.post('/api/scene-images/compose', wrapAsync(async (req, res) => {
        const { campaignId, contextInput, llmConfig: clientLlmConfig } = req.body;
        if (!campaignId || !contextInput || !contextInput.sourceMessageId || !contextInput.selectedText) {
            return res.status(400).json({ error: 'Missing required parameters: campaignId, contextInput' });
        }
        validateCampaignId(campaignId);

        const llmConfig = getActiveStoryConfig(clientLlmConfig);
        const promptPackage = await composeSceneImagePrompt({ contextInput, llmConfig });

        res.json({ ok: true, promptPackage });
    }));

    router.post('/api/scene-images/generate', wrapAsync(async (req, res) => {
        const { campaignId, sourceMessageId, selectedText, promptPackage, selectionStart, selectionEnd, imageConfig: clientImageConfig } = req.body;
        if (!campaignId || !sourceMessageId || !selectedText || !promptPackage || !promptPackage.positivePrompt) {
            return res.status(400).json({ error: 'Missing required parameters for image generation' });
        }
        validateCampaignId(campaignId);

        const imageConfig = getActiveImageConfig(clientImageConfig);
        if (!imageConfig || !imageConfig.endpoint) {
            return res.status(400).json({ error: 'Image AI endpoint is not configured in Settings.' });
        }

        const genResult = await generateSceneImage({
            campaignId,
            promptPackage,
            config: imageConfig,
        });

        const attachment = {
            id: genResult.id,
            kind: 'scene-image',
            status: 'complete',
            sourceMessageId,
            selectedText,
            selectionStart,
            selectionEnd,
            imageUrl: genResult.imageUrl,
            sceneContext: {
                currentScene: promptPackage.sceneContextSummary || '',
                presentCharacters: [],
                recentMessageIds: [],
            },
            promptPackage,
            generatedAt: new Date().toISOString(),
            generator: {
                provider: genResult.provider,
                model: imageConfig.modelName || 'Image AI',
            },
        };

        res.json({ ok: true, attachment });
    }));

    router.delete('/api/scene-images/attachment', wrapAsync(async (req, res) => {
        const { campaignId, attachmentId, imageUrl } = req.body;
        if (!campaignId || !attachmentId) {
            return res.status(400).json({ error: 'Missing campaignId or attachmentId' });
        }
        validateCampaignId(campaignId);

        if (imageUrl) {
            const expectedPrefix = `/assets/campaigns/${campaignId}/scene-images/`;
            if (imageUrl.startsWith(expectedPrefix)) {
                const filename = path.basename(imageUrl);
                const targetDir = getCampaignSceneImagesDir(campaignId);
                const targetPath = path.join(targetDir, filename);
                const resolved = path.resolve(targetPath);
                const resolvedDir = path.resolve(targetDir);

                if (resolved.startsWith(resolvedDir) && fs.existsSync(resolved)) {
                    try {
                        fs.unlinkSync(resolved);
                        console.log(`[SceneImages Router] Cleaned up file ${resolved}`);
                    } catch (err) {
                        console.warn(`[SceneImages Router] Failed to unlink file ${resolved}:`, err.message);
                    }
                }
            }
        }

        res.json({ ok: true, deleted: true });
    }));

    return router;
}
