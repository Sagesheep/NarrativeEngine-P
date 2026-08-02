/**
 * WO-P5-17 / WO-P5-18 — render declared screens inside Extensions.
 *
 * The screen host owns the message boundary. This component supplies only
 * the declaring mod's validated table declarations and namespaced table
 * callbacks; no general app-store accessor crosses into the frame.
 */
import { useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ValidatedMod } from '../../services/mods/modTypes';
import { modTableName } from '../../services/mods/modTables';
import { formatScreenFaultReason, screenFaultStore, type ScreenFaultKind } from '../../services/mods/screenFaults';
import { ScreenFrame } from './ScreenFrame';

export function ModScreens({ mods }: { mods: readonly ValidatedMod[] }) {
    const getModTable = useAppStore((state) => state.getModTable);
    const setModTable = useAppStore((state) => state.setModTable);

    const onFault = useCallback((fault: { modId: string; screenId: string; kind: ScreenFaultKind; message: string }) => {
        const mod = mods.find((candidate) => candidate.id === fault.modId);
        screenFaultStore.add({
            modId: fault.modId,
            screenId: fault.screenId,
            file: mod?.file ?? `${fault.modId}.mod.json`,
            kind: fault.kind,
            reason: formatScreenFaultReason({
                modName: mod?.name ?? fault.modId,
                screenId: fault.screenId,
                kind: fault.kind,
                message: fault.message,
            }),
        });
    }, [mods]);

    const onTableRead = useCallback((modId: string, table: string): unknown => {
        return getModTable(modTableName(modId, table));
    }, [getModTable]);

    const onTableWrite = useCallback((modId: string, table: string, value: unknown): void => {
        setModTable(modTableName(modId, table), value);
    }, [setModTable]);

    const entries: Array<{
        modId: string;
        modName: string;
        screen: ValidatedMod['screens'][number];
        source: string;
        tables: ValidatedMod['tables'];
    }> = [];
    for (const mod of mods) {
        if (!Array.isArray(mod.screens) || !Array.isArray(mod.screenSources)) continue;
        for (let index = 0; index < mod.screens.length; index += 1) {
            const source = mod.screenSources[index];
            if (typeof source !== 'string' || source.length === 0) continue;
            entries.push({
                modId: mod.id,
                modName: mod.name,
                screen: mod.screens[index],
                source,
                tables: mod.tables,
            });
        }
    }

    if (entries.length === 0) return null;

    return (
        <div className="space-y-4">
            <div>
                <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                    Mod screens
                </label>
                <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                    Screens declared by installed mods. Each screen renders in an isolated frame with no access to the app's DOM, storage, or network.
                </p>
            </div>
            {entries.map(({ modId, modName, screen, source, tables }) => (
                <div
                    key={`${modId}.${screen.id}`}
                    className="bg-void p-3 border border-border rounded"
                    data-mod-screen={modId}
                >
                    <div className="flex items-baseline gap-2 mb-2">
                        <span className="chrome-label text-[10px] text-text-primary uppercase tracking-wider font-bold">
                            {modName}
                        </span>
                        <span className="text-[9px] text-text-dim">·</span>
                        <span className="text-[10px] text-text-dim">{screen.label ?? screen.id}</span>
                    </div>
                    <ScreenFrame
                        modId={modId}
                        screen={screen}
                        source={source}
                        tables={tables}
                        onTableRead={(table) => onTableRead(modId, table)}
                        onTableWrite={(table, value) => onTableWrite(modId, table, value)}
                        onFault={onFault}
                    />
                </div>
            ))}
        </div>
    );
}
