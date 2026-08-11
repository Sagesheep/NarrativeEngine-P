import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * WORKORDER-P5-02 §9 — live wiring smoke test.
 *
 * The WO-P2-05 lesson: a screen that unit-tested green still needed `refreshMods()` wired
 * at App mount, or an installed mod was listed but never reached the prompt. Unit tests
 * with mocked registries do NOT catch unwired state.
 *
 * This test mounts `BlockViewModal` against the REAL registries (no mocks of
 * `listTierBlocks`, `createFinalUserRegistryWithExtensions`, or `postTurnTracks`) and
 * verifies that the three sections actually enumerate blocks. If a registry accessor is
 * unwired, the corresponding section renders empty — the test catches that here, in CI,
 * rather than in a manual browser session.
 *
 * Only the store and the translation hook are mocked, because they depend on a campaign
 * being loaded and a provider being configured — neither of which is available in jsdom.
 */

vi.mock('../../../store/useAppStore', () => {
    const state = {
        blockViewOpen: true,
        toggleBlockView: () => {},
        settings: { aiTier: 'pro', moduleEnabled: {} },
        updateSettings: () => {},
    };
    const useAppStore = (selector: (s: typeof state) => unknown) => selector(state);
    return { useAppStore };
});

vi.mock('../../../i18n/useTranslation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}));

import { BlockViewModal } from '../BlockViewModal';

describe('WORKORDER-P5-02 §9 — live wiring (real registries, not mocked)', () => {
    it('the tier section enumerates blocks from listTierBlocks (not empty)', () => {
        render(<BlockViewModal />);
        expect(screen.getByText('blockview.section.tier')).toBeTruthy();
        const engineBadges = screen.getAllByText('ENGINE');
        const modelBadges = screen.getAllByText('MODEL');
        expect(engineBadges.length).toBeGreaterThan(0);
        expect(modelBadges.length).toBeGreaterThan(0);
    });

    it('the contributions section enumerates built-in contribution modules', () => {
        render(<BlockViewModal />);
        expect(screen.getByText('blockview.section.contrib')).toBeTruthy();
        const lockedBadges = screen.getAllByText('blockview.badge.locked');
        expect(lockedBadges.length).toBeGreaterThanOrEqual(4);
    });

    it('the tracks section enumerates registered post-turn tracks', () => {
        render(<BlockViewModal />);
        expect(screen.getByText('blockview.section.tracks')).toBeTruthy();
        const allEngineModel = [
            ...screen.getAllByText('ENGINE'),
            ...screen.getAllByText('MODEL'),
        ];
        // Phase 8.3 — 26 tier + 8 contributions + 2 tracks = 36 (was 38 pre-8.3:
        // enemyDiscovery left the built-ins and enemySuggestionTrack left the
        // track registry). The bound is `>= 36` so a future mod that registers
        // a tier entry or a track raises the count without breaking this test.
        expect(allEngineModel.length).toBeGreaterThanOrEqual(36);
    });

    it('manual blocks render visible with a MANUAL badge (not omitted)', () => {
        render(<BlockViewModal />);
        // arcSpawn is the only manual block (button-fired). It renders the MANUAL text
        // twice in the component (badge + lock indicator), so at least 2.
        const manualBadges = screen.getAllByText('blockview.badge.manual');
        expect(manualBadges.length).toBeGreaterThanOrEqual(2);
    });

    it('unwired blocks render visible with an UNWIRED badge (not omitted)', () => {
        render(<BlockViewModal />);
        // witnessAux and npcProfileGen are unwired (reserved slots, no call site).
        // Each renders the UNWIRED text twice (badge + lock indicator).
        const unwiredBadges = screen.getAllByText('blockview.badge.unwired');
        expect(unwiredBadges.length).toBeGreaterThanOrEqual(4);
    });
});