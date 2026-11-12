import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { applyAction, buildPcCombatant, createCombat, currentTurn, distance, runEngineTurns } from '@narrative/engine';
import { CombatScreen } from '../CombatScreen';
import { attackableTargets } from '../combatVisuals';
import { isEngineTurn } from '../../../services/combat/combatController';
import type { ChatMessage, CombatAction, CombatPos, CombatSession, CombatSheet } from '../../../types';

const mockState: { settings: Record<string, unknown>; modTables: Record<string, unknown>; messages: ChatMessage[] } = { settings: {}, modTables: {}, messages: [] };

vi.mock('../../../store/useAppStore', () => {
    const useAppStore = Object.assign(
        (selector: (s: typeof mockState) => unknown) => selector(mockState),
        { getState: () => mockState, subscribe: () => () => {} },
    );
    return { useAppStore };
});

vi.mock('../../../services/turn/pendingCommit', () => ({
    commitPendingTurn: vi.fn(async () => {}),
    findPendingCommitMessage: () => null,
}));

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

let observedWidth = 1400;

class FakeResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(target: Element) {
        this.callback([{ target, contentRect: { width: observedWidth } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
}

function startSession(): CombatSession {
    const created = createCombat(
        { id: 'fight', combatants: [{ name: 'Rat', side: 'enemy', tier: 'minion' }, { name: 'Wolf', side: 'enemy', tier: 'minion' }], map: { size: 'small' }, mapSeed: 3 },
        buildPcCombatant({ name: 'Kira', sheet }),
        11,
    );
    let state = created.state;
    if (isEngineTurn(state)) state = runEngineTurns(state).state;
    return { state, log: created.events, narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Rats!' };
}

const latest: { session: CombatSession | null } = { session: null };

function Harness({ initial, onSkip = () => {} }: { initial: CombatSession; onSkip?: () => void }) {
    const [session, setSession] = useState(initial);
    const feedRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { latest.session = session; });
    const onAction = (action: CombatAction) => setSession(current => {
        const applied = applyAction(current.state, action);
        if (applied.events.some(e => e.type === 'rejected')) return current;
        let state = applied.state;
        if (!state.outcome && isEngineTurn(state)) state = runEngineTurns(state).state;
        return { ...current, state, log: [...current.log, ...applied.events] };
    });
    return (
        <CombatScreen
            session={session}
            busy={false}
            onAction={onAction}
            onEnd={() => {}}
            onSkip={onSkip}
            feedScrollRef={feedRef}
            feed={<div ref={feedRef} data-testid="feed-body">{session.reason}</div>}
        />
    );
}

function enemiesUp(session: CombatSession) {
    return Object.values(session.state.combatants).filter(c => c.side === 'enemy' && c.status === 'up' && c.position);
}

function bestStep(session: CombatSession): CombatPos | null {
    const state = session.state;
    const pc = state.combatants.pc;
    const foes = enemiesUp(session);
    if (!pc.position || foes.length === 0) return null;
    const gap = (p: CombatPos) => Math.min(...foes.map(f => distance(p, f.position as CombatPos)));
    let best: CombatPos | null = null;
    let bestGap = gap(pc.position);
    for (const r of screen.queryAllByTestId('combat-reachable')) {
        const p = { x: Number(r.getAttribute('data-x')), y: Number(r.getAttribute('data-y')) };
        if (gap(p) < bestGap) { best = p; bestGap = gap(p); }
    }
    return best;
}

function attackNow(session: CombatSession) {
    const turn = currentTurn(session.state);
    return attackableTargets(session.state, session.state.combatants.pc, !!turn && !turn.actionUsed);
}

const tileAt = (p: CombatPos) => document.querySelector(`rect[data-x="${p.x}"][data-y="${p.y}"][data-tile]`) as SVGRectElement;

async function playWithMouse() {
    for (let step = 0; step < 200 && !latest.session?.state.outcome; step++) {
        const session = latest.session as CombatSession;
        const targets = attackNow(session);
        if (targets.length > 0) {
            fireEvent.click(screen.getByTestId(`token-${targets[0].id}`));
            continue;
        }
        const move = bestStep(session);
        if (move) {
            fireEvent.click(tileAt(move));
            continue;
        }
        fireEvent.click(screen.getByText('End turn'));
    }
}

async function playWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
    for (let step = 0; step < 200 && !latest.session?.state.outcome; step++) {
        const session = latest.session as CombatSession;
        const surface = screen.getByTestId('combat-board-surface');
        expect(document.activeElement).toBe(surface);
        const targets = attackNow(session);
        if (targets.length > 0) {
            fireEvent.keyDown(document.activeElement as Element, { key: 'a' });
            if (latest.session === session) fireEvent.keyDown(surface, { key: 'Enter' });
            continue;
        }
        const move = bestStep(session);
        const from = session.state.combatants.pc.position as CombatPos;
        if (move) {
            fireEvent.keyDown(surface, { key: 'Escape' });
            for (let i = 0; i < Math.abs(move.x - from.x); i++) fireEvent.keyDown(surface, { key: move.x > from.x ? 'ArrowRight' : 'ArrowLeft' });
            for (let i = 0; i < Math.abs(move.y - from.y); i++) fireEvent.keyDown(surface, { key: move.y > from.y ? 'ArrowDown' : 'ArrowUp' });
            fireEvent.keyDown(surface, { key: 'Enter' });
            continue;
        }
        screen.getByText('End turn').closest('button')?.focus();
        await user.keyboard('{Enter}');
        surface.focus();
    }
}

beforeEach(() => {
    mockState.messages = [];
    observedWidth = 1400;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try { window.localStorage.clear(); } catch { return; }
});

afterEach(() => {
    vi.unstubAllGlobals();
    latest.session = null;
});

describe('CombatScreen layout', () => {
    it('lays out strip, board beside the story feed, and action bar at a wide width', () => {
        render(<Harness initial={startSession()} />);
        const root = screen.getByTestId('combat-screen');
        expect(root.getAttribute('data-layout')).toBe('wide');
        expect(screen.getByTestId('combat-initiative')).toBeInTheDocument();
        expect(screen.getByTestId('combat-action-bar')).toBeInTheDocument();
        expect(screen.getByTestId('combat-board-cell')).not.toHaveAttribute('hidden');
        expect(screen.getByTestId('combat-feed')).not.toHaveAttribute('hidden');
        expect(screen.queryByRole('button', { name: /Story/ })).toBeNull();
        const middle = screen.getByTestId('combat-board-cell').parentElement as HTMLElement;
        expect(middle.style.gridTemplateColumns).toBe('minmax(0, 1.7fr) minmax(280px, 1fr)');
    });

    it('falls back to the wide layout when ResizeObserver is missing', () => {
        vi.unstubAllGlobals();
        const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        try {
            render(<Harness initial={startSession()} />);
            expect(screen.getByTestId('combat-screen').getAttribute('data-layout')).toBe('wide');
        } finally {
            if (original) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
        }
    });

    it('switches between Map and Story below 900 px and marks unread narration', () => {
        observedWidth = 700;
        const view = render(<Harness initial={startSession()} />);
        expect(screen.getByTestId('combat-screen').getAttribute('data-layout')).toBe('narrow');
        const map = screen.getByRole('button', { name: 'Map' });
        const story = screen.getByRole('button', { name: 'Story' });
        expect(map).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('combat-board-cell')).not.toHaveAttribute('hidden');
        expect(screen.getByTestId('combat-feed')).toHaveAttribute('hidden');
        expect(screen.queryByTestId('combat-story-unread')).toBeNull();
        mockState.messages = [{ id: 'beat', role: 'assistant', content: 'Teeth flash.', timestamp: 1, combatBeat: { sessionId: 'fight', fromSeq: 1, toSeq: 2 } }];
        view.rerender(<Harness initial={startSession()} />);
        expect(screen.getByTestId('combat-story-unread')).toBeInTheDocument();
        fireEvent.click(story);
        expect(screen.queryByTestId('combat-story-unread')).toBeNull();
        expect(screen.getByTestId('combat-board-cell')).toHaveAttribute('hidden');
        expect(screen.getByTestId('combat-feed')).not.toHaveAttribute('hidden');
        fireEvent.click(screen.getByTestId('combatant-pc'));
        expect(screen.getByTestId('combat-board-cell')).not.toHaveAttribute('hidden');
        expect(within(screen.getByTestId('combat-board-cell')).getByTestId('combat-inspect')).toBeInTheDocument();
    });

    it('selects a token from its initiative chip and shows the inspect card', () => {
        render(<Harness initial={startSession()} />);
        const foe = enemiesUp(latest.session as CombatSession)[0];
        fireEvent.click(screen.getByTestId(`combatant-${foe.id}`));
        expect(screen.getByTestId('combat-inspect').textContent).toContain(foe.name);
        expect(screen.getByTestId(`token-${foe.id}`).querySelector('[data-testid="combat-selected"]')).not.toBeNull();
    });

    it('enters target picking from Attack when nothing valid is selected, and attacks on the next press', () => {
        const initial = startSession();
        const pc = initial.state.combatants.pc;
        const foe = enemiesUp(initial)[0];
        const adjacent = { x: (pc.position as CombatPos).x + 1, y: (pc.position as CombatPos).y };
        initial.state = {
            ...initial.state,
            combatants: { ...initial.state.combatants, [foe.id]: { ...foe, position: adjacent } },
        };
        initial.state.grid = { ...initial.state.grid!, tiles: initial.state.grid!.tiles.map(() => 'floor') };
        render(<Harness initial={initial} />);
        fireEvent.keyDown(document.body, { key: 'a' });
        const surface = screen.getByTestId('combat-board-surface');
        expect(surface.getAttribute('data-picking')).toBe('true');
        expect(document.activeElement).toBe(surface);
        expect(screen.getByTestId('combat-board-status').textContent).toBe(`Attack ${foe.name}`);
        expect(screen.getByTestId('combat-cursor').getAttribute('x')).toBe(String(adjacent.x * 10 + 0.4));
        expect(screen.getByTestId('combat-inspect').textContent).toContain(foe.name);
        const before = latest.session;
        fireEvent.keyDown(surface, { key: 'a' });
        expect(latest.session).not.toBe(before);
        expect(latest.session?.log.some(e => e.type === 'attack' && e.actorId === 'pc')).toBe(true);
        expect(screen.getByTestId('combat-board-surface').getAttribute('data-picking')).toBeNull();
    });
});

describe('a whole fight in the combat screen', () => {
    for (const [label, width] of [['wide', 1400], ['narrow', 700]] as const) {
        it(`is playable start to finish with the mouse only at a ${label} width`, async () => {
            observedWidth = width;
            render(<Harness initial={startSession()} />);
            expect(screen.getByTestId('combat-screen').getAttribute('data-layout')).toBe(label);
            await playWithMouse();
            expect(latest.session?.state.outcome).toBe('victory');
            expect(screen.getByTestId('combat-action-bar').getAttribute('data-mode')).toBe('resolving');
        });

        it(`is playable start to finish with the keyboard only at a ${label} width`, async () => {
            observedWidth = width;
            const user = userEvent.setup();
            render(<Harness initial={startSession()} />);
            await playWithKeyboard(user);
            expect(latest.session?.state.outcome).toBe('victory');
        });
    }
});
