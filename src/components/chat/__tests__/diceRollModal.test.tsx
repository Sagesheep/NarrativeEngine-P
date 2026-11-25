import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DiceRollModal } from '../DiceRollModal';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { migrateLegacyContext } from '../../../types';
import type { GameContext, ManualRollRequest } from '../../../types';

const adv20: ManualRollRequest = { dieTypeId: 'dt_d20', rollDef: { modifier: 'adv', count: 1, aggregation: 'pick_one' } };
const sum6: ManualRollRequest = { dieTypeId: 'dt_d6', rollDef: { modifier: 'none', count: 8, aggregation: 'total_all' } };

function seed(patch: Partial<GameContext> = {}) {
    useAppStore.setState({
        context: migrateLegacyContext(patch),
        activeCampaignId: null,
        diceRollModalOpen: true,
        armedRoll: null,
    });
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('DiceRollModal quick rolls', () => {
    it('offers one plain chip per die type before there is any history', () => {
        seed();
        render(<DiceRollModal />);
        expect(screen.getByText('Quick Roll')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '1d20' }));
        const s = useAppStore.getState();
        expect(s.armedRoll).toEqual({ dieTypeId: 'dt_d20', rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } });
        expect(s.context.diceRecent).toHaveLength(1);
        expect(s.diceRollModalOpen).toBe(false);
    });

    it('shows recent rolls and arms one in a single tap, moving it to the front', () => {
        seed({ diceRecent: [sum6, adv20] });
        render(<DiceRollModal />);
        expect(screen.getByText('Recent')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '1d20 adv' }));
        const s = useAppStore.getState();
        expect(s.armedRoll).toEqual(adv20);
        expect(s.context.diceRecent).toEqual([adv20, sum6]);
    });

    it('right-click loads a chip into the form instead of arming', () => {
        seed({ diceRecent: [sum6] });
        render(<DiceRollModal />);
        fireEvent.contextMenu(screen.getByRole('button', { name: '8d6 sum' }));
        expect(useAppStore.getState().armedRoll).toBeNull();
        expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('8');
    });

    it('hides rolls whose die was removed from the campaign', () => {
        seed({ diceRecent: [{ ...adv20, dieTypeId: 'dt_gone' }, sum6] });
        render(<DiceRollModal />);
        expect(screen.getAllByRole('button', { name: /^\d+d/ }).map(b => b.textContent)).toEqual(['8d6 sum']);
    });

    it('records the roll armed from the form as recent', () => {
        seed();
        render(<DiceRollModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Arm Roll' }));
        expect(useAppStore.getState().context.diceRecent).toHaveLength(1);
    });
});

describe('DiceRollModal presets', () => {
    it('saves the form as a named preset, arms it in one tap and deletes it', () => {
        seed();
        const { rerender } = render(<DiceRollModal />);
        fireEvent.contextMenu(screen.getByRole('button', { name: '1d20' }));
        fireEvent.click(screen.getByRole('button', { name: /Save as preset/ }));
        fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Attack' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        const presets = useAppStore.getState().context.dicePresets!;
        expect(presets).toHaveLength(1);
        expect(presets[0].name).toBe('Attack');

        fireEvent.click(screen.getByRole('button', { name: /^Attack/ }));
        expect(useAppStore.getState().armedRoll).toEqual(presets[0].roll);

        useAppStore.setState({ diceRollModalOpen: true });
        rerender(<DiceRollModal />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete preset Attack' }));
        expect(useAppStore.getState().context.dicePresets).toEqual([]);
    });
});
