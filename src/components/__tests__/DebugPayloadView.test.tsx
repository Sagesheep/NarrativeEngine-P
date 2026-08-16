import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebugPayloadView } from '../DebugPayloadView';
import type { DebugSection } from '../../types';

function section(overrides: Partial<DebugSection> = {}): DebugSection {
    return {
        label: 'Section',
        role: 'system',
        content: 'content',
        ...overrides,
    };
}

describe('DebugPayloadView — utility sections (WO2-Clock §5)', () => {
    it('renders a NOT SENT TO GM badge on role:utility sections', () => {
        const sections = [
            section({ label: 'GM payload', role: 'system', content: 'sent to GM' }),
            section({ label: 'Director world_facts', role: 'utility', content: '<world_facts>...</world_facts>' }),
        ];
        render(<DebugPayloadView debugPayload={{ sections }} />);

        const badge = screen.getByText('NOT SENT TO GM');
        expect(badge).toBeTruthy();

        // Exactly one badge (only the utility section is badged).
        expect(screen.getAllByText('NOT SENT TO GM')).toHaveLength(1);

        // The GM-facing section's content is present in the body but NOT badged.
        const gmSection = screen.getByText('GM payload');
        expect(gmSection).toBeTruthy();
        const gmSectionRow = gmSection.closest('details')!;
        expect(gmSectionRow.getAttribute('data-utility')).toBe('false');

        // The utility section row is marked.
        const utilSection = screen.getByText('Director world_facts');
        const utilSectionRow = utilSection.closest('details')!;
        expect(utilSectionRow.getAttribute('data-role')).toBe('utility');
        expect(utilSectionRow.getAttribute('data-utility')).toBe('true');
    });

    it('does not badge a role:system section (the common case)', () => {
        const sections = [section({ label: 'Profile/Inventory', role: 'system' })];
        render(<DebugPayloadView debugPayload={{ sections }} />);
        expect(screen.queryByText('NOT SENT TO GM')).toBeNull();
    });

    it('does not badge arbitrary non-utility roles', () => {
        const sections = [section({ label: 'Rules', role: 'system' }), section({ label: 'World', role: 'system' })];
        render(<DebugPayloadView debugPayload={{ sections }} />);
        expect(screen.queryByText('NOT SENT TO GM')).toBeNull();
    });

    it('still renders the raw JSON fallback when no sections are present', () => {
        render(<DebugPayloadView debugPayload={{ raw: { foo: 'bar' } }} />);
        expect(screen.getByText(/"foo"/)).toBeTruthy();
        expect(screen.queryByText('NOT SENT TO GM')).toBeNull();
    });
});