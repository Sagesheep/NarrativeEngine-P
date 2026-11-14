import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { buildPcCombatant, freshTurn, STARTER_ABILITIES } from '@narrative/engine';
import { CombatScreen } from '../CombatScreen';
import type { ChatMessage, CombatAction, CombatSession, CombatSheet, CombatState, Combatant, GlyphAbility } from '../../../types';

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

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const fireball = STARTER_ABILITIES.find(a => a.id === 'fireball') as GlyphAbility;

function foe(id: string, x: number, y: number): Combatant {
    return {
        id, name: id, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 40, hp: 40, ac: 30, attackBonus: -20, damage: { count: 1, sides: 4, bonus: 0, type: 'slashing' },
        initiative: 1, status: 'up', conditions: [], position: { x, y }, range: 'close',
    };
}

function session(): CombatSession {
    const pc = { ...buildPcCombatant({ name: 'Kira', sheet, kit: [fireball] }), position: { x: 1, y: 4 } };
    const all = [pc, foe('Brute', 7, 4)];
    const base: CombatState = {
        id: 'ui', round: 1, order: all.map(c => c.id), turnIndex: 0,
        combatants: Object.fromEntries(all.map(c => [c.id, c])),
        rngSeed: 5, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
        grid: { width: 12, height: 8, tiles: new Array(96).fill('floor') },
    };
    return { state: { ...base, turn: freshTurn(base, 'pc') }, log: [], narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

function Harness({ onAction }: { onAction: (action: CombatAction, flourish?: string) => void | Promise<readonly unknown[]> }) {
    const feedRef = useRef<HTMLDivElement | null>(null);
    return <CombatScreen session={session()} busy={false} onAction={onAction} onEnd={() => {}} onSkip={() => {}} feedScrollRef={feedRef} feed={<div ref={feedRef} />} />;
}

describe('N5 the player\'s flourish field', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is shown on the player\'s turn, optional, single-line and capped at 200 characters', () => {
        render(<Harness onAction={vi.fn()} />);
        const field = screen.getByTestId('combat-flourish');
        expect(field).toHaveAttribute('placeholder', 'How do you do it? (optional)');
        expect(field).toHaveAttribute('maxLength', '200');
        expect(field.tagName).toBe('INPUT');
    });

    it('does not fire combat shortcuts while typing, and the shortcuts still work when it is not focused', () => {
        const onAction = vi.fn();
        render(<Harness onAction={onAction} />);
        const field = screen.getByTestId('combat-flourish');
        field.focus();
        for (const key of ['1', 'd', 'a', 'D']) fireEvent.keyDown(field, { key });
        fireEvent.change(field, { target: { value: 'I duck and laugh' } });
        expect(onAction).not.toHaveBeenCalled();
        expect(screen.queryAllByTestId('combat-aim-legal')).toHaveLength(0);
        field.blur();
        fireEvent.keyDown(window, { key: 'd' });
        expect(onAction).toHaveBeenCalledWith({ type: 'defend', actorId: 'pc' }, 'I duck and laugh');
    });

    it('rides along with the next action that takes it, then clears; other actions go without it', () => {
        const onAction = vi.fn();
        render(<Harness onAction={onAction} />);
        const field = screen.getByTestId('combat-flourish');
        fireEvent.change(field, { target: { value: 'Shield up, "Come on then!"' } });
        fireEvent.click(screen.getByRole('button', { name: /End turn/ }));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'end_turn', actorId: 'pc' });
        expect(onAction.mock.calls[0]).toHaveLength(1);
        expect(field).toHaveValue('Shield up, "Come on then!"');
        fireEvent.click(screen.getByRole('button', { name: /Defend/ }));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'defend', actorId: 'pc' }, 'Shield up, "Come on then!"');
        expect(field).toHaveValue('');
        fireEvent.click(screen.getByRole('button', { name: /Defend/ }));
        expect(onAction.mock.calls.at(-1)).toEqual([{ type: 'defend', actorId: 'pc' }]);
    });

    it('keeps the typed text when the engine rejects the action, and clears it once one is accepted', async () => {
        const results: unknown[][] = [[], [{ seq: 9, type: 'defend' }]];
        const onAction = vi.fn(() => Promise.resolve(results.shift() ?? []));
        render(<Harness onAction={onAction} />);
        const field = screen.getByTestId('combat-flourish');
        fireEvent.change(field, { target: { value: 'Back to the wall' } });
        fireEvent.click(screen.getByRole('button', { name: /Defend/ }));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'defend', actorId: 'pc' }, 'Back to the wall');
        await act(async () => { await Promise.resolve(); });
        expect(field).toHaveValue('Back to the wall');
        fireEvent.click(screen.getByRole('button', { name: /Defend/ }));
        expect(onAction).toHaveBeenLastCalledWith({ type: 'defend', actorId: 'pc' }, 'Back to the wall');
        await waitFor(() => expect(field).toHaveValue(''));
    });
});
