import { describe, it, expect } from 'vitest';
import {
    EMBEDDING_MODELS,
    DEFAULT_EMBEDDING_MODEL_KEY,
    getModelSpec,
    formatQuery,
    formatPassage,
    resolveModelKey,
} from '../lib/embedder.js';
import { resolveVectorSchema } from '../lib/vectorStore.js';

describe('embedding model registry', () => {
    it('keeps mxbai as the built-in English default, unchanged', () => {
        expect(DEFAULT_EMBEDDING_MODEL_KEY).toBe('english');
        expect(EMBEDDING_MODELS.english).toMatchObject({
            id: 'mixedbread-ai/mxbai-embed-large-v1',
            dims: 1024,
            dtype: 'q8',
            passagePrefix: '',
            maxInputTokens: 512,
        });
    });

    it('offers multilingual-e5-small as the opt-in download', () => {
        expect(EMBEDDING_MODELS.multilingual).toMatchObject({
            id: 'Xenova/multilingual-e5-small',
            dims: 384,
            dtype: 'q8',
            queryPrefix: 'query: ',
            passagePrefix: 'passage: ',
        });
        expect(EMBEDDING_MODELS.multilingual.approxDownloadMB).toBeGreaterThan(0);
    });

    it('falls back to the default spec for an unknown key', () => {
        expect(getModelSpec('klingon')).toBe(EMBEDDING_MODELS.english);
        expect(getModelSpec(undefined)).toBe(EMBEDDING_MODELS.english);
    });
});

describe('query / passage prefixes', () => {
    it('gives mxbai its retrieval instruction on queries and nothing on passages', () => {
        expect(formatQuery('who is Helena', 'english'))
            .toBe('Represent this sentence for searching relevant passages: who is Helena');
        expect(formatPassage('Helena opened the gate.', 'english')).toBe('Helena opened the gate.');
    });

    it('gives e5 its query: and passage: prefixes', () => {
        expect(formatQuery('scena 598', 'multilingual')).toBe('query: scena 598');
        expect(formatPassage('Helena otworzyła bramę.', 'multilingual')).toBe('passage: Helena otworzyła bramę.');
    });
});

describe('resolveModelKey', () => {
    const none = () => false;
    const all = () => true;

    it('runs the default when nothing or something unknown is chosen', () => {
        expect(resolveModelKey(undefined, all)).toBe('english');
        expect(resolveModelKey('bogus', all)).toBe('english');
    });

    it('runs the chosen model only once it is downloaded', () => {
        expect(resolveModelKey('multilingual', all)).toBe('multilingual');
        // A failed or unfinished download, or deleted files: keep the built-in model.
        expect(resolveModelKey('multilingual', none)).toBe('english');
    });

    it('never needs a download check for the default', () => {
        expect(resolveModelKey('english', none)).toBe('english');
    });
});

describe('resolveVectorSchema', () => {
    const MX = 'mixedbread-ai/mxbai-embed-large-v1';
    const E5 = 'Xenova/multilingual-e5-small';

    it('reads a settings file from before model choice as the same model', () => {
        expect(resolveVectorSchema({ embeddingDims: 1024 }, MX, 1024))
            .toEqual({ dims: 1024, modelChanged: false, storedModelId: null });
    });

    it('flags a model change and takes the new model size', () => {
        expect(resolveVectorSchema({ embeddingDims: 1024, embeddingModelId: MX }, E5, 384))
            .toEqual({ dims: 384, modelChanged: true, storedModelId: MX });
    });

    it('flags a model change even when the sizes match', () => {
        expect(resolveVectorSchema({ embeddingDims: 1024, embeddingModelId: 'other/model-1024' }, MX, 1024).modelChanged)
            .toBe(true);
    });

    it('is unchanged when the stored model is the running one', () => {
        expect(resolveVectorSchema({ embeddingDims: 384, embeddingModelId: E5 }, E5, 384))
            .toEqual({ dims: 384, modelChanged: false, storedModelId: E5 });
    });
});
