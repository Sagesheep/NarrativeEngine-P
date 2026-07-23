import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CAMPAIGNS_DIR, validateCampaignId } from '../lib/fileStore.js';
import { generateComfyUIImage } from './comfyUiProvider.js';

export function getCampaignSceneImagesDir(campaignId) {
    validateCampaignId(campaignId);
    const dir = path.join(CAMPAIGNS_DIR, campaignId, 'scene-images');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

export function aspectToSize(aspectRatio) {
    switch (aspectRatio) {
        case '16:9':
            return '1280x720';
        case '9:16':
            return '720x1280';
        case '1:1':
        default:
            return '1024x1024';
    }
}

function sizeToWH(size) {
    const [w, h] = String(size).split('x').map((n) => parseInt(n, 10));
    return {
        width: Number.isFinite(w) ? w : 1024,
        height: Number.isFinite(h) ? h : 1024,
    };
}

function isValidImageBuffer(buf) {
    if (!buf || buf.length < 4) return false;
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8) return true;
    // WebP
    if (buf.length >= 12 && buf.toString('utf-8', 8, 12) === 'WEBP') return true;
    // GIF
    if (buf.length >= 3 && buf.toString('utf-8', 0, 3) === 'GIF') return true;
    return false;
}

export async function generateSceneImage({ campaignId, promptPackage, config }) {
    if (!campaignId) throw new Error('Missing campaignId');
    validateCampaignId(campaignId);

    if (!config || !config.endpoint) {
        throw new Error('Image AI is not configured');
    }

    const size = aspectToSize(promptPackage.aspectRatio);

    // Build visual prompt without raw paragraph quotes to prevent text-to-image models from rendering text typography
    const positiveParts = [promptPackage.positivePrompt];
    if (promptPackage.style) positiveParts.push(`Style: ${promptPackage.style}.`);
    if (promptPackage.framing) positiveParts.push(`Framing: ${promptPackage.framing}.`);
    const prompt = positiveParts.join(' ');

    const defaultNegative = 'text, words, writing, font, quote, letters, typography, handwriting, captions, watermark, logo, signature, low quality, distorted';
    const negative_prompt = promptPackage.negativePrompt
        ? `${promptPackage.negativePrompt}, ${defaultNegative}`
        : defaultNegative;

    // ── Native ComfyUI branch ────────────────────────────────────────────────
    // Routes to a local ComfyUI server (built-in or custom API workflow). The
    // OpenAI-compatible branch below is retained unchanged for every other format.
    if (config.apiFormat === 'comfyui') {
        const { width, height } = sizeToWH(size);
        console.log(`[SceneImage Provider] Generating ComfyUI image for campaign ${campaignId} via ${config.endpoint}`);

        const imageBuffer = await generateComfyUIImage({
            config,
            prompt,
            negativePrompt: negative_prompt,
            width,
            height,
        });

        if (!isValidImageBuffer(imageBuffer)) {
            throw new Error('ComfyUI response was not a valid binary image (received invalid format or empty output)');
        }

        const id = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const filename = `${id}.png`;
        const targetDir = getCampaignSceneImagesDir(campaignId);
        const targetPath = path.join(targetDir, filename);

        fs.writeFileSync(targetPath, imageBuffer);

        const relativeUrl = `/assets/campaigns/${campaignId}/scene-images/${filename}`;
        return {
            id,
            imageUrl: relativeUrl,
            filename,
            provider: config.modelName || 'ComfyUI',
        };
    }

    const payload = {
        model: config.modelName || 'standard-image-v1',
        prompt,
        negative_prompt,
        size,
        response_format: 'url',
    };

    const headers = {
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const baseEndpoint = config.endpoint
        .replace(/\/+$/, '')
        .replace(/\/images\/generations$/, '');
    const url = `${baseEndpoint}/images/generations`;

    console.log(`[SceneImage Provider] Generating image for campaign ${campaignId} via ${url}`);

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Image provider error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    let imageUrlOrB64 = null;

    if (data.data && data.data[0]) {
        const item = data.data[0];
        imageUrlOrB64 = item.url || item.b64_json;
    } else if (data.url) {
        imageUrlOrB64 = data.url;
    } else if (data.images && data.images[0]) {
        imageUrlOrB64 = typeof data.images[0] === 'string' ? data.images[0] : (data.images[0].url || data.images[0].b64_json);
    } else if (data.output && data.output[0]) {
        imageUrlOrB64 = typeof data.output[0] === 'string' ? data.output[0] : data.output[0].url;
    }

    if (!imageUrlOrB64) {
        throw new Error('Image provider returned an unrecognized data format: ' + JSON.stringify(data));
    }

    let imageBuffer = null;

    if (imageUrlOrB64.startsWith('http://') || imageUrlOrB64.startsWith('https://')) {
        const imgRes = await fetch(imageUrlOrB64);
        if (!imgRes.ok) throw new Error(`Failed to download generated image from ${imageUrlOrB64}`);
        const ab = await imgRes.arrayBuffer();
        imageBuffer = Buffer.from(ab);
    } else if (imageUrlOrB64.startsWith('data:image/')) {
        const base64Data = imageUrlOrB64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
    } else {
        imageBuffer = Buffer.from(imageUrlOrB64, 'base64');
    }

    if (!isValidImageBuffer(imageBuffer)) {
        throw new Error('Image provider response was not a valid binary image (received invalid format or text response)');
    }

    const id = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const filename = `${id}.png`;
    const targetDir = getCampaignSceneImagesDir(campaignId);
    const targetPath = path.join(targetDir, filename);

    fs.writeFileSync(targetPath, imageBuffer);

    const relativeUrl = `/assets/campaigns/${campaignId}/scene-images/${filename}`;
    return {
        id,
        imageUrl: relativeUrl,
        filename,
        provider: config.modelName || 'Image AI',
    };
}
