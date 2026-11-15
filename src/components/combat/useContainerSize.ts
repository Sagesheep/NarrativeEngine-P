import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export type ContainerSize = { width: number; height: number };

export function useContainerSize(ref: RefObject<HTMLElement | null>, active: boolean): ContainerSize | null {
    const [size, setSize] = useState<ContainerSize | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!active || !el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(entries => {
            const rect = entries[entries.length - 1]?.contentRect;
            if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
            setSize(prev => (prev && prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref, active]);
    return size;
}
