import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { buildPcCombatant, createCombat } from '@narrative/engine';
import { MessageBubble } from '../../MessageBubble';
import { ChatMessageList } from '../../chat/ChatMessageList';
import { CombatProposalDialog } from '../CombatProposalDialog';
import { CombatActionBar } from '../CombatActionBar';
import { CombatInitiativeStrip } from '../CombatInitiativeStrip';
import { isTypingTarget } from '../combatKeys';
import type { AppSettings, ChatMessage, CombatProposal, CombatSession, CombatSheet } from '../../../types';

const { rewriteBeat } = vi.hoisted(() => ({ rewriteBeat: vi.fn(async () => {}) }));

vi.mock('../../../store/useAppStore', () => {
    const state = { settings: {}, npcLedger: [], locationLedger: [], context: {}, pipelinePhase: 'idle', streamingStats: null };
    const useAppStore = Object.assign(
        (selector: (s: typeof state) => unknown) => selector(state),
        { getState: () => state, subscribe: () => () => {} },
    );
    return { useAppStore };
});

vi.mock('../../../services/tts/useTtsStatus', () => ({
    useTtsStatus: () => ({ modelReady: false, initializing: false, voice: 'af_heart', modelId: 'm', dtype: 'q8' }),
}));

vi.mock('../../../services/turn/pendingCommit', () => ({
    hasSwipeSet: (msg: ChatMessage | undefined) => !!(msg && msg.swipeSet && msg.swipeSet.length > 0 && msg.pendingCommit),
    commitPendingTurn: vi.fn(async () => {}),
    findPendingCommitMessage: () => null,
}));

vi.mock('../../../services/turn/swipeGeneration', () => ({ MAX_SWIPES: 5 }));

vi.mock('../../../services/combat/combatNarration', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../services/combat/combatNarration')>()),
    rewriteCombatBeat: rewriteBeat,
}));

const pending: ChatMessage = {
    id: 'gm-1', role: 'assistant', content: 'They draw steel.', timestamp: 1, pendingCommit: true, swipeActiveIndex: 0,
    swipeSet: [{ id: 'v1', text: 'They draw steel.', sceneStakes: 'dangerous', tagPresent: true }, { id: 'v2', text: 'Alt', sceneStakes: 'dangerous', tagPresent: true }],
};

function bubble(message: ChatMessage, combatLock?: Parameters<typeof MessageBubble>[0]['combatLock']) {
    return render(
        <MessageBubble
            message={message}
            isStreaming={false}
            isLastMessage
            showReasoning={false}
            debugMode={false}
            onStartEdit={() => {}}
            onRegenerate={() => {}}
            onDelete={() => {}}
            onOpenSwipeSheet={() => {}}
            combatLock={combatLock}
        />,
    );
}

describe('swipe lock UI (T3 rule 2, A8)', () => {
    it('disables swipe arrows, Continue and the variant sheet while a proposal is pending, with a tooltip', () => {
        bubble(pending, { swipeLocked: true, rewindDeleteLocked: false, sessionActive: false });
        const locked = screen.getAllByTitle('Answer the combat prompt first.');
        expect(locked.length).toBeGreaterThanOrEqual(4);
        for (const el of locked) expect(el).toBeDisabled();
    });

    it('restores the controls once the lock is gone', () => {
        bubble({ ...pending, swipeActiveIndex: 1 });
        expect(screen.queryByTitle('Answer the combat prompt first.')).toBeNull();
        expect(screen.getByTitle('Previous variant')).not.toBeDisabled();
        expect(screen.getByTitle('Continue — extend this reply')).not.toBeDisabled();
    });

    it('shows Rewrite instead of Rewind on a narration beat and blocks Delete', () => {
        const onRewrite = vi.fn();
        bubble({ id: 'b', role: 'assistant', content: 'Blades flash.', timestamp: 2, combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 3 } },
            { swipeLocked: false, rewindDeleteLocked: true, sessionActive: false, onRewrite });
        expect(screen.queryByTitle(/Rewind to here/)).toBeNull();
        fireEvent.click(screen.getByTitle('Rewrite this narration'));
        expect(onRewrite).toHaveBeenCalled();
        expect(screen.getByTitle('Combat messages cannot be rewound or deleted.')).toBeDisabled();
    });

    it('disables Rewind and Delete on ordinary messages while a fight is running', () => {
        bubble({ id: 'g', role: 'assistant', content: 'Earlier.', timestamp: 0 }, { swipeLocked: false, rewindDeleteLocked: true, sessionActive: true });
        const locked = screen.getAllByTitle('Not available during a fight.');
        expect(locked).toHaveLength(2);
        for (const el of locked) expect(el).toBeDisabled();
    });

    it('offers a retry on a failed beat', () => {
        const onRewrite = vi.fn();
        bubble({ id: 'b', role: 'assistant', content: '', timestamp: 2, combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 3, failed: true } },
            { swipeLocked: false, rewindDeleteLocked: true, sessionActive: true, onRewrite });
        fireEvent.click(screen.getByText('Retry'));
        expect(onRewrite).toHaveBeenCalled();
    });
});

