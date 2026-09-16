import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { STImportWizard } from '../STImportWizard';
import { useAppStore } from '../../../store/useAppStore';
import { buildCardPng, buildPlainPng } from '../../../services/import/__tests__/pngFixture';
import type { AdaptationResult, AdaptationTarget } from '../../../services/import/adaptationTypes';

// ── The write path. Only the wiring is under test here, never the disk. ──────
vi.mock('../../../store/campaignStore', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../store/campaignStore')>()),
    saveCampaign: vi.fn(async () => {}),
    saveLoreChunks: vi.fn(async () => {}),
    saveNPCLedger: vi.fn(async () => {}),
    saveCampaignState: vi.fn(async () => {}),
}));
vi.mock('../../../store/campaignHydrator', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../store/campaignHydrator')>()),
    hydrateCampaign: vi.fn(async () => {}),
}));
vi.mock('../../../services/infrastructure/assetService', async importOriginal => ({
    ...(await importOriginal<typeof import('../../../services/infrastructure/assetService')>()),
    uploadImageToLocal: vi.fn(async () => '/assets/portraits/x.png'),
}));
vi.mock('../../../services/import/coverImage', () => ({
    downscaleCover: vi.fn(async () => 'data:image/jpeg;base64,COVER'),
}));

// ── §9.3 — the adaptation service is the other half of C2; here it is a stub. ─
const runAdaptation = vi.fn<(
    targets: AdaptationTarget[],
    deps: { onResult?: (r: AdaptationResult) => void },
    opts: { importId: string },
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

function setAdaptationFlag(on: boolean) {
    useAppStore.setState(s => ({ settings: { ...s.settings, stImportAdaptation: on } }));
}

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

// ─── §9.3 (C2) — the Review step's adaptation choice ─────────────────────────

/**
 * Shelf → Who are you? → Review, with two parsed cards. Returns the `onDone`
 * spy: `open` is a prop the harness never flips, so a finished import is
 * observed by that callback firing, not by the wizard unmounting.
 */
async function reachReview() {
    const onDone = vi.fn();
    render(<STImportWizard open onClose={() => {}} onDone={onDone} />);
    fireEvent.change(screen.getByTestId('st-card-input'), {
        target: {
            files: [
                file('aria.png', buildCardPng(payload())),
                file('bram.png', buildCardPng(payload({ name: 'Bram', scenario: '', first_mes: '', description: 'A blacksmith.' }))),
            ],
        },
    });
    await waitFor(() => expect(screen.getByText('Aria')).toBeInTheDocument());

    // Step 1 → "Who are you?" (no alternate greetings, so step 2 is skipped).
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText('Build my own character')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /create campaign/i })).toBeInTheDocument());
    return onDone;
}

describe('STImportWizard — AI adaptation (WO-C §9.3, order C2)', () => {
    beforeEach(() => {
        runAdaptation.mockReset();
        resolveAdaptationEndpoint.mockReset();
        resolveAdaptationEndpoint.mockReturnValue(PROVIDER);
    });
    afterEach(() => { setAdaptationFlag(false); });

    it('with the flag off: one muted line, no choice, and no model call', async () => {
        setAdaptationFlag(false);
        const onDone = await reachReview();

        expect(screen.getByText(/AI adaptation is off — enable it in Settings → Global/)).toBeInTheDocument();
        expect(screen.queryByRole('radio')).toBeNull();

        const create = screen.getByRole('button', { name: /create campaign/i });
        expect(create).not.toBeDisabled();
        fireEvent.click(create);

        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(screen.queryByTestId('st-adaptation-panel')).toBeNull();
        expect(runAdaptation).not.toHaveBeenCalled();
    });

    it('with the flag on: Create waits for an explicit choice, and Direct makes no call', async () => {
        setAdaptationFlag(true);
        const onDone = await reachReview();

        // §9.3 — never pre-checked, so nothing is selected and Create is dead.
        const living = screen.getByRole('radio', { name: /living-world adaptation/i });
        const direct = screen.getByRole('radio', { name: /direct import/i });
        expect(living).not.toBeChecked();
        expect(direct).not.toBeChecked();
        expect(living).not.toBeDisabled();
        expect(screen.getByText(/Uses Utility AI \(glm-4-flash\)/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /create campaign/i })).toBeDisabled();

        fireEvent.click(direct);
        const create = screen.getByRole('button', { name: /create campaign/i });
        expect(create).not.toBeDisabled();
        fireEvent.click(create);

        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(screen.queryByTestId('st-adaptation-panel')).toBeNull();
        expect(runAdaptation).not.toHaveBeenCalled();
    });

    it('with no endpoint the Living-world option is disabled and says why', async () => {
        resolveAdaptationEndpoint.mockReturnValue(undefined);
        setAdaptationFlag(true);
        await reachReview();

        expect(screen.getByRole('radio', { name: /living-world adaptation/i })).toBeDisabled();
        expect(screen.getByText(/no utility or story endpoint is configured/)).toBeInTheDocument();
    });

    it('Living-world runs the pass, names the fallback, and offers Retry per row', async () => {
        setAdaptationFlag(true);
        runAdaptation.mockImplementation(async targets => targets.map((t, i) => (
            i === 0
                ? { id: t.id, name: t.name, status: 'adapted', wants: { short: ['Guard the ledgers'], medium: [], long: 'Keep the tower standing.' } }
                : { id: t.id, name: t.name, status: 'failed', error: 'the model timed out' }
        )));

        await reachReview();
        fireEvent.click(screen.getByRole('radio', { name: /living-world adaptation/i }));
        fireEvent.click(screen.getByRole('button', { name: /create campaign/i }));

        // The pass runs only after the import is on disk, and its panel replaces Review.
        await waitFor(() => expect(screen.getByTestId('st-adaptation-panel')).toBeInTheDocument());
        expect(runAdaptation).toHaveBeenCalledTimes(1);
        expect(runAdaptation.mock.calls[0][0].map(t => t.name)).toEqual(['Aria', 'Bram']);
        expect(runAdaptation.mock.calls[0][2].importId).toBeTruthy();

        // §9.3 — every fallback NPC is named, with a reason and its own Retry.
        await waitFor(() => expect(screen.getByRole('button', { name: /retry bram/i })).toBeInTheDocument());
        expect(screen.getByText(/the model timed out/)).toBeInTheDocument();
        expect(screen.getByText('Keep the tower standing.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /retry bram/i }));
        await waitFor(() => expect(runAdaptation).toHaveBeenCalledTimes(2));
        expect(runAdaptation.mock.calls[1][0].map(t => t.name)).toEqual(['Bram']);

        // Continue resolves the hook, and the campaign finally opens.
        await waitFor(() => expect(screen.getByRole('button', { name: /continue to campaign/i })).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /continue to campaign/i }));
        await waitFor(() => expect(screen.queryByTestId('st-adaptation-panel')).toBeNull());
    });
});
