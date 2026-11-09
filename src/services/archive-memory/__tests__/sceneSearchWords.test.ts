import { beforeEach, describe, expect, it } from 'vitest';
import { clearArchiveIdfCache, computeArchiveIdf, sceneSearchWords } from '../idf';
import { scoreEntry } from '../scoring';
import type { ArchiveIndexEntry } from '../../../types';

const entry = (sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry => ({
    sceneId, timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', ...over,
});

beforeEach(() => clearArchiveIdfCache());

describe('sceneSearchWords', () => {
    it('uses the definition words when a scene has a definition', () => {
        const scene = entry('001', { keywordStrengths: { tavern: 0.9 }, definition: 'Grey forges an IOU in Marken.' });
        expect(sceneSearchWords(scene)).toEqual({ grey: 1, forges: 1, iou: 1, marken: 1 });
    });

    it('keeps the full-text keywords for a scene without one', () => {
        expect(sceneSearchWords(entry('001', { keywordStrengths: { tavern: 0.9 } }))).toEqual({ tavern: 0.9 });
        expect(sceneSearchWords(entry('002'))).toEqual({});
    });
});

describe('keyword ranking over definitions', () => {
    it('a defined scene matches on its definition, not on words only in its full text', () => {
        const scene = entry('001', { keywordStrengths: { tavern: 1 }, definition: 'Grey forges an IOU in Marken.' });
        const idf = { tavern: 1, iou: 1 };
        expect(scoreEntry(scene, '', { tavern: 1 }, 1, idf).keywordRelevance).toBe(0);
        expect(scoreEntry(scene, '', { iou: 1 }, 1, idf).keywordRelevance).toBe(2);
    });

    it('IDF counts definition words, and refreshes when definitions are added later', () => {
        const before = [entry('001', { keywordStrengths: { tavern: 1 } }), entry('002', { keywordStrengths: { tavern: 1 } })];
        expect(computeArchiveIdf(before, 'c1').iou).toBeUndefined();

        const after = [{ ...before[0], definition: 'Grey forges an IOU in Marken.' }, before[1]];
        expect(computeArchiveIdf(after, 'c1').iou).toBeGreaterThan(0);
    });
});
