import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';

afterEach(() => cleanup());

const descriptor = (layout: PanelDescriptor['layout']): PanelDescriptor => ({
    id: 'opaque-panel',
    bindsTo: 'context.rows',
    launch: 'nested',
    layout,
    fields: [],
    crud: { read: true },
});

describe('PanelRenderer contract', () => {
    it.each(['form', 'tree'] as const)('reports layout %s as not yet supported', (layout) => {
        render(<PanelRenderer descriptor={descriptor(layout)} rows={[]} />);

        expect(screen.getByRole('status')).toHaveTextContent(`Panel layout “${layout}” is not supported yet.`);
        expect(screen.getByRole('status')).toHaveAttribute('data-panel-unsupported-layout', layout);
    });

    it('contains no measured panel names in the renderer implementation', () => {
        const rendererFiles = [
            'src/components/panels/PanelRenderer.tsx',
            'src/components/panels/ListDetailRenderer.tsx',
            'src/components/panels/ListPanelRenderer.tsx',
            'src/components/panels/ListPanelRendererCore.tsx',
        ];
        const source = rendererFiles
            .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
            .join('\n');

        for (const panelId of ['npc-ledger', 'lore-chunks', 'memory-facts', 'pinned-memories']) {
            expect(source, `${panelId} must stay opaque to the renderer`).not.toContain(panelId);
        }
    });
});
