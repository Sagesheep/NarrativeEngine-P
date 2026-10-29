import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readingStyleVars, clampReadingSize, READING_DEFAULTS } from '../readingPrefs';
import { ReadingControls } from '../ReadingControls';
import { migrateSettings } from '../../../store/slices/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';

describe('readingStyleVars', () => {
    it('defaults to 17px, 1.55 leading and a ~34em measure plus the rail gutter', () => {
        expect(readingStyleVars({})).toEqual({
            '--reading-size': '17px',
            '--reading-leading': '1.55',
            '--reading-measure': `${17 * 34 + 44}px`,
        });
    });

    it('scales the measure with the size, so line length holds when text grows', () => {
        const small = readingStyleVars({ readingSize: 14, readingWidth: 'standard' });
        const large = readingStyleVars({ readingSize: 22, readingWidth: 'standard' });
        expect(small['--reading-measure' as keyof typeof small]).toBe(`${14 * 34 + 44}px`);
        expect(large['--reading-measure' as keyof typeof large]).toBe(`${22 * 34 + 44}px`);
    });

    it('full width removes the cap', () => {
        const vars = readingStyleVars({ readingWidth: 'full' });
        expect(vars['--reading-measure' as keyof typeof vars]).toBe('none');
    });

    it('falls back to defaults on junk values', () => {
        const vars = readingStyleVars({
            readingSize: Number.NaN,
            readingLeading: 'huge' as never,
            readingWidth: 'mega' as never,
        });
        expect(vars).toEqual(readingStyleVars({}));
    });

    it('clamps size to the supported range', () => {
        expect(clampReadingSize(4)).toBe(13);
        expect(clampReadingSize(99)).toBe(24);
        expect(clampReadingSize(16.6)).toBe(17);
    });
});

describe('migrateSettings — reading settings', () => {
    it('fills defaults for settings saved before the fields existed', () => {
        const out = migrateSettings({ settings: { providers: [], presets: [] } });
        expect(out).toMatchObject(READING_DEFAULTS);
    });

    it('keeps saved values and repairs invalid ones', () => {
        const out = migrateSettings({
            settings: { providers: [], presets: [], readingFont: 'sans', readingSize: 40, readingLeading: 'tight', readingWidth: 'nope', readingAlign: 'sideways' },
        });
        expect(out).toMatchObject({ readingFont: 'sans', readingSize: 24, readingLeading: 'tight', readingWidth: 'standard', readingAlign: 'center' });
    });
});

describe('ReadingControls', () => {
    const initial = useAppStore.getState().settings;
    afterEach(() => useAppStore.setState({ settings: initial }));

    it('opens a panel whose choices write the persisted settings', () => {
        useAppStore.setState({ settings: { ...initial, ...READING_DEFAULTS } });
        render(<ReadingControls />);
        fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }));

        fireEvent.click(screen.getByRole('button', { name: 'Sans' }));
        fireEvent.click(screen.getByRole('button', { name: 'Larger text' }));
        fireEvent.click(screen.getByRole('button', { name: 'Relaxed' }));
        fireEvent.click(screen.getByRole('button', { name: 'Narrow' }));
        fireEvent.click(screen.getByRole('button', { name: 'Right' }));

        expect(useAppStore.getState().settings).toMatchObject({
            readingFont: 'sans', readingSize: 18, readingLeading: 'relaxed', readingWidth: 'narrow', readingAlign: 'right',
        });

        fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
        expect(useAppStore.getState().settings).toMatchObject(READING_DEFAULTS);
    });

    it('closes on Escape', () => {
        render(<ReadingControls />);
        fireEvent.click(screen.getByRole('button', { name: 'Reading settings' }));
        expect(screen.getByRole('dialog')).toBeTruthy();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
