import { describe, it, expect, vi } from 'vitest';
import {
    buildDefaultComfyWorkflow,
    resolveComfyWorkflow,
    generateComfyUIImage,
} from '../services/comfyUiProvider.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngResponse() {
    return {
        ok: true,
        arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer.slice(0)),
    };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

const CONFIG = { endpoint: 'http://127.0.0.1:8188', modelName: 'sd_xl_base_1.0.safetensors' };

describe('comfyUiProvider — built-in graph & resolution', () => {
    it('built-in graph exposes the expected nodes and every placeholder', () => {
        const wf = buildDefaultComfyWorkflow();
        const classTypes = Object.values(wf).map((n) => n.class_type);

        expect(classTypes).toContain('CheckpointLoaderSimple');
        expect(classTypes).toContain('EmptyLatentImage');
        expect(classTypes).toContain('CLIPTextEncode');
        expect(classTypes).toContain('KSampler');
        expect(classTypes).toContain('VAEDecode');
        expect(classTypes).toContain('SaveImage');
        // Two CLIPTextEncode nodes (positive + negative).
        expect(classTypes.filter((c) => c === 'CLIPTextEncode')).toHaveLength(2);

        const serialized = JSON.stringify(wf);
        for (const token of [
            '%prompt%', '%negative_prompt%', '%seed%', '%width%', '%height%',
            '%steps%', '%cfg%', '%sampler%', '%scheduler%', '%denoise%', '%model%',
        ]) {
            expect(serialized).toContain(token);
        }
    });

    it('substitutes built-in placeholders and keeps numeric placeholders as numbers', () => {
        const resolved = resolveComfyWorkflow({}, {
            prompt: 'a lone knight',
            negative_prompt: 'blurry',
            seed: 42,
            width: 1280,
            height: 720,
            steps: 25,
            cfg: 7.5,
            sampler: 'dpmpp_2m',
            scheduler: 'karras',
            denoise: 1,
            model: 'my_ckpt.safetensors',
        });

        expect(resolved['6'].inputs.text).toBe('a lone knight');
        expect(resolved['7'].inputs.text).toBe('blurry');
        expect(resolved['4'].inputs.ckpt_name).toBe('my_ckpt.safetensors');

        // Standalone numeric placeholders must remain numbers, not stringified.
        expect(resolved['3'].inputs.seed).toBe(42);
        expect(typeof resolved['3'].inputs.seed).toBe('number');
        expect(resolved['3'].inputs.steps).toBe(25);
        expect(typeof resolved['3'].inputs.steps).toBe('number');
        expect(resolved['3'].inputs.cfg).toBe(7.5);
        expect(typeof resolved['3'].inputs.cfg).toBe('number');
        expect(resolved['5'].inputs.width).toBe(1280);
        expect(typeof resolved['5'].inputs.width).toBe('number');
        // Node graph wiring (array refs) is preserved untouched.
        expect(resolved['3'].inputs.latent_image).toEqual(['5', 0]);
    });

    it('parses a custom workflow and replaces values recursively (exact vs inline)', () => {
        const custom = JSON.stringify({
            '10': {
                class_type: 'CLIPTextEncode',
                inputs: {
                    text: 'masterpiece, %prompt%, detailed',
                    seed: '%seed%',
                    nested: { deep: ['%steps%', 'prefix-%model%-suffix'] },
                },
            },
        });

        const resolved = resolveComfyWorkflow({ customWorkflowJson: custom }, {
            prompt: 'a cat',
            seed: 99,
            steps: 30,
            model: 'dreamshaper.safetensors',
        });

        expect(resolved['10'].inputs.text).toBe('masterpiece, a cat, detailed');
        expect(resolved['10'].inputs.seed).toBe(99);
        expect(typeof resolved['10'].inputs.seed).toBe('number');
        expect(resolved['10'].inputs.nested.deep[0]).toBe(30);
        expect(typeof resolved['10'].inputs.nested.deep[0]).toBe('number');
        expect(resolved['10'].inputs.nested.deep[1]).toBe('prefix-dreamshaper.safetensors-suffix');
    });

    it('throws a useful error on invalid custom JSON', () => {
        expect(() => resolveComfyWorkflow({ customWorkflowJson: '{ not valid json' }, {}))
            .toThrow(/Invalid ComfyUI workflow JSON/);
    });

    it('rejects a custom workflow that is not a node object', () => {
        expect(() => resolveComfyWorkflow({ customWorkflowJson: '[1,2,3]' }, {}))
            .toThrow(/Save \(API Format\)/);
    });
});

