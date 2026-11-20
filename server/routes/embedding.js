import os from 'os';
import { Router } from 'express';
import { isModelReady } from '../lib/embedder.js';
import { getActiveJobs } from '../lib/embedJobs.js';
import { getVectorHealth } from '../lib/vectorStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import {
    getEmbeddingModelStatus,
    selectEmbeddingModel,
    EmbeddingModelError,
} from '../services/embeddingModelService.js';

/**
 * Suggest an indexing-speed default from the host's CPU/RAM. Conservative on purpose:
 * embedding is CPU-bound and shares the box with the game, so we only recommend
 * 'aggressive' on clearly capable machines.
 */
function suggestSpeed(cores, totalMemGB) {
    if (cores >= 12 && totalMemGB >= 16) return 'aggressive';
    if (cores >= 6 && totalMemGB >= 8) return 'balanced';
    return 'eco';
}

export function createEmbeddingRouter() {
    const router = Router();

    // Live embedder state: is the model warm, and what bulk embeds are in flight.
    // Polled by the client to drive the indexing snackbar. `?campaignId=` filters jobs.
    router.get('/api/embedding/runtime', wrapAsync((req, res) => {
        res.json({
            modelReady: isModelReady(),
            jobs: getActiveJobs(req.query.campaignId),
            vectorHealth: getVectorHealth(req.query.campaignId),
        });
    }));

    // Embedding model choice: which is selected and running, whether each is
    // downloaded, and the progress of a download or the re-index after a switch.
    router.get('/api/embedding/model', wrapAsync((_req, res) => {
        res.json(getEmbeddingModelStatus());
    }));

    // Choose a model: switches at once when it is on disk, otherwise starts the
    // download (202) and switches when it finishes. Poll GET for progress.
    router.post('/api/embedding/model', wrapAsync((req, res) => {
        try {
            const { status } = selectEmbeddingModel(req.body?.key);
            res.status(status === 'downloading' ? 202 : 200).json({ result: status, ...getEmbeddingModelStatus() });
        } catch (err) {
            if (err instanceof EmbeddingModelError) return res.status(err.status).json({ error: err.message });
            throw err;
        }
    }));

    // Host hardware summary + a suggested indexing speed. Used once on first run to
    // offer a sensible default the user can accept or change.
    router.get('/api/system/specs', wrapAsync((_req, res) => {
        const cores = os.cpus()?.length ?? 0;
        const totalMemGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
        res.json({
            cores,
            totalMemGB,
            cpuModel: os.cpus()?.[0]?.model?.trim() ?? 'unknown',
            suggestedSpeed: suggestSpeed(cores, totalMemGB),
        });
    }));

    return router;
}
