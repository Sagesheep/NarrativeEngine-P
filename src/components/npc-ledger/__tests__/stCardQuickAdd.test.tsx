import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NPCLedgerModal } from '../../NPCLedgerModal';
import { useAppStore } from '../../../store/useAppStore';
import { buildCardPng } from '../../../services/import/__tests__/pngFixture';
import type { NPCEntry } from '../../../types';
import type { AdaptationResult, AdaptationTarget } from '../../../services/import/adaptationTypes';

// The portrait upload needs the asset server; the wiring under test is
// "did the returned URL land on the NPC", not the upload itself.
vi.mock('../../../services/infrastructure/assetService', () => ({
    uploadImageToLocal: vi.fn(async () => '/assets/portraits/x.png'),
    downloadImageToLocal: vi.fn(async () => '/assets/portraits/x.png'),
}));

// ── §9.3 (C2) — the adaptation service is the other half; here it is a stub. ──
const runAdaptation = vi.fn<(
    targets: AdaptationTarget[],
    deps: { onResult?: (r: AdaptationResult) => void },
    opts: { importId: string; matureMode?: boolean },
) => Promise<AdaptationResult[]>>();
const resolveAdaptationEndpoint = vi.fn();

vi.mock('../../../services/import/adaptation', () => ({
    resolveAdaptationEndpoint: (...args: unknown[]) => resolveAdaptationEndpoint(...args),
    describeAdaptationEndpoint: () => ({ label: 'Utility AI', modelName: 'glm-4-flash' }),
    makeModelCaller: () => async () => '{}',
    runAdaptation: (...args: Parameters<typeof runAdaptation>) => runAdaptation(...args),
    applyAdaptedWants: (npc: Record<string, unknown>, wants: unknown) => ({
        ...npc, wants, wantsProvenance: 'inferred',
    }),
}));

const PROVIDER = { id: 'p-util', label: 'Utility AI', endpoint: 'http://x', apiKey: '', modelName: 'glm-4-flash' };

/** The modal subscribes to the whole store, so a bare `setState` re-renders it outside act. */
function setAdaptationFlag(on: boolean) {
    act(() => { useAppStore.setState(s => ({ settings: { ...s.settings, stImportAdaptation: on } })); });
}

function cardPayload(name: string, personality: string) {
    return {
        spec: 'chara_card_v2',
        data: {
            name,
            description: `${name} keeps the lamp burning after dark.`,
            personality,
            scenario: '',
            first_mes: '',
            mes_example: '',
            tags: [],
        },
    };
}

function pngFile(name: string, personality: string, fileName = `${name}.png`): File {
    return new File([new Uint8Array(buildCardPng(cardPayload(name, personality)))], fileName, {
        type: 'image/png',
    });
}

function jsonFile(content: unknown, fileName = 'ledger.json'): File {
    return new File([JSON.stringify(content)], fileName, { type: 'application/json' });
}

const MIRA: NPCEntry = {
    id: 'ledger-mira',
    name: 'Mira',
    aliases: '',
    appearance: 'Ink-stained cuffs',
    faction: 'The Archive',
    storyRelevance: 'Campaign-era projection',
    disposition: 'Wary',
    status: 'Alive',
    goals: 'Find the missing folio',
    voice: 'Soft',
    personality: 'Campaign-era personality',
    exampleOutput: '',
    affinity: 81,
    pcRelation: 2,
};

function importInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept=".json,.png"]');
    if (!input) throw new Error('quick-add file input not found');
    return input;
}

