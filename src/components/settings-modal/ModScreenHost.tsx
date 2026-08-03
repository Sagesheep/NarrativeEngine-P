import { useCallback } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ValidatedMod, ValidatedModScreen } from '../../services/mods/modTypes';
import { modTableName } from '../../services/mods/modTables';
import { formatScreenFaultReason, screenFaultStore, type ScreenFaultKind } from '../../services/mods/screenFaults';
import { ScreenFrame } from './ScreenFrame';

/** Host-owned bridge shared by Extensions and declared prime-navigation launchers. */
export function ModScreenHost({
    mod,
    screen,
    source,
}: {
    mod: ValidatedMod;
    screen: ValidatedModScreen;
    source: string;
}) {
    const getModTable = useAppStore((state) => state.getModTable);
    const setModTable = useAppStore((state) => state.setModTable);

    const onFault = useCallback((fault: { modId: string; screenId: string; kind: ScreenFaultKind; message: string }) => {
        screenFaultStore.add({
            modId: fault.modId,
            screenId: fault.screenId,
            file: mod.file,
            kind: fault.kind,
            reason: formatScreenFaultReason({
                modName: mod.name,
                screenId: fault.screenId,
                kind: fault.kind,
                message: fault.message,
            }),
        });
    }, [mod.file, mod.name]);

    const onCampaignRead = useCallback((resource: string): unknown => {
        const state = useAppStore.getState();
        if (resource === 'characters') {
            const pc = state.context.playerCharacter;
            return [
                ...(pc ? [{
                    type: 'pc', id: pc.id, name: pc.name, archived: false,
                    abilities: pc.signatureKit?.abilities ?? [],
                }] : []),
                ...state.npcLedger.map((npc) => ({
                    type: 'npc', id: npc.id, name: npc.name, archived: npc.archived === true,
                    abilities: npc.signatureKit?.abilities ?? [],
                })),
            ];
        }
        if (resource === 'character-sheet') return state.characterProfileData ?? state.context.characterProfileData;
        if (resource === 'inventory') return state.inventoryItems ?? state.context.inventoryItems ?? [];
        if (resource === 'recent-play') {
            return state.messages.slice(-12).map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
            }));
        }
        return null;
    }, []);

    const onDownload = useCallback((filename: string, content: string): void => {
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    }, []);

    return (
        <ScreenFrame
            modId={mod.id}
            screen={screen}
            source={source}
            tables={mod.tables}
            onTableRead={(table) => getModTable(modTableName(mod.id, table))}
            onTableWrite={(table, value) => setModTable(modTableName(mod.id, table), value)}
            onCampaignRead={onCampaignRead}
            onDownload={onDownload}
            onFault={onFault}
        />
    );
}
