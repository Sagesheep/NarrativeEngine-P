import type { WorldLoreDraft } from '../../types';

const FLAT_SECTIONS: { key: keyof WorldLoreDraft; header: string }[] = [
    { key: 'background', header: 'World Background' },
    { key: 'languages', header: 'Languages & Naming Conventions' },
    { key: 'powerSystem', header: 'Power System' },
    { key: 'techEconomy', header: 'Technology & Economy Level' },
    { key: 'timeline', header: 'Timeline / Calendar / Current Era' },
    { key: 'toneBoundaries', header: 'Tone & Content Boundaries' },
    { key: 'houseRules', header: 'House Rules / Mechanical Conventions' },
];

const LIST_SECTIONS: { key: keyof Pick<WorldLoreDraft, 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs'>; header: string }[] = [
    { key: 'locations', header: 'Geography & Locations' },
    { key: 'cultures', header: 'Cultures' },
    { key: 'factions', header: 'Established Factions' },
    { key: 'threats', header: 'Threats / Antagonist Forces' },
    { key: 'npcs', header: 'Pre-seeded NPCs' },
];

export function exportDraftToMarkdown(draft: WorldLoreDraft): string {
    const lines: string[] = [];

    lines.push(`# ${draft.name}`);
    lines.push('');

    for (const sec of FLAT_SECTIONS) {
        const value = (draft[sec.key] as string).trim();
        if (value) {
            lines.push(`## ${sec.header}`);
            lines.push('');
            lines.push(value);
            lines.push('');
        }
    }

    for (const sec of LIST_SECTIONS) {
        const items = draft[sec.key] as { id: string; title: string; body: string }[];
        if (items.length > 0) {
            lines.push(`## ${sec.header}`);
            lines.push('');
            for (const item of items) {
                const title = item.title.trim() || 'Untitled';
                lines.push(`### ${title}`);
                lines.push('');
                if (item.body.trim()) {
                    lines.push(item.body.trim());
                    lines.push('');
                }
            }
        }
    }

    const charQ = draft.characterCreationQuestions.trim();
    if (charQ) {
        lines.push('## Character Creation Questions');
        lines.push('');
        lines.push(charQ);
        lines.push('');
    }

    for (const chunk of draft.importedLoreChunks ?? []) {
        if (chunk.disabled) continue;
        lines.push(`### ${chunk.header}`, '', chunk.content, '');
    }
    return lines.join('\n');
}

export function downloadMarkdown(draft: WorldLoreDraft): void {
    const md = exportDraftToMarkdown(draft);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draft.name.replace(/[^a-zA-Z0-9]/g, '_')}_lore.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}