describe('story feed (compact ChatMessageList)', () => {
    const story: ChatMessage[] = [
        { id: 'm1', role: 'assistant', content: 'The road was quiet.', timestamp: 1 },
        { id: 'm2', role: 'user', content: 'I walk on.', timestamp: 2 },
        { id: 'gm', role: 'assistant', content: 'Bandits leap from the ditch.', timestamp: 3 },
        { id: 'log', role: 'system', name: 'combat-log', content: 'Kira hits Bandit for 6.', timestamp: 4 },
        { id: 'beat', role: 'assistant', content: 'Steel rings on steel.', timestamp: 5, combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 3 } },
        { id: 'failed', role: 'assistant', content: '', timestamp: 6, combatBeat: { sessionId: 's', fromSeq: 4, toSeq: 5, failed: true } },
    ];

    function feed(messages: ChatMessage[], isStreaming = false) {
        return render(
            <ChatMessageList
                scrollContainerRef={{ current: null }}
                bottomRef={{ current: null }}
                messages={messages}
                isStreaming={isStreaming}
                settings={{} as AppSettings}
                editor={{ startEditing: () => {}, handleRegenerate: () => {}, handleDeleteOutput: () => {}, editingMessageId: null, inlineDraft: '', setInlineDraft: () => {}, handleEditSubmit: () => {}, cancelEditing: () => {} } as never}
                pendingMessageId={null}
                swipe={{ prevSwipe: () => {}, nextSwipe: () => {}, swipeGenLoading: false } as never}
                sceneContinue={{ runSceneContinue: () => {}, continueLoading: false } as never}
                onOpenSwipeSheet={() => {}}
                onCreateCharacter={() => {}}
                loadingStatus={null}
                pipelinePhase="idle"
                streamingStats={null}
                directorBriefRunning={false}
                onSkipDirectorBrief={() => {}}
                compact
                fromMessageId="gm"
            />,
        );
    }

    beforeEach(() => { rewriteBeat.mockClear(); });

    it('starts at the message that began the fight and reveals earlier story on request', () => {
        const { container } = feed(story);
        expect(container.querySelector('[data-compact="true"]')).not.toBeNull();
        expect(screen.queryByText('The road was quiet.')).toBeNull();
        expect(screen.getByText('Bandits leap from the ditch.')).toBeInTheDocument();
        expect(screen.getByText('Kira hits Bandit for 6.')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Show earlier story'));
        expect(screen.getByText('The road was quiet.')).toBeInTheDocument();
        expect(screen.queryByText('Show earlier story')).toBeNull();
    });

    it('keeps Rewrite and failed-beat retry working in the feed', () => {
        feed(story);
        fireEvent.click(screen.getAllByTitle('Rewrite this narration')[0]);
        expect(rewriteBeat).toHaveBeenCalledWith('beat');
        fireEvent.click(screen.getByText('Retry'));
        expect(rewriteBeat).toHaveBeenCalledWith('failed');
    });

    it('renders a streaming beat as it grows', () => {
        const streaming = [...story.slice(0, 5), { id: 'live', role: 'assistant' as const, content: 'The bandit', timestamp: 7, combatBeat: { sessionId: 's', fromSeq: 6, toSeq: 7 } }];
        const view = feed(streaming, true);
        expect(screen.getByText('The bandit')).toBeInTheDocument();
        view.rerender(
            <ChatMessageList
                scrollContainerRef={{ current: null }}
                bottomRef={{ current: null }}
                messages={[...streaming.slice(0, 5), { ...streaming[5], content: 'The bandit staggers back.' }]}
                isStreaming
                settings={{} as AppSettings}
                editor={{ startEditing: () => {}, handleRegenerate: () => {}, handleDeleteOutput: () => {}, editingMessageId: null, inlineDraft: '', setInlineDraft: () => {}, handleEditSubmit: () => {}, cancelEditing: () => {} } as never}
                pendingMessageId={null}
                swipe={{ prevSwipe: () => {}, nextSwipe: () => {}, swipeGenLoading: false } as never}
                sceneContinue={{ runSceneContinue: () => {}, continueLoading: false } as never}
                onOpenSwipeSheet={() => {}}
                onCreateCharacter={() => {}}
                loadingStatus={null}
                pipelinePhase="idle"
                streamingStats={null}
                directorBriefRunning={false}
                onSkipDirectorBrief={() => {}}
                compact
                fromMessageId="gm"
            />,
        );
        expect(screen.getByText('The bandit staggers back.')).toBeInTheDocument();
    });

    it('renders an offer node directly beneath the message it refers to', () => {
        render(
            <ChatMessageList
                scrollContainerRef={{ current: null }}
                bottomRef={{ current: null }}
                messages={story.slice(0, 3)}
                isStreaming={false}
                settings={{} as AppSettings}
                editor={{ startEditing: () => {}, handleRegenerate: () => {}, handleDeleteOutput: () => {}, editingMessageId: null, inlineDraft: '', setInlineDraft: () => {}, handleEditSubmit: () => {}, cancelEditing: () => {} } as never}
                pendingMessageId={null}
                swipe={{ prevSwipe: () => {}, nextSwipe: () => {}, swipeGenLoading: false } as never}
                sceneContinue={{ runSceneContinue: () => {}, continueLoading: false } as never}
                onOpenSwipeSheet={() => {}}
                onCreateCharacter={() => {}}
                loadingStatus={null}
                pipelinePhase="idle"
                streamingStats={null}
                directorBriefRunning={false}
                onSkipDirectorBrief={() => {}}
                offer={{ messageId: 'm1', node: <div data-testid="offer">offer</div> }}
            />,
        );
        const rows = Array.from(document.querySelectorAll('[data-ui="msg-row"], [data-testid="offer"]'));
        expect(rows.map(r => r.getAttribute('data-testid') ?? r.getAttribute('data-role'))).toEqual(['assistant', 'offer', 'user', 'assistant']);
    });
});

