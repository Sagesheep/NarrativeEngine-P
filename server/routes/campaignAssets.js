import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR } from '../lib/fileStore.js';

/**
 * Serves each campaign's generated scene images, and nothing else.
 *
 * This used to be `express.static(CAMPAIGNS_DIR)` mounted at
 * `/assets/campaigns`, which served the entire campaign data directory to
 * satisfy one sub-folder: every `<id>.state.json`, `<id>.archive.md`,
 * `<id>.npcs.json` and mod table was a plain GET away. It also sat outside
 * the `/api` fetch-site guard, so it had one fewer layer than the API itself.
 *
 * Scene images are the only URLs the app ever generates under this prefix
 * (`imageProvider.js`), so the route accepts exactly that shape. Every
 * existing image URL keeps working unchanged.
 */

// Campaign ids, as `fileStore.validateCampaignId` accepts them.
const CAMPAIGN_ID = /^[a-zA-Z0-9_-]+$/;
// A single path segment with a raster image extension. Generated names are
// `<id>.png`; the other extensions cover images a provider may return later.
const IMAGE_FILE = /^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif|avif)$/i;

export function createCampaignAssetsRouter() {
    const router = Router();

    router.get('/assets/campaigns/:campaignId/scene-images/:file', (req, res) => {
        const { campaignId, file } = req.params;
        if (!CAMPAIGN_ID.test(campaignId) || !IMAGE_FILE.test(file)) {
            res.status(404).end();
            return;
        }
        // `root` confines the lookup to this campaign's image folder even if a
        // name slipped past the patterns above; dotfiles are refused outright.
        res.sendFile(file, {
            root: path.join(CAMPAIGNS_DIR, campaignId, 'scene-images'),
            dotfiles: 'deny',
        }, (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    });

    return router;
}
