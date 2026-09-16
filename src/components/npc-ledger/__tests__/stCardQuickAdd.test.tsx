import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NPCLedgerModal } from '../../NPCLedgerModal';
import { useAppStore } from '../../../store/useAppStore';
import { buildCardPng } from '../../../services/import/__tests__/pngFixture';
import type { NPCEntry } from '../../../types';

// The portrait upload needs the asset server; the wiring under test is
// "did the returned URL land on the NPC", not the upload itself.
vi.mock('../../../services/infrastructure/assetService', () => ({
    uploadImageToLocal: vi.fn(async () => '/assets/portraits/x.png'),
    downloadImageToLocal: vi.fn(async () => '/assets/portraits/x.png'),
}));

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
