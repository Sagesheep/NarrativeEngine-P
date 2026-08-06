import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageBubble } from '../MessageBubble';
import type { ChatMessage } from '../../types';
import {
    registerModChrome,
    registerModMessageBelow,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';

vi.mock('../../store/useAppStore', () => {
    const state = {
        settings: { ttsEnabled: true, ttsVoice: 'af_heart' },
        npcLedger: [],
    };
    const getState = vi.fn(() => state);
    const subscribe = vi.fn(() => vi.fn());
    const useAppStore = Object.assign(
        (selector: (s: typeof state) => unknown) => selector(state),
        { getState, subscribe }
    );
    return { useAppStore };
});

vi.mock('../../services/tts/useTtsStatus', () => ({
    useTtsStatus: () => ({ modelReady: true, initializing: false, voice: 'af_heart', modelId: 'm', dtype: 'q8' }),
}));

vi.mock('../../services/tts/ttsClient', () => ({
    generateTts: vi.fn(async () => new Blob(['audio'])),
    loadCachedTts: vi.fn(async () => null),
    checkCachedChunks: vi.fn(async (chunks: string[]) => chunks.map(() => false)),
}));

vi.mock('../../services/turn/pendingCommit', () => ({
    // Mirror of the real one-liner; mocked to keep the heavy module graph out of jsdom.
    hasSwipeSet: (msg: ChatMessage | undefined) =>
        !!(msg && msg.swipeSet && msg.swipeSet.length > 0 && msg.pendingCommit),
}));

vi.mock('../../services/turn/swipeGeneration', () => ({
    MAX_SWIPES: 5,
}));

import { checkCachedChunks, loadCachedTts } from '../../services/tts/ttsClient';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: 'The dragon roars!',
        timestamp: Date.now(),
        ...overrides,
    } as ChatMessage;
}

const noopHandlers = {
    onStartEdit: vi.fn(),
    onRegenerate: vi.fn(),
    onDelete: vi.fn(),
};

function renderBubble(msg: ChatMessage, extra: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
    return render(
        <MessageBubble
            message={msg}
            isStreaming={false}
            isLastMessage={true}
            showReasoning={true}
            debugMode={false}
            {...noopHandlers}
            {...extra}
        />
    );
}

beforeAll(() => {
    // jsdom has no object-URL support; the TTS cache path needs both.
    if (!URL.createObjectURL) {
        Object.assign(URL, {
            createObjectURL: () => `blob:mock-${Math.random()}`,
            revokeObjectURL: () => {},
        });
    }
});

