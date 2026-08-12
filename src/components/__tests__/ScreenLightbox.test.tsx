import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenLightbox } from '../ScreenLightbox';

afterEach(() => {
    document.body.innerHTML = '';
});

describe('ScreenLightbox', () => {
    it('uses the default 90% shell and closes from Escape or the backdrop', () => {
        const onClose = vi.fn();
        render(<ScreenLightbox title="Lore" onClose={onClose}><button>Save</button></ScreenLightbox>);

        expect(screen.getByRole('dialog', { name: 'Lore' })).toBeInTheDocument();
        expect(screen.getByRole('dialog').querySelector('.w-\\[90vw\\]')).not.toBeNull();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('dialog'));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('traps Tab and restores focus to the opener on unmount', () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const { unmount } = render(
            <ScreenLightbox title="Rules" onClose={() => undefined}>
                <button>First</button>
                <button>Last</button>
            </ScreenLightbox>,
        );

        const last = screen.getByRole('button', { name: 'Last' });
        const close = screen.getByRole('button', { name: 'Close Rules' });
        expect(document.activeElement).toBe(close);

        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(close);

        close.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);

        unmount();
        expect(document.activeElement).toBe(opener);
    });

    it('supports the full-size opt-out', () => {
        render(<ScreenLightbox size="full" title="Settings" onClose={() => undefined}><p>Content</p></ScreenLightbox>);
        expect(screen.getByRole('dialog').querySelector('.w-full.h-full')).not.toBeNull();
    });
});
