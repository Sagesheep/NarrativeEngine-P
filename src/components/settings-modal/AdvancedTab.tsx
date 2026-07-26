import { useState, useEffect, useRef } from 'react';
import { Loader2, RefreshCw, Volume2, Download, Square } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getEmbeddingStatus, runBackfill } from '../../services/archive-memory/backfillRunner';
import { api } from '../../services/llm/apiClient';
import { API_BASE } from '../../lib/apiBase';
import { toast } from '../Toast';
import type { BackfillStatus } from '../../services/archive-memory/backfillRunner';
import { generateTts, getTtsStatus, initTtsModel, type TtsStatus } from '../../services/tts/ttsClient';

type EmbedderInfo = {
    modelId: string;
    dims: number;
    embeddingVersion: number;
};

const DEFAULT_TTS_PREVIEW_TEXT = 'The rain settles over the road as a distant bell marks the turning of the hour.';

export function AdvancedTab() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);

    const [embedderInfo, setEmbedderInfo] = useState<EmbedderInfo | null>(null);
    const [embedStatus, setEmbedStatus] = useState<BackfillStatus | null>(null);
    const [reindexing, setReindexing] = useState(false);
    const [reindexStatus, setReindexStatus] = useState('');
    const [rebuildingRules, setRebuildingRules] = useState(false);

    // TTS (Kokoro) state
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null);
    const [ttsIniting, setTtsIniting] = useState(false);
    const [ttsPolling, setTtsPolling] = useState(false);
    const [ttsPreviewText, setTtsPreviewText] = useState(DEFAULT_TTS_PREVIEW_TEXT);
    const [ttsPreviewing, setTtsPreviewing] = useState(false);
    const ttsPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const ttsPreviewAudio = useRef<HTMLAudioElement | null>(null);
    const TTS_VOICES = [
        { id: 'af_heart', label: 'Heart (F, warm)' },
        { id: 'af_bella', label: 'Bella (F, expressive)' },
        { id: 'af_nicole', label: 'Nicole (F, headphones)' },
        { id: 'af_sarah', label: 'Sarah (F)' },
        { id: 'am_michael', label: 'Michael (M)' },
        { id: 'am_puck', label: 'Puck (M, dynamic)' },
        { id: 'am_onyx', label: 'Onyx (M)' },
        { id: 'bf_emma', label: 'Emma (F, British)' },
        { id: 'bm_george', label: 'George (M, British)' },
    ];

    useEffect(() => {
        let cancelled = false;
        fetch(`${API_BASE}/embeddings/info`)
            .then(res => res.ok ? res.json() : null)
            .then(info => { if (!cancelled && info) setEmbedderInfo(info); })
            .catch(() => { /* best-effort */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!activeCampaignId) {
            setEmbedStatus(null);
            return;
        }
        let cancelled = false;
        getEmbeddingStatus(activeCampaignId)
            .then(status => { if (!cancelled) setEmbedStatus(status); })
            .catch(() => { if (!cancelled) setEmbedStatus(null); });
        return () => { cancelled = true; };
    }, [activeCampaignId, reindexing]);

    const handleReindex = async () => {
        if (!activeCampaignId) {
            toast.error('No active campaign');
            return;
        }
        setReindexing(true);
        setReindexStatus('Re-indexing...');
        try {
            const result = await runBackfill(activeCampaignId, 'all', (msg) => setReindexStatus(msg));
            setEmbedStatus(result.status);
            toast.success(`Re-indexed ${result.reindexedScenes} scenes, ${result.reindexedLore} lore chunks`);
        } catch (err) {
            toast.error(`Re-index failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setReindexing(false);
            setReindexStatus('');
        }
    };

    const handleRebuildRules = async () => {
        if (!activeCampaignId) {
            toast.error('No active campaign');
            return;
        }
        setRebuildingRules(true);
        try {
            toast.info('Rebuilding rules embeddings...');
            const res = await api.rules.reindex(activeCampaignId);
            if (res) {
                toast.success(`Successfully rebuilt ${res.totalChunks} rule chunks`);
            } else {
                toast.error('Rebuild failed');
            }
        } catch (err) {
            toast.error(`Rebuild failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setRebuildingRules(false);
        }
    };

    // ── TTS (Kokoro) ──
    const refreshTtsStatus = async () => {
        try {
            const status = await getTtsStatus();
            setTtsStatus(status);
            return status;
        } catch {
            return null;
        }
    };

    const startTtsPolling = () => {
        if (ttsPollTimer.current) return;
        setTtsPolling(true);
        ttsPollTimer.current = setInterval(() => {
            getTtsStatus().then(s => {
                setTtsStatus(s);
                if (s.modelReady) {
                    if (ttsPollTimer.current) clearInterval(ttsPollTimer.current);
                    ttsPollTimer.current = null;
                    setTtsPolling(false);
                    setTtsIniting(false);
                    toast.success('Kokoro TTS model ready');
                }
            }).catch(() => {});
        }, 2000);
    };

    const stopTtsPreview = () => {
        const audio = ttsPreviewAudio.current;
        if (!audio) return;
        const url = audio.src;
        audio.pause();
        audio.src = '';
        ttsPreviewAudio.current = null;
        if (url) URL.revokeObjectURL(url);
        setTtsPreviewing(false);
    };

    useEffect(() => {
        const startup = window.setTimeout(() => {
            void refreshTtsStatus().then(status => {
                if (status?.modelCached && !status.modelReady) startTtsPolling();
            });
        }, 0);
        return () => {
            window.clearTimeout(startup);
            if (ttsPollTimer.current) clearInterval(ttsPollTimer.current);
            stopTtsPreview();
        };
    }, []);

    const handleTtsDownload = async () => {
        setTtsIniting(true);
        startTtsPolling();
        try {
            await initTtsModel();
            refreshTtsStatus();
            toast.success('Kokoro TTS model downloaded');
        } catch (err) {
            toast.error(`TTS download failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
            setTtsIniting(false);
            setTtsPolling(false);
            if (ttsPollTimer.current) { clearInterval(ttsPollTimer.current); ttsPollTimer.current = null; }
        }
    };

    const handleTtsPreview = async () => {
        if (ttsPreviewing) {
            stopTtsPreview();
            return;
        }
        const text = ttsPreviewText.trim();
        if (!text) {
            toast.error('Enter a sentence to preview this voice');
            return;
        }
        setTtsPreviewing(true);
        try {
            const blob = await generateTts(text, settings.ttsVoice ?? 'af_heart');
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            ttsPreviewAudio.current = audio;
            const finish = () => {
                if (ttsPreviewAudio.current === audio) {
                    ttsPreviewAudio.current = null;
                    setTtsPreviewing(false);
                }
                URL.revokeObjectURL(url);
            };
            audio.onended = finish;
            audio.onerror = finish;
            await audio.play();
        } catch (err) {
            setTtsPreviewing(false);
            toast.error('Voice preview failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
        }
    };

    const ttsReady = !!ttsStatus?.modelReady;
    const ttsCached = !!ttsStatus?.modelCached;

    return (
        <div className="space-y-6">
            <label className="text-text-dim text-xs uppercase tracking-widest font-bold block">Advanced</label>

            {/* Kokoro TTS — local text-to-speech for GM narration */}
            <div className="bg-void p-4 border border-border rounded space-y-3">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1 flex items-center gap-1.5">
                        <Volume2 size={11} /> Text-to-Speech (Kokoro)
                    </label>
                    <p className="text-[9px] text-text-dim max-w-[320px] leading-tight">
                        Local neural TTS for GM narration. ~90MB one-time download (q8), runs fully offline.
                        Not bundled — opt in here. A speaker icon appears on GM messages once ready.
                    </p>
                </div>

                {/* Status pill */}
                <div className="border border-terminal/30 bg-terminal/5 rounded p-3 flex items-center justify-between">
                    <div>
                        <div className="text-[11px] font-bold text-text-primary">
                            {ttsStatus?.modelId?.split('/').pop() ?? 'Kokoro-82M'}
                        </div>
                        <div className="text-[9px] text-text-dim">
                            {ttsReady
                                ? `Ready · voice: ${ttsStatus?.voice}`
                                : ttsIniting || ttsPolling
                                    ? 'Downloading / warming up...'
                                    : ttsCached
                                        ? 'Installed / warming up...'
                                        : 'Not downloaded'}
                        </div>
                    </div>
                    <span className={`text-[9px] font-bold uppercase ${ttsReady ? 'text-terminal' : 'text-text-dim'}`}>
                        {ttsReady ? 'Ready' : ttsCached ? 'Installed' : 'Idle'}
                    </span>
                </div>

                {/* Download / init button — shown until ready */}
                {!ttsReady && (
                    <button
                        disabled={ttsIniting || ttsPolling}
                        onClick={handleTtsDownload}
                        className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                        {ttsIniting || ttsPolling ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                        {ttsIniting || ttsPolling ? 'Downloading...' : ttsCached ? 'Warm Up Model' : 'Download Model'}
                    </button>
                )}

                {/* Toggle + voice picker — shown once ready */}
                {ttsReady && (
                    <>
                        <label className="flex items-center gap-2 text-[10px] text-text-primary cursor-pointer">
                            <input
                                type="checkbox"
                                checked={!!settings.ttsEnabled}
                                onChange={e => updateSettings({ ttsEnabled: e.target.checked })}
                                className="accent-terminal"
                            />
                            <span className="uppercase tracking-wider">Read GM replies aloud (speaker button)</span>
                        </label>

                        <div>
                            <label className="block text-[9px] text-text-dim uppercase tracking-wider mb-1">Voice</label>
                            <select
                                value={settings.ttsVoice ?? 'af_heart'}
                                onChange={e => updateSettings({ ttsVoice: e.target.value })}
                                className="bg-void-darker border border-border text-text-primary text-[11px] px-2 py-1 rounded outline-none focus:border-terminal w-full"
                            >
                                {TTS_VOICES.map(v => (
                                    <option key={v.id} value={v.id}>{v.label}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label htmlFor="tts-preview-text" className="block text-[9px] text-text-dim uppercase tracking-wider mb-1">Voice preview</label>
                            <textarea
                                id="tts-preview-text"
                                value={ttsPreviewText}
                                onChange={e => setTtsPreviewText(e.target.value)}
                                maxLength={300}
                                rows={2}
                                className="bg-void-darker border border-border text-text-primary text-[11px] px-2 py-1.5 rounded outline-none focus:border-terminal w-full resize-y"
                            />
                            <button
                                type="button"
                                onClick={() => void handleTtsPreview()}
                                disabled={!ttsPreviewText.trim()}
                                className="mt-2 text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                            >
                                {ttsPreviewing ? <Square size={10} /> : <Volume2 size={10} />}
                                {ttsPreviewing ? 'Stop Preview' : 'Preview Voice'}
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Active embedder — read-only on desktop (single server-side model) */}
            <div className="bg-void p-4 border border-border rounded space-y-3">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Embedding Model</label>
                    <p className="text-[10px] text-text-dim leading-tight">
                        mainApp runs embeddings server-side with a single bundled model. Switching is not supported here (unlike the mobile on-device build).
                    </p>
                </div>
                <div className="border border-terminal/30 bg-terminal/5 rounded p-3 flex items-center justify-between">
                    <div>
                        <div className="text-[11px] font-bold text-text-primary">
                            {embedderInfo ? embedderInfo.modelId.split('/').pop() : '—'}
                        </div>
                        <div className="text-[9px] text-text-dim">
                            {embedderInfo
                                ? `${embedderInfo.dims}-dim · server-side · v${embedderInfo.embeddingVersion}`
                                : 'Loading…'}
                        </div>
                    </div>
                    <span className="text-[9px] text-terminal font-bold uppercase">Active</span>
                </div>
            </div>

            {/* Re-index embeddings */}
            <div className="bg-void p-4 border border-border rounded space-y-2">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        Re-index Embeddings
                    </label>
                    <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
                        Re-embeds stale or unversioned scene and lore vectors. Use after changing embedding models or if semantic search seems off.
                    </p>
                </div>
                <button
                    disabled={reindexing || !activeCampaignId}
                    onClick={handleReindex}
                    className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                    {reindexing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    {reindexing ? (reindexStatus || 'Re-indexing...') : 'Re-index Now'}
                </button>
                {embedStatus && !reindexing && (
                    <div className="text-[9px] text-text-dim">
                        Scenes: {embedStatus.scenes.current}/{embedStatus.scenes.total} current · Lore: {embedStatus.lore.current}/{embedStatus.lore.total} current
                        {embedStatus.scenes.stale > 0 && ` · ${embedStatus.scenes.stale + embedStatus.lore.stale} stale`}
                        {` (v${embedStatus.version})`}
                    </div>
                )}
                {!activeCampaignId && (
                    <p className="text-[9px] text-text-dim italic">Open a campaign to re-index its embeddings.</p>
                )}
            </div>

            {/* Rebuild rules embeddings */}
            <div className="bg-void p-4 border border-border rounded space-y-2">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        Rebuild Rules Embeddings
                    </label>
                    <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
                        Manually parse and re-embed rules markdown.
                    </p>
                </div>
                <button
                    disabled={rebuildingRules || !activeCampaignId}
                    onClick={handleRebuildRules}
                    className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                    {rebuildingRules ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    {rebuildingRules ? 'Rebuilding...' : 'Rebuild Now'}
                </button>
            </div>
        </div>
    );
}