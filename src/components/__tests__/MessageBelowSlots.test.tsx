/**
 * Phase 4.4 — `MessageBelowSlots` component tests.
 *
 * Proves the `message.below` content mount against the contract in
 * `MOUNTS.md` §2.6 / §8.3 / §6:
 *   • Zero-mod DOM: renders nothing when no slot is claimed (§2.8).
 *   • Mounts into a host-owned node and stays live through one subscription
 *     without polling (4.4 §3 — "if a rail panel has to poll, this phase is
 *     not done" applies equally to message slots).
 *   • Stacks multiple mods' slots in `(loadIndex, withinModIndex)` order (§4.3).
 *   • A throwing mount unmounts that slot only and records a fault (§6 / §8.6).
 *   • A swipe/scene-continue that lands a new message id re-runs the mount
 *     (mutation survival — 4.4 §3 / §8.4).
 *   • Disable removes the slot and runs the mod's cleanup (§8.5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
    disableModMounts,
    registerModMessageBelow,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';
import { mountFaultStore } from '../../services/mods/mounts/mountFaults';
import { MessageBelowSlots } from '../message/MessageBelowSlots';

const MOD_A = { id: 'mod-a', name: 'Mod A' };
const MOD_B = { id: 'mod-b', name: 'Mod B' };
const MESSAGE = { id: 'msg-1', role: 'assistant' as const, sceneId: '042' };

beforeEach(() => {
    resetMountRegistryForTests();
    mountFaultStore.clear();
});

afterEach(() => {
    cleanup();
});

describe('Phase 4.4 — MessageBelowSlots', () => {
    it('renders nothing when no mod has claimed message.below (zero-mod DOM, §2.8)', () => {
        const { container } = render(<MessageBelowSlots message={MESSAGE} />);
        expect(container.firstChild).toBeNull();
    });

    it('mounts into a host node and renders the mod interior', async () => {
        registerModMessageBelow(MOD_A, {
            id: 'note',
            mount: (node) => { node.textContent = 'annotation from mod-a'; },
        }, 0, {});

        render(<MessageBelowSlots message={MESSAGE} />);
        expect(await screen.findByText('annotation from mod-a')).toBeInTheDocument();
    });

    it('passes the MessageRef (id, role, sceneId) to the mod mount callback (§8.4)', async () => {
        const seen: Array<{ id: string; role: string; sceneId: string | null }> = [];
        registerModMessageBelow(MOD_A, {
            id: 'ref',
            mount: (node, _ctx, message) => {
                seen.push({ id: message.id, role: message.role, sceneId: message.sceneId });
                node.textContent = `ref:${message.id}:${message.role}:${message.sceneId}`;
            },
        }, 0, {});

        render(<MessageBelowSlots message={MESSAGE} />);
        expect(await screen.findByText('ref:msg-1:assistant:042')).toBeInTheDocument();
        expect(seen).toEqual([{ id: 'msg-1', role: 'assistant', sceneId: '042' }]);
    });

    it('stays live through ctx.subscribe without polling (4.4 §3)', async () => {
        const listeners = new Set<() => void>();
        const context = {
            data: { messages: [{ id: 'msg-1', content: 'before' }] },
            subscribe: (_key: string, listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        registerModMessageBelow(MOD_A, {
            id: 'live',
            mount: (node, ctx) => {
                const live = ctx as typeof context;
                const paint = () => {
                    const row = live.data.messages.find((m: { id: string }) => m.id === 'msg-1');
                    node.textContent = row ? (row as { content: string }).content : 'gone';
                };
                paint();
                return live.subscribe('messages', paint);
            },
        }, 0, context);

        render(<MessageBelowSlots message={MESSAGE} />);
        expect(await screen.findByText('before')).toBeInTheDocument();

        context.data.messages[0].content = 'after';
        listeners.forEach((listener) => listener());
        expect(await screen.findByText('after')).toBeInTheDocument();
    });

    it('stacks two mods in (loadIndex, withinModIndex) order (§4.3)', async () => {
        registerModMessageBelow(MOD_A, {
            id: 'late', mount: (node) => { node.textContent = 'late-panel'; },
        }, 5, {});
        registerModMessageBelow(MOD_B, {
            id: 'early', mount: (node) => { node.textContent = 'early-panel'; },
        }, 1, {});

        const { container } = render(<MessageBelowSlots message={MESSAGE} />);
        const slots = container.querySelectorAll('[class*="overflow-hidden"]');
        expect(slots.length).toBe(2);
        // MOD_B (loadIndex 1) sorts first; MOD_A (loadIndex 5) sorts second.
        expect(slots[0].textContent).toBe('early-panel');
        expect(slots[1].textContent).toBe('late-panel');
    });

    it('a throwing mount unmounts that slot only and records a fault (§6/§8.6)', async () => {
        registerModMessageBelow(MOD_A, {
            id: 'boom',
            mount: () => { throw new Error('mount exploded'); },
        }, 0, {});
        registerModMessageBelow(MOD_B, {
            id: 'fine',
            mount: (node) => { node.textContent = 'survivor'; },
        }, 1, {});

        render(<MessageBelowSlots message={MESSAGE} />);
        // The throwing slot is contained — the survivor still renders.
        expect(await screen.findByText('survivor')).toBeInTheDocument();
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'threw' && f.region === 'message.below' && f.entryId === 'boom')).toBe(true);
    });

    it('runs the mod cleanup on disable (§8.5)', async () => {
        let cleaned = false;
        registerModMessageBelow(MOD_A, {
            id: 'cleanup',
            mount: (node) => {
                node.textContent = 'mounted';
                return () => { cleaned = true; };
            },
        }, 0, {});

        render(<MessageBelowSlots message={MESSAGE} />);
        expect(await screen.findByText('mounted')).toBeInTheDocument();
        expect(cleaned).toBe(false);

        disableModMounts('mod-a');
        await waitFor(() => expect(cleaned).toBe(true));
    });

    it('re-runs the mount when message.id changes (swipe/scene-continue mutation survival, §8.4)', async () => {
        const mountIds: string[] = [];
        registerModMessageBelow(MOD_A, {
            id: 'survive',
            mount: (node, _ctx, message) => {
                mountIds.push(message.id);
                node.textContent = `mount-for:${message.id}`;
            },
        }, 0, {});

        const { rerender } = render(<MessageBelowSlots message={MESSAGE} />);
        expect(await screen.findByText('mount-for:msg-1')).toBeInTheDocument();

        // A swipe or scene-continue lands a new message id — the slot re-runs.
        const nextMessage = { id: 'msg-2', role: 'assistant' as const, sceneId: '043' };
        rerender(<MessageBelowSlots message={nextMessage} />);
        expect(await screen.findByText('mount-for:msg-2')).toBeInTheDocument();
        // The mount fired for both ids.
        expect(mountIds).toEqual(['msg-1', 'msg-2']);
    });
});