import type { PinnedExcerpt } from '../../types';

export function buildPinnedMemoriesBlock(pinnedExcerpts: PinnedExcerpt[]): string {
    const lines = pinnedExcerpts.map(e => `- "${e.text}"`);
    return `[PINNED MEMORIES]\n${lines.join('\n')}`;
}