// Phase 3.2 — the emit sites that are reachable through the real store.
//
// The turn-path sites (`turn.*`, `archive.sceneAppended`) are covered end to
// end by `baseAppGate/eventBusCanonicalTurn.test.ts`, which runs the real
// orchestrator. This file covers the rest: the Zustand actions in `chatSlice`
// and `settingsSlice`, and `campaignSlice`'s switch boundary.
//
// The recurring assertion is `EVENTS.md` §6.7's rule for store emits:
//
// > Emits go after the `set(...)` returns, never inside a Zustand updater.
//
// which is why each test reads the store from inside the listener and asserts it
// already sees post-write state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '../../../../store/useAppStore';
import { modEventBus, eventFaultStore } from '..';
import type { ModEventOwner } from '..';
import type { ChatMessage } from '../../../../types';

const OWNER: ModEventOwner = { modId: 'probe', modName: 'Probe', file: 'probe.mod.json' };

type Logged = { name: string; payload: Record<string, unknown> };

function listen(names: readonly string[], log: Logged[]): () => void {
    const offs = names.map((name) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        modEventBus.on(name as any, (payload: unknown) => {
            log.push({ name, payload: payload as Record<string, unknown> });
        }, OWNER),
    );
    return () => { for (const off of offs) off(); };
}

const msg = (id: string, role: ChatMessage['role'] = 'assistant', extra: Partial<ChatMessage> = {}): ChatMessage =>
    ({ id, role, content: `${id} body`, timestamp: 0, ...extra }) as ChatMessage;

