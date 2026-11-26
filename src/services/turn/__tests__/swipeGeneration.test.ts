import { describe, it, expect } from 'vitest';
import { extractAndStripSceneStakes } from '../sceneStakesTag';
import { MAX_SWIPES, SWIPE_BASE_TEMP_OFFSET, computeSwipeTemperature, SWIPE_SYSTEM_LINE } from '../swipeGeneration';
import { hasSwipeSet, isLatestGmMessage, findPendingCommitMessage } from '../pendingCommit';
import type { ChatMessage, SwipeVariant } from '../../../types';

// ── Helpers ──
function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'msg_1',
        role: 'assistant',
        content: 'The tavern is quiet tonight.',
        timestamp: Date.now(),
        ...overrides,
    };
}

function makeVariant(overrides: Partial<SwipeVariant> = {}): SwipeVariant {
    return {
        id: 'var_1',
        text: 'The tavern is quiet tonight.',
        sceneStakes: 'calm',
        tagPresent: false,
        ...overrides,
    };
}

// ── Tests ──

describe('Swipe Generation — types & helpers', () => {
    it('MAX_SWIPES is 5', () => {
        expect(MAX_SWIPES).toBe(5);
    });

    it('SWIPE_BASE_TEMP_OFFSET is 0.1', () => {
        expect(SWIPE_BASE_TEMP_OFFSET).toBe(0.1);
    });

    it('SWIPE_SYSTEM_LINE forbids inventing dice rolls / lore lookups', () => {
        expect(SWIPE_SYSTEM_LINE).toMatch(/dice rolls/i);
        expect(SWIPE_SYSTEM_LINE).toMatch(/lore lookups/i);
        expect(SWIPE_SYSTEM_LINE).toMatch(/narrate only/i);
    });
});

describe('computeSwipeTemperature', () => {
    it('opens at base + 0.1', () => {
        expect(computeSwipeTemperature(0.7, SWIPE_BASE_TEMP_OFFSET)).toBeCloseTo(0.8, 5);
    });

    it('clamps to [0, 2]', () => {
        expect(computeSwipeTemperature(1.9, 0.5)).toBe(2);
        expect(computeSwipeTemperature(0.05, -0.1)).toBe(0);
    });

    it('uses a session offset when provided', () => {
        expect(computeSwipeTemperature(0.7, 0.3)).toBeCloseTo(1.0, 5);
    });

    it('falls back to 0.7 base when undefined', () => {
        expect(computeSwipeTemperature(undefined, 0.1)).toBeCloseTo(0.8, 5);
    });
});

describe('extractAndStripSceneStakes — per-variant', () => {
    it('strips the tag from a variant display text', () => {
        const raw = 'Guards patrol the corridor.\n[[SCENE_STAKES: tense]]';
        const { displayText, stakes } = extractAndStripSceneStakes(raw);
        expect(stakes).toBe('tense');
        expect(displayText).toBe('Guards patrol the corridor.');
        expect(displayText).not.toContain('SCENE_STAKES');
    });

    it('returns calm when no tag present', () => {
        const raw = 'A quiet evening.';
        const { displayText, stakes } = extractAndStripSceneStakes(raw);
        expect(stakes).toBe('calm');
        expect(displayText).toBe(raw);
    });
});

