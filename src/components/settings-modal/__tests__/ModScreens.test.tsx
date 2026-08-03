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

/**
 * Expand every collapsed mod screen.
 *
 * Screens render collapsed and mount their frame on first open. These tests are
 * about the FRAME contract, not the disclosure, so they open everything first;
 * the disclosure itself is asserted in its own describe block below.
 */
function openAllScreens() {
    for (const button of screen.getAllByRole('button', { expanded: false })) {
        fireEvent.click(button);
    }
}

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
        openAllScreens();
        expect(document.querySelector('[data-screen-frame="gate-mod"]')).not.toBeNull();
    });

    it('mounts the frame with sandbox allow-scripts', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        openAllScreens();
        expect(document.querySelector('iframe[data-screen-frame="gate-mod"]')?.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('carries source text into the srcdoc builder', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        openAllScreens();
        const srcdoc = document.querySelector('iframe[data-screen-frame="gate-mod"]')?.getAttribute('srcdoc') ?? '';
        expect(srcdoc).toContain('globalThis.__screenMod');
        expect(srcdoc).toContain('document.body.innerHTML');
    });

    it('surfaces an authenticated frame fault on the Extensions fault store', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        openAllScreens();
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
        openAllScreens();
        expect(document.querySelectorAll('iframe[data-screen-frame="gate-mod"]')).toHaveLength(2);
    });
});

describe('ModScreens — the disclosure', () => {
    beforeEach(() => screenFaultStore.clear());
    afterEach(() => {
        screenFaultStore.clear();
        vi.restoreAllMocks();
    });

    it('renders collapsed, and mounts NO frame until opened', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        // The mod and screen are listed — the user can see what is installed.
        expect(screen.getByText('Gate Screen')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Gate Screen/ })).toHaveAttribute('aria-expanded', 'false');
        // ...but nothing is executing. An unopened screen costs nothing.
        expect(document.querySelector('iframe[data-screen-frame="gate-mod"]')).toBeNull();
    });

    it('opening mounts the frame', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        fireEvent.click(screen.getByRole('button', { name: /Gate Screen/ }));
        expect(screen.getByRole('button', { name: /Gate Screen/ })).toHaveAttribute('aria-expanded', 'true');
        expect(document.querySelector('iframe[data-screen-frame="gate-mod"]')).not.toBeNull();
    });

    it('collapsing HIDES the frame but does not destroy it', () => {
        // The frame owns edits the host has not seen yet — the skill-tree editor
        // debounces its table write by 400ms. Unmounting on collapse would drop
        // anything inside that window, so a collapsed screen stays alive.
        render(<ModScreens mods={[modWithScreen]} />);
        const button = screen.getByRole('button', { name: /Gate Screen/ });
        fireEvent.click(button);
        const frame = document.querySelector('iframe[data-screen-frame="gate-mod"]');
        expect(frame).not.toBeNull();

        fireEvent.click(button);
        expect(button).toHaveAttribute('aria-expanded', 'false');
        // Same element, still in the document — hidden by its container, not removed.
        expect(document.querySelector('iframe[data-screen-frame="gate-mod"]')).toBe(frame);
        expect(document.getElementById('mod-screen-body-gate-mod.gate-screen')?.className).toContain('hidden');
    });

    it('opens each screen independently', () => {
        const mod: ValidatedMod = {
            ...modWithScreen,
            screens: [
                { id: 'screen-a', file: 'a.js', label: 'A' },
                { id: 'screen-b', file: 'b.js', label: 'B' },
            ],
            screenSources: ['export default function () {}', 'export default function () {}'],
        };
        render(<ModScreens mods={[mod]} />);
        fireEvent.click(screen.getByRole('button', { name: /\bA\b/ }));
        expect(document.querySelectorAll('iframe[data-screen-frame="gate-mod"]')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: /\bB\b/ }));
        expect(document.querySelectorAll('iframe[data-screen-frame="gate-mod"]')).toHaveLength(2);
    });
});
