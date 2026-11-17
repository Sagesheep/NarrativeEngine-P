import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CombatSettingsSection } from '../CombatSettingsSection';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { DEFAULT_COMBAT_CONFIG, migrateLegacyContext } from '../../../types';

function Harness() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    return <CombatSettingsSection context={context} updateContext={updateContext} />;
}

describe('CombatSettingsSection', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        const context = migrateLegacyContext({
            characterProfileData: {
                name: 'Ari', race: '', class: '', level: 1, hp: { current: 20, max: 20 },
                stats: { STR: 17 }, skills: [], abilities: [], traits: [], notes: '',
            },
        });
        useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null });
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('hides the settings while combat is off', () => {
        render(<Harness />);
        expect(screen.getByRole('button', { name: 'Toggle combat' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByLabelText('Party control')).toBeNull();
    });

    it('turning combat on creates a default sheet that needs allocation and mirrors it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const s = useAppStore.getState();
        expect(s.context.combatModeActive).toBe(true);
        expect(s.context.combatSheet).toMatchObject({ needsAllocation: true, budget: 'NORMAL' });
        expect(s.characterProfileData.stats.STR).toBe(8);
        expect(screen.getByLabelText('Party control')).toHaveValue('engine');
    });

    it('turning combat off keeps the sheet', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const sheet = useAppStore.getState().context.combatSheet;
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        expect(useAppStore.getState().context.combatModeActive).toBe(false);
        expect(useAppStore.getState().context.combatSheet).toEqual(sheet);
    });

    it('writes normalized settings', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        fireEvent.change(screen.getByLabelText('Defeat'), { target: { value: 'ironman' } });
        fireEvent.change(screen.getByLabelText('Narration'), { target: { value: 'round' } });
        fireEvent.click(screen.getByLabelText('Ask before a fight starts'));
        expect(useAppStore.getState().context.combatConfig).toEqual({
            ...DEFAULT_COMBAT_CONFIG, defeatMode: 'ironman', narrationCadence: 'round', confirmStart: false,
        });
    });

    it('shows the narration length beside the cadence, defaulting to standard, and saves it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const length = screen.getByLabelText('Narration length');
        expect(length).toHaveValue('standard');
        expect(Array.from((length as HTMLSelectElement).options).map(o => o.value)).toEqual(['brief', 'standard', 'rich']);
        fireEvent.change(length, { target: { value: 'rich' } });
        expect(useAppStore.getState().context.combatConfig).toEqual({ ...DEFAULT_COMBAT_CONFIG, narrationLength: 'rich' });
        expect(screen.getByLabelText('Narration length')).toHaveValue('rich');
    });

    it('explains that ability points are pending while combat is on, and opens the character sheet', () => {
        useAppStore.setState({ pcPanelOpen: false });
        render(<Harness />);
        expect(screen.queryByTestId('combat-alloc-note')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        expect(screen.getByTestId('combat-alloc-note')).toHaveTextContent("Combat is on, but your ability points aren't distributed yet.");
        fireEvent.click(screen.getByRole('button', { name: 'Open character sheet' }));
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
    });

    it('offers the officer orders setting, on by default, and saves it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const director = screen.getByLabelText('Officer orders');
        expect(director).toHaveValue('on');
        fireEvent.change(director, { target: { value: 'off' } });
        expect(useAppStore.getState().context.combatConfig).toEqual({ ...DEFAULT_COMBAT_CONFIG, combatDirector: 'off' });
    });

    it('offers the elements setting with exactly three choices, all by default, and saves it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const elements = screen.getByLabelText('Elements') as HTMLSelectElement;
        expect(elements).toHaveValue('all');
        expect([...elements.options].map(o => [o.value, o.textContent])).toEqual([['all', 'All'], ['fantasy', 'Fantasy'], ['modern', 'Modern']]);
        fireEvent.change(elements, { target: { value: 'fantasy' } });
        expect(useAppStore.getState().context.combatConfig).toEqual({ ...DEFAULT_COMBAT_CONFIG, combatElements: 'fantasy' });
    });

    it('shows the last fight\'s director measurements in debug mode only', () => {
        const director = {
            sessionId: 's', calls: 3, failed: 1, latencyMsTotal: 3000, latencyMsMax: 1800, promptTokens: 2400, replyTokens: 120,
            accepted: 4, rejected: 1, lateReplies: 1, waits: 2, waitedMs: 4000, last: [],
        };
        const context = useAppStore.getState().context;
        useAppStore.setState({ context: { ...context, combatModeActive: true, combatTelemetry: { dangerousCommits: 0, dangerousWithoutProposal: 0, director } } });
        const settings = useAppStore.getState().settings;
        const { unmount } = render(<Harness />);
        expect(screen.queryByTestId('combat-director-telemetry')).toBeNull();
        unmount();
        useAppStore.setState({ settings: { ...settings, debugMode: true } });
        render(<Harness />);
        expect(screen.getByTestId('combat-director-telemetry')).toHaveTextContent('3 calls (1 without orders), 1000 ms average, 1800 ms longest, tokens 2400 in / 120 out, orders 4 accepted / 1 rejected, 1 late, 2 waits');
        useAppStore.setState({ settings });
    });

    it('shows no allocation note once the points are distributed', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const sheet = useAppStore.getState().context.combatSheet!;
        act(() => useAppStore.getState().updateContext({ combatSheet: { ...sheet, needsAllocation: false } }));
        expect(screen.queryByTestId('combat-alloc-note')).toBeNull();
    });
});