describe('NPC Ledger — SillyTavern card quick-add (WO-C §5 / §10.4)', () => {
    beforeEach(() => {
        useAppStore.setState({
            npcLedgerOpen: true,
            npcLedger: [{ ...MIRA }],
            loreChunks: [],
            npcSuggestions: [],
            playerCharacter: null,
            activeCampaignId: null,
        });
    });

    it('adds a new card, and offers Overwrite for one that collides with an existing NPC', async () => {
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), {
            target: { files: [pngFile('Mira', 'freshly authored'), pngFile('Rin', 'brash, loyal')] },
        });

        // The collision dialog names the existing character.
        await screen.findByText('Existing character detected');
        expect(screen.getByText(/already exists in this campaign/).textContent).toContain('Mira');

        // The non-colliding card landed immediately, populated and with a portrait.
        const rin = useAppStore.getState().npcLedger.find(n => n.name === 'Rin');
        expect(rin).toBeDefined();
        expect(rin?.populated).toBe(true);
        expect(rin?.tier).toBe('recurring');
        expect(rin?.personality).toBe('brash, loyal');
        expect(rin?.portrait).toBe('/assets/portraits/x.png');

        // …and so did its lore, stamped with the ST provenance group.
        const rinChunks = useAppStore.getState().loreChunks.filter(c => c.group === 'ST:Rin');
        expect(rinChunks.length).toBeGreaterThan(0);
        expect(rinChunks[0].header).toBe('Rin — character sheet');
        expect(useAppStore.getState().loreChunks.some(c => c.group === 'ST:Mira')).toBe(false);

        // Overwrite updates the existing row in place.
        fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));

        await waitFor(() => {
            const mira = useAppStore.getState().npcLedger.find(n => n.name === 'Mira');
            expect(mira?.personality).toBe('freshly authored');
        });
        const mira = useAppStore.getState().npcLedger.find(n => n.name === 'Mira');
        expect(mira?.id).toBe('ledger-mira');
        // Campaign-owned state survives.
        expect(mira?.affinity).toBe(81);
        expect(mira?.pcRelation).toBe(2);
        expect(mira?.goals).toBe('Find the missing folio');
        // The card's own lore group landed on the overwrite.
        expect(useAppStore.getState().loreChunks.some(c => c.group === 'ST:Mira')).toBe(true);
        expect(screen.queryByText('Existing character detected')).not.toBeInTheDocument();
    });

    it('Cancel skips the colliding card entirely', async () => {
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), { target: { files: [pngFile('Mira', 'freshly authored')] } });
        await screen.findByText('Existing character detected');

        fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

        await waitFor(() => {
            expect(screen.queryByText('Existing character detected')).not.toBeInTheDocument();
        });
        const mira = useAppStore.getState().npcLedger.find(n => n.name === 'Mira');
        expect(mira?.personality).toBe('Campaign-era personality');
        expect(useAppStore.getState().loreChunks).toHaveLength(0);
    });

    it('still routes a legacy NPC-export array to the Full/Strip/Isekai chooser', async () => {
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), {
            target: { files: [jsonFile([{ name: 'Old Friend' }, { name: 'Old Foe' }])] },
        });

        await screen.findByText('Full import');
        expect(screen.getByText('Strip plot')).toBeInTheDocument();
        expect(screen.queryByText('Existing character detected')).not.toBeInTheDocument();
    });
});

// ─── §9.3 (order C2) — the Living-world adaptation pass on the quick-add ──────

