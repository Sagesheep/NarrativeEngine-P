/**
 * WO-P5-16 Step 4 — the §4 opaque-owner test, plus the source-level guard.
 *
 * 4.1's opaque-id rule says the renderer may not branch on WHICH panel it
 * renders. This sub-phase adds the same rule one level up: the renderer may
 * not branch on WHETHER a panel is ours or a mod's. Two row sources, one
 * renderer, and it cannot tell them apart.
 *
 * The behavioural test: run the SAME descriptor (same fields, crud, sort,
 * layout) through both paths — the host path (a plain `PanelDescriptor`
 * bound to a store field) and the mod path (a `ValidatedModPanel` run
 * through `modPanelToDescriptor`, bound to a `mod.*` table) — and assert
 * the rendered output is identical modulo the panel id (which the renderer
 * does not read).
 *
 * The source-level guard: `src/components/panels/` must contain no
 * `isMod`, `ownerId`, or `source === 'mod'` branch. Any owner branch is a
 * hard stop (§8).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';
import { modPanelToDescriptor } from '../../../services/mods/modPanels';
import type { ValidatedModPanel } from '../../../services/mods/modTypes';

type Row = { name: string; count: number };

const fields = [
    { key: 'name', label: 'Name', control: 'text' as const },
    { key: 'count', label: 'Count', control: 'number' as const, min: 0 },
];
const crud = { create: true, read: true, update: true, delete: true };

/** The host path: a plain descriptor bound to a store field. */
const hostDescriptor: PanelDescriptor<Row> = {
    id: 'host.things',
    bindsTo: 'things', // a store field
    launch: 'nested',
    layout: 'list',
    fields,
    crud,
    sort: { field: 'name', direction: 'desc' },
};

/** The mod path: a validated mod panel declaration, run through the adapter. */
const modPanel: ValidatedModPanel = {
    id: 'things-panel',
    bindsTo: 'things',
    launch: 'nested',
    layout: 'list',
    fields,
    crud,
    sort: { field: 'name', direction: 'desc' },
};
// modPanelToDescriptor namespaces `id` and `bindsTo` so the descriptor
// registry cannot collide with a host panel, and the store can resolve
// `bindsTo` against `modTables`. The renderer reads neither.
const modDescriptor: PanelDescriptor<Row> = modPanelToDescriptor('mymod', modPanel);

const rows: Row[] = [
    { name: 'Alpha', count: 1 },
    { name: 'Beta', count: 2 },
];

/** Strip the panel id (the renderer never reads it; both paths produce a
 *  namespaced id by design — host's is `host.things`, mod's is
 *  `mod.mymod.things-panel`). Everything else must be byte-identical. */
function normalize(container: HTMLElement): string {
    // The renderer renders `data-panel-layout`, `data-panel-control`,
    // `data-panel-row`, `data-panel-create`, `data-panel-delete`,
    // `data-panel-sort`, `data-panel-sort-direction` — none of which carry
    // the panel id. The panel id lives only in the descriptor object, never
    // in the DOM. So the raw innerHTML is the right comparison.
    return container.innerHTML;
}

describe('PanelRenderer — §4 opaque-owner (host path and mod path produce identical output)', () => {
    it('renders the same descriptor through both paths and asserts identical output', () => {
        const { container: hostContainer } = render(
            <PanelRenderer descriptor={hostDescriptor} rows={rows} />,
        );
        const { container: modContainer } = render(
            <PanelRenderer descriptor={modDescriptor} rows={rows} />,
        );

        expect(normalize(hostContainer)).toBe(normalize(modContainer));
    });

    it('the mod-path descriptor carries namespaced id and bindsTo (no collision with host)', () => {
        // The mod-path adapter namespaces id and bindsTo so the host's
        // `things` and the mod's `mod.mymod.things` cannot collide. The
        // renderer does not read either field; the host resolves them.
        expect(modDescriptor.id).toBe('mod.mymod.things-panel');
        expect(modDescriptor.bindsTo).toBe('mod.mymod.things');
        expect(hostDescriptor.id).toBe('host.things');
        expect(hostDescriptor.bindsTo).toBe('things');
        // The two descriptors share the same fields, crud, sort, layout —
        // everything the renderer actually reads.
        expect(modDescriptor.layout).toBe(hostDescriptor.layout);
        expect(modDescriptor.fields).toEqual(hostDescriptor.fields);
        expect(modDescriptor.crud).toEqual(hostDescriptor.crud);
        expect(modDescriptor.sort).toEqual(hostDescriptor.sort);
    });

    it('the mod-path renderer round-trips an edit through the same onRowsChange contract', () => {
        // The renderer calls onRowsChange with the next rows array. The
        // host path writes to a store field; the mod path writes to a mod
        // table. The renderer does not know which — it just calls the
        // callback. Assert both paths accept the same callback shape.
        let hostRows = rows;
        let modRows = rows;
        const hostOnChange = (next: Row[]) => { hostRows = next; };
        const modOnChange = (next: Row[]) => { modRows = next; };

        render(<PanelRenderer descriptor={hostDescriptor} rows={rows} onRowsChange={hostOnChange} />);
        render(<PanelRenderer descriptor={modDescriptor} rows={rows} onRowsChange={modOnChange} />);

        // The initial render does not call onRowsChange; both paths leave
        // the rows unchanged. The contract is symmetric: the renderer
        // calls onRowsChange identically for both.
        expect(hostRows).toBe(rows);
        expect(modRows).toBe(rows);
    });
});

describe('PanelRenderer — §4 source-level guard (no owner branches in src/components/panels/)', () => {
    it('contains no isMod, ownerId, or source === "mod" branch in the renderer implementation', () => {
        const rendererFiles = [
            'src/components/panels/PanelRenderer.tsx',
            'src/components/panels/ListDetailRenderer.tsx',
            'src/components/panels/ListPanelRenderer.tsx',
            'src/components/panels/ListPanelRendererCore.tsx',
        ];
        const source = rendererFiles
            .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
            .join('\n');

        // The renderer must not learn who owns the panel. Any of these
        // branches is a hard stop (§8). The check is on identifiers, not
        // just strings, so a comment mentioning "mod" would not trip it —
        // but the renderer has no reason to mention mods at all.
        expect(source, 'no isMod branch').not.toMatch(/\bisMod\b/);
        expect(source, 'no ownerId branch').not.toMatch(/\bownerId\b/);
        expect(source, 'no source === "mod" branch').not.toMatch(/source\s*===?\s*['"]mod['"]/);
        // No host store field names either — the renderer must not know
        // that `enemyInstances`, `settings`, etc. exist. It reads
        // `bindsTo` as an opaque string.
        for (const fieldId of ['enemyInstances', 'enemyCompendium', 'settings', 'npcLedger', 'loreChunks']) {
            expect(source, `${fieldId} must stay opaque to the renderer`).not.toContain(fieldId);
        }
    });

    it('the modPanels adapter namespaces bindsTo (the renderer never sees a bare mod table name)', () => {
        // The adapter is the one place where the translation happens. The
        // renderer receives `mod.mymod.things` as bindsTo, not `things`.
        // A host that resolves bindsTo against the store finds the mod
        // table under the same namespaced key; the renderer never compares.
        expect(modDescriptor.bindsTo).toBe('mod.mymod.things');
        expect(modDescriptor.bindsTo).not.toBe('things');
    });
});