describe('Phase 3.2 — store-driven emit sites', () => {
    beforeEach(() => {
        modEventBus.reset();
        eventFaultStore.clear();
        useAppStore.setState({ messages: [], activeCampaignId: 'camp_probe' });
    });

    afterEach(() => {
        modEventBus.reset();
        eventFaultStore.clear();
    });

    describe('§6.7 message.edited — the three USER-edit paths', () => {
        it('fires from updateMessageContent, carrying role and pending', () => {
            useAppStore.setState({ messages: [msg('a1', 'assistant', { pendingCommit: true })] });
            const log: Logged[] = [];
            const off = listen(['message.edited'], log);

            useAppStore.getState().updateMessageContent('a1', 'edited by the user');
            off();

            expect(log).toEqual([{
                name: 'message.edited',
                payload: { campaignId: 'camp_probe', messageId: 'a1', role: 'assistant', pending: true },
            }]);
        });

        it('reports pending: false for a history edit', () => {
            useAppStore.setState({ messages: [msg('u1', 'user')] });
            const log: Logged[] = [];
            const off = listen(['message.edited'], log);
            useAppStore.getState().updateMessageContent('u1', 'fixed a typo');
            off();
            expect(log[0].payload).toMatchObject({ role: 'user', pending: false });
        });

        it('a listener sees post-write state — the emit is after set(...) returns', () => {
            useAppStore.setState({ messages: [msg('a1')] });
            let observed: string | undefined;
            const off = modEventBus.on('message.edited', () => {
                observed = useAppStore.getState().messages[0].content;
            }, OWNER);

            useAppStore.getState().updateMessageContent('a1', 'the new text');
            off();
            expect(observed).toBe('the new text');
        });

        it('fires from replaceMessageText only when the span was applied', () => {
            useAppStore.setState({ messages: [msg('a1', 'assistant', { content: 'the red door' })] });
            const log: Logged[] = [];
            const off = listen(['message.edited'], log);

            expect(useAppStore.getState().replaceMessageText('a1', 'red', 'blue')).toBe(true);
            expect(log).toHaveLength(1);

            // A span that is not there writes nothing, so it announces nothing.
            expect(useAppStore.getState().replaceMessageText('a1', 'not present', 'x')).toBe(false);
            off();
            expect(log).toHaveLength(1);
        });

        it('does NOT fire from the host\'s own bookkeeping writes (§6.7)', () => {
            useAppStore.setState({ messages: [msg('a1')] });
            const log: Logged[] = [];
            const off = listen(['message.edited'], log);

            // Per-chunk streaming, the swipe-set/sceneId/pendingCommit stamps —
            // a mod that saw these would receive hundreds of "edits" per turn
            // and could not tell any of them from a real one.
            useAppStore.getState().updateLastAssistant('chunk one');
            useAppStore.getState().updateLastAssistant('chunk one two');
            useAppStore.getState().updateLastAssistantMessage({ sceneId: '001', pendingCommit: true });
            off();

            expect(log).toEqual([]);
        });
    });

    describe('§6.7 message.deleted — the only two deletion paths', () => {
        it('deleteMessage emits one id', () => {
            useAppStore.setState({ messages: [msg('a1'), msg('a2')] });
            const log: Logged[] = [];
            const off = listen(['message.deleted'], log);
            useAppStore.getState().deleteMessage('a1');
            off();
            expect(log).toEqual([{
                name: 'message.deleted',
                payload: { campaignId: 'camp_probe', messageIds: ['a1'] },
            }]);
        });

        it('deleteMessagesFrom emits the removed tail ONCE, not once per message', () => {
            useAppStore.setState({ messages: [msg('a1'), msg('a2'), msg('a3'), msg('a4')] });
            const log: Logged[] = [];
            const off = listen(['message.deleted'], log);
            useAppStore.getState().deleteMessagesFrom('a2');
            off();
            expect(log).toHaveLength(1);
            expect(log[0].payload.messageIds).toEqual(['a2', 'a3', 'a4']);
            expect(Object.isFrozen(log[0].payload.messageIds)).toBe(true);
        });

        it('is a no-op when the id is not found', () => {
            useAppStore.setState({ messages: [msg('a1')] });
            const log: Logged[] = [];
            const off = listen(['message.deleted'], log);
            useAppStore.getState().deleteMessagesFrom('nope');
            off();
            expect(log).toEqual([]);
        });
    });

    describe('§6.8 settings', () => {
        it('settings.changed carries key names and NOTHING else', () => {
            const log: Logged[] = [];
            const off = listen(['settings.changed'], log);
            useAppStore.getState().updateSettings({ theme: 'dark', debugMode: true });
            off();

            expect(log).toHaveLength(1);
            expect(log[0].payload).toEqual({ changedKeys: ['theme', 'debugMode'] });
            // The credential-bearing shapes are the reason for the rule (§3).
            expect(JSON.stringify(log[0].payload)).not.toMatch(/providers|apiKey|presets/);
        });

        it('a tier change fires BOTH events, changed first', () => {
            useAppStore.getState().updateSettings({ aiTier: 'lite' });
            const log: Logged[] = [];
            const off = listen(['settings.changed', 'settings.tierChanged'], log);
            useAppStore.getState().updateSettings({ aiTier: 'max' });
            off();

            expect(log.map(e => e.name)).toEqual(['settings.changed', 'settings.tierChanged']);
            expect(log[1].payload).toEqual({ tier: 'max', previous: 'lite' });
        });

        it('an unchanged tier in the patch fires only settings.changed', () => {
            useAppStore.getState().updateSettings({ aiTier: 'pro' });
            const log: Logged[] = [];
            const off = listen(['settings.changed', 'settings.tierChanged'], log);
            useAppStore.getState().updateSettings({ aiTier: 'pro' });
            off();
            expect(log.map(e => e.name)).toEqual(['settings.changed']);
        });

        it('settings.presetChanged carries the id and display name, never the body', () => {
            const presets = useAppStore.getState().settings.presets;
            expect(presets.length).toBeGreaterThan(0);
            const target = presets[0];

            const log: Logged[] = [];
            const off = listen(['settings.presetChanged'], log);
            useAppStore.getState().setActivePreset(target.id);
            off();

            expect(log).toHaveLength(1);
            expect(log[0].payload).toEqual({ presetId: target.id, name: target.name });
        });
    });

    describe('§6.2 campaign.closing', () => {
        it('fires with the OLD campaign still readable, before activeCampaignId changes', async () => {
            useAppStore.setState({ activeCampaignId: 'camp_old' });
            const seen: Array<{ payload: Record<string, unknown>; idAtFireTime: string | null }> = [];
            const off = modEventBus.on('campaign.closing', (payload) => {
                seen.push({
                    payload: payload as unknown as Record<string, unknown>,
                    idAtFireTime: useAppStore.getState().activeCampaignId,
                });
            }, OWNER);

            await useAppStore.getState().setActiveCampaign('camp_new');
            off();

            expect(seen).toHaveLength(1);
            expect(seen[0].payload).toEqual({ campaignId: 'camp_old', nextCampaignId: 'camp_new' });
            // The last instant the old campaign is readable.
            expect(seen[0].idAtFireTime).toBe('camp_old');
        });

        it('exit-to-hub carries nextCampaignId: null', async () => {
            useAppStore.setState({ activeCampaignId: 'camp_old' });
            const log: Logged[] = [];
            const off = listen(['campaign.closing'], log);
            await useAppStore.getState().setActiveCampaign(null);
            off();
            expect(log[0].payload).toEqual({ campaignId: 'camp_old', nextCampaignId: null });
        });

        it('a first open from the hub closes nothing', async () => {
            useAppStore.setState({ activeCampaignId: null });
            const log: Logged[] = [];
            const off = listen(['campaign.closing'], log);
            await useAppStore.getState().setActiveCampaign('camp_first');
            off();
            expect(log).toEqual([]);
        });
    });

    describe('§3 zero listeners costs nothing', () => {
        it('every store action runs unchanged with no bus subscribers', () => {
            useAppStore.setState({ messages: [msg('a1'), msg('a2')] });
            expect(modEventBus.getListenerCount()).toBe(0);

            useAppStore.getState().updateMessageContent('a1', 'x');
            useAppStore.getState().deleteMessage('a2');
            useAppStore.getState().updateSettings({ theme: 'light' });

            expect(useAppStore.getState().messages.map(m => m.id)).toEqual(['a1']);
            expect(useAppStore.getState().messages[0].content).toBe('x');
            expect(eventFaultStore.getRecords()).toEqual([]);
        });
    });
});
