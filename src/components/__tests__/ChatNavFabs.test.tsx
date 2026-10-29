import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatNavFabs } from '../chat/ChatNavFabs';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(scrollTop = 300) {
    const sc = document.createElement('div');
    sc.style.scrollPaddingTop = '24px';
    sc.scrollTop = scrollTop;
    Object.defineProperty(sc, 'scrollHeight', { value: 1200 });
    sc.getBoundingClientRect = () => ({ top: 30 } as DOMRect);
    sc.scrollTo = vi.fn();
    for (const position of [24, 224, 624]) {
        const row = document.createElement('div');
        row.dataset.ui = 'msg-row';
        row.getBoundingClientRect = () => ({ top: 30 + position - sc.scrollTop } as DOMRect);
        // Inner bubbles have unrelated offset parents; navigation must use rows.
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble-base';
        row.append(bubble);
        sc.append(row);
    }
    render(<ChatNavFabs scrollContainerRef={{ current: sc }} />);
    return { sc };
}

describe('message navigation', () => {
    it('jumps to previous and next message rows using scroll-container coordinates', () => {
        const { sc } = setup();
        fireEvent.click(screen.getByRole('button', { name: 'Previous message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'smooth' });
        fireEvent.click(screen.getByRole('button', { name: 'Next message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' });
    });
    it('skips the aligned message and stops safely at the ends', () => {
        const { sc } = setup(200);
        fireEvent.click(screen.getByRole('button', { name: 'Previous message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
        sc.scrollTop = 0;
        fireEvent.click(screen.getByRole('button', { name: 'Previous message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
        sc.scrollTop = 600;
        fireEvent.click(screen.getByRole('button', { name: 'Next message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
    });
    it('retains a separate latest-message shortcut', () => {
        const { sc } = setup();
        fireEvent.click(screen.getByRole('button', { name: 'Latest message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'smooth' });
    });
    it('respects reduced motion for navigation', () => {
        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
        const { sc } = setup();
        fireEvent.click(screen.getByRole('button', { name: 'Next message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'auto' });
        fireEvent.click(screen.getByRole('button', { name: 'Latest message' }));
        expect(sc.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'auto' });
    });
});