describe('NPC Ledger — Living-world adaptation (WO-C §9.3, order C2)', () => {
    beforeEach(() => {
        useAppStore.setState({
            npcLedgerOpen: true,
            npcLedger: [{ ...MIRA }],
            loreChunks: [],
            npcSuggestions: [],
            playerCharacter: null,
            activeCampaignId: null,
        });
        runAdaptation.mockReset();
        resolveAdaptationEndpoint.mockReset();
        resolveAdaptationEndpoint.mockReturnValue(PROVIDER);
    });
    afterEach(() => { setAdaptationFlag(false); });

    it('with the flag off: no chooser, and no model call anywhere', async () => {
        setAdaptationFlag(false);
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), { target: { files: [pngFile('Rin', 'brash, loyal')] } });

        await waitFor(() => expect(useAppStore.getState().npcLedger.some(n => n.name === 'Rin')).toBe(true));
        expect(screen.queryByText(/Adapt 1 imported character/)).not.toBeInTheDocument();
        expect(runAdaptation).not.toHaveBeenCalled();
        // The offline fallback is what the row keeps.
        expect(useAppStore.getState().npcLedger.find(n => n.name === 'Rin')?.wantsProvenance).toBe('pool');
    });

    it('with the flag on: the chooser names the count, and Direct makes no call', async () => {
        setAdaptationFlag(true);
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), {
            target: { files: [pngFile('Rin', 'brash, loyal'), pngFile('Bram', 'stoic')] },
        });

        await screen.findByText(/Adapt 2 imported characters/);
        expect(screen.getByRole('button', { name: /living-world adaptation/i })).not.toBeDisabled();
        expect(screen.getByText(/Uses Utility AI \(glm-4-flash\)/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /direct import/i }));

        await waitFor(() => expect(screen.queryByText(/Adapt 2 imported characters/)).not.toBeInTheDocument());
        expect(runAdaptation).not.toHaveBeenCalled();
        expect(screen.queryByTestId('st-adaptation-panel')).toBeNull();
    });

    it('with no endpoint the Living-world button is disabled and says why', async () => {
        resolveAdaptationEndpoint.mockReturnValue(undefined);
        setAdaptationFlag(true);
        const { container } = render(<NPCLedgerModal />);

        fireEvent.change(importInput(container), { target: { files: [pngFile('Rin', 'brash, loyal')] } });

        await screen.findByText(/Adapt 1 imported character/);
        expect(screen.getByRole('button', { name: /living-world adaptation/i })).toBeDisabled();
        expect(screen.getByText('no utility or story endpoint is configured')).toBeInTheDocument();
    });

    it('Living-world writes the adapted wants, names the fallback, and offers Retry', async () => {
        setAdaptationFlag(true);
        runAdaptation.mockImplementation(async targets => targets.map((t, i) => (
            i === 0
                ? {
                    id: t.id,
                    name: t.name,
                    status: 'adapted' as const,
                    wants: { short: ['Keep the lamp trimmed'], medium: [], long: 'Keep the lamp lit.' },
                }
                : { id: t.id, name: t.name, status: 'failed' as const, error: 'the model timed out' }
        )));

        const { container } = render(<NPCLedgerModal />);
        fireEvent.change(importInput(container), {
            target: { files: [pngFile('Rin', 'brash, loyal'), pngFile('Bram', 'stoic')] },
        });

        await screen.findByText(/Adapt 2 imported characters/);
        fireEvent.click(screen.getByRole('button', { name: /living-world adaptation/i }));

        await waitFor(() => expect(screen.getByTestId('st-adaptation-panel')).toBeInTheDocument());
        expect(runAdaptation).toHaveBeenCalledTimes(1);
        expect(runAdaptation.mock.calls[0][0].map(t => t.name)).toEqual(['Rin', 'Bram']);
        expect(runAdaptation.mock.calls[0][2].importId).toMatch(/^ledger-/);

        // §9.3 — every fallback NPC is named, with a reason and its own Retry.
        await waitFor(() => expect(screen.getByRole('button', { name: /retry bram/i })).toBeInTheDocument());
        expect(screen.getByText(/the model timed out/)).toBeInTheDocument();

        const ledger = useAppStore.getState().npcLedger;
        const rin = ledger.find(n => n.name === 'Rin');
        const bram = ledger.find(n => n.name === 'Bram');
        expect(rin?.wants?.long).toBe('Keep the lamp lit.');
        expect(rin?.wantsProvenance).toBe('inferred');
        // The failed one keeps the mechanical pool wants it imported with.
        expect(bram?.wantsProvenance).toBe('pool');
        expect(bram?.wants?.long).toBe('');

        // Retry is the same run, restricted to the ids asked for.
        fireEvent.click(screen.getByRole('button', { name: /retry bram/i }));
        await waitFor(() => expect(runAdaptation).toHaveBeenCalledTimes(2));
        expect(runAdaptation.mock.calls[1][0].map(t => t.name)).toEqual(['Bram']);

        await waitFor(() => expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
        await waitFor(() => expect(screen.queryByTestId('st-adaptation-panel')).toBeNull());
    });

    it('never adapts an overwritten NPC — only the rows this drop added', async () => {
        setAdaptationFlag(true);
        runAdaptation.mockResolvedValue([]);

        const { container } = render(<NPCLedgerModal />);
        fireEvent.change(importInput(container), {
            target: { files: [pngFile('Mira', 'freshly authored'), pngFile('Rin', 'brash, loyal')] },
        });

        // The collision is answered first; the chooser cannot appear before it.
        await screen.findByText('Existing character detected');
        expect(screen.queryByText(/imported character/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));

        // Mira was overwritten, so only Rin is offered (§9.4 — campaign-owned
        // motivations are preserved, never re-inferred from the card).
        await screen.findByText(/Adapt 1 imported character/);
        fireEvent.click(screen.getByRole('button', { name: /living-world adaptation/i }));

        await waitFor(() => expect(runAdaptation).toHaveBeenCalledTimes(1));
        expect(runAdaptation.mock.calls[0][0].map(t => t.name)).toEqual(['Rin']);
    });
});