describe('CombatProposalDialog', () => {
    const proposal: CombatProposal = {
        id: 'p', messageId: 'gm-1', reason: 'Bandits block the road.', source: 'tool',
        combatants: [{ name: 'Bandit 1', side: 'enemy', tier: 'grunt' }, { name: 'Bandit 2', side: 'enemy', tier: 'grunt' }],
    };

    function dialog(over: Partial<Parameters<typeof CombatProposalDialog>[0]> = {}) {
        const props = { onStart: vi.fn(), onDecline: vi.fn(), onMinimise: vi.fn(), onClosed: vi.fn() };
        const utils = render(<CombatProposalDialog proposal={proposal} open {...props} {...over} />);
        return { ...props, ...over, ...utils };
    }

    afterEach(() => { vi.restoreAllMocks(); });

    it('is a modal dialog headed by the reason that lets the player edit the roster before starting', () => {
        const { onStart } = dialog();
        const d = screen.getByRole('dialog');
        expect(d.getAttribute('aria-modal')).toBe('true');
        expect(within(d).getByRole('heading', { name: 'Bandits block the road.' })).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText('Remove Bandit 2'));
        fireEvent.change(screen.getByLabelText('Tier of Bandit 1'), { target: { value: 'elite' } });
        fireEvent.change(screen.getByPlaceholderText('Combatant name'), { target: { value: 'Hound' } });
        fireEvent.click(screen.getByText('Add'));
        fireEvent.change(screen.getByLabelText('Side of Hound'), { target: { value: 'ally' } });
        fireEvent.click(screen.getByText('Start combat', { selector: 'button' }));
        expect(onStart).toHaveBeenCalledWith({ ...proposal, combatants: [
            { name: 'Bandit 1', side: 'enemy', tier: 'elite' },
            { name: 'Hound', side: 'ally', tier: 'grunt' },
        ], map: expect.objectContaining({ area: 'street', density: 'normal', hazard: 'none', size: 'medium', labels: { wall: 'hedgerows', cover: 'carts', difficult: 'mud', hazard: 'hazard' } }), mapSeed: expect.any(Number) });
    });

    it('cannot start without an enemy and declines only on Not now', () => {
        const { onStart, onDecline } = dialog({ proposal: { ...proposal, combatants: [], source: 'manual' } });
        expect(screen.getByText('Start combat', { selector: 'button' })).toBeDisabled();
        fireEvent.click(screen.getByText('Start combat', { selector: 'button' }));
        expect(onStart).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Not now'));
        expect(onDecline).toHaveBeenCalled();
    });

    it('minimises on Escape and on a backdrop click, never declining, and keeps Escape from other handlers', () => {
        const leaked: string[] = [];
        const outside = (e: KeyboardEvent) => { leaked.push(e.key); };
        document.addEventListener('keydown', outside);
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        const { onMinimise, onDecline } = dialog();
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(onMinimise).toHaveBeenCalledTimes(1);
        expect(leaked).toEqual([]);
        const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
        fireEvent.click(backdrop);
        expect(onMinimise).toHaveBeenCalledTimes(1);
        now.mockReturnValue(5000);
        fireEvent.click(backdrop);
        expect(onMinimise).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole('dialog'));
        expect(onMinimise).toHaveBeenCalledTimes(2);
        expect(onDecline).not.toHaveBeenCalled();
        document.removeEventListener('keydown', outside);
    });

    it('traps focus inside and hands focus back when closed, keeping edits while minimised', () => {
        const props = { onStart: vi.fn(), onDecline: vi.fn(), onMinimise: vi.fn(), onClosed: vi.fn() };
        const view = render(<CombatProposalDialog proposal={proposal} open {...props} />);
        const d = screen.getByRole('dialog');
        const start = screen.getByText('Start combat', { selector: 'button' });
        expect(document.activeElement).toBe(start);
        expect(fireEvent.keyDown(d, { key: 'Tab' })).toBe(false);
        const focusables = Array.from(d.querySelectorAll<HTMLElement>('button:not([disabled]), select, input'));
        expect(document.activeElement).toBe(focusables[0]);
        expect(fireEvent.keyDown(d, { key: 'Tab', shiftKey: true })).toBe(false);
        expect(document.activeElement).toBe(focusables[focusables.length - 1]);
        fireEvent.click(screen.getByLabelText('Remove Bandit 2'));
        view.rerender(<CombatProposalDialog proposal={proposal} open={false} {...props} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(props.onClosed).toHaveBeenCalledTimes(1);
        view.rerender(<CombatProposalDialog proposal={proposal} open {...props} />);
        expect(screen.queryByLabelText('Remove Bandit 2')).toBeNull();
        expect(screen.getByLabelText('Remove Bandit 1')).toBeInTheDocument();
    });
});

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function session(): CombatSession {
    const { state, events } = createCombat({ id: 'f', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }, { name: 'Wolf', side: 'enemy', tier: 'minion' }] }, buildPcCombatant({ name: 'Kira', sheet }), 2);
    const combatants = { ...state.combatants };
    const pc = combatants.pc.position!;
    let dy = -1;
    for (const id of Object.keys(combatants).filter(id => id !== 'pc')) {
        combatants[id] = { ...combatants[id], position: { x: pc.x + 1, y: pc.y + dy } };
        dy += 1;
    }
    const pcIndex = state.order.indexOf('pc');
    return { state: { ...state, combatants, turnIndex: pcIndex, turn: { actorId: 'pc', moveLeft: 6, actionUsed: false } }, log: events, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

describe('CombatActionBar', () => {
    const bar = (s: CombatSession, over: { busy?: boolean; targetId?: string | null } = {}) => {
        const props = { onAction: vi.fn(), onPick: vi.fn(), onSkip: vi.fn() };
        render(<CombatActionBar session={s} busy={false} targetId={null} {...props} {...over} />);
        return props;
    };

    beforeEach(() => { vi.restoreAllMocks(); });

    it('shows the acting player vitals with numbers, AC and movement left', () => {
        bar(session());
        const vitals = screen.getByTestId('combat-vitals');
        expect(vitals.textContent).toContain('Kira');
        expect(vitals.textContent).toContain('28 / 28 HP');
        expect(vitals.textContent).toMatch(/AC \d+/);
        expect(screen.getByTestId('combat-move-left').textContent).toBe('Move 6');
    });

    it('A attacks the selected target, or enters target picking with no valid selection; D defends', () => {
        const picked = bar(session());
        fireEvent.keyDown(window, { key: 'a' });
        expect(picked.onPick).toHaveBeenCalledTimes(1);
        expect(picked.onAction).not.toHaveBeenCalled();
        fireEvent.keyDown(window, { key: 'd' });
        expect(picked.onAction).toHaveBeenLastCalledWith({ type: 'defend', actorId: 'pc' });
    });

    it('draws Attack and Defend as ability tiles with their glyph strip and rules, before everything else (5B-1)', () => {
        bar(session());
        const group = screen.getByTestId('combat-basic-actions');
        const attack = within(group).getByTestId('combat-ability-builtin:attack');
        const defend = within(group).getByTestId('combat-ability-builtin:defend');
        expect(attack).toHaveAttribute('aria-keyshortcuts', 'A');
        expect(defend).toHaveAttribute('aria-keyshortcuts', 'D');
        expect(attack).toHaveTextContent('Attack');
        expect(defend).toHaveTextContent('Defend');
        const tip = screen.getByTestId('combat-ability-tip-builtin:attack');
        expect(attack).toHaveAttribute('aria-describedby', 'combat-ability-tip-builtin:attack');
        expect(within(tip).getByTestId('glyph-strip')).toBeInTheDocument();
        expect(within(tip).getByRole('img', { name: 'Weapon strike' })).toBeInTheDocument();
        expect(tip).toHaveTextContent('Attack roll +');
        expect(screen.getByTestId('combat-ability-tip-builtin:defend')).toHaveTextContent('The user takes a defensive stance');
        const buttons = within(screen.getByTestId('combat-actions')).getAllByRole('button');
        expect(buttons[0]).toBe(attack);
        expect(buttons[1]).toBe(defend);
    });

    const full = (s: CombatSession, over: { compact?: boolean; aimingId?: string | null } = {}) => {
        const props = { onAction: vi.fn(), onPick: vi.fn(), onSkip: vi.fn(), onAim: vi.fn() };
        render(<CombatActionBar session={s} busy={false} targetId={null} {...props} {...over} />);
        return props;
    };

    it('draws the five tabletop actions after Attack and Defend, with keys, glyph strips and rules (5B-2)', () => {
        full(session());
        const group = screen.getByTestId('combat-basic-actions');
        const buttons = within(group).getAllByRole('button');
        expect(buttons[2].getAttribute('data-testid')).toBe('combat-stunt');
        const tiles = buttons.filter(b => b.getAttribute('data-testid') !== 'combat-stunt');
        expect(tiles.map(b => b.getAttribute('data-testid'))).toEqual([
            'builtin:attack', 'builtin:defend', 'builtin:dash', 'builtin:shove', 'builtin:jump', 'builtin:throw', 'builtin:help',
        ].map(id => `combat-ability-${id}`));
        expect(tiles.map(b => b.getAttribute('aria-keyshortcuts'))).toEqual(['A', 'D', 'R', 'S', 'J', 'T', 'H']);
        expect(tiles.map(b => b.textContent?.replace(/^[A-Z]/, '').replace(/No legal target$/, ''))).toEqual(['Attack', 'Defend', 'Dash', 'Shove', 'Jump', 'Throw', 'Help']);
        const dash = screen.getByTestId('combat-ability-tip-builtin:dash');
        expect(within(dash).getByRole('img', { name: 'Sprint' })).toBeInTheDocument();
        expect(dash).toHaveTextContent('one more full allowance of movement');
        expect(within(screen.getByTestId('combat-ability-tip-builtin:jump')).getByRole('img', { name: 'Leap' })).toBeInTheDocument();
        expect(within(screen.getByTestId('combat-ability-tip-builtin:help')).getByRole('img', { name: 'Rally' })).toBeInTheDocument();
        expect(screen.getByTestId('combat-ability-tip-builtin:shove')).toHaveTextContent('STR or DEX save');
        expect(screen.getByTestId('combat-ability-tip-builtin:throw')).toHaveTextContent('1d4');
    });

    it('starts aiming a tabletop action by key and by button, and disables the ones with no legal use, stating why', () => {
        const props = full(session());
        fireEvent.keyDown(window, { key: 'r' });
        expect(props.onAim).toHaveBeenLastCalledWith('builtin:dash');
        fireEvent.keyDown(window, { key: 's' });
        expect(props.onAim).toHaveBeenLastCalledWith('builtin:shove');
        fireEvent.click(screen.getByTestId('combat-ability-builtin:throw'));
        expect(props.onAim).toHaveBeenLastCalledWith('builtin:throw');
        props.onAim.mockClear();
        fireEvent.keyDown(window, { key: 'h' });
        expect(props.onAim).not.toHaveBeenCalled();
        const help = screen.getByTestId('combat-ability-builtin:help');
        expect(help).toHaveAttribute('aria-disabled', 'true');
        expect(help).toHaveTextContent('No legal target');
        fireEvent.keyDown(window, { key: 'x' });
        expect(props.onAim).not.toHaveBeenCalled();
    });

    it('explains a spent action, a spent bonus action and short movement on the tiles', () => {
        const s = session();
        const spent = { ...s, state: { ...s.state, turn: { actorId: 'pc', moveLeft: 0, actionUsed: true, bonusUsed: true } } };
        full(spent);
        expect(screen.getByTestId('combat-ability-builtin:dash')).toHaveTextContent('Your action for this turn is used');
        expect(screen.getByTestId('combat-ability-builtin:shove')).toHaveTextContent('Bonus action already used');
        expect(screen.getByTestId('combat-ability-builtin:jump')).toHaveTextContent('Bonus action already used');
        expect(screen.getByTestId('combat-ability-builtin:throw')).toHaveAttribute('aria-disabled', 'true');
        cleanup();
        const slow = { ...s, state: { ...s.state, turn: { actorId: 'pc', moveLeft: 0, actionUsed: false } } };
        full(slow);
        expect(screen.getByTestId('combat-ability-builtin:jump')).toHaveTextContent('Not enough movement left');
    });

    it('opens Try something with a 240-character field and the rule line, and shows the verdict with Roll and Back (5B-3)', () => {
        full(session());
        fireEvent.click(screen.getByTestId('combat-stunt'));
        expect(screen.getByTestId('combat-stunt-input')).toHaveAttribute('maxLength', '240');
        expect(screen.getByTestId('combat-stunt-form')).toHaveTextContent('the referee sets the odds, the dice decide');
        cleanup();
        const s = session();
        const at = s.state.combatants.pc.position!;
        full({ ...s, stunt: { attemptId: 'a', actorId: 'pc', words: 'I vault.', stage: 'verdict', difficulty: 'moderate', spec: { ability: 'DEX', parts: [{ outcome: 'move', at: { x: at.x - 2, y: at.y }, difficulty: 'moderate' }] } } });
        const verdict = screen.getByTestId('combat-stunt-verdict');
        expect(verdict).toHaveTextContent('Get to a square 2 away');
        expect(screen.getByTestId('combat-stunt-odds')).toHaveTextContent('DEX check, moderate');
        expect(screen.getByTestId('combat-stunt-roll')).toBeInTheDocument();
        expect(screen.getByTestId('combat-stunt-back')).toBeInTheDocument();
    });

    it('folds the five tabletop actions into a More actions popover at narrow widths, keeping Attack and Defend', () => {
        const props = full(session(), { compact: true });
        const group = screen.getByTestId('combat-basic-actions');
        expect(within(group).getAllByRole('button').map(b => b.getAttribute('data-testid'))).toEqual([
            'combat-ability-builtin:attack', 'combat-ability-builtin:defend', 'combat-stunt', 'combat-more-actions',
        ]);
        expect(screen.queryByTestId('combat-ability-builtin:dash')).toBeNull();
        fireEvent.click(screen.getByTestId('combat-more-actions'));
        const popover = screen.getByTestId('combat-more-popover');
        expect(within(popover).getAllByRole('button')).toHaveLength(5);
        fireEvent.click(within(popover).getByTestId('combat-ability-builtin:shove'));
        expect(props.onAim).toHaveBeenLastCalledWith('builtin:shove');
        expect(screen.queryByTestId('combat-more-popover')).toBeNull();
        fireEvent.click(screen.getByTestId('combat-more-actions'));
        fireEvent.keyDown(screen.getByTestId('combat-more-popover'), { key: 'Escape' });
        expect(screen.queryByTestId('combat-more-popover')).toBeNull();
        fireEvent.keyDown(window, { key: 'r' });
        expect(props.onAim).toHaveBeenLastCalledWith('builtin:dash');
    });

    it('attacks a selected target in reach directly, by key and by button', () => {
        const s = session();
        const target = s.state.order.find(id => id !== 'pc') as string;
        const { onAction } = bar(s, { targetId: target });
        fireEvent.keyDown(window, { key: 'a' });
        expect(onAction).toHaveBeenLastCalledWith({ type: 'attack', actorId: 'pc', targetId: target });
        onAction.mockClear();
        fireEvent.click(screen.getByRole('button', { name: /Attack/ }));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'attack', actorId: 'pc', targetId: target });
        fireEvent.click(screen.getByText('End turn'));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'end_turn', actorId: 'pc' });
    });

    it('ignores shortcuts typed into inputs and shows Resolving while busy', () => {
        const onAction = vi.fn();
        render(<><input data-testid="field" /><CombatActionBar session={session()} busy targetId={null} onAction={onAction} onPick={() => {}} onSkip={() => {}} /></>);
        fireEvent.keyDown(screen.getByTestId('field'), { key: 'd' });
        expect(onAction).not.toHaveBeenCalled();
        expect(screen.getByTestId('combat-action-bar').getAttribute('data-mode')).toBe('resolving');
        expect(screen.queryByText('Attack')).toBeNull();
        expect(screen.getByText('Resolving…')).toBeInTheDocument();
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'true');
        expect(isTypingTarget(div)).toBe(true);
    });

    it('replaces the actions with "<name> is acting…" and Skip during an engine turn', () => {
        const s = session();
        const enemyIndex = s.state.order.findIndex(id => id !== 'pc');
        const enemy = s.state.order[enemyIndex];
        const engine = { ...s, state: { ...s.state, turnIndex: enemyIndex, turn: { actorId: enemy, moveLeft: 6, actionUsed: false } } };
        const { onSkip, onAction } = bar(engine, { busy: true });
        expect(screen.getByText(`${engine.state.combatants[enemy].name} is acting…`)).toBeInTheDocument();
        expect(screen.queryByText('Attack')).toBeNull();
        expect(screen.queryByText('End turn')).toBeNull();
        fireEvent.click(screen.getByText('Skip'));
        expect(onSkip).toHaveBeenCalled();
        fireEvent.keyDown(window, { key: 'd' });
        expect(onAction).not.toHaveBeenCalled();
    });

    it('shows a neutral Resolving state once the fight is ending', () => {
        const s = session();
        bar({ ...s, state: { ...s.state, outcome: 'victory' } });
        expect(screen.getByTestId('combat-action-bar').getAttribute('data-mode')).toBe('resolving');
        expect(screen.queryByText('End turn')).toBeNull();
    });
});

