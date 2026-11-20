import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { API_BASE } from '../../lib/apiBase';
import { useTranslation } from '../../i18n/useTranslation';
import { toast } from '../Toast';

/** Mirrors `getEmbeddingModelStatus` in server/services/embeddingModelService.js. */
export type EmbeddingModelStatus = {
    selected: string;
    active: string;
    defaultKey: string;
    models: { key: string; id: string; dims: number; approxDownloadMB: number; downloaded: boolean }[];
    download: { key: string | null; state: 'idle' | 'downloading' | 'done' | 'failed'; loaded: number; total: number; error: string | null };
    reindex: { state: 'idle' | 'running' | 'done' | 'failed'; done: number; total: number; error: string | null };
};

const POLL_MS = 1000;
// Decimal MB, matching the registry's approxDownloadMB.
const mb = (bytes: number) => (bytes / 1e6).toFixed(0);

/**
 * Settings → Advanced: pick the model semantic recall runs on. English is built in;
 * Multilingual downloads on request, then every campaign re-indexes on the server.
 * While a download or re-index runs this polls the server for progress.
 */
export function EmbeddingModelSection({ detail }: { detail?: string }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<EmbeddingModelStatus | null>(null);
    const [choice, setChoice] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastReindexState = useRef<string | null>(null);

    const refresh = useCallback(async (): Promise<EmbeddingModelStatus | null> => {
        try {
            const res = await fetch(`${API_BASE}/embedding/model`);
            if (!res.ok) return null;
            const next = (await res.json()) as EmbeddingModelStatus;
            setStatus(next);
            return next;
        } catch {
            return null;
        }
    }, []);

    // Poll while something is in flight; stop once idle.
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            const next = await refresh();
            if (cancelled || !next) return;
            const prev = lastReindexState.current;
            lastReindexState.current = next.reindex.state;
            if (prev === 'running' && next.reindex.state === 'done') toast.success(t('settings.embeddingModel.reindexDone'));
            if (next.download.state === 'downloading' || next.reindex.state === 'running') {
                timer.current = setTimeout(tick, POLL_MS);
            }
        };
        void tick();
        return () => {
            cancelled = true;
            if (timer.current) clearTimeout(timer.current);
        };
        // Re-arm after a submit starts something new.
    }, [refresh, submitting, t]);

    if (!status) return null;

    const downloading = status.download.state === 'downloading';
    const selected = (downloading ? status.download.key : null) ?? choice ?? status.active;
    const multilingual = status.models.find(m => m.key === 'multilingual');
    const reindexing = status.reindex.state === 'running';
    const busy = downloading || reindexing || submitting;
    const target = status.models.find(m => m.key === selected);
    const needsDownload = !!target && target.key !== status.defaultKey && !target.downloaded;

    const label = (key: string) => {
        if (key === 'english') return t('settings.embeddingModel.english');
        if (key === 'multilingual') {
            return multilingual?.downloaded
                ? t('settings.embeddingModel.multilingualReady')
                : t('settings.embeddingModel.multilingual', { size: String(multilingual?.approxDownloadMB ?? '') });
        }
        return key;
    };

    const apply = async () => {
        setSubmitting(true);
        try {
            const res = await fetch(`${API_BASE}/embedding/model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: selected }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(t('settings.embeddingModel.error', { error: body?.error ?? res.statusText }));
                return;
            }
            if (body?.result === 'switched') toast.info(t('settings.embeddingModel.switched'));
            setChoice(null);
        } catch (err) {
            toast.error(t('settings.embeddingModel.error', { error: err instanceof Error ? err.message : String(err) }));
        } finally {
            setSubmitting(false);
        }
    };

    const dl = status.download;
    // Files report their size only as each starts, so the small tokenizer can look
    // like the whole download; never show less than the registry's estimate.
    const estimate = (status.models.find(m => m.key === dl.key)?.approxDownloadMB ?? 0) * 1e6;
    const dlTotal = Math.max(dl.total, dl.state === 'downloading' ? estimate : 0);
    const pct = dlTotal > 0 ? Math.min(100, Math.round((dl.loaded / dlTotal) * 100)) : null;

    return (
        <div className="bg-void p-4 border border-border rounded space-y-3">
            <div>
                <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                    {t('settings.embeddingModel.title')}
                </label>
                <p className="text-[10px] text-text-dim leading-tight">{t('settings.embeddingModel.help')}</p>
            </div>

            <div className="space-y-1.5" role="radiogroup" aria-label={t('settings.embeddingModel.title')}>
                {status.models.map(m => (
                    <label
                        key={m.key}
                        className={`border rounded p-2.5 flex items-center gap-2 cursor-pointer ${selected === m.key ? 'border-terminal/50 bg-terminal/5' : 'border-border'} ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                        <input
                            type="radio"
                            name="embedding-model"
                            value={m.key}
                            checked={selected === m.key}
                            disabled={busy}
                            onChange={() => setChoice(m.key)}
                        />
                        <div className="flex-1">
                            <div className="text-[11px] font-bold text-text-primary">{label(m.key)}</div>
                            <div className="text-[9px] text-text-dim">
                                {m.id.split('/').pop()} · {m.dims}-dim
                                {m.key === status.active && detail ? ` · ${detail}` : ''}
                            </div>
                        </div>
                        {m.key === status.active && (
                            <span className="text-[9px] text-terminal font-bold uppercase">{t('settings.embeddingModel.active')}</span>
                        )}
                    </label>
                ))}
            </div>

            {selected !== status.active && !busy && (
                <button
                    onClick={() => void apply()}
                    className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 flex items-center gap-1.5"
                >
                    {needsDownload ? <Download size={10} /> : <RefreshCw size={10} />}
                    {needsDownload ? t('settings.embeddingModel.download') : t('settings.embeddingModel.switch')}
                </button>
            )}

            {downloading && (
                <div className="space-y-1">
                    <div className="text-[10px] text-terminal flex items-center gap-1.5">
                        <Loader2 size={10} className="animate-spin" />
                        {dlTotal > 0
                            ? t('settings.embeddingModel.downloading', { loaded: mb(dl.loaded), total: mb(dlTotal) })
                            : t('settings.embeddingModel.downloadStarting')}
                    </div>
                    <div className="h-1 bg-terminal/15 rounded-full overflow-hidden">
                        <div className="h-full bg-terminal/70 transition-all duration-500" style={{ width: `${pct ?? 0}%` }} />
                    </div>
                </div>
            )}

            {dl.state === 'failed' && !downloading && (
                <p className="text-[10px] text-amber-400">{t('settings.embeddingModel.downloadFailed', { error: dl.error ?? '' })}</p>
            )}

            {reindexing && (
                <div className="text-[10px] text-terminal flex items-center gap-1.5">
                    <Loader2 size={10} className="animate-spin" />
                    {t('settings.embeddingModel.reindexing', { done: String(status.reindex.done), total: String(status.reindex.total) })}
                </div>
            )}

            {status.reindex.state === 'failed' && (
                <p className="text-[10px] text-amber-400">{t('settings.embeddingModel.reindexFailed', { error: status.reindex.error ?? '' })}</p>
            )}

            <p className="text-[9px] text-text-dim italic">{t('settings.embeddingModel.reindexNote')}</p>
        </div>
    );
}
