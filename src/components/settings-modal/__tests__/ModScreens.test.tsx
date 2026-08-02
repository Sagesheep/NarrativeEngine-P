import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModScreens } from '../ModScreens';
import { screenFaultStore } from '../../../services/mods/screenFaults';
import type { ValidatedMod } from '../../../services/mods/modTypes';

const modWithScreen: ValidatedMod = {
    id: 'gate-mod',
    name: 'Gate Mod',
    version: '1.0.0',
    description: 'A mod declaring a screen.',
    file: 'gate.mod.json',
    contributions: [{ id: 'placeholder', order: 990, text: '.' }],
    tables: [],
    panels: [],
    screens: [{ id: 'gate-screen', file: 'gate.js', label: 'Gate Screen' }],
    screenSources: ['export default function () { document.body.innerHTML = "<p>ok</p>"; }'],
};

function bootFrame(frame: HTMLIFrameElement): { nonce: string; target: Window } {
    const target = frame.contentWindow;
    if (!target) throw new Error('jsdom did not create iframe.contentWindow');
    const postSpy = vi.spyOn(target, 'postMessage').mockImplementation(() => undefined);
    fireEvent.load(frame);
    const init = postSpy.mock.calls.map(([message]) => message).find((message) => (
        typeof message === 'object' && message !== null && (message as { __screenInit?: boolean }).__screenInit === true
    )) as { nonce: string } | undefined;
    if (!init) throw new Error('ScreenFrame did not send init');
    return { nonce: init.nonce, target };
}

describe('ModScreens — Extensions rendering', () => {
    beforeEach(() => screenFaultStore.clear());
    afterEach(() => {
        screenFaultStore.clear();
        vi.restoreAllMocks();
    });

    it('renders nothing when no mod declares screens', () => {
        const { container } = render(<ModScreens mods={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing when a screen has no paired source', () => {
        const mod = { ...modWithScreen, screenSources: [] };
        const { container } = render(<ModScreens mods={[mod]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders the screen nested under its declaring mod', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        expect(screen.getByText('Gate Mod')).toBeInTheDocument();
        expect(screen.getByText('Gate Screen')).toBeInTheDocument();
        expect(document.querySelector('[data-screen-frame="gate-mod"]')).not.toBeNull();
    });

    it('mounts the frame with sandbox allow-scripts', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        expect(document.querySelector('iframe[data-screen-frame="gate-mod"]')?.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('carries source text into the srcdoc builder', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        const srcdoc = document.querySelector('iframe[data-screen-frame="gate-mod"]')?.getAttribute('srcdoc') ?? '';
        expect(srcdoc).toContain('globalThis.__screenMod');
        expect(srcdoc).toContain('document.body.innerHTML');
    });

    it('surfaces an authenticated frame fault on the Extensions fault store', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        const frame = screen.getByTitle('gate-mod.gate-screen') as HTMLIFrameElement;
        const { nonce, target } = bootFrame(frame);
        fireEvent(window, new MessageEvent('message', {
            source: target,
            data: { __screenFault: true, nonce, kind: 'threw', message: 'boom' },
        }));
        expect(screen.queryByTitle('gate-mod.gate-screen')).toBeNull();
        expect(screenFaultStore.getFaults()).toEqual([{
            file: 'gate.mod.json',
            reason: 'Gate Mod: screen "gate-screen": threw (boom)',
        }]);
    });

    it('renders one independent frame for each declared screen', () => {
        const mod: ValidatedMod = {
            ...modWithScreen,
            screens: [
                { id: 'screen-a', file: 'a.js', label: 'A' },
                { id: 'screen-b', file: 'b.js', label: 'B' },
            ],
            screenSources: ['export default function () {}', 'export default function () {}'],
        };
        render(<ModScreens mods={[mod]} />);
        expect(document.querySelectorAll('iframe[data-screen-frame="gate-mod"]')).toHaveLength(2);
    });
});
