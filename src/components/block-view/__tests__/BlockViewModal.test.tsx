import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BlockCard } from '../BlockCard';
import type { Block } from '../blockModel';

/**
 * WORKORDER-P5-02 §8 — component tests.
 *
 * Three cases the work order requires:
 *   1. renders with an empty registry (zero blocks, no crash) — covered by BlockViewModal
 *      with all registries mocked to return empty.
 *   2. renders a locked block as locked — BlockCard with a non-switchable block.
 *   3. toggling calls `updateSettings` with the expected patch — BlockCard with a
 *      switchable block, clicking the switch calls `onToggle(id, !enabled)`.
 *
 * The BlockViewModal tests mock the three registry accessors at the module boundary so
 * the empty-registry case is real (the modal renders against a truly empty enumeration).
 */

// ── Helpers ────────────────────────────────────────────────────────────

function makeBlock(overrides: Partial<Block> = {}): Block {
    return {
        id: 'test.block',
        name: 'Test Block',
        description: 'A block used by the test suite.',
        source: 'tier',
        kind: 'engine',
        switchable: true,
        defaultEnabled: true,
        ...overrides,
    };
}

// ── BlockCard tests (no store mocking needed — props only) ─────────────

describe('BlockCard', () => {
    it('renders an ENGINE badge for an engine block', () => {
        render(<BlockCard block={makeBlock({ kind: 'engine' })} enabled={true} onToggle={vi.fn()} />);
        expect(screen.getByText('ENGINE')).toBeTruthy();
    });

    it('renders a MODEL badge for a model block', () => {
        render(<BlockCard block={makeBlock({ kind: 'model' })} enabled={true} onToggle={vi.fn()} />);
        expect(screen.getByText('MODEL')).toBeTruthy();
    });

    it('renders a locked block as locked (lock indicator + LOCKED badge, no switch)', () => {
        const block = makeBlock({ switchable: false, lockReason: 'structural' });
        render(<BlockCard block={block} enabled={true} onToggle={vi.fn()} />);
        // The t() mock returns the key; the locked badge + lock indicator both render it.
        expect(screen.getAllByText('blockview.badge.locked').length).toBeGreaterThan(0);
        // The switch button is not rendered for a locked block.
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('renders a manual block as manual (hand indicator + MANUAL badge, no switch)', () => {
        const block = makeBlock({ switchable: false, lockReason: 'manual' });
        render(<BlockCard block={block} enabled={true} onToggle={vi.fn()} />);
        expect(screen.getAllByText('blockview.badge.manual').length).toBeGreaterThan(0);
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('renders an unwired block as unwired (unplug indicator + UNWIRED badge, no switch)', () => {
        const block = makeBlock({ switchable: false, lockReason: 'unwired' });
        render(<BlockCard block={block} enabled={true} onToggle={vi.fn()} />);
        expect(screen.getAllByText('blockview.badge.unwired').length).toBeGreaterThan(0);
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('clicking the switch on a switchable block calls onToggle with the inverted state', () => {
        const onToggle = vi.fn();
        const block = makeBlock({ id: 'test.flippable', switchable: true });
        render(<BlockCard block={block} enabled={true} onToggle={onToggle} />);
        const sw = screen.getByRole('switch');
        expect(sw.getAttribute('aria-checked')).toBe('true');
        fireEvent.click(sw);
        expect(onToggle).toHaveBeenCalledWith('test.flippable', false);
    });

    it('clicking the switch when off calls onToggle with true', () => {
        const onToggle = vi.fn();
        const block = makeBlock({ id: 'test.flippable', switchable: true });
        render(<BlockCard block={block} enabled={false} onToggle={onToggle} />);
        const sw = screen.getByRole('switch');
        expect(sw.getAttribute('aria-checked')).toBe('false');
        fireEvent.click(sw);
        expect(onToggle).toHaveBeenCalledWith('test.flippable', true);
    });
});

// ── BlockViewModal tests (mock the store + registries) ────────────────

vi.mock('../../../store/useAppStore', () => {
    const state = {
        blockViewOpen: true,
        toggleBlockView: vi.fn(),
        settings: { aiTier: 'pro', moduleEnabled: {} },
        updateSettings: vi.fn(),
    };
    const useAppStore = vi.fn((selector: (s: typeof state) => unknown) => selector(state));
    return { useAppStore };
});

// Mock useTranslation at both relative paths the components under test import it from.
// BlockViewModal uses '../../../i18n/useTranslation'; BlockCard/TierPresetBar use '../../i18n/useTranslation'.
// vi.mock factories are hoisted, so the factory must be self-contained (no closure vars).
vi.mock('../../../i18n/useTranslation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));
vi.mock('../../i18n/useTranslation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

vi.mock('../../../services/turn/blockEnablement', () => ({
    isBlockEnabled: (_id: string, _tier: unknown, moduleEnabled: Record<string, boolean> | undefined) =>
        moduleEnabled?.[_id] !== false,
}));

vi.mock('../../../services/turn/aiTier', () => ({
    MATRIX: { lite: {}, pro: {}, max: {} },
    listTierBlocks: () => [],
}));

vi.mock('../../../services/payload/contributions/extensions', () => ({
    createFinalUserRegistryWithExtensions: () => ({ list: () => [] }),
}));

vi.mock('../../../services/turn/tracks', () => ({
    postTurnTracks: { list: () => [] },
}));

import { BlockViewModal } from '../BlockViewModal';
import { useAppStore } from '../../../store/useAppStore';

describe('BlockViewModal — empty registry (no crash)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset the mock store to the default open state before each test.
        const state = {
            blockViewOpen: true,
            toggleBlockView: vi.fn(),
            settings: { aiTier: 'pro', moduleEnabled: {} },
            updateSettings: vi.fn(),
        };
        (useAppStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (selector: (s: typeof state) => unknown) => selector(state),
        );
    });

    it('renders without crashing when all three registries are empty', () => {
        const { container } = render(<BlockViewModal />);
        // The modal shell is present.
        expect(container.querySelector('[role="dialog"]')).toBeTruthy();
        // The empty-state message is shown once per empty section (three sections).
        expect(screen.getAllByText('blockview.empty').length).toBe(3);
    });

    it('returns null when blockViewOpen is false', () => {
        const mockState = {
            blockViewOpen: false,
            toggleBlockView: vi.fn(),
            settings: { aiTier: 'pro', moduleEnabled: {} },
            updateSettings: vi.fn(),
        };
        (useAppStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (selector: (s: typeof mockState) => unknown) => selector(mockState),
        );
        const { container } = render(<BlockViewModal />);
        expect(container.firstChild).toBeNull();
    });

    it('renders the three section headers even when registries are empty', () => {
        render(<BlockViewModal />);
        expect(screen.getByText('blockview.section.tier')).toBeTruthy();
        expect(screen.getByText('blockview.section.contrib')).toBeTruthy();
        expect(screen.getByText('blockview.section.tracks')).toBeTruthy();
    });
});