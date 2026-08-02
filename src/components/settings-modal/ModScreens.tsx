/**
 * WO-P5-17 Step 5 — render a mod's declared screens inside the Extensions tab.
 *
 * Each installed mod that declares `screens[]` gets one ScreenFrame per
 * declaration, nested under the mod that declared it (R4 of WO-P5-16
 * already ruled that mod UI lives nested in Extensions; a screen does not
 * change that). The frame is `sandbox="allow-scripts"` with no
 * same-origin capability (R1); the screen source ships as text and the
 * server never evaluates it (R2); the CSP `default-src 'none'` leaves the
 * frame no network (R3); one frame per screen, destroyed on unmount (R4);
 * a fault surfaces on the Extensions fault list (R5); no host API in 5.1
 * — the frame receives nothing and sends nothing (R6).
 *
 * The `onFault` callback feeds `screenFaultStore`, which the Extensions
 * tab subscribes to (Step 3). A faulted screen shows a fault card in
 * place of the frame; the app keeps running.
 */
import { useCallback } from 'react';
import type { ValidatedMod } from '../../services/mods/modTypes';
import { screenFaultStore, formatScreenFaultReason, type ScreenFaultKind } from '../../services/mods/screenFaults';
import { ScreenFrame } from './ScreenFrame';

export function ModScreens({ mods }: { mods: readonly ValidatedMod[] }) {
    // Build the (mod, screen, source) list once per render. A mod with no
    // screens contributes nothing; a mod with screens contributes one
    // entry per screen. The source text is paired with the declaration by
    // index (the server carries `screenSources[i]` for `screens[i]`).
    const entries: Array<{ modId: string; modName: string; screen: ValidatedMod['screens'][number]; source: string }> = [];
    for (const mod of mods) {
        if (!Array.isArray(mod.screens) || !Array.isArray(mod.screenSources)) continue;
        for (let i = 0; i < mod.screens.length; i += 1) {
            // Defensive: the server pairs screens[i] with screenSources[i],
            // but these objects arrive over HTTP. A missing source is a
            // server-side pairing failure; skip the screen rather than
            // mount a frame with an empty document.
            const source = mod.screenSources[i];
            if (typeof source !== 'string' || source.length === 0) continue;
            entries.push({
                modId: mod.id,
                modName: mod.name,
                screen: mod.screens[i],
                source,
            });
        }
    }

    const onFault = useCallback((fault: { modId: string; screenId: string; kind: ScreenFaultKind; message: string }) => {
        const mod = mods.find((m) => m.id === fault.modId);
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
            {entries.map(({ modId, modName, screen, source }) => (
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
                        onFault={onFault}
                    />
                </div>
            ))}
        </div>
    );
}