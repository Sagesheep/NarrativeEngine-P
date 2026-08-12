import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BookOpen, Sliders } from 'lucide-react';
import { ScreenSection } from '../ScreenSection';

describe('ScreenSection', () => {
    it('renders label, icon, and count badge', () => {
        render(<ScreenSection icon={BookOpen} label="Chapters" count={24} />);
        expect(screen.getByText('Chapters')).toBeInTheDocument();
        expect(screen.getByText('(24)')).toBeInTheDocument();
        // The icon renders as an inline SVG inside the leading span.
        expect(screen.getByText('Chapters').parentElement?.querySelector('svg')).not.toBeNull();
    });

    it('renders the right-slot pinned to the trailing edge', () => {
        render(
            <ScreenSection label="Rules" rightSlot={<button type="button">Manage</button>} />,
        );
        expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    });

    it('uses the neutral tone and a bottom border by default', () => {
        const { container } = render(<ScreenSection label="Lore" />);
        const header = container.firstElementChild as HTMLElement;
        expect(header.className).toMatch(/text-text-dim/);
        expect(header.className).toMatch(/border-b/);
        expect(header.className).toMatch(/border-border\/50/);
    });

    it('opts out of the border and supports a state tone', () => {
        const { container: c1 } = render(<ScreenSection label="Always On" tone="terminal" border={false} />);
        const h1 = c1.firstElementChild as HTMLElement;
        expect(h1.className).toMatch(/text-terminal/);
        expect(h1.className).not.toMatch(/border-b/);

        const { container: c2 } = render(<ScreenSection label="Review" tone="amber" />);
        const h2 = c2.firstElementChild as HTMLElement;
        expect(h2.className).toMatch(/text-amber-400/);
        expect(h2.className).toMatch(/border-amber-500\/20/);
    });

    it('renders a marker dot when asked, not by default', () => {
        const { container: c1 } = render(<ScreenSection label="Lore" />);
        expect(c1.querySelector('.rounded-full')).toBeNull();

        const { container: c2 } = render(<ScreenSection icon={Sliders} label="Engines" marker />);
        expect(c2.querySelector('.rounded-full')).not.toBeNull();
    });
});