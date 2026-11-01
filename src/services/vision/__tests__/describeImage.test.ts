import { describe, it, expect } from 'vitest';
import { parseVisionDescription, extractJsonObject, buildDescribeInstruction, VisionParseError } from '../describeImage';
import { parseDataUrl, computeScaledSize, estimateImageTokens, DEFAULT_MAX_EDGE } from '../imageSource';

describe('extractJsonObject', () => {
    it('strips markdown fences', () => {
        expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('isolates the object from surrounding prose', () => {
        expect(extractJsonObject('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
    });
});

describe('parseVisionDescription', () => {
    const full = JSON.stringify({
        appearance: 'A young East Asian woman in her early 20s, lean, in lacquered scale armour with a red sash. A scar crosses her left brow.',
        artStyle: 'Stylized Anime',
    });

    it('returns the appearance prose', () => {
        const out = parseVisionDescription(full);
        expect(out.appearance).toContain('lacquered scale armour');
        expect(out.appearance).toContain('scar crosses her left brow');
    });

    it('accepts an artStyle only when it is in the controlled vocabulary', () => {
        expect(parseVisionDescription(full).artStyle).toBe('Stylized Anime');
        const bogus = JSON.stringify({ artStyle: 'Deep Fried Meme', appearance: 'x' });
        expect(parseVisionDescription(bogus).artStyle).toBeUndefined();
    });

    it('matches artStyle case-insensitively and returns the canonical casing', () => {
        const lower = JSON.stringify({ artStyle: 'stylized anime', appearance: 'x' });
        expect(parseVisionDescription(lower).artStyle).toBe('Stylized Anime');
    });

    it('clamps a runaway appearance', () => {
        const out = parseVisionDescription(JSON.stringify({ appearance: 'y'.repeat(2000) }));
        expect(out.appearance.length).toBeLessThanOrEqual(700);
    });

    it('ignores a non-string appearance instead of stringifying it', () => {
        expect(() => parseVisionDescription(JSON.stringify({ appearance: { text: 'elf' } }))).toThrow(VisionParseError);
    });

    it('throws on unparseable output', () => {
        expect(() => parseVisionDescription('I cannot see images.')).toThrow(VisionParseError);
    });

    it('throws when the model returns valid JSON with nothing usable in it', () => {
        expect(() => parseVisionDescription('{"appearance":""}')).toThrow(VisionParseError);
    });
});

describe('buildDescribeInstruction', () => {
    it('names the subject when one is known', () => {
        expect(buildDescribeInstruction('Senna')).toContain('named Senna');
    });

    it('omits the name clause when there is none', () => {
        expect(buildDescribeInstruction()).not.toContain('named');
    });

    it('offers the art-style vocabulary so the model picks a valid value', () => {
        expect(buildDescribeInstruction()).toContain('Stylized Game Realism');
    });
});

describe('imageSource helpers', () => {
    it('parses a base64 image data URL', () => {
        expect(parseDataUrl('data:image/png;base64,QUJD')).toEqual({ mediaType: 'image/png', base64: 'QUJD' });
    });

    it('strips newlines that some encoders emit (providers reject them)', () => {
        expect(parseDataUrl('data:image/png;base64,QUJD\nRUZH')?.base64).toBe('QUJDRUZH');
    });

    it('rejects non-image and non-base64 data URLs', () => {
        expect(parseDataUrl('data:text/plain;base64,QUJD')).toBeNull();
        expect(parseDataUrl('https://example.com/a.png')).toBeNull();
        expect(parseDataUrl('data:image/png;base64,')).toBeNull();
    });

    it('fits an oversized image inside the box, preserving aspect ratio', () => {
        const out = computeScaledSize(2048, 1024, 768);
        expect(out).toEqual({ width: 768, height: 384, scaled: true });
    });

    it('never upscales an image that already fits', () => {
        expect(computeScaledSize(300, 200, 768)).toEqual({ width: 300, height: 200, scaled: false });
    });

    it('keeps the downscaled portrait cheap — the whole point of the cap', () => {
        // A 2048x2048 portrait costs ~5,600 input tokens; the cap brings it under 1k.
        expect(estimateImageTokens(2048, 2048)).toBeGreaterThan(5000);
        const { width, height } = computeScaledSize(2048, 2048, DEFAULT_MAX_EDGE);
        expect(estimateImageTokens(width, height)).toBeLessThan(1000);
    });
});
