import { describe, expect, it } from 'vitest';
import { buildChatBody, withThinkingReserve } from '../llmApiHelper';
import type { ApiFormat, EndpointConfig, ThinkingEffort } from '../../types';

const messages = [{ role: 'user', content: 'Hello' }];
const efforts: ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'max'];
const reasoningEfforts: ThinkingEffort[] = ['low', 'medium', 'high', 'max'];

const claudeProvider: EndpointConfig = {
    endpoint: 'https://api.anthropic.com',
    apiKey: 'test-key',
    modelName: 'claude-sonnet',
    apiFormat: 'claude',
};
const geminiProvider: EndpointConfig = {
    endpoint: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-key',
    modelName: 'gemini-2.0-flash',
    apiFormat: 'gemini',
};
const openaiProvider: EndpointConfig = {
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelName: 'gpt-4o',
    apiFormat: 'openai',
};
const ollamaProvider: EndpointConfig = {
    endpoint: 'http://localhost:11434',
    apiKey: '',
    modelName: 'llama3',
    apiFormat: 'ollama',
};

const providers: Array<[ApiFormat, EndpointConfig]> = [
    ['claude', claudeProvider],
    ['gemini', geminiProvider],
    ['openai', openaiProvider],
    ['ollama', ollamaProvider],
];

describe('thinking token reserve', () => {
    it('keeps thinking-off request bodies byte-identical', () => {
        for (const [, provider] of providers) {
            const inheritedOff = buildChatBody(
                { ...provider, thinkingEffort: 'off' },
                messages,
                { stream: false, max_tokens: 800, temperature: 0.2 },
            );
            const explicitOff = buildChatBody(
                provider,
                messages,
                { stream: false, max_tokens: 800, temperature: 0.2, thinkingEffort: 'off' },
            );
            expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(inheritedOff));
        }
    });

    it('keeps Claude answer capacity above its exact thinking budget', () => {
        for (const effort of reasoningEfforts) {
            for (const answerTokens of [10, 800, 4096]) {
                const body = buildChatBody(claudeProvider, messages, {
                    max_tokens: answerTokens,
                    thinkingEffort: effort,
                });
                const thinking = body.thinking as { budget_tokens: number };
                expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
            }
        }
    });

    it('leaves Gemini answer capacity intact after its exact thinking budget', () => {
        for (const effort of reasoningEfforts) {
            for (const answerTokens of [10, 800, 4096]) {
                const body = buildChatBody(geminiProvider, messages, {
                    max_tokens: answerTokens,
                    thinkingEffort: effort,
                });
                const generationConfig = body.generationConfig as {
                    maxOutputTokens: number;
                    thinkingConfig: { thinkingBudget: number };
                };
                expect(generationConfig.maxOutputTokens - generationConfig.thinkingConfig.thinkingBudget)
                    .toBeGreaterThanOrEqual(answerTokens);
            }
        }
    });

    it('does not apply the OpenAI ceiling to Claude exact reserves', () => {
        const body = buildChatBody(
            { ...claudeProvider, maxOutputTokens: 1000 },
            messages,
            { max_tokens: 800, thinkingEffort: 'max' },
        );
        expect(body.max_tokens).toBe(800 + 16384);
    });

    it('clamps OpenAI thinking headroom to the declared ceiling', () => {
        const body = buildChatBody(
            { ...openaiProvider, maxOutputTokens: 3000 },
            messages,
            { max_tokens: 800, thinkingEffort: 'high' },
        );
        expect(body.max_tokens).toBe(3000);
    });

    it('clamps OpenAI thinking headroom to 8192 when the ceiling is unknown', () => {
        const body = buildChatBody(
            openaiProvider,
            messages,
            { max_tokens: 800, thinkingEffort: 'high' },
        );
        expect(body.max_tokens).toBe(8192);
    });

    it('never lets the conservative clamp eat a large requested answer', () => {
        const body = buildChatBody(
            openaiProvider,
            messages,
            { max_tokens: 20000, thinkingEffort: 'high' },
        );
        expect(body.max_tokens as number).toBeGreaterThanOrEqual(20000);
    });

    it('leaves Ollama max_tokens untouched at every thinking effort', () => {
        for (const effort of efforts) {
            const body = buildChatBody(ollamaProvider, messages, {
                max_tokens: 800,
                thinkingEffort: effort,
            });
            expect(body.max_tokens).toBe(800);
        }
    });

    it('is monotonic for every format, effort, answer, and ceiling', () => {
        for (const [format] of providers) {
            for (const effort of efforts) {
                for (const answerTokens of [0, 10, 800, 20000]) {
                    for (const ceiling of [undefined, 1000, 8192, 30000]) {
                        expect(withThinkingReserve(format, effort, answerTokens, ceiling))
                            .toBeGreaterThanOrEqual(answerTokens);
                    }
                }
            }
        }
    });

    it('applies the reserve to the resolved sampling.max_tokens value', () => {
        const body = buildChatBody(openaiProvider, messages, {
            sampling: { max_tokens: 500 },
            thinkingEffort: 'low',
        });
        expect(body.max_tokens as number).toBeGreaterThan(500);
    });
});