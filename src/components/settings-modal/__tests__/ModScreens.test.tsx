/**
 * WO-P5-17 Step 5 — the Extensions-tab mod screen render test.
 *
 * The Extensions tab renders one ScreenFrame per declared mod screen,
 * nested under the mod that declared it. The frame is
 * `sandbox="allow-scripts"` (R1); the source ships as text (R2); the CSP
 * is `default-src 'none'` (R3); one frame per screen (R4); a fault
 * surfaces on the Extensions fault list (R5); no host API (R6).
 *
 * ⚠️ JSDOM PROVES NOTHING ABOUT ISOLATION. jsdom does not enforce the
 * sandbox attribute. The real isolation proof is
 * `scripts/verify-screen-frame.mjs` (Step 4). These tests cover the
 * WIRING: the frame is mounted with the right attributes, the source is
 * carried into the srcdoc, and a fault surfaces on the store.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

describe('ModScreens — Extensions-tab rendering', () => {
    beforeEach(() => {
        screenFaultStore.clear();
    });

    afterEach(() => {
        screenFaultStore.clear();
    });

    it('renders nothing when no mod declares screens', () => {
        const { container } = render(<ModScreens mods={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing when a mod declares screens but no sources', () => {
        const mod: ValidatedMod = {
            ...modWithScreen,
            screens: [{ id: 'gate-screen', file: 'gate.js' }],
            screenSources: [],
        };
        const { container } = render(<ModScreens mods={[mod]} />);
        // The component skips screens with no matching source (defensive
        // — the server pairs them by index, but the client reads
        // defensively because these objects arrive over HTTP).
        expect(container.firstChild).toBeNull();
    });

    it('renders a section per declared mod screen, nested under the mod', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        // The mod's name appears as the section label.
        expect(screen.getByText('Gate Mod')).toBeInTheDocument();
        // The screen's label appears.
        expect(screen.getByText('Gate Screen')).toBeInTheDocument();
        // The ScreenFrame is mounted (the iframe has the data attributes).
        const frame = document.querySelector('[data-screen-frame="gate-mod"]');
        expect(frame).not.toBeNull();
    });

    it('mounts the frame with sandbox="allow-scripts" (R1)', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        const frame = document.querySelector('iframe[data-screen-frame="gate-mod"]') as HTMLIFrameElement;
        expect(frame).not.toBeNull();
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('carries the screen source into the srcdoc (R2)', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        const frame = document.querySelector('iframe[data-screen-frame="gate-mod"]') as HTMLIFrameElement;
        expect(frame).not.toBeNull();
        const srcdoc = frame.getAttribute('srcdoc') ?? '';
        // The source is wrapped into the srcdoc. The `export default` is
        // rewritten to `globalThis.__screenMod =` (the transform in
        // buildScreenSrcDoc). The original function body is present.
        expect(srcdoc).toContain('globalThis.__screenMod');
        expect(srcdoc).toContain('document.body.innerHTML');
    });

    it('surfaces a fault on the screenFaultStore (R5)', () => {
        render(<ModScreens mods={[modWithScreen]} />);
        // Simulate the frame posting a fault.
        fireEvent(window, new MessageEvent('message', {
            origin: 'null',
            data: { __screenFault: true, kind: 'threw', message: 'boom' },
        }));
        // The fault card replaces the iframe.
        expect(screen.queryByTitle('gate-mod.gate-screen')).toBeNull();
        expect(screen.getByText(/faulted and was stopped/)).toBeInTheDocument();
        // The fault is on the store, in the Extensions-list shape.
        const faults = screenFaultStore.getFaults();
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('gate.mod.json');
        expect(faults[0].reason).toContain('Gate Mod');
        expect(faults[0].reason).toContain('threw');
        expect(faults[0].reason).toContain('boom');
    });

    it('renders two frames for two screens (no pooling, no reuse)', () => {
        const mod: ValidatedMod = {
            ...modWithScreen,
            screens: [
                { id: 'screen-a', file: 'a.js', label: 'A' },
                { id: 'screen-b', file: 'b.js', label: 'B' },
            ],
            screenSources: [
                'export default function () {}',
                'export default function () {}',
            ],
        };
        render(<ModScreens mods={[mod]} />);
        const frames = document.querySelectorAll('iframe[data-screen-frame="gate-mod"]');
        expect(frames).toHaveLength(2);
    });
});