describe('CombatInitiativeStrip', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('lists combatants in turn order with downed ones last, numbers for the party and bands for others', () => {
        const s = session();
        const first = s.state.order.find(id => id !== 'pc') as string;
        s.state.combatants[first] = { ...s.state.combatants[first], status: 'down', hp: 0 };
        const onSelect = vi.fn();
        render(<CombatInitiativeStrip session={s} busy={false} selectedId={null} onSelect={onSelect} onEnd={() => {}} />);
        const chips = screen.getAllByRole('button').filter(b => b.getAttribute('data-testid')?.startsWith('combatant-'));
        expect(chips.map(c => c.getAttribute('data-testid'))[chips.length - 1]).toBe(`combatant-${first}`);
        expect(chips[chips.length - 1].className).toContain('opacity-45');
        expect(screen.getByTestId('combatant-pc').textContent).toContain('28 / 28 HP');
        expect(screen.getByTestId('combatant-pc').getAttribute('aria-current')).toBe('true');
        expect(screen.getByTestId(`combatant-${first}`).textContent).toContain('Down');
        expect(screen.getByText(`Combat · round ${s.state.round}`)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId(`combatant-${first}`));
        expect(onSelect).toHaveBeenCalledWith(first);
    });

    it('asks before ending the fight', () => {
        const onEnd = vi.fn();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<CombatInitiativeStrip session={session()} busy={false} selectedId={null} onSelect={() => {}} onEnd={onEnd} />);
        fireEvent.click(screen.getByText('End combat'));
        expect(onEnd).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('End combat'));
        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});
