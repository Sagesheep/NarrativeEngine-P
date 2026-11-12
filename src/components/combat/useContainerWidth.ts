import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export function useContainerWidth(ref: RefObject<HTMLElement | null>): number | null {
    const [width, setWidth] = useState<number | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(entries => {
            const next = entries[entries.length - 1]?.contentRect.width;
            if (typeof next === 'number' && Number.isFinite(next)) setWidth(next);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return width;
}
