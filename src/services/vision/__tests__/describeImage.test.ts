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
        race: 'human, East Asian',
        gender: 'female',
        ageRange: 'early 20s',
        build: 'lean',
        symmetry: 'striking',
        hairStyle: 'long black, braided',
        eyeColor: 'dark brown',
        skinTone: 'light olive',
        gait: 'upright, guarded',
        distinctMarks: 'scar across left brow',
        clothing: 'lacquered scale armour, red sash',
        artStyle: 'Stylized Anime',
        appearance: 'A young woman in lacquered scale armour, a red sash at her waist.',
    });

    it('maps every observed field into the visual profile', () => {
        const out = parseVisionDescription(full);
        expect(out.visualProfile.race).toBe('human, East Asian');
        expect(out.visualProfile.distinctMarks).toBe('scar across left brow');
        expect(out.appearance).toContain('lacquered scale armour');
    });

    it('accepts an artStyle only when it is in the controlled vocabulary', () => {
        expect(parseVisionDescription(full).visualProfile.artStyle).toBe('Stylized Anime');
        const bogus = JSON.stringify({ race: 'elf', artStyle: 'Deep Fried Meme', appearance: 'x' });
        expect(parseVisionDescription(bogus).visualProfile.artStyle).toBeUndefined();
    });

    it('matches artStyle case-insensitively and returns the canonical casing', () => {
        const lower = JSON.stringify({ race: 'elf', artStyle: 'stylized anime', appearance: 'x' });
        expect(parseVisionDescription(lower).visualProfile.artStyle).toBe('Stylized Anime');
    });

    it('drops empty fields rather than writing blanks over existing values', () => {
        const sparse = JSON.stringify({ race: 'orc', gender: '', distinctMarks: '   ', appearance: 'An orc.' });
        const out = parseVisionDescription(sparse);
        expect(out.visualProfile.race).toBe('orc');
        expect('gender' in out.visualProfile).toBe(false);
        expect('distinctMarks' in out.visualProfile).toBe(false);
    });

    it('clamps runaway fields so they still fit the single-line inputs', () => {
        const long = JSON.stringify({ race: 'x'.repeat(500), appearance: 'y'.repeat(2000) });
        const out = parseVisionDescription(long);
        expect(out.visualProfile.race!.length).toBeLessThanOrEqual(80);
        expect(out.appearance.length).toBeLessThanOrEqual(600);
    });

    it('ignores non-string values instead of stringifying them', () => {
        const weird = JSON.stringify({ race: { name: 'elf' }, gender: 42, appearance: 'An elf.' });
        const out = parseVisionDescription(weird);
        expect('race' in out.visualProfile).toBe(false);
        expect('gender' in out.visualProfile).toBe(false);
        expect(out.appearance).toBe('An elf.');
    });

    it('throws on unparseable output', () => {
        expect(() => parseVisionDescription('I cannot see images.')).toThrow(VisionParseError);
    });

    it('throws when the model returns valid JSON with nothing usable in it', () => {
        expect(() => parseVisionDescription('{"race":"","appearance":""}')).toThrow(VisionParseError);
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
