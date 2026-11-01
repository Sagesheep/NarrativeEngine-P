import { describe, expect, it } from 'vitest';
import { buildPortraitPrompt } from '../portraitPrompt';

const subject = {
    appearance: 'Human woman in her mid-twenties, petite and poised. Waist-length ink-black hair with a jade hairpin, deep brown eyes, warm ivory skin. Wears layered jade and crimson embroidered silk robes. A beauty mark beneath the left eye.',
    artStyle: 'Stylized Game Realism',
};

describe('buildPortraitPrompt', () => {
    it('sends the whole appearance paragraph', () => {
        const prompt = buildPortraitPrompt(subject, 'Diao Chan');
        expect(prompt).toContain('Appearance: Human woman in her mid-twenties');
        expect(prompt).toContain('beauty mark beneath the left eye');
    });

    it('drops the generator\'s "[inferred]" tag', () => {
        const prompt = buildPortraitPrompt({ appearance: '[inferred] A tall elf.' }, 'X');
        expect(prompt).toContain('Appearance: A tall elf.');
        expect(prompt).not.toContain('[inferred]');
    });

    it('never sends the character name to the image model', () => {
        // A name is not visual information, and labelling it makes models letter it into
        // the frame — as a caption, a signature, or CJK calligraphy for rosters like this.
        const prompt = buildPortraitPrompt(subject, 'Diao Chan');
        expect(prompt).not.toContain('Diao Chan');
        expect(prompt).not.toContain('Name:');
    });

    it('forbids writing in the positive prompt, which is all OpenRouter honours', () => {
        const prompt = buildPortraitPrompt(subject, 'Diao Chan');
        expect(prompt).toContain('free of writing');
        expect(prompt).toContain('calligraphy');
    });

    it('omits the Appearance clause when there is nothing to describe', () => {
        expect(buildPortraitPrompt({ appearance: 'Unknown' }, 'X')).not.toContain('Appearance:');
    });

    it('keeps a long appearance within the image-provider limit', () => {
        const prompt = buildPortraitPrompt({ appearance: 'detail '.repeat(800) }, 'A very long name '.repeat(30));
        expect(prompt.length).toBeLessThanOrEqual(1_300);
    });

    it('uses the image provider limit when one is set, so a long appearance is not cut', () => {
        const longAppearance = 'Charcoal tailored suit, ' + 'smart-fabric lining with faint LED piping, '.repeat(20);
        expect(buildPortraitPrompt({ appearance: longAppearance }, 'X')).not.toContain(longAppearance.trim());
        const roomy = buildPortraitPrompt({ appearance: longAppearance }, 'X', 4_000);
        expect(roomy).toContain(longAppearance.trim());
        expect(roomy.length).toBeLessThanOrEqual(4_000);
    });
});
