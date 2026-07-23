import { describe, expect, it } from 'vitest';
import { buildPortraitPrompt } from '../portraitPrompt';
import type { NPCVisualProfile } from '../../../types';

const populatedProfile: NPCVisualProfile = {
    race: 'Human', gender: 'Woman', ageRange: 'Mid-twenties', build: 'Petite, fine-boned, poised',
    symmetry: 'Strikingly harmonious courtly beauty', hairStyle: 'Waist-length ink-black hair with a jade hairpin',
    eyeColor: 'Deep brown', skinTone: 'Warm ivory', gait: 'Deliberate dancer’s poise',
    distinctMarks: 'Beauty mark beneath the left eye', clothing: 'Layered jade and crimson embroidered silk robes',
    artStyle: 'Stylized Game Realism',
};

describe('buildPortraitPrompt', () => {
    it('uses structured fields instead of duplicating legacy appearance notes', () => {
        const prompt = buildPortraitPrompt(populatedProfile, 'Diao Chan', 'THIS LEGACY TEXT MUST NOT BE INCLUDED');
        expect(prompt).toContain('Clothing: Layered jade and crimson embroidered silk robes.');
        expect(prompt).not.toContain('THIS LEGACY TEXT MUST NOT BE INCLUDED');
    });

    it('keeps even long structured profiles within the image-provider limit', () => {
        const longProfile = Object.fromEntries(
            Object.keys(populatedProfile).map(key => [key, key + ' ' + 'detail '.repeat(80)]),
        ) as unknown as NPCVisualProfile;
        longProfile.artStyle = 'Stylized Game Realism';

        expect(buildPortraitPrompt(longProfile, 'A very long name '.repeat(30), 'Legacy text '.repeat(200)).length).toBeLessThanOrEqual(1_100);
    });
});
