import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir;
let originalDataDir;

describe('TTS persisted model status', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-tts-test-'));
        originalDataDir = process.env.DATA_DIR;
        process.env.DATA_DIR = tmpDir;
        vi.resetModules();
    });

    afterEach(() => {
        if (originalDataDir) process.env.DATA_DIR = originalDataDir;
        else delete process.env.DATA_DIR;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('reports a downloaded model as cached before startup warmup finishes', async () => {
        const modelFile = path.join(
            tmpDir,
            '.tts_cache',
            '.cache',
            'onnx-community',
            'Kokoro-82M-v1.0-ONNX',
            'onnx',
            'model_quantized.onnx',
        );
        fs.mkdirSync(path.dirname(modelFile), { recursive: true });
        fs.writeFileSync(modelFile, 'model');

        const { getTtsStatus, isTtsModelCached } = await import('../lib/tts.js');

        expect(isTtsModelCached()).toBe(true);
        expect(getTtsStatus()).toMatchObject({
            modelCached: true,
            modelReady: false,
            initializing: false,
        });
    });
});