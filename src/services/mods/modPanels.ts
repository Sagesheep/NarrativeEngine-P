/**
 * WO-P5-16 Step 4 — convert a validated mod panel declaration into the
 * `PanelDescriptor` shape the generic renderer consumes.
 *
 * The renderer (`src/components/panels/PanelRenderer.tsx`) may not branch on
 * whether a panel is ours or a mod's (§4). This adapter is the single place
 * where the translation happens: a `ValidatedModPanel` (the serializable
 * subset declared in `*.mod.json`) becomes a `PanelDescriptor` with the
 * same fields, crud, sort, reads, search, and filter — plus a namespaced
 * `id` so the descriptor registry cannot collide with a host panel.
 *
 * `bindsTo` is the NAMESPACED mod-table name (`mod.<modId>.<bindsTo>`), not
 * the bare table name. The host resolves `bindsTo` against the store's
 * `modTables` map; the renderer just sees a string. A host panel's
 * `bindsTo` is a store field; a mod panel's `bindsTo` is a `mod.*` key. The
 * renderer cannot tell the two apart by construction.
 *
 * The `id` is namespaced to `mod.<modId>.<panelId>` for the same reason —
 * two mods could each declare a panel called `things`, and the host could
 * have a panel called `things` too. The renderer never compares ids to
 * host panel ids; namespacing keeps the descriptor registry collision-free
 * if a host ever registers both.
 */
import type { PanelDescriptor, PanelField, PanelFilter, PanelInputField, SortSpec } from '@narrative/engine';
import type { ModPanelField, ModPanelSort, ValidatedMod, ValidatedModPanel } from './modTypes';
import { modTableName } from './modTables';

/** Namespaced panel id: `mod.<modId>.<panelId>`. */
export function modPanelId(modId: string, panelId: string): string {
    return `mod.${modId}.${panelId}`;
}

/** Namespaced `bindsTo`: the mod-table key the store holds. */
export function modPanelBindsTo(modId: string, bindsTo: string): string {
    return modTableName(modId, bindsTo);
}

function toField(field: ModPanelField): PanelField {
    // The mod panel field is the serializable subset of PanelInputField
    // (no `compute`). The cast is safe because the shapes are identical
    // after validation; `control` is one of the ten non-`computed` kinds.
    const input: PanelInputField = {
        key: field.key,
        control: field.control,
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.description !== undefined ? { description: field.description } : {}),
        ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
        ...(field.options !== undefined ? { options: field.options } : {}),
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
    };
    return input;
}

function toSort(sort: string | ModPanelSort | undefined): string | SortSpec | undefined {
    if (sort === undefined) return undefined;
    if (typeof sort === 'string') return sort;
    return { field: sort.field, ...(sort.direction !== undefined ? { direction: sort.direction } : {}) };
}

function toFilter(filter: NonNullable<ValidatedModPanel['filter']>): PanelFilter {
    return {
        field: filter.field,
        options: filter.options,
        ...(filter.label !== undefined ? { label: filter.label } : {}),
    };
}

/**
 * Build a `PanelDescriptor` from a mod's validated panel declaration.
 *
 * The descriptor carries the namespaced `id` and `bindsTo`; everything else
 * is a 1:1 shape translation. `hooks` is never set (R3 defers panel logic),
 * `writes` is never set (a mod panel writes via crud on `bindsTo` only),
 * and `reads` is namespaced to the mod's own tables so a host that ever
 * consumes `reads` finds the same `mod.<modId>.<table>` keys it finds for
 * `bindsTo`.
 */
export function modPanelToDescriptor(modId: string, panel: ValidatedModPanel): PanelDescriptor {
    const descriptor: PanelDescriptor = {
        id: modPanelId(modId, panel.id),
        bindsTo: modPanelBindsTo(modId, panel.bindsTo),
        launch: 'nested',
        layout: panel.layout,
        fields: panel.fields.map(toField),
        crud: { ...panel.crud },
        ...(panel.sort !== undefined ? { sort: toSort(panel.sort) } : {}),
        ...(panel.search !== undefined ? { search: panel.search } : {}),
        ...(panel.filter !== undefined ? { filter: toFilter(panel.filter) } : {}),
    };
    if (panel.reads !== undefined) {
        // Namespace `reads` so a host that consumes them finds the same
        // `mod.<modId>.<table>` keys it finds for `bindsTo`. The mod loader
        // already validated that each name is one of this mod's own tables.
        descriptor.reads = panel.reads.map((name) => modTableName(modId, name));
    }
    return descriptor;
}

/**
 * Collect every declared mod panel across all loaded mods, as
 * `{ modId, panel }` pairs. Used by the Extensions UI to render each mod's
 * panels under the mod that declared them.
 */
export function collectDeclaredModPanels(mods: readonly ValidatedMod[]): Array<{ modId: string; panel: ValidatedModPanel }> {
    const out: Array<{ modId: string; panel: ValidatedModPanel }> = [];
    for (const mod of mods) {
        if (!Array.isArray(mod.panels)) continue;
        for (const panel of mod.panels) {
            out.push({ modId: mod.id, panel });
        }
    }
    return out;
}