describe('comfyUiProvider — generateComfyUIImage', () => {
    it('queue → history → view happy path returns a valid PNG buffer', async () => {
        const promptId = 'abc123';
        const calls = [];
        const fetchMock = vi.fn((url, opts) => {
            calls.push({ url, opts });
            if (url.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: promptId }));
            if (url.includes(`/history/${promptId}`)) {
                return Promise.resolve(jsonResponse({
                    [promptId]: {
                        outputs: { '9': { images: [{ filename: 'NarrativeEngine_00001_.png', subfolder: '', type: 'output' }] } },
                        status: { status_str: 'success', completed: true },
                    },
                }));
            }
            if (url.includes('/view?')) return Promise.resolve(pngResponse());
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        const buffer = await generateComfyUIImage({
            config: CONFIG,
            prompt: 'a knight',
            negativePrompt: 'blurry',
            width: 1280,
            height: 720,
            seed: 7,
            fetch: fetchMock,
            pollIntervalMs: 1,
        });

        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        // Workflow was POSTed under { prompt: ... } with the seed preserved as a number.
        const postCall = calls.find((c) => c.url.endsWith('/prompt'));
        const body = JSON.parse(postCall.opts.body);
        expect(body.prompt).toBeDefined();
        expect(body.prompt['3'].inputs.seed).toBe(7);
        // /view was queried with filename/subfolder/type.
        const viewCall = calls.find((c) => c.url.includes('/view?'));
        expect(viewCall.url).toContain('filename=NarrativeEngine_00001_.png');
        expect(viewCall.url).toContain('type=output');
    });

    it('discovers the first images[] output dynamically (not a hard-coded node id)', async () => {
        const promptId = 'p2';
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: promptId }));
            if (url.includes(`/history/${promptId}`)) {
                return Promise.resolve(jsonResponse({
                    [promptId]: {
                        outputs: {
                            '42': { text: ['ignore me'] },
                            '77': { images: [{ filename: 'out.png', subfolder: 'sub', type: 'temp' }] },
                        },
                        status: { completed: true },
                    },
                }));
            }
            if (url.includes('/view?')) return Promise.resolve(pngResponse());
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        const buffer = await generateComfyUIImage({ config: CONFIG, prompt: 'x', fetch: fetchMock, pollIntervalMs: 1 });
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    it('fails when the endpoint protocol is not http(s)', async () => {
        await expect(generateComfyUIImage({
            config: { endpoint: 'ftp://127.0.0.1:8188', modelName: 'x' },
            prompt: 'x',
            fetch: vi.fn(),
        })).rejects.toThrow(/http or https/);
    });

    it('surfaces a rejected workflow with node errors (HTTP 400)', async () => {
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) {
                return Promise.resolve(jsonResponse(
                    { error: { message: 'invalid prompt' }, node_errors: { '3': { errors: ['bad ckpt'] } } },
                    { ok: false, status: 400 },
                ));
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        await expect(generateComfyUIImage({ config: CONFIG, prompt: 'x', fetch: fetchMock }))
            .rejects.toThrow(/rejected the workflow.*node_errors/s);
    });

    it('fails cleanly when no prompt_id is returned', async () => {
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) {
                return Promise.resolve(jsonResponse({ node_errors: { '6': { errors: ['bad'] } } }));
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        await expect(generateComfyUIImage({ config: CONFIG, prompt: 'x', fetch: fetchMock }))
            .rejects.toThrow(/did not return a prompt_id/);
    });

    it('reports a ComfyUI execution error from history status', async () => {
        const promptId = 'perr';
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: promptId }));
            if (url.includes(`/history/${promptId}`)) {
                return Promise.resolve(jsonResponse({
                    [promptId]: {
                        outputs: {},
                        status: {
                            status_str: 'error',
                            completed: false,
                            messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]],
                        },
                    },
                }));
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        await expect(generateComfyUIImage({ config: CONFIG, prompt: 'x', fetch: fetchMock, pollIntervalMs: 1 }))
            .rejects.toThrow(/execution failed: KSampler: CUDA out of memory/);
    });

    it('fails when generation completes but yields no image', async () => {
        const promptId = 'noimg';
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: promptId }));
            if (url.includes(`/history/${promptId}`)) {
                return Promise.resolve(jsonResponse({
                    [promptId]: { outputs: { '9': { gifs: [] } }, status: { completed: true } },
                }));
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        await expect(generateComfyUIImage({ config: CONFIG, prompt: 'x', fetch: fetchMock, pollIntervalMs: 1 }))
            .rejects.toThrow(/no image output/);
    });

    it('times out cleanly when history never completes', async () => {
        const promptId = 'pending';
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) return Promise.resolve(jsonResponse({ prompt_id: promptId }));
            if (url.includes(`/history/${promptId}`)) return Promise.resolve(jsonResponse({})); // never present
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });

        await expect(generateComfyUIImage({
            config: CONFIG,
            prompt: 'x',
            fetch: fetchMock,
            timeoutMs: 40,
            pollIntervalMs: 5,
        })).rejects.toThrow(/timed out/);
    });
});
