/**
 * Characterisation tests for EnemyInstancesView — WORKORDER-P5-15 §4 oracle.
 *
 * Written FIRST, against the current bespoke component, before any conversion.
 * These same tests must pass UNMODIFIED against the declared version. If an
 * assertion needs editing, either behaviour changed or the test was wrong —
 * both are stop conditions.
 *
 * These tests assert what the bespoke component does TODAY. Notable findings
 * recorded here so the declared version is held to the same behaviour:
 *   - The panel does NOT filter instances by `selectedTemplateId`. It renders
 *     every instance in the store, sorted by createdAt descending. The prop
 *     only selects which template the "Create" button spawns from.
 *   - The numeric coercion clamps to a finite non-negative number.
 *   - The conditions editor splits on newlines and trims/drops empties.
 *   - The temporary-modifiers editor preserves existing row ids by index.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EnemyEntry, EnemyInstance } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { EnemyInstancesView } from '../EnemyInstancesView';

vi.mock('../Toast', () => ({
    toast: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
    },
}));

const template = (id: string, name: string): EnemyEntry => ({
    id, name, aliases: '', classification: '', description: '', threatTier: '',
    tags: [], faction: '', stats: [], actions: [], passiveTraits: [],
    specialBehaviors: [], weaknesses: [], resistances: [], tactics: '',
    loot: '', gmNotes: '', promptEnabled: true, createdAt: 1, updatedAt: 1,
});

const instance = (patch: Partial<EnemyInstance> = {}): EnemyInstance => ({
    id: 'inst-1',
    templateId: 'orc-template',
    templateSnapshot: template('orc-template', 'Orc Warrior'),
    displayName: 'Orc Warrior #1',
    currentHp: 10,
    maxHp: 10,
    currentBarrier: 0,
    maxBarrier: 0,
    conditions: [],
    temporaryModifiers: [],
    defeated: false,
    initiative: null,
    actionsRemaining: 1,
    actionsPerTurn: 1,
    cooldowns: [],
    resources: [],
    createdAt: 100,
    updatedAt: 100,
    ...patch,
});

const baseStore = {
    activeCampaignId: null,
    enemyCompendium: [template('orc-template', 'Orc Warrior')],
    enemyInstances: [] as EnemyInstance[],
    spawnEnemyInstance: vi.fn((templateId: string) => {
        const s = useAppStore.getState();
        const tmpl = s.enemyCompendium.find((e) => e.id === templateId);
        if (!tmpl) return null;
        const next = instance({ templateId: tmpl.id, templateSnapshot: tmpl, displayName: `${tmpl.name} #1` });
        useAppStore.setState({ enemyInstances: [...s.enemyInstances, next] });
        return next;
    }),
    updateEnemyInstance: vi.fn((id: string, patch: Partial<EnemyInstance>) => {
        const s = useAppStore.getState();
        useAppStore.setState({
            enemyInstances: s.enemyInstances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        });
    }),
    removeEnemyInstance: vi.fn((id: string) => {
        const s = useAppStore.getState();
        useAppStore.setState({ enemyInstances: s.enemyInstances.filter((i) => i.id !== id) });
    }),
};

describe('EnemyInstancesView — characterisation (bespoke baseline)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useAppStore.setState({ ...baseStore });
    });
    afterEach(() => cleanup());

    it('renders every instance in the store, sorted by createdAt descending', () => {
        useAppStore.setState({
            enemyInstances: [
                instance({ id: 'old', displayName: 'Old Copy', createdAt: 100 }),
                instance({ id: 'new', displayName: 'New Copy', createdAt: 900 }),
                instance({ id: 'mid', displayName: 'Mid Copy', createdAt: 500 }),
            ],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const buttons = screen.getAllByRole('button');
        const labels = buttons.map((b) => b.textContent ?? '');
        const copyLabels = labels.filter((l) => l.includes('Copy'));
        expect(copyLabels[0]).toContain('New Copy');
        expect(copyLabels[1]).toContain('Mid Copy');
        expect(copyLabels[2]).toContain('Old Copy');
    });

    it('does NOT filter instances by selectedTemplateId — instances from other templates are shown', () => {
        useAppStore.setState({
            enemyCompendium: [
                template('orc-template', 'Orc Warrior'),
                template('goblin-template', 'Goblin'),
            ],
            enemyInstances: [
                instance({ id: 'orc-1', displayName: 'Orc Copy', templateId: 'orc-template' }),
                instance({ id: 'gob-1', displayName: 'Goblin Copy', templateId: 'goblin-template', templateSnapshot: template('goblin-template', 'Goblin') }),
            ],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        expect(screen.getByText('Orc Copy')).toBeInTheDocument();
        expect(screen.getByText('Goblin Copy')).toBeInTheDocument();
    });

    it('renders an empty-state prompt when no instances exist', () => {
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);
        expect(screen.getByText(/Select a template on the left and create the first encounter copy/))
            .toBeInTheDocument();
    });

    it('renders a no-selection detail pane when the store is empty', () => {
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);
        expect(screen.getByText('No enemy instances are active.')).toBeInTheDocument();
    });

    it('disables Create and shows "Select a template" when selectedTemplateId is null or unknown', () => {
        render(<EnemyInstancesView selectedTemplateId={null} />);
        const create = screen.getByRole('button', { name: /Select a template/ });
        expect(create).toBeDisabled();
    });

    it('spawns a new instance from the selected template via the Create button', async () => {
        const user = userEvent.setup();
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        await user.click(screen.getByRole('button', { name: /Create Orc Warrior/ }));

        expect(baseStore.spawnEnemyInstance).toHaveBeenCalledWith('orc-template');
        expect(useAppStore.getState().enemyInstances).toHaveLength(1);
        expect(useAppStore.getState().enemyInstances[0].templateId).toBe('orc-template');
    });

    it('warns and does not spawn when no template is selected', async () => {
        const { toast } = await import('../Toast');
        render(<EnemyInstancesView selectedTemplateId={null} />);

        const create = screen.getByRole('button', { name: /Select a template/ });
        // disabled button — clicking should not fire spawn
        expect(create).toBeDisabled();
        expect(baseStore.spawnEnemyInstance).not.toHaveBeenCalled();
        expect(toast.warning).not.toHaveBeenCalled();
    });

    it('edits currentHp and coerces to a finite non-negative number', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', currentHp: 10 })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const hpInput = screen.getByLabelText('Current HP');
        await user.clear(hpInput);
        await user.type(hpInput, '-7abc');

        expect(baseStore.updateEnemyInstance).toHaveBeenCalledWith('inst-1', expect.objectContaining({ currentHp: 0 }));
    });

    it('edits maxBarrier to a finite non-negative number', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', maxBarrier: 5 })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const input = screen.getByLabelText('Maximum Barrier');
        await user.clear(input);
        await user.type(input, '42');

        expect(baseStore.updateEnemyInstance).toHaveBeenCalledWith('inst-1', expect.objectContaining({ maxBarrier: 42 }));
    });

    it('edits displayName as free text', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', displayName: 'Orc Warrior #1' })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const input = screen.getByLabelText('Display Name');
        await user.clear(input);
        await user.type(input, 'Boss Monster');

        expect(baseStore.updateEnemyInstance).toHaveBeenCalledWith('inst-1', expect.objectContaining({ displayName: 'Boss Monster' }));
    });

    it('adds a condition tag via the conditions textarea (one per line, trimmed, empties dropped)', async () => {
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', conditions: [] })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const conditions = screen.getByLabelText(/Conditions/) as HTMLTextAreaElement;
        // userEvent.type does not always emit \n as a newline character; set the
        // value and dispatch a change event to model a real textarea paste.
        fireEvent.change(conditions, { target: { value: '  Poisoned  \n\n  Stunned ' } });

        expect(baseStore.updateEnemyInstance).toHaveBeenCalledWith('inst-1', expect.objectContaining({
            conditions: ['Poisoned', 'Stunned'],
        }));
    });

    it('toggles the defeated checkbox', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', defeated: false })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const checkbox = screen.getByRole('checkbox', { name: /Mark defeated/ });
        await user.click(checkbox);

        expect(baseStore.updateEnemyInstance).toHaveBeenLastCalledWith('inst-1', expect.objectContaining({ defeated: true }));
    });

    it('parses temporary modifiers as "name: value" lines and preserves existing row ids by index', async () => {
        let uuid = 0;
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `new-${++uuid}`) });
        useAppStore.setState({
            enemyInstances: [instance({
                id: 'inst-1',
                temporaryModifiers: [
                    { id: 'mod-a', name: 'Bless', value: '+1' },
                    { id: 'mod-b', name: 'Bane', value: '-1' },
                ],
            })],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const modifiers = screen.getByLabelText(/Temporary Modifiers/) as HTMLTextAreaElement;
        fireEvent.change(modifiers, { target: { value: 'Bless: +2\nBane: -2' } });

        const calls = baseStore.updateEnemyInstance.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0]).toBe('inst-1');
        const patch = lastCall[1] as Partial<EnemyInstance>;
        expect(patch.temporaryModifiers).toEqual([
            { id: 'mod-a', name: 'Bless', value: '+2' },
            { id: 'mod-b', name: 'Bane', value: '-2' },
        ]);
        vi.unstubAllGlobals();
    });

    it('assigns a new id when a modifier line is added beyond the existing count', async () => {
        let uuid = 0;
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `new-${++uuid}`) });
        useAppStore.setState({
            enemyInstances: [instance({ id: 'inst-1', temporaryModifiers: [] })],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const modifiers = screen.getByLabelText(/Temporary Modifiers/) as HTMLTextAreaElement;
        fireEvent.change(modifiers, { target: { value: 'Haste: +3' } });

        const calls = baseStore.updateEnemyInstance.mock.calls;
        const patch = calls[calls.length - 1][1] as Partial<EnemyInstance>;
        expect(patch.temporaryModifiers).toEqual([{ id: 'new-1', name: 'Haste', value: '+3' }]);
        vi.unstubAllGlobals();
    });

    it('deletes the selected instance via the Delete Instance button', async () => {
        const user = userEvent.setup();
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1' })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        await user.click(screen.getByRole('button', { name: /Delete Instance/ }));

        expect(baseStore.removeEnemyInstance).toHaveBeenCalledWith('inst-1');
    });

    it('selecting a different instance in the list shows that instance in the detail pane', async () => {
        const user = userEvent.setup();
        useAppStore.setState({
            enemyInstances: [
                instance({ id: 'first', displayName: 'First Copy', createdAt: 100 }),
                instance({ id: 'second', displayName: 'Second Copy', createdAt: 200 }),
            ],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        // Newest (Second Copy) is selected by default and shown in the detail pane.
        expect(screen.getByDisplayValue('Second Copy')).toBeInTheDocument();

        // Click the older row in the list.
        await user.click(screen.getByRole('button', { name: /First Copy/ }));

        expect(screen.getByDisplayValue('First Copy')).toBeInTheDocument();
    });

    it('renders the frozen-snapshot banner naming the source template', () => {
        useAppStore.setState({ enemyInstances: [instance({ id: 'inst-1', templateSnapshot: template('orc-template', 'Orc Warrior') })] });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        const banner = screen.getByText(/This copy uses a frozen snapshot of/);
        expect(banner.textContent).toContain('Orc Warrior');
    });

    it('shows a "Defeated" marker in the list for defeated instances', () => {
        useAppStore.setState({
            enemyInstances: [instance({ id: 'inst-1', displayName: 'Felled One', defeated: true })],
        });
        render(<EnemyInstancesView selectedTemplateId="orc-template" />);

        expect(screen.getByText('Defeated')).toBeInTheDocument();
    });
});