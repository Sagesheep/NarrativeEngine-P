import type { LoreCategory } from '../../types';

/** Shared by the new-entry form and the inline lore editor. */
export const button = 'px-3 py-2 text-xs border border-terminal/40 text-terminal rounded hover:bg-terminal/10 disabled:opacity-40';
export const field = 'block w-full mt-1 bg-surface border border-border rounded p-2 text-xs text-text-primary placeholder:text-text-dim/40 focus:outline-none focus:border-terminal';

export const CATEGORIES: LoreCategory[] = [
    'world_overview', 'faction', 'location', 'character', 'power_system',
    'economy', 'event', 'relationship', 'rules', 'culture', 'misc',
];
