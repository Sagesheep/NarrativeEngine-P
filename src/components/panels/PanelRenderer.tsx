import type { PanelDescriptor } from '@narrative/engine';
import { ListDetailRenderer } from './ListDetailRenderer';
import { ListPanelRenderer, type PanelRendererProps } from './ListPanelRenderer';

export type { PanelRendererProps } from './ListPanelRenderer';

export function PanelRenderer<TRow extends Record<string, unknown> = Record<string, unknown>>(
    props: PanelRendererProps<TRow>,
) {
    if (props.descriptor.layout === 'list-detail') {
        return <ListDetailRenderer {...props} />;
    }
    return <ListPanelRenderer {...props} />;
}

export type PanelDescriptorShape = PanelDescriptor;
