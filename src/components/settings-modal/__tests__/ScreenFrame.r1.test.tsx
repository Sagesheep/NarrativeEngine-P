import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ScreenFrame } from '../ScreenFrame';
import { SCREEN_FRAME_CSP, SCREEN_SANDBOX_ATTRIBUTE, buildScreenSrcDoc } from '../screenFrameBuild';
import { screenFaultStore, formatScreenFaultReason } from '../../../services/mods/screenFaults';
import type { ScreenFaultKind } from '../../../services/mods/screenFaults';

const here = dirname(fileURLToPath(import.meta.url));
const componentPath = join(here, '..', 'screenFrameBuild.ts');

function bootFrame(frame: HTMLIFrameElement): { nonce: string; target: Window } {
    const target = frame.contentWindow;
    if (!target) throw new Error('jsdom did not create iframe.contentWindow');
    const postSpy = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
    fireEvent.load(frame);
    const init = postSpy.mock.calls.map(([message]) => message).find((message) => (
        typeof message === 'object' && message !== null && (message as { __screenInit?: boolean }).__screenInit === true
    )) as { nonce: string } | undefined;
    if (!init) throw new Error('ScreenFrame did not send its init message');
    return { nonce: init.nonce, target };
}

function sendFrom(target: Window, data: unknown): void {
    fireEvent(window, new MessageEvent('message', { source: target, data }));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ScreenFrame — R1 sandbox and authentication', () => {
    it('renders an iframe with sandbox="allow-scripts"', () => {
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        expect(screen.getByTitle('m.s').getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('keeps the sandbox constant limited to allow-scripts', () => {
        expect(SCREEN_SANDBOX_ATTRIBUTE).toBe('allow-scripts');
        expect(SCREEN_SANDBOX_ATTRIBUTE).not.toContain('allow-same-origin');
    });

    it('source-scans the srcdoc builder for the forbidden same-origin token', async () => {
        const source = await readFile(componentPath, 'utf-8');
        expect(source).toContain('allow-scripts');
        expect(source).not.toMatch(/allow-same-origin/);
    });

    it('does not put the forbidden same-origin token in srcdoc', () => {
        expect(buildScreenSrcDoc('export default function () {}', SCREEN_FRAME_CSP)).not.toMatch(/allow-same-origin/);
    });

    it('rejects a message from a different frame even when its shape is valid', () => {
        const onFault = vi.fn();
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" onFault={onFault} />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        bootFrame(frame);
        sendFrom(window, { __screenRequest: true, id: 1, nonce: 'forged', capability: 'theme' });
        expect(onFault).not.toHaveBeenCalled();
        expect(screen.getByTitle('m.s')).toBeInTheDocument();
    });

    it('rejects a matching-source message with the wrong nonce', () => {
        const onFault = vi.fn();
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" onFault={onFault} />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        bootFrame(frame);
        sendFrom(frame.contentWindow!, { __screenRequest: true, id: 1, nonce: 'wrong', capability: 'theme' });
        expect(onFault).toHaveBeenCalledWith({ modId: 'm', screenId: 's', kind: 'denied', message: 'invalid screen nonce' });
    });
});

describe('ScreenFrame — CSP and lifecycle wiring', () => {
    it('puts the CSP meta before scripts in srcdoc', () => {
        const srcdoc = buildScreenSrcDoc('export default function () {}', SCREEN_FRAME_CSP);
        expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<script>'));
    });

    it('pins the exact default-src none policy', () => {
        expect(SCREEN_FRAME_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:");
    });

    it('does not add a network-capable CSP directive', () => {
        expect(buildScreenSrcDoc('export default function () {}', SCREEN_FRAME_CSP)).not.toMatch(/connect-src|font-src|frame-src|media-src|object-src/);
    });

    it('renders one iframe and removes it on unmount', () => {
        const result = render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        expect(result.container.querySelectorAll('iframe')).toHaveLength(1);
        result.unmount();
        expect(result.container.querySelectorAll('iframe')).toHaveLength(0);
    });

    it('does not create a second iframe on a same-source rerender', () => {
        const result = render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        result.rerender(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        expect(result.container.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('renders separate frames for separate screens', () => {
        const result = render(
            <>
                <ScreenFrame modId="m" screen={{ id: 'a', file: 'a.js' }} source="export default function () {}" />
                <ScreenFrame modId="m" screen={{ id: 'b', file: 'b.js' }} source="export default function () {}" />
            </>,
        );
        expect(result.container.querySelectorAll('iframe')).toHaveLength(2);
    });

    it('sends one init message carrying a nonce and token data on load', () => {
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        const { nonce } = bootFrame(frame);
        expect(nonce).toMatch(/^[a-f0-9-]+$/);
    });

    it('keeps the frame mounted for a message from another window', () => {
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        bootFrame(frame);
        sendFrom(window, { __screenFault: true, nonce: 'wrong', kind: 'threw', message: 'spoof' });
        expect(screen.getByTitle('m.s')).toBeInTheDocument();
    });
});

describe('ScreenFrame — faults and Extensions projection', () => {
    beforeEach(() => screenFaultStore.clear());
    afterEach(() => screenFaultStore.clear());

    it('faults a frame when its authenticated source reports a throw', () => {
        const onFault = vi.fn();
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" onFault={onFault} />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        const { nonce, target } = bootFrame(frame);
        sendFrom(target, { __screenFault: true, nonce, kind: 'threw', message: 'boom' });
        expect(screen.queryByTitle('m.s')).toBeNull();
        expect(onFault).toHaveBeenCalledWith({ modId: 'm', screenId: 's', kind: 'threw', message: 'boom' });
    });

    it('projects a denied API fault to the Extensions fault shape', () => {
        const file = 'screen-mod.mod.json';
        render(
            <ScreenFrame
                modId="screen-mod"
                screen={{ id: 'main-screen', file }}
                source="export default function () {}"
                onFault={(fault) => screenFaultStore.add({
                    modId: fault.modId,
                    screenId: fault.screenId,
                    file,
                    kind: fault.kind as ScreenFaultKind,
                    reason: formatScreenFaultReason({
                        modName: 'Screen Mod',
                        screenId: fault.screenId,
                        kind: fault.kind,
                        message: fault.message,
                    }),
                })}
            />,
        );
        const frame = screen.getByTitle('screen-mod.main-screen') as HTMLIFrameElement;
        const { nonce, target } = bootFrame(frame);
        sendFrom(target, { __screenRequest: true, id: 1, nonce, capability: 'unknown' });
        expect(screenFaultStore.getFaults()).toEqual([{ file, reason: 'Screen Mod: screen "main-screen": denied (unknown capability "unknown")' }]);
    });

    it('formats all message-boundary fault kinds', () => {
        expect(formatScreenFaultReason({ modName: 'M', screenId: 'S', kind: 'denied', message: 'x' })).toContain('denied');
        expect(formatScreenFaultReason({ modName: 'M', screenId: 'S', kind: 'flood', message: 'x' })).toContain('message flood');
        expect(formatScreenFaultReason({ modName: 'M', screenId: 'S', kind: 'malformed', message: 'x' })).toContain('malformed');
    });

    it('keeps the app frame isolated from a fault', () => {
        const onFault = vi.fn();
        render(<ScreenFrame modId="m" screen={{ id: 's', file: 's.js' }} source="export default function () {}" onFault={onFault} />);
        const frame = screen.getByTitle('m.s') as HTMLIFrameElement;
        const { nonce, target } = bootFrame(frame);
        sendFrom(target, { __screenFault: true, nonce, kind: 'malformed', message: 'bad request' });
        expect(document.body).toBeTruthy();
        expect(onFault).toHaveBeenCalledTimes(1);
    });
});
