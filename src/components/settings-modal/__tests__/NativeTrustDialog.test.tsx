/**
 * Phase 6.1 — `NativeTrustDialog` component tests.
 *
 * Pins that the verbatim `TRUST.md` §D warning text renders with the mod
 * name substituted, that the affirmative action is "Enable native mod", and
 * that the safe action is "Cancel". The dialog must not rewrite the warning
 * body — it is a required security disclosure (`TRUST.md` §D: "Phase 6.1
 * must paste it without editing").
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NativeTrustDialog } from '../NativeTrustDialog';

const PROPS = { modName: 'Grimdark', onConfirm: vi.fn(), onCancel: vi.fn() };

describe('NativeTrustDialog', () => {
    it('renders the verbatim warning body with the mod name substituted', () => {
        render(<NativeTrustDialog {...PROPS} />);
        // The body is a single paragraph; assert the full text matches the
        // §D verbatim wording with {modName} replaced. Whitespace is collapsed
        // by the DOM, so match against the rendered text content.
        const body = screen.getByText(/This mod contains native code/);
        expect(body.textContent).toContain('Grimdark');
        expect(body.textContent).toContain('Narrative Engine');
        expect(body.textContent).toContain('API keys currently available in the browser');
        expect(body.textContent).toContain('Sandboxed-compute and declarative mods do not receive this access');
        expect(body.textContent).toContain('Do you want to enable');
    });

    it('renders the affirmative action "Enable native mod" and fires onConfirm', () => {
        const onConfirm = vi.fn();
        render(<NativeTrustDialog {...PROPS} onConfirm={onConfirm} />);
        const button = screen.getByRole('button', { name: 'Enable native mod' });
        fireEvent.click(button);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('renders the safe action "Cancel" and fires onCancel', () => {
        const onCancel = vi.fn();
        render(<NativeTrustDialog {...PROPS} onCancel={onCancel} />);
        const button = screen.getByRole('button', { name: 'Cancel' });
        fireEvent.click(button);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('does not rewrite or paraphrase the warning (verbatim §D)', () => {
        render(<NativeTrustDialog {...PROPS} />);
        const body = screen.getByText(/This mod contains native code/);
        // The exact §D text, with the mod name substituted. Newlines are
        // collapsed by the DOM, so compare against the joined string.
        const expected =
            'This mod contains native code that will run inside Narrative Engine with the same access as the app. '
            + 'It can read and change your campaigns, settings, and data available to the app, including API keys '
            + 'currently available in the browser. Only enable it if you trust its author and source. '
            + 'Sandboxed-compute and declarative mods do not receive this access. Do you want to enable '
            + 'Grimdark?';
        // Collapse whitespace in both for a robust comparison.
        const collapse = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
        expect(collapse(body.textContent)).toBe(collapse(expected));
    });
});