describe('hasSwipeSet', () => {
    it('returns true for a message with swipeSet + pendingCommit', () => {
        const msg = makeMsg({ swipeSet: [makeVariant()], pendingCommit: true });
        expect(hasSwipeSet(msg)).toBe(true);
    });

    it('returns false for a message with swipeSet but no pendingCommit (committed)', () => {
        const msg = makeMsg({ swipeSet: [makeVariant()], pendingCommit: false });
        expect(hasSwipeSet(msg)).toBe(false);
    });

    it('returns false for a message without swipeSet', () => {
        const msg = makeMsg();
        expect(hasSwipeSet(msg)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(hasSwipeSet(undefined)).toBe(false);
    });

    it('returns false for an empty swipeSet', () => {
        const msg = makeMsg({ swipeSet: [], pendingCommit: true });
        expect(hasSwipeSet(msg)).toBe(false);
    });
});

describe('isLatestGmMessage', () => {
    it('returns true when the message is the last assistant message', () => {
        const msgs = [
            makeMsg({ id: 'u1', role: 'user' }),
            makeMsg({ id: 'g1', role: 'assistant' }),
        ];
        expect(isLatestGmMessage(msgs, 'g1')).toBe(true);
    });

    it('returns false when the message is not the last assistant message', () => {
        const msgs = [
            makeMsg({ id: 'g1', role: 'assistant' }),
            makeMsg({ id: 'u2', role: 'user' }),
            makeMsg({ id: 'g2', role: 'assistant' }),
        ];
        expect(isLatestGmMessage(msgs, 'g1')).toBe(false);
    });

    it('skips trailing system messages (timeskip-seam)', () => {
        const msgs = [
            makeMsg({ id: 'u1', role: 'user' }),
            makeMsg({ id: 'g1', role: 'assistant' }),
            { id: 'sm1', role: 'system', content: 'Scene 001', timestamp: Date.now(), name: 'scene-marker' } as ChatMessage,
        ];
        expect(isLatestGmMessage(msgs, 'g1')).toBe(true);
    });

    it('returns false when no assistant message exists', () => {
        const msgs = [makeMsg({ id: 'u1', role: 'user' })];
        expect(isLatestGmMessage(msgs, 'u1')).toBe(false);
    });
});

describe('findPendingCommitMessage', () => {
    it('finds a pending commit message at the tail', () => {
        const msgs = [
            makeMsg({ id: 'u1', role: 'user' }),
            makeMsg({ id: 'g1', role: 'assistant', swipeSet: [makeVariant()], pendingCommit: true }),
        ];
        const found = findPendingCommitMessage(msgs);
        expect(found?.id).toBe('g1');
    });

    it('returns null when no pending commit exists', () => {
        const msgs = [
            makeMsg({ id: 'u1', role: 'user' }),
            makeMsg({ id: 'g1', role: 'assistant' }),
        ];
        expect(findPendingCommitMessage(msgs)).toBeNull();
    });

    it('returns null when the assistant message has pendingCommit=false (committed)', () => {
        const msgs = [
            makeMsg({ id: 'g1', role: 'assistant', swipeSet: [makeVariant()], pendingCommit: false }),
        ];
        expect(findPendingCommitMessage(msgs)).toBeNull();
    });

    it('stops at a committed assistant message (sceneId set) — mainApp stamps sceneId on commit', () => {
        // mainApp has no scene-marker system message; the scan stops at an
        // assistant message with sceneId set (committed) OR at a user message.
        // A pending message before a committed one should NOT be found.
        const msgs = [
            makeMsg({ id: 'g1', role: 'assistant', swipeSet: [makeVariant()], pendingCommit: true }),
            makeMsg({ id: 'g2', role: 'assistant', sceneId: '042' }),
        ];
        expect(findPendingCommitMessage(msgs)).toBeNull();
    });

    it('finds the pending message when it is after the last committed one', () => {
        const msgs = [
            makeMsg({ id: 'g1', role: 'assistant', sceneId: '042' }),
            makeMsg({ id: 'u2', role: 'user' }),
            makeMsg({ id: 'g2', role: 'assistant', swipeSet: [makeVariant()], pendingCommit: true }),
        ];
        const found = findPendingCommitMessage(msgs);
        expect(found?.id).toBe('g2');
    });

    it('stops at a user message — pending must be in the un-committed tail', () => {
        const msgs = [
            makeMsg({ id: 'g1', role: 'assistant', swipeSet: [makeVariant()], pendingCommit: true }),
            makeMsg({ id: 'u2', role: 'user' }),
        ];
        // The user message breaks the scan — g1 is NOT the latest GM bubble.
        expect(findPendingCommitMessage(msgs)).toBeNull();
    });
});