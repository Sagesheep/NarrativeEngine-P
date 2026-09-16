import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { STImportWizard } from '../STImportWizard';
import { buildCardPng, buildPlainPng } from '../../../services/import/__tests__/pngFixture';

/** A V2 card payload in the shape `parsePngCard` normalizes. */
function payload(over: Record<string, unknown> = {}) {
    return {
        spec: 'chara_card_v2',
        data: {
            name: 'Aria',
            description: 'A tall archivist who never sleeps.',
            personality: 'patient',
            scenario: 'The tower has stood empty for a hundred years.',
            first_mes: 'Aria looks up as you enter.',
            ...over,
        },
    };
}

function file(name: string, buf: ArrayBuffer): File {
    return new File([buf], name, { type: 'image/png' });
}

describe('STImportWizard — Step 1 card shelf (WO-C §4, §9.5)', () => {
    it('parses dropped files into card tiles, names the failures, and auto-stars the seed', async () => {
        render(<STImportWizard open onClose={() => {}} onDone={() => {}} />);

        const input = screen.getByTestId('st-card-input');
        fireEvent.change(input, {
            target: {
                files: [
                    // Seedable: has a scenario.
                    file('aria.png', buildCardPng(payload())),
                    // Parsed but not seedable: no scenario, no first_mes.
                    file('bram.png', buildCardPng(payload({
                        name: 'Bram', scenario: '', first_mes: '', description: 'A blacksmith.',
                    }))),
                    // A valid PNG whose card metadata was stripped.
                    file('stripped.png', buildPlainPng()),
                ],
            },
        });

        await waitFor(() => expect(screen.getByText('Aria')).toBeInTheDocument());
        expect(screen.getByText('Bram')).toBeInTheDocument();

        // §9.5 — the failure tile says which failure it was, and blocks nothing.
        expect(screen.getByText('stripped.png')).toBeInTheDocument();
        expect(screen.getByText(/No card data in this image/)).toBeInTheDocument();

        // The first card that can seed is starred automatically (§4 auto-star).
        expect(screen.getByText('CAMPAIGN SEED — proposes premise & opening scene')).toBeInTheDocument();

        // A card with neither scenario nor first_mes cannot seed a world.
        const ariaStar = screen.getByRole('button', { name: 'Campaign seed: Aria' });
        const bramStar = screen.getByRole('button', { name: 'Campaign seed: Bram' });
        expect(ariaStar).not.toBeDisabled();
        expect(bramStar).toBeDisabled();
        expect(bramStar).toHaveAttribute('title', "no scenario in this card — can't seed a world");

        // Continue needs a parsed card AND a star; both are satisfied.
        expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
        expect(screen.getByRole('button', { name: /import as npcs only/i })).not.toBeDisabled();
    });

    it('renders nothing when closed', () => {
        const { container } = render(<STImportWizard open={false} onClose={() => {}} onDone={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });
});
