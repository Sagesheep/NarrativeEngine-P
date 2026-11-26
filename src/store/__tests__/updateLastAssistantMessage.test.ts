import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../useAppStore';
import type { ChatMessage } from '../../types';

function assistant(id: string, content = 'GM reply'): ChatMessage {
    return { id, role: 'assistant', content, timestamp: 0 };
}
function user(id: string, content = 'input'): ChatMessage {
    return { id, role: 'user', content, timestamp: 0 };
}
function tool(id: string, name = 'roll_dice', content = 'result'): ChatMessage {
    return { id, role: 'tool', content, name, tool_call_id: 'call_x', timestamp: 0, ephemeral: true } as ChatMessage;
}

describe('updateLastAssistantMessage', () => {
    beforeEach(() => {
        useAppStore.setState({ messages: [], activeCampaignId: 'camp_test' });
    });

    it('patches the last assistant message when it is the literal last message', () => {
        useAppStore.setState({
            messages: [user('u1'), assistant('a1')],
        });
        useAppStore.getState().updateLastAssistantMessage({ pendingCommit: true, swipeActiveIndex: 0 });
        const msgs = useAppStore.getState().messages;
        expect(msgs[1].pendingCommit).toBe(true);
        expect(msgs[1].swipeActiveIndex).toBe(0);
    });

    it('patches the LAST assistant when a tool message trails the array (the regression)', () => {
        // Reproduces the Swipe v1 bug: after a tool call, the literal last
        // message is the tool message. `updateLastMessage` would stamp the
        // swipeSet on the tool — `updateLastAssistantMessage` must scan back
        // and stamp the assistant instead.
        useAppStore.setState({
            messages: [
                user('u1'),
                assistant('a1', 'preamble'),
                tool('t1', 'roll_dice', 'rolled 12'),
            ],
        });
        useAppStore.getState().updateLastAssistantMessage({
            swipeSet: [{ id: 'v1', text: 'final', sceneStakes: 'calm', tagPresent: false }],
            pendingCommit: true,
            swipeActiveIndex: 0,
        });
        const msgs = useAppStore.getState().messages;
        // Assistant got the stamp
        expect(msgs[1].pendingCommit).toBe(true);
        expect(msgs[1].swipeSet?.length).toBe(1);
        expect(msgs[1].swipeActiveIndex).toBe(0);
        // Tool message was NOT touched — this is the bug we're fixing
        expect(msgs[2].pendingCommit).toBeUndefined();
        expect(msgs[2].swipeSet).toBeUndefined();
        expect(msgs[2].swipeActiveIndex).toBeUndefined();
    });

    it('skips trailing system messages too (mirrors updateLastAssistant semantics)', () => {
        useAppStore.setState({
            messages: [
                user('u1'),
                assistant('a1'),
                { id: 'sys1', role: 'system', content: 'timeskip — 3 days pass', timestamp: 0 },
            ],
        });
        useAppStore.getState().updateLastAssistantMessage({ sceneId: '042' });
        const msgs = useAppStore.getState().messages;
        expect(msgs[1].sceneId).toBe('042');
        expect(msgs[2].sceneId).toBeUndefined();
    });

    it('is a no-op when no assistant message exists', () => {
        useAppStore.setState({ messages: [user('u1')] });
        useAppStore.getState().updateLastAssistantMessage({ pendingCommit: true });
        expect(useAppStore.getState().messages[0].pendingCommit).toBeUndefined();
    });

    it('patches only the last assistant when multiple exist in the array', () => {
        useAppStore.setState({
            messages: [user('u1'), assistant('a1', 'old'), user('u2'), assistant('a2', 'new')],
        });
        useAppStore.getState().updateLastAssistantMessage({ sceneId: '010' });
        const msgs = useAppStore.getState().messages;
        expect(msgs[1].sceneId).toBeUndefined(); // a1 untouched
        expect(msgs[3].sceneId).toBe('010');    // a2 patched
    });
});