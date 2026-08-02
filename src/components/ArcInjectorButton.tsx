import { useState, useRef, useEffect } from 'react';
import { Syringe, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { spawnArc, pickArcSpawnInput } from '../services/arc';
import { computeOpenThreads } from '../services/arc/openThreads';
import { toast } from './Toast';
import type { NPCPressure } from '../types';
import type { ArcRecord } from '../types/arc';

type Phase = 'idle' | 'loading' | 'success' | 'error';

/**
 * Arc Injector — manual trigger for the Arc Engine (System 2 / Oracle).
 *
 * The old "Create Trouble" button generated a 4-option A/B/C/D menu the player PICKED
 * from (predictable — the thing requirement #2 was built to kill). This fires ONE
 * auto-generated, laddered arc into context.arcs; the player prods the timing but does
 * NOT author the arc. It then surfaces gradually (ambient → rumor → direct) via the
 * existing runArcTick / arcDigest machinery. The press IS the spawn gate — there is no
 * automatic seam spawn and no arcWorldState check.
 *
 * Feedback is shown INLINE on the button (loading → success/error). The toast stays as
 * a secondary signal. On success the button shows a brief ✓ then resets; on error it
 * stays as ✗ so the player can retry.
 */
export function ArcInjectorButton({ onDone }: { onDone?: () => void } = {}) {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const [phase, setPhase] = useState<Phase>('idle');
    const resetTimer = useRef<number | null>(null);
    // Synchronous re-entry lock. `phase` is React state (async), so two taps in the same
    // tick could both pass the guard and spawn TWO arcs. This ref flips synchronously.
    const inFlight = useRef(false);

    // Clear any pending reset timer on unmount.
    useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

    const isStreaming = pipelinePhase !== 'idle';

    const handleClick = async () => {
        if (inFlight.current || phase === 'loading') return;
        const state = useAppStore.getState();

        const provider = state.getActiveStoryEndpoint?.();
        if (!provider) {
            toast.error('No Story AI configured. Set one in Settings → AI Providers.');
            return;
        }

        inFlight.current = true;
        setPhase('loading');
        try {
            // Swipe Generation v1 — commit any pending turn before injecting an
            // arc. The arc tick reads engine state (relation meters, witness
            // capture, arc/agency ticks) that the commit derives, so a deferred
            // commit must fire first or the arc would seed against stale state.
            const { commitPendingTurn } = await import('../services/turn/pendingCommit');
            await commitPendingTurn().catch(e => console.warn('[ArcInjector] commit failed:', e));

            const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt != null && !c.invalidated);
            const openThreads = computeOpenThreads(sealedChapters);
            const archiveIndex = state.archiveIndex ?? [];
            const nowScene = archiveIndex.length > 0
                ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
                : 0;
            const bornScene = archiveIndex.length > 0
                ? archiveIndex[archiveIndex.length - 1].sceneId
                : '000';

            const latestChapter = sealedChapters[sealedChapters.length - 1];
            const worldContext = latestChapter?.summary
                ? `Recently sealed chapter "${latestChapter.title}": ${latestChapter.summary}`
                : '';

            // Fallback anchor so a press always grounds on something: the last GM line.
            const lastGm = [...state.messages].reverse().find(m => m.role === 'assistant');
            const fallbackAnchorText = typeof lastGm?.content === 'string' ? lastGm.content : undefined;

            // Desktop stores NPC pressure inside each NPCEntry.pressure (per-NPC field),
            // not as a top-level Record<string, NPCPressure> like mobile. Rebuild the map
            // shape pickArcSpawnInput expects from the ledger.
            const npcLedger = state.npcLedger ?? [];
            const pressure: Record<string, NPCPressure> = {};
            for (const npc of npcLedger) {
                if (npc.pressure) pressure[npc.id] = npc.pressure;
            }

            const spawnInput = pickArcSpawnInput({
                arcs: (state.getModTable('mod.arc.arcs') as ArcRecord[] | undefined) ?? [],
                openThreads,
                pressure,
                npcLedger,
                worldContext,
                bornScene,
                nowScene,
                fallbackAnchorText,
            });

            if (!spawnInput) {
                toast.info('Nothing to anchor an arc to yet — play a little further first.');
                setPhase('idle');
                return;
            }

            const arc = await spawnArc({ provider, ...spawnInput });
            if (!arc) {
                toast.error('Arc generation failed — try again.');
                setPhase('error');
                resetTimer.current = window.setTimeout(() => setPhase('idle'), 2500);
                return;
            }

            const currentArcs = (state.getModTable('mod.arc.arcs') as ArcRecord[] | undefined) ?? [];
            state.setModTable('mod.arc.arcs', [...currentArcs, arc]);
            const activeCount = currentArcs.filter(a => a.status === 'active').length + 1;
            toast.success(`Arc injected — ${activeCount} now simmering. It will surface as the story unfolds.`);
            setPhase('success');
            resetTimer.current = window.setTimeout(() => { setPhase('idle'); onDone?.(); }, 1600);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to inject an arc');
            setPhase('error');
            resetTimer.current = window.setTimeout(() => setPhase('idle'), 2500);
        } finally {
            inFlight.current = false;
        }
    };

    const disabled = isStreaming || phase === 'loading' || phase === 'success';

    const styles: Record<Phase, string> = {
        idle: 'border-amber-500/50 text-amber-500 hover:bg-amber-500/5',
        loading: 'border-amber-500/50 text-amber-500',
        success: 'border-green-600 text-green-400 bg-green-900/30',
        error: 'border-danger text-danger bg-danger/15',
    };
    const label: Record<Phase, string> = {
        idle: 'INJECT ARC',
        loading: 'INJECTING…',
        success: 'INJECTED',
        error: 'FAILED — TAP TO RETRY',
    };
    const Icon = phase === 'loading' ? Loader2 : phase === 'success' ? Check : phase === 'error' ? AlertCircle : Syringe;

    return (
        <button
            onClick={handleClick}
            disabled={disabled}
            className={`shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:cursor-not-allowed whitespace-nowrap ${styles[phase]}`}
        >
            <Icon size={13} className={phase === 'loading' ? 'animate-spin' : ''} /> {label[phase]}
        </button>
    );
}