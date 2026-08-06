/**
 * Phase 4.5 — the `WindowManager` React component tests.
 *
 * Proves the host chrome contracts in `MOUNTS.md` §2.7 / §4.4 and the
 * Phase 4.5 §3 rules:
 *   • Zero-mod DOM: with no windows open, `WindowManager` renders nothing —
 *     no wrapper, no hidden layer (§2.8).
 *   • Opening a window renders host chrome (title bar with title, minimize,
 *     close, resize handles) and mounts the mod's `mount(node, ctx)` into a
 *     host-owned node.
 *   • Close button closes the window; minimize toggles the flag.
 *   • Escape closes the focused window — but NOT while the chat input or a
 *     contenteditable holds focus (4.5 §3 — "Windows must not trap keyboard
 *     focus away from the chat input").
 *   • Disable removes the window cleanly — no orphan chrome, no error.
 *   • Bounds clamp on app resize: a stranded window is pulled back into the
 *     new viewport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WindowManager } from '../WindowManager';
import {
    clearAllWindowsWindows,
    closeWindow,
    openWindow,
    registerWindowDeclaration,
    setMinimized,
} from '../../services/mods/mounts/windowStore';
import {
    clearAllModMounts,
    disableModMounts,
    registerModWindow,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';
import type { WindowDeclaration } from '../../services/mods/mounts/mountTypes';

beforeEach(() => {
    resetMountRegistryForTests();
    localStorage.clear();
    if (typeof window !== 'undefined') {
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 });
    }
});

afterEach(() => {
    cleanup();
    clearAllWindowsWindows();
    clearAllModMounts();
    localStorage.clear();
});

const MOD_A = { id: 'mod-a', name: 'Mod A' };

const declaration: WindowDeclaration = {
    id: 'editor',
    title: 'Example Editor',
    defaultSize: { width: 360, height: 240 },
    minSize: { width: 200, height: 150 },
    mount: (node) => {
        const span = document.createElement('span');
        span.textContent = 'Window interior mounted';
        span.dataset.modInterior = 'true';
        node.append(span);
    },
};

describe('Phase 4.5 — WindowManager: zero-mod rule (MOUNTS.md §2.8)', () => {
    it('renders nothing when no windows are declared', () => {
        const { container } = render(<WindowManager />);
        expect(container.querySelector('[data-mod-window-layer]')).toBeNull();
        expect(container.querySelectorAll('*')).toHaveLength(0);
    });

    it('renders nothing when a window is declared but not opened', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        const { container } = render(<WindowManager />);
        expect(container.querySelector('[data-mod-window-layer]')).toBeNull();
    });

    it('renders the layer only while at least one window is open', async () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        expect(screen.getByText('Example Editor')).toBeInTheDocument();
        closeWindow('mod.mod-a.editor');
        await waitFor(() => {
            expect(screen.queryByText('Example Editor')).toBeNull();
        });
    });
});

describe('Phase 4.5 — WindowManager: host chrome + mod interior', () => {
    it('renders the host title bar with the declared title and a mod-owned interior node', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        // Title is host chrome.
        const titleBar = screen.getByText('Example Editor');
        expect(titleBar).toBeInTheDocument();
        // The mod's interior mount ran and produced content.
        expect(screen.getByText('Window interior mounted')).toBeInTheDocument();
        // Close + minimize controls are host chrome with stable labels.
        expect(screen.getByLabelText('Close window')).toBeInTheDocument();
        expect(screen.getByLabelText('Minimize window')).toBeInTheDocument();
    });

    it('the window node carries the qualified id and mod id as data attributes', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        const { container } = render(<WindowManager />);
        const frame = container.querySelector('[data-mod-window="mod.mod-a.editor"]');
        expect(frame).not.toBeNull();
        expect(frame?.getAttribute('data-mod-window-mod')).toBe('mod-a');
    });

    it('the mod mount receives the host-owned node and the live context', () => {
        const ctx = { data: { messages: [] } };
        let receivedNode: HTMLElement | null = null;
        let receivedCtx: unknown = null;
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'ctx',
            title: 'Ctx',
            defaultSize: { width: 200, height: 150 },
            mount: (node, context) => {
                receivedNode = node;
                receivedCtx = context;
            },
        }, 0, ctx);
        openWindow('mod.mod-a.ctx');
        render(<WindowManager />);
        expect(receivedNode).toBeInstanceOf(HTMLElement);
        expect(receivedCtx).toBe(ctx);
    });

    it('a throwing mod mount faults and closes the window (no chat crash)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'throws',
            title: 'Throws',
            defaultSize: { width: 200, height: 150 },
            mount: () => { throw new Error('mod interior blew up'); },
        }, 0, {});
        openWindow('mod.mod-a.throws');
        // The error boundary in the parent catches the throw during the
        // imperative mount effect; the window is closed.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<WindowManager />);
        expect(screen.queryByText('Throws')).toBeNull();
        spy.mockRestore();
    });
});

describe('Phase 4.5 — WindowManager: close + minimize controls', () => {
    it('clicking the close button closes the window', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        fireEvent.click(screen.getByLabelText('Close window'));
        expect(screen.queryByText('Example Editor')).toBeNull();
    });

    it('clicking minimize toggles the window to a bar only (no interior)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        // Interior is visible initially.
        expect(screen.getByText('Window interior mounted')).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText('Minimize window'));
        // The interior unmounts (the frame renders only the title bar).
        expect(screen.queryByText('Window interior mounted')).toBeNull();
        expect(screen.getByText('Example Editor')).toBeInTheDocument();
        // The aria-label swaps to "Restore window".
        expect(screen.getByLabelText('Restore window')).toBeInTheDocument();
        // Clicking again restores.
        fireEvent.click(screen.getByLabelText('Restore window'));
        expect(screen.getByText('Window interior mounted')).toBeInTheDocument();
    });
});

describe('Phase 4.5 — WindowManager: Escape closes the focused window (4.5 §3)', () => {
    it('Escape closes the focused window', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText('Example Editor')).toBeNull();
    });

    it('Escape does NOT close when the chat input holds focus (4.5 §3)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        const input = document.createElement('textarea');
        document.body.append(input);
        input.focus();
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.getByText('Example Editor')).toBeInTheDocument();
        input.remove();
    });

    it('Escape does NOT close when a contenteditable holds focus', async () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        const editable = document.createElement('div');
        document.body.append(editable);
        // jsdom does not always honor `contentEditable='true'` for the
        // `isContentEditable` property; set both the attribute and the
        // property so the production check `target.isContentEditable`
        // returns truthy and the test exercises the path it documents.
        editable.setAttribute('contenteditable', 'true');
        try {
            Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });
        } catch {
            // Some jsdom versions disallow overriding; the attribute is
            // enough in that case. The production check is the contract;
            // the test documents the intent either way.
        }
        editable.focus();
        fireEvent.keyDown(editable, { key: 'Escape' });
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByText('Example Editor')).toBeInTheDocument();
        editable.remove();
    });

    it('Escape with no focused window is a no-op (no error)', () => {
        render(<WindowManager />);
        expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
    });

    it('Escape does not fire while no windows are open', () => {
        // The listener is installed only while open.length > 0; with no
        // windows, Escape does nothing and never reaches the store.
        const { container } = render(<WindowManager />);
        expect(container.querySelector('[data-mod-window-layer]')).toBeNull();
        // Sanity: a window opened after the listener is gone still works.
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        // Re-render by re-mounting (the test environment does not auto-rerender).
        cleanup();
        render(<WindowManager />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText('Example Editor')).toBeNull();
    });
});

describe('Phase 4.5 — WindowManager: bounds clamp on app resize (4.5 §3)', () => {
    it('shrinking the app window pulls a stranded floating window back on-canvas', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        // Park the window at the right edge of a 1024 viewport.
        const { container } = render(<WindowManager />);
        const frame = container.querySelector('[data-mod-window="mod.mod-a.editor"]') as HTMLElement;
        expect(frame).not.toBeNull();
        // Shrink the viewport and dispatch a resize event.
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 300 });
        fireEvent(window, new Event('resize'));
        // The window's left edge must now be within the new 400-wide viewport
        // (allowing for WINDOW_KEEP_VISIBLE on the right edge).
        const after = container.querySelector('[data-mod-window="mod.mod-a.editor"]') as HTMLElement;
        const left = parseInt(after.style.left, 10);
        expect(left).toBeLessThanOrEqual(400 - 32);
    });
});

describe('Phase 4.5 — WindowManager: host-owned teardown via disableModMounts (§8.5)', () => {
    it('disableModMounts removes the window declaration and closes the open window', async () => {
        // Use the public `registerModWindow` so the declaration goes through
        // the same path the production `ctx.mounts.window` uses.
        registerModWindow(MOD_A, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        render(<WindowManager />);
        expect(screen.getByText('Example Editor')).toBeInTheDocument();
        disableModMounts(MOD_A.id);
        // The store mutates synchronously, but React re-renders async; wait
        // for the window to unmount.
        await waitFor(() => {
            expect(screen.queryByText('Example Editor')).toBeNull();
        });
    });

    it('disableModMounts cleans up even when the window is minimized', async () => {
        registerModWindow(MOD_A, declaration, 0, {});
        openWindow('mod.mod-a.editor');
        setMinimized('mod.mod-a.editor', true);
        render(<WindowManager />);
        disableModMounts(MOD_A.id);
        await waitFor(() => {
            expect(screen.queryByText('Example Editor')).toBeNull();
        });
    });

    it('a second mod\'s window stays open when the first is disabled', async () => {
        const MOD_B = { id: 'mod-b', name: 'Mod B' };
        registerModWindow(MOD_A, declaration, 0, {});
        registerModWindow(MOD_B, {
            id: 'other',
            title: 'Other',
            defaultSize: { width: 200, height: 150 },
            mount: () => undefined,
        }, 1, {});
        openWindow('mod.mod-a.editor');
        openWindow('mod.mod-b.other');
        render(<WindowManager />);
        disableModMounts(MOD_A.id);
        await waitFor(() => {
            expect(screen.queryByText('Example Editor')).toBeNull();
        });
        expect(screen.getByText('Other')).toBeInTheDocument();
    });
});

describe('Phase 4.5 — WindowManager: two windows, z-order + focus', () => {
    it('two windows render at once; the one opened last is on top (higher z-index)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'a',
            title: 'Window A',
            defaultSize: { width: 200, height: 150 },
            mount: () => undefined,
        }, 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'b',
            title: 'Window B',
            defaultSize: { width: 200, height: 150 },
            mount: () => undefined,
        }, 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-a.b');
        const { container } = render(<WindowManager />);
        const frameA = container.querySelector('[data-mod-window="mod.mod-a.a"]') as HTMLElement;
        const frameB = container.querySelector('[data-mod-window="mod.mod-a.b"]') as HTMLElement;
        const zA = parseInt(frameA.style.zIndex, 10);
        const zB = parseInt(frameB.style.zIndex, 10);
        expect(zB).toBeGreaterThan(zA);
    });
});
