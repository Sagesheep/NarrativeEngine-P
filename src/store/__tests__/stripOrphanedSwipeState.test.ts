import { describe, it, expect } from 'vitest';
import { stripOrphanedSwipeState } from '../campaignHydrator';
import type { ChatMessage, SwipeVariant } from '../../types';

function assistant(id: string): ChatMessage {
    return { id, role: 'assistant', content: 'GM reply', timestamp: 0 };
}
function user(id: string): ChatMessage {
    return { id, role: 'user', content: 'input', timestamp: 0 };
}
function tool(id: string, name = 'roll_dice'): ChatMessage {
    return { id, role: 'tool', content: 'result', name, tool_call_id: 'call_x', timestamp: 0, ephemeral: true } as ChatMessage;
}
function variant(): SwipeVariant {
    return { id: 'v1', text: 'final', sceneStakes: 'calm', tagPresent: false };
}

describe('stripOrphanedSwipeState', () => {
    it('is a no-op on a healthy campaign (no orphans)', () => {
        const msgs: ChatMessage[] = [
            user('u1'),
            assistant('a1'),
            user('u2'),
            { ...assistant('a2'), sceneId: '042' },
        ];
        const { messages, changed } = stripOrphanedSwipeState(msgs);
        expect(changed).toBe(false);
        expect(messages).toEqual(msgs);
    });

    it('strips pendingCommit + swipeSet + swipeActiveIndex from tool messages', () => {
        const msgs: ChatMessage[] = [
            user('u1'),
            { ...assistant('a1'), tool_calls: [{ id: 'c1', type: 'function', function: { name: 'roll_dice', arguments: '{}' } }] },
            { ...tool('t1', 'roll_dice'), pendingCommit: true, swipeSet: [variant()], swipeActiveIndex: 0 },
        ];
        const { messages, changed } = stripOrphanedSwipeState(msgs);
        expect(changed).toBe(true);
        expect(messages[2].pendingCommit).toBeUndefined();
        expect(messages[2].swipeSet).toBeUndefined();
        expect(messages[2].swipeActiveIndex).toBeUndefined();
        // Other tool fields preserved
        expect(messages[2].role).toBe('tool');
        expect(messages[2].name).toBe('roll_dice');
        expect(messages[2].tool_call_id).toBe('call_x');
    });

    it('preserves swipe state on assistant messages (the intended carrier)', () => {
        const msgs: ChatMessage[] = [
            user('u1'),
            { ...assistant('a1'), pendingCommit: true, swipeSet: [variant()], swipeActiveIndex: 0 },
        ];
        const { messages, changed } = stripOrphanedSwipeState(msgs);
        expect(changed).toBe(false);
        expect(messages[1].pendingCommit).toBe(true);
        expect(messages[1].swipeSet?.length).toBe(1);
        expect(messages[1].swipeActiveIndex).toBe(0);
    });

    it('strips orphans from system messages too', () => {
        const msgs: ChatMessage[] = [
            user('u1'),
            assistant('a1'),
            { id: 's1', role: 'system', content: 'timeskip', timestamp: 0, pendingCommit: true, swipeSet: [variant()] },
        ];
        const { messages, changed } = stripOrphanedSwipeState(msgs);
        expect(changed).toBe(true);
        expect(messages[2].pendingCommit).toBeUndefined();
        expect(messages[2].swipeSet).toBeUndefined();
    });

    it('handles multiple orphans in the same array', () => {
        const msgs: ChatMessage[] = [
            { ...tool('t1'), pendingCommit: true, swipeSet: [variant()] },
            { ...tool('t2'), pendingCommit: true, swipeSet: [variant()], swipeActiveIndex: 0 },
            assistant('a1'),
        ];
        const { messages, changed } = stripOrphanedSwipeState(msgs);
        expect(changed).toBe(true);
        expect(messages[0].pendingCommit).toBeUndefined();
        expect(messages[0].swipeSet).toBeUndefined();
        expect(messages[1].pendingCommit).toBeUndefined();
        expect(messages[1].swipeSet).toBeUndefined();
        expect(messages[1].swipeActiveIndex).toBeUndefined();
        // Assistant untouched
        expect(messages[2].role).toBe('assistant');
    });

    it('is idempotent — running twice yields no further changes', () => {
        const msgs: ChatMessage[] = [
            { ...tool('t1'), pendingCommit: true, swipeSet: [variant()] },
        ];
        const first = stripOrphanedSwipeState(msgs);
        const second = stripOrphanedSwipeState(first.messages);
        expect(second.changed).toBe(false);
    });
});