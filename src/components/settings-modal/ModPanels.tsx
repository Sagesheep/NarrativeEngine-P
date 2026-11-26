/**
 * WO-P5-16 Step 4 — render a mod's declared panels inside the Extensions tab.
 *
 * Each installed mod that declares `panels[]` gets one section per panel,
 * nested under the mod that declared it (R4: launch is always `nested`).
 * The host resolves `bindsTo` against the store's `modTables` map; the
 * generic `PanelRenderer` receives rows and a descriptor and cannot tell
 * a mod panel from a host panel (§4 — the renderer must not learn who owns
 * the panel).
 *
 * Edits round-trip to disk through the store's `setModTable`, which
 * fire-and-forgets a PUT to `/api/campaigns/:id/mod-tables/:table` (the
 * same path the Arc mod uses for `mod.arc.arcs`). An edit here is the gate
 * test: type a value, reload, the value is still there.
 */
import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ValidatedMod } from '../../services/mods/modTypes';
import { modPanelToDescriptor } from '../../services/mods/modPanels';
import { modTableName } from '../../services/mods/modTables';
import { PanelRenderer } from '../panels/PanelRenderer';

type PanelRow = Record<string, unknown>;

export function ModPanels({ mods }: { mods: readonly ValidatedMod[] }) {
    const modTables = useAppStore((s) => s.modTables);
    const setModTable = useAppStore((s) => s.setModTable);

    // Build the (modId, panel) list once per render. A mod with no panels
    // contributes nothing; a mod with panels contributes one entry per panel.
    const entries = useMemo(() => {
        const out: Array<{ modId: string; modName: string; panelId: string; panelLabel: string }> = [];
        for (const mod of mods) {
            if (!Array.isArray(mod.panels)) continue;
            for (const panel of mod.panels) {
                out.push({
                    modId: mod.id,
                    modName: mod.name,
                    panelId: panel.id,
                    panelLabel: panel.fields[0]?.label ?? panel.id,
                });
            }
        }
        return out;
    }, [mods]);

    if (entries.length === 0) return null;

    return (
        <div className="space-y-4">
            <div>
                <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                    Mod panels
                </label>
                <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                    Panels declared by installed mods. Each panel edits the mod's own table; edits save to disk.
                </p>
            </div>
            {entries.map(({ modId, modName, panelId, panelLabel }) => {
                const mod = mods.find((m) => m.id === modId);
                if (!mod) return null;
                const panel = mod.panels.find((p) => p.id === panelId);
                if (!panel) return null;
                const descriptor = modPanelToDescriptor(modId, panel);
                const tableKey = modTableName(modId, panel.bindsTo);
                // The store holds mod tables as `unknown`. An array table is
                // a row array; a single-object table is one record. The
                // renderer's list layout takes an array; the form layout
                // (used for single-object tables per R5) takes a one-row
                // array and the host wraps the single row.
                const raw = modTables[tableKey];
                const rows: PanelRow[] = panel.layout === 'form'
                    ? (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw as PanelRow])
                    : Array.isArray(raw) ? raw as PanelRow[] : [];
                return (
                    <div
                        key={`${modId}.${panelId}`}
                        className="bg-void p-3 border border-border rounded"
                        data-mod-panel={modId}
                    >
                        <div className="flex items-baseline gap-2 mb-2">
                            <span className="chrome-label text-[10px] text-text-primary uppercase tracking-wider font-bold">
                                {modName}
                            </span>
                            <span className="text-[9px] text-text-dim">·</span>
                            <span className="text-[10px] text-text-dim">{panelLabel}</span>
                        </div>
                        <PanelRenderer
                            descriptor={descriptor}
                            rows={rows}
                            getRowKey={(row, index) => {
                                // Prefer an `id` field if the row carries one;
                                // fall back to the index. The renderer uses
                                // this as React's `key`, nothing more.
                                const candidate = (row as PanelRow).id;
                                return typeof candidate === 'string' ? candidate : String(index);
                            }}
                            onRowsChange={(nextRows) => {
                                // For a `form` layout over a single-object
                                // table, the renderer produces a one-row
                                // array; the store holds one record. Write
                                // back the single record, not the array.
                                if (panel.layout === 'form') {
                                    setModTable(tableKey, nextRows[0] ?? null);
                                } else {
                                    setModTable(tableKey, nextRows);
                                }
                            }}
                        />
                    </div>
                );
            })}
        </div>
    );
}