import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { CombatActionBar } from '../CombatActionBar';
import { CombatInitiativeStrip } from '../CombatInitiativeStrip';
import { CombatParleyBox } from '../CombatParleyBox';
import { CombatFallenScreen } from '../CombatFallenScreen';
import { CombatProposalDialog } from '../CombatProposalDialog';
import type { CombatProposal, CombatSession, CombatState, Combatant, GameContext, PlayerCharacter } from '../../../types';

function unit(id: string, side: Combatant['side'], at: [number, number], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id.toUpperCase(), side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: { x: at[0], y: at[1] }, ...extra,
    };
}

function session(list: Combatant[], extra: Partial<CombatState> = {}): CombatSession {
    const combatants: Record<string, Combatant> = {};
    for (const c of list) combatants[c.id] = c;
    const first = list[0];
    const state: CombatState = {
        id: 'ui', round: 2, order: list.map(c => c.id), turnIndex: 0, combatants, rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null,
        grid: { width: 8, height: 5, tiles: new Array(40).fill('floor') }, turnCount: 3,
        turnStart: first.position ? { actorId: first.id, pos: { ...first.position } } : undefined,
        ...extra,
    };
    return { state, log: [], narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

const noop = () => {};

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    useAppStore.setState({ activeCampaignId: 'c1', combatSession: null, combatBusy: false, pcPanelOpen: false });
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('flee and abandon in the action bar', () => {
    it('offers Flee on an edge square it started on, and dispatches it', () => {
        const onAction = vi.fn();
        render(<CombatActionBar session={session([unit('pc', 'player', [0, 2]), unit('e', 'enemy', [7, 2])])} busy={false} targetId={null} onAction={onAction} onPick={noop} onSkip={noop} />);
        const flee = screen.getByTestId('combat-flee');
        expect(flee.getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(flee);
        expect(onAction).toHaveBeenCalledWith({ type: 'flee', actorId: 'pc' });
    });

    it('explains why Flee is unavailable and asks the board to show the edges', () => {
        const onAction = vi.fn();
        const onShowEdges = vi.fn();
        render(<CombatActionBar session={session([unit('pc', 'player', [3, 2]), unit('e', 'enemy', [7, 2])])} busy={false} targetId={null} onAction={onAction} onPick={noop} onSkip={noop} onShowEdges={onShowEdges} />);
        const flee = screen.getByTestId('combat-flee');
        expect(flee.getAttribute('aria-disabled')).toBe('true');
        expect(flee.getAttribute('title')).toContain('edge');
        fireEvent.click(flee);
        expect(onShowEdges).toHaveBeenCalled();
        expect(onAction).not.toHaveBeenCalled();
    });

    it('lets a player-controlled ally abandon the others once the player character has fled', () => {
        const onAction = vi.fn();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<CombatActionBar session={session([unit('ally', 'ally', [3, 2], { controller: 'player' }), unit('pc', 'player', [0, 2], { status: 'fled' }), unit('e', 'enemy', [7, 2])])} busy={false} targetId={null} onAction={onAction} onPick={noop} onSkip={noop} />);
        fireEvent.click(screen.getByTestId('combat-abandon'));
        expect(onAction).toHaveBeenCalledWith({ type: 'abandon', actorId: 'ally' });
    });

    it('shows recharge rounds, not MP, on an ally\'s kit button', () => {
        const kit = [{ id: 'kit-bolt', name: 'Arcane bolt', form: { id: 'projectile' as const, augments: [] }, effects: [{ id: 'damage' as const, augments: [] }], source: 'preset' as const }];
        render(<CombatActionBar session={session([unit('ally', 'ally', [3, 2], { controller: 'player', kit, cooldowns: { 'kit-bolt': 4 } }), unit('pc', 'player', [0, 2]), unit('e', 'enemy', [7, 2])])} busy={false} targetId={null} onAction={noop} onPick={noop} onSkip={noop} />);
        const button = screen.getByTestId('combat-ability-kit-bolt');
        expect(button.textContent).toContain('2r');
        expect(screen.queryByTestId('combat-mp')).toBeNull();
    });
});

describe('parley box', () => {
    it('appears on the player character\'s turn with the action unspent, and not for an ally', () => {
        const pcTurn = session([unit('pc', 'player', [0, 2]), unit('e', 'enemy', [7, 2])]);
        const { rerender } = render(<CombatParleyBox session={pcTurn} busy={false} />);
        expect(screen.getByTestId('combat-parley')).toBeTruthy();
        rerender(<CombatParleyBox session={{ ...pcTurn, state: { ...pcTurn.state, turn: { actorId: 'pc', moveLeft: 6, actionUsed: true } } }} busy={false} />);
        expect(screen.queryByTestId('combat-parley')).toBeNull();
        rerender(<CombatParleyBox session={session([unit('ally', 'ally', [3, 2], { controller: 'player' }), unit('pc', 'player', [0, 2]), unit('e', 'enemy', [7, 2])])} busy={false} />);
        expect(screen.queryByTestId('combat-parley')).toBeNull();
        rerender(<CombatParleyBox session={{ ...pcTurn, parley: { attemptId: 'a', words: 'x', lineMessageId: 'l', stage: 'rating' } }} busy={false} />);
        expect(screen.getByTestId('combat-parley-pending')).toBeTruthy();
    });
});

describe('hard modes in the UI', () => {
    it('turns End combat into Concede under hardcore and ironman', () => {
        const s = session([unit('pc', 'player', [0, 2]), unit('e', 'enemy', [7, 2])], { defeatMode: 'ironman' });
        render(<CombatInitiativeStrip session={s} busy={false} selectedId={null} onSelect={noop} onEnd={noop} />);
        expect(screen.getByText(/Concede/)).toBeTruthy();
    });

    it('shows the death screen, prepares succession and opens the character panel', () => {
        const base = useAppStore.getState().context;
        const pc = { id: 'pc-1', name: 'Kira', isPC: true } as PlayerCharacter;
        useAppStore.setState({
            context: { ...base, playerCharacter: pc, combatFallen: { name: 'Kira', mode: 'ironman', at: 1, stage: 'fallen' } } as GameContext,
            playerCharacter: pc,
            npcLedger: [],
        });
        render(<CombatFallenScreen />);
        expect(screen.getByText('Kira has fallen')).toBeTruthy();
        expect(screen.getByText(/planned/)).toBeTruthy();
        act(() => { fireEvent.click(screen.getByTestId('combat-fallen-create')); });
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
        expect(useAppStore.getState().context.combatFallen?.stage).toBe('creating');
        expect(useAppStore.getState().npcLedger.some(n => n.name === 'Kira' && n.condition === 'dead')).toBe(true);
        expect(screen.queryByTestId('combat-fallen')).toBeNull();
    });
});

describe('solo party control in the proposal dialog', () => {
    it('shows proposed allies as staying out, with a control to include them', () => {
        const base = useAppStore.getState().context;
        useAppStore.setState({ context: { ...base, combatConfig: { ...base.combatConfig, partyControl: 'solo' } } as GameContext });
        const proposal: CombatProposal = {
            id: 'p', messageId: 'gm', reason: 'Ambush', source: 'tool',
            combatants: [{ name: 'Mira', side: 'ally', tier: 'grunt' }, { name: 'Bandit', side: 'enemy', tier: 'grunt' }],
        };
        const onStart = vi.fn();
        render(<CombatProposalDialog proposal={proposal} open onStart={onStart} onDecline={noop} onMinimise={noop} />);
        expect(screen.getByText('Mira stays out of the fight')).toBeTruthy();
        fireEvent.click(screen.getByText('Include'));
        expect(screen.queryByText('Mira stays out of the fight')).toBeNull();
        fireEvent.click(screen.getAllByText('Start combat').find(el => el.tagName === 'BUTTON' || el.closest('button'))!);
        expect(onStart.mock.calls[0][0].combatants[0]).toMatchObject({ name: 'Mira', included: true });
    });
});
