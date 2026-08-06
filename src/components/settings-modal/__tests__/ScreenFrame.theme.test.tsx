import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ScreenFrame } from '../ScreenFrame';
import {
    DARK_SCREEN_THEME,
    LIGHT_SCREEN_THEME,
    SCREEN_THEME,
    resolveScreenTheme,
    getAppThemeMode,
} from '../../../services/mods/screenApiTypes';
import { modEventBus } from '../../../services/mods/events/eventBus';

function bootFrame(frame: HTMLIFrameElement): { nonce: string; target: Window; postSpy: ReturnType<typeof vi.spyOn> } {
    const target = frame.contentWindow;
    if (!target) throw new Error('jsdom did not create iframe.contentWindow');
    const postSpy = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
    fireEvent.load(frame);
    const init = postSpy.mock.calls.map(([message]) => message).find((message) => (
        typeof message === 'object' && message !== null && (message as { __screenInit?: boolean }).__screenInit === true
    )) as { nonce: string } | undefined;
    if (!init) throw new Error('ScreenFrame did not send its init message');
    return { nonce: init.nonce, target, postSpy };
}

afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
});

describe('Phase 4.6 — ScreenTheme token set extension & versioning', () => {
    it('defines DARK_SCREEN_THEME with version 2, mode dark, and interaction states', () => {
        expect(DARK_SCREEN_THEME.version).toBe(2);
        expect(DARK_SCREEN_THEME.mode).toBe('dark');
        expect(DARK_SCREEN_THEME.colors).toHaveProperty('hover');
        expect(DARK_SCREEN_THEME.colors).toHaveProperty('active');
        expect(DARK_SCREEN_THEME.colors).toHaveProperty('focus');
        expect(DARK_SCREEN_THEME.colors).toHaveProperty('selected');
        expect(DARK_SCREEN_THEME.colors).toHaveProperty('disabled');
    });

    it('defines LIGHT_SCREEN_THEME with version 2, mode light, and interaction states', () => {
        expect(LIGHT_SCREEN_THEME.version).toBe(2);
        expect(LIGHT_SCREEN_THEME.mode).toBe('light');
        expect(LIGHT_SCREEN_THEME.colors).toHaveProperty('hover');
        expect(LIGHT_SCREEN_THEME.colors).toHaveProperty('active');
        expect(LIGHT_SCREEN_THEME.colors).toHaveProperty('focus');
        expect(LIGHT_SCREEN_THEME.colors).toHaveProperty('selected');
        expect(LIGHT_SCREEN_THEME.colors).toHaveProperty('disabled');
    });

    it('retains all legacy v1 token keys for backward compatibility', () => {
        const requiredKeys = ['background', 'surface', 'border', 'text', 'muted', 'accent', 'danger'];
        for (const key of requiredKeys) {
            expect(DARK_SCREEN_THEME.colors).toHaveProperty(key);
            expect(LIGHT_SCREEN_THEME.colors).toHaveProperty(key);
        }
        expect(DARK_SCREEN_THEME.fontSizes).toEqual({ small: '11px', body: '13px', heading: '16px' });
        expect(DARK_SCREEN_THEME.radii).toEqual({ small: '4px', medium: '8px' });
    });

    it('resolveScreenTheme yields theme matching mode or document data-theme', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        expect(getAppThemeMode()).toBe('light');
        expect(resolveScreenTheme()).toEqual(LIGHT_SCREEN_THEME);

        document.documentElement.setAttribute('data-theme', 'dark');
        expect(getAppThemeMode()).toBe('dark');
        expect(resolveScreenTheme()).toEqual(DARK_SCREEN_THEME);

        expect(resolveScreenTheme('light')).toEqual(LIGHT_SCREEN_THEME);
        expect(resolveScreenTheme('dark')).toEqual(DARK_SCREEN_THEME);
    });

    it('exports default SCREEN_THEME for backward compatibility', () => {
        expect(SCREEN_THEME.version).toBe(2);
        expect(SCREEN_THEME.colors).toBeDefined();
    });
});

describe('Phase 4.6 — Live theme push updates to ScreenFrame', () => {
    it('pushes __screenThemeUpdate when modEventBus emits settings.changed with theme', () => {
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        const { postSpy } = bootFrame(frame);

        document.documentElement.setAttribute('data-theme', 'light');
        modEventBus.emit('settings.changed', { changedKeys: ['theme'] });

        const themeUpdate = postSpy.mock.calls.map(([message]) => message).find((message) => (
            typeof message === 'object' && message !== null && (message as { __screenThemeUpdate?: boolean }).__screenThemeUpdate === true
        )) as { __screenThemeUpdate: boolean; theme: typeof LIGHT_SCREEN_THEME } | undefined;

        expect(themeUpdate).toBeDefined();
        expect(themeUpdate?.theme.mode).toBe('light');
    });

    it('pushes __screenThemeUpdate when DOM data-theme attribute mutates', async () => {
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        const { postSpy } = bootFrame(frame);

        document.documentElement.setAttribute('data-theme', 'dark');
        await new Promise((r) => setTimeout(r, 20));

        const themeUpdate = postSpy.mock.calls.map(([message]) => message).find((message) => (
            typeof message === 'object' && message !== null && (message as { __screenThemeUpdate?: boolean }).__screenThemeUpdate === true
        )) as { __screenThemeUpdate: boolean; theme: typeof DARK_SCREEN_THEME } | undefined;

        expect(themeUpdate).toBeDefined();
        expect(themeUpdate?.theme.mode).toBe('dark');
    });
});
