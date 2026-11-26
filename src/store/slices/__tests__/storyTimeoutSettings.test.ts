import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings } from '../settingsHelpers';

describe('story timeout persistence and migration', () => {
    it('gives new and existing installations the ten-minute default', () => {
        expect(defaultSettings.storyTimeoutSeconds).toBe(600);
        expect(migrateSettings({}).storyTimeoutSeconds).toBe(600);
    });

    it('preserves a saved preference across settings reloads', () => {
        const saved = migrateSettings({ storyTimeoutSeconds: 1200 });
        expect(migrateSettings({ settings: saved }).storyTimeoutSeconds).toBe(1200);
    });

    it.each([null, '900', 0, -1, NaN, Infinity])('replaces invalid saved value %s with the default', value => {
        expect(migrateSettings({ storyTimeoutSeconds: value }).storyTimeoutSeconds).toBe(600);
    });

    it.each([[1, 30], [7200, 3600], [60.5, 61]])('bounds saved value %s to %s seconds', (value, expected) => {
        expect(migrateSettings({ storyTimeoutSeconds: value }).storyTimeoutSeconds).toBe(expected);
    });
});