describe('MessageBubble', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders a user message with the YOU label', () => {
        renderBubble(makeMessage({ role: 'user', content: 'I open the door' }));
        expect(screen.getByText('I open the door')).toBeInTheDocument();
        expect(screen.getByText('► YOU')).toBeInTheDocument();
    });

    it('renders assistant markdown content with the GM label', () => {
        renderBubble(makeMessage({ content: 'The **dragon** roars!' }));
        expect(screen.getByText('◇ GM')).toBeInTheDocument();
        expect(screen.getByText('dragon')).toBeInTheDocument();
        expect(screen.getByText('dragon').tagName).toBe('STRONG');
    });

    describe('reasoning accordion', () => {
        const thinkMsg = () => makeMessage({ content: '<think>secret plan</think>Visible narration.' });

        it('shows the Cognitive Process accordion when showReasoning is on', () => {
            renderBubble(thinkMsg(), { showReasoning: true });
            expect(screen.getByText('Cognitive Process')).toBeInTheDocument();
            expect(screen.getByText(/secret plan/)).toBeInTheDocument();
            expect(screen.getByText('Visible narration.')).toBeInTheDocument();
        });

        it('hides the reasoning block entirely when showReasoning is off', () => {
            renderBubble(thinkMsg(), { showReasoning: false });
            expect(screen.queryByText('Cognitive Process')).not.toBeInTheDocument();
            expect(screen.queryByText('secret plan')).not.toBeInTheDocument();
            expect(screen.getByText('Visible narration.')).toBeInTheDocument();
        });

        it('renders the Cognitive Process accordion from native reasoning_content field', () => {
            const nativeMsg = makeMessage({
                content: 'Visible narration.',
                reasoning_content: 'secret plan from native field',
            });
            renderBubble(nativeMsg, { showReasoning: true });
            expect(screen.getByText('Cognitive Process')).toBeInTheDocument();
            expect(screen.getByText(/secret plan from native field/)).toBeInTheDocument();
            expect(screen.getByText('Visible narration.')).toBeInTheDocument();
        });

        it('prefers inline <think> tags over reasoning_content when both are present', () => {
            const both = makeMessage({
                content: '<think>inline plan</think>Visible narration.',
                reasoning_content: 'native plan that should be ignored',
            });
            renderBubble(both, { showReasoning: true });
            expect(screen.getByText(/inline plan/)).toBeInTheDocument();
            expect(screen.queryByText(/native plan that should be ignored/)).not.toBeInTheDocument();
            expect(screen.getByText('Visible narration.')).toBeInTheDocument();
        });
    });

    describe('swipe navigation', () => {
        const swipeMsg = (activeIndex = 1) => makeMessage({
            content: 'variant one',
            pendingCommit: true,
            swipeActiveIndex: activeIndex,
            swipeSet: [
                { id: 's1', text: 'variant one' },
                { id: 's2', text: 'variant two' },
            ],
        } as Partial<ChatMessage>);

        it('shows the position indicator as current/MAX_SWIPES', () => {
            renderBubble(swipeMsg(1));
            expect(screen.getByText('2/5')).toBeInTheDocument();
        });

        it('chevrons navigate prev/next', async () => {
            const user = userEvent.setup();
            const onSwipeNavigate = vi.fn();
            const msg = swipeMsg(1);
            renderBubble(msg, { onSwipeNavigate });
            await user.click(screen.getByTitle('Next variant'));
            expect(onSwipeNavigate).toHaveBeenCalledWith(msg.id, 'next');
            await user.click(screen.getByTitle('Previous variant'));
            expect(onSwipeNavigate).toHaveBeenCalledWith(msg.id, 'prev');
        });

        it('disables the prev chevron on the first variant', () => {
            renderBubble(swipeMsg(0));
            expect(screen.getByTitle('Previous variant')).toBeDisabled();
        });

        it('touch-swiping left on the bubble navigates to the next variant', () => {
            const onSwipeNavigate = vi.fn();
            const msg = swipeMsg(0);
            renderBubble(msg, { onSwipeNavigate });
            const bubble = screen.getByText('variant one').closest('[data-message-id]')!;
            fireEvent.touchStart(bubble, { touches: [{ clientX: 200, clientY: 100 }] });
            fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 100, clientY: 105 }] });
            expect(onSwipeNavigate).toHaveBeenCalledWith(msg.id, 'next');
        });

        it('a mostly-vertical touch move does not trigger swipe navigation', () => {
            const onSwipeNavigate = vi.fn();
            renderBubble(swipeMsg(0), { onSwipeNavigate });
            const bubble = screen.getByText('variant one').closest('[data-message-id]')!;
            fireEvent.touchStart(bubble, { touches: [{ clientX: 200, clientY: 100 }] });
            fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 140, clientY: 300 }] });
            expect(onSwipeNavigate).not.toHaveBeenCalled();
        });

        it('Continue button fires onSceneContinue and is disabled while streaming', async () => {
            const user = userEvent.setup();
            const onSceneContinue = vi.fn();
            const msg = swipeMsg(1);
            const { unmount } = renderBubble(msg, { onSceneContinue });
            await user.click(screen.getByTitle('Continue — extend this reply'));
            expect(onSceneContinue).toHaveBeenCalledWith(msg.id);
            unmount();
            renderBubble(swipeMsg(1), { onSceneContinue, globalIsStreaming: true });
            expect(screen.getByTitle('Continue — extend this reply')).toBeDisabled();
        });
    });

    describe('TTS playback panel', () => {
        it('shows the Read aloud button for assistant messages when TTS is ready', () => {
            renderBubble(makeMessage());
            expect(screen.getByTitle('Read aloud')).toBeInTheDocument();
        });

        it('does not show a speaker button on user messages', () => {
            renderBubble(makeMessage({ role: 'user', content: 'hello' }));
            expect(screen.queryByTitle('Read aloud')).not.toBeInTheDocument();
        });

        it('shows the playback panel when disk-cached audio chunks exist', async () => {
            (checkCachedChunks as ReturnType<typeof vi.fn>).mockImplementation(
                async (chunks: string[]) => chunks.map(() => true)
            );
            (loadCachedTts as ReturnType<typeof vi.fn>).mockResolvedValue(new Blob(['wav']));
            renderBubble(makeMessage({ content: 'One sentence. Another sentence.' }));
            expect(await screen.findByText('click a sentence to jump')).toBeInTheDocument();
        });
    });

    describe('inline edit mode', () => {
        it('renders the editor textarea and submits on Enter, cancels on Escape', async () => {
            const user = userEvent.setup();
            const onInlineSubmit = vi.fn();
            const onInlineCancel = vi.fn();
            renderBubble(makeMessage(), {
                isEditing: true,
                inlineDraft: 'edited text',
                onInlineDraftChange: vi.fn(),
                onInlineSubmit,
                onInlineCancel,
            });
            const editor = screen.getByPlaceholderText('Edit message...');
            expect(editor).toHaveValue('edited text');
            await user.type(editor, '{Enter}');
            expect(onInlineSubmit).toHaveBeenCalled();
            await user.type(editor, '{Escape}');
            expect(onInlineCancel).toHaveBeenCalled();
        });
    });

    // ── Phase 4.4 — message-row affordances (message.actions + message.below) ──
    //
    // Proves the zero-mod DOM rule (MOUNTS.md §2.8) and that both mount
    // points render inside the bubble without disturbing the existing
    // structure. The rail's mod overlay and the below-body slots each
    // render `null` when no mod has claimed the region, so the bubble's DOM
    // is byte-identical to the pre-4.4 bubble with zero mods installed.
    describe('Phase 4.4 — message-row affordances', () => {
        beforeEach(() => {
            resetMountRegistryForTests();
        });

        it('with zero mods: the bubble has no mod-action buttons and no below-body slot (§2.8)', () => {
            const { container } = renderBubble(makeMessage({ content: 'Hello world' }));
            // No mod-action buttons: the rail has only the built-in
            // edit/rewind/speak/delete buttons. A mod's button would carry
            // a `mod.mod-a.` qualified id, which we can assert is absent.
            const buttons = container.querySelectorAll('button');
            const modButtons = Array.from(buttons).filter((b) =>
                (b.getAttribute('aria-label') ?? '').startsWith('mod.'));
            expect(modButtons).toHaveLength(0);
            // No below-body slot: the `MessageBelowSlots` component renders
            // `null` when no slot is claimed, so there is no wrapper div with
            // `overflow-hidden text-text-dim` between the attachments block
            // and the retry/swipe/continue block.
            const slotWrappers = container.querySelectorAll('.overflow-hidden.text-text-dim');
            expect(slotWrappers).toHaveLength(0);
        });

        it('a mod action button appears in the rail when a mod claims message.actions', () => {
            registerModChrome('message.actions', { id: 'mod-a', name: 'Mod A' }, {
                id: 'tag',
                icon: 'Tag',
                label: 'Tag',
                tooltip: 'Tag this message',
                onSelect: () => undefined,
            }, 0);
            renderBubble(makeMessage({ content: 'Hello' }));
            // The mod's button is present (the aria-label is the namespaced
            // tooltip, per the i18n lookup in the mod's namespace).
            const modButton = screen.getByRole('button', { name: 'mod.mod-a.Tag this message' });
            expect(modButton).toBeInTheDocument();
        });

        it('a mod below-body slot renders beneath the prose and above the swipe/continue block', async () => {
            registerModMessageBelow({ id: 'mod-a', name: 'Mod A' }, {
                id: 'note',
                mount: (node) => { node.textContent = 'below-body-annotation'; },
            }, 0, {});
            renderBubble(makeMessage({ content: 'The dragon roars' }));
            expect(await screen.findByText('below-body-annotation')).toBeInTheDocument();
        });

        it('mod action buttons do NOT appear while editing (§2.5)', () => {
            registerModChrome('message.actions', { id: 'mod-a', name: 'Mod A' }, {
                id: 'tag',
                icon: 'Tag',
                label: 'Tag',
                tooltip: 'Tag',
                onSelect: () => undefined,
            }, 0);
            renderBubble(makeMessage(), {
                isEditing: true,
                inlineDraft: 'draft',
                onInlineDraftChange: vi.fn(),
                onInlineSubmit: vi.fn(),
                onInlineCancel: vi.fn(),
            });
            // While editing, the rail is save/cancel only — the mod's button
            // is absent (MessageActionsOverlay returns null when isEditing).
            expect(screen.queryByRole('button', { name: 'mod.mod-a.Tag' })).toBeNull();
            // The save/cancel buttons are present.
            expect(screen.getByTitle('Save edit (Enter)')).toBeInTheDocument();
            expect(screen.getByTitle('Cancel (Esc)')).toBeInTheDocument();
        });

        it('survives a swipe-set message (renders slot without crashing, §8.4)', async () => {
            registerModMessageBelow({ id: 'mod-a', name: 'Mod A' }, {
                id: 'note',
                mount: (node, _ctx, message) => {
                    node.textContent = `slot-for:${message.id}`;
                },
            }, 0, {});
            const swipeMsg = makeMessage({
                content: 'Swipe me',
                pendingCommit: true,
                swipeSet: [{ content: 'variant 1', streaming: false }],
                swipeActiveIndex: 0,
            });
            renderBubble(swipeMsg);
            expect(await screen.findByText(`slot-for:${swipeMsg.id}`)).toBeInTheDocument();
            // The swipe/continue affordance is still present (the slot did
            // not displace it).
            expect(screen.getByTitle('Previous variant')).toBeInTheDocument();
        });
    });
});
