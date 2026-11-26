import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import {
    applyAiSummaries,
    buildLoreIndexText,
    chunksNeedingAiIndex,
    hasFreshAiSummary,
    isIndexedLore,
    LORE_SHORTLIST_SIZE,
    MAX_LORE_SHORTLIST_TOKENS,
    MIN_LORE_SHORTLIST_TOKENS,
    normalizeLoreShortlistTokens,
} from '../../services/lore/loreAiIndex';
import { runAiLoreIndexing, utilityAiIndexCall, type AiIndexProgress } from '../../services/lore/loreAiIndexRunner';
import { countTokens } from '../../services/infrastructure/tokenizer';

/**
 * Lore tab: the AI index switches. "Use AI index" makes the Context Recommender read the
 * AI-written line for each entry; "Run AI indexing" writes the missing or outdated lines;
 * the shortlist sends only the top keyword matches once the index passes a token limit.
 */
export function LoreAiIndexPanel({ campaignId }: { campaignId: string }) {
    const loreChunks = useAppStore(s => s.loreChunks);
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const hasUtility = useAppStore(s => !!s.getActiveUtilityEndpoint()?.endpoint);

    const [progress, setProgress] = useState<AiIndexProgress | null>(null);
    const [running, setRunning] = useState(false);
    const [message, setMessage] = useState('');
    const abortRef = useRef<AbortController | null>(null);

    const useAi = !!settings.aiLoreIndex;
    const shortlistOn = !!settings.aiLoreShortlist;
    const tokenLimit = normalizeLoreShortlistTokens(settings.aiLoreShortlistTokens);
    const [limitDraft, setLimitDraft] = useState(String(tokenLimit));

    const eligible = loreChunks.filter(isIndexedLore).length;
    const fresh = loreChunks.filter(c => isIndexedLore(c) && hasFreshAiSummary(c)).length;
    const needing = chunksNeedingAiIndex(loreChunks).length;
    const indexTokens = useMemo(
        () => countTokens(buildLoreIndexText(loreChunks, { useAiSummaries: useAi }).text),
        [loreChunks, useAi],
    );
    const wouldShortlist = shortlistOn && eligible > LORE_SHORTLIST_SIZE && indexTokens > tokenLimit;

    const run = async () => {
        const endpoint = useAppStore.getState().getActiveUtilityEndpoint();
        if (!endpoint?.endpoint) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        setMessage('');
        let campaignChanged = false;
        try {
            const result = await runAiLoreIndexing({
                chunks: useAppStore.getState().loreChunks,
                call: utilityAiIndexCall(endpoint),
                signal: controller.signal,
                onProgress: setProgress,
                onBatch: (lines, hashes) => {
                    const state = useAppStore.getState();
                    if (state.activeCampaignId !== campaignId) {
                        campaignChanged = true;
                        controller.abort();
                        return;
                    }
                    const next = applyAiSummaries(state.loreChunks, lines, hashes);
                    if (next !== state.loreChunks) state.setLoreChunks(next);
                },
            });
            if (campaignChanged) setMessage('Stopped: the active campaign changed.');
            else if (controller.signal.aborted) setMessage(`Stopped. ${result.written} entries indexed.`);
            else if (result.failedBatches > 0) setMessage(`${result.written} entries indexed. ${result.failedBatches} batch(es) failed; run again to retry them.`);
            else setMessage(`${result.written} entries indexed.`);
        } finally {
            abortRef.current = null;
            setRunning(false);
            setProgress(null);
        }
    };

    const commitLimit = () => {
        const n = normalizeLoreShortlistTokens(Number(limitDraft));
        setLimitDraft(String(n));
        if (n !== tokenLimit) updateSettings({ aiLoreShortlistTokens: n });
    };

    const switchRow = 'flex items-start gap-2 text-[11px] text-text-primary cursor-pointer';
    const hint = 'block text-[11px] text-text-dim leading-snug';

    return (
        <section className="border border-border rounded p-3 space-y-3 bg-void/40" aria-label="AI lore index">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 className="text-[11px] uppercase tracking-wider font-bold text-text-primary">AI lore index</h3>
                <span className="text-[11px] text-text-dim">
                    {fresh} of {eligible} entries indexed · index ≈{indexTokens.toLocaleString()} tk
                </span>
            </div>

            <label className={switchRow}>
                <input
                    type="checkbox"
                    role="switch"
                    checked={useAi}
                    onChange={e => updateSettings({ aiLoreIndex: e.target.checked })}
                    className="mt-0.5 accent-terminal"
                />
                <span>
                    Use AI index
                    <span className={hint}>
                        The Context Recommender reads an AI-written line for each entry (what it covers, when it matters) instead of its first line.
                        Entries without a line, or edited since, use their first line.
                    </span>
                </span>
            </label>

            <div className="flex items-center gap-2 flex-wrap">
                {running ? (
                    <button
                        onClick={() => abortRef.current?.abort()}
                        className="px-3 py-1.5 text-[11px] uppercase tracking-wider border border-danger/50 text-danger rounded hover:bg-danger/10"
                    >
                        Stop
                    </button>
                ) : (
                    <button
                        onClick={() => void run()}
                        disabled={!hasUtility || needing === 0}
                        className="px-3 py-1.5 text-[11px] uppercase tracking-wider border border-terminal/40 text-terminal rounded hover:bg-terminal/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Run AI indexing
                    </button>
                )}
                <span className="text-[11px] text-text-dim" role="status">
                    {running && progress
                        ? `Indexing ${progress.done} of ${progress.total}…`
                        : !hasUtility
                            ? 'Needs a utility AI endpoint (Settings).'
                            : message || (needing === 0 ? 'All entries are indexed.' : `${needing} entries to index.`)}
                </span>
            </div>

            <label className={switchRow}>
                <input
                    type="checkbox"
                    role="switch"
                    checked={shortlistOn}
                    onChange={e => updateSettings({ aiLoreShortlist: e.target.checked })}
                    className="mt-0.5 accent-terminal"
                />
                <span>
                    Shortlist the top {LORE_SHORTLIST_SIZE} when the index is large
                    <span className={hint}>
                        Over the token limit, the Recommender sees only the {LORE_SHORTLIST_SIZE} entries that best match the scene by keyword.
                        The rest can still be found by keyword and meaning search.
                    </span>
                </span>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-text-dim pl-5">
                Token limit
                <input
                    type="number"
                    min={MIN_LORE_SHORTLIST_TOKENS}
                    max={MAX_LORE_SHORTLIST_TOKENS}
                    step={500}
                    value={limitDraft}
                    disabled={!shortlistOn}
                    onChange={e => setLimitDraft(e.target.value)}
                    onBlur={commitLimit}
                    onKeyDown={e => { if (e.key === 'Enter') commitLimit(); }}
                    className="w-24 bg-surface border border-border rounded px-1.5 py-0.5 text-[11px] text-text-primary disabled:opacity-40"
                />
                <span>
                    {shortlistOn
                        ? wouldShortlist ? 'Shortlisting now.' : 'Under the limit: the full index is sent.'
                        : ''}
                </span>
            </label>
        </section>
    );
}
