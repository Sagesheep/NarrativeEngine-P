import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatRightRail } from '../ChatRightRail';
import {
    disableModMounts,
    registerModRail,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';

const MOD_A = { id: 'mod-a', name: 'Mod A' };
const MOD_B = { id: 'mod-b', name: 'Mod B' };

beforeEach(() => {
    resetMountRegistryForTests();
    localStorage.clear();
});

afterEach(() => {
    cleanup();
});

describe('Phase 4.3 ? chat right rail', () => {
    it('is completely absent until a mod claims chat.rail', () => {
        const { container } = render(<ChatRightRail />);
        expect(container.querySelector('[data-chat-rail]')).toBeNull();
    });

    it('mounts into a host node and stays live through ctx.subscribe without polling', async () => {
        const listeners = new Set<() => void>();
        const context = {
            data: { messages: ['Before'] },
            subscribe: (_key: string, listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        registerModRail(MOD_A, {
            id: 'status',
            title: 'Status',
            mount: (node, ctx) => {
                const live = ctx as typeof context;
                const value = document.createElement('span');
                const paint = () => { value.textContent = live.data.messages[0]; };
                paint();
                node.append(value);
                return live.subscribe('messages', paint);
            },
        }, 0, context);

        render(<ChatRightRail />);
        expect(await screen.findByText('Before')).toBeInTheDocument();

        context.data.messages[0] = 'After';
        listeners.forEach((listener) => listener());
        expect(await screen.findByText('After')).toBeInTheDocument();
    });

    it('uses tabs in resolved load order and persists the selected qualified panel id', async () => {
        registerModRail(MOD_A, { id: 'late', title: 'Late panel', mount: () => undefined }, 4, {});
        registerModRail(MOD_B, { id: 'early', title: 'Early panel', mount: () => undefined }, 1, {});

        render(<ChatRightRail />);
        const tabs = await screen.findAllByRole('tab');
        expect(tabs.map((tab) => tab.textContent)).toEqual(['Early panel', 'Late panel']);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');

        fireEvent.click(tabs[1]);
        await waitFor(() => expect(tabs[1].getAttribute('aria-selected')).toBe('true'));
        const saved = JSON.parse(localStorage.getItem('nn_chat_rail') ?? '{}') as { activePanelId?: string };
        expect(saved.activePanelId).toBe('mod.mod-a.late');
    });

    it('persists collapsed state and tears down the mod interior on disable', async () => {
        let cleaned = false;
        registerModRail(MOD_A, {
            id: 'status',
            title: 'Status',
            mount: (node) => {
                node.textContent = 'Mounted';
                return () => { cleaned = true; };
            },
        }, 0, {});

        render(<ChatRightRail />);
        expect(await screen.findByText('Mounted')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Collapse mod rail' }));
        await waitFor(() => {
            const saved = JSON.parse(localStorage.getItem('nn_chat_rail') ?? '{}') as { collapsed?: boolean };
            expect(saved.collapsed).toBe(true);
        });
        expect(cleaned).toBe(false);

        disableModMounts('mod-a');
        await waitFor(() => expect(document.querySelector('[data-chat-rail]')).toBeNull());
        expect(cleaned).toBe(true);
    });
});
