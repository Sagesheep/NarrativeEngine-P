import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, Plus, X, Globe } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/llm/apiClient';
import { queryTimeline } from '../../services/campaign-state/timelineResolver';
import { TIMELINE_PREDICATES } from '../../types';
import { toast } from '../Toast';

const PREDICATE_LIST = TIMELINE_PREDICATES as unknown as string[];

export const ResolvedStatePanel: React.FC = () => {
    const { timeline, activeCampaignId, chapters, setTimeline, addTimelineEvent, removeTimelineEvent } = useAppStore();

    const [collapsed, setCollapsed] = useState(true);
    const [filter, setFilter] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);
    const [form, setForm] = useState({
        subject: '',
        predicate: 'status',
        object: '',
        summary: '',
        importance: 5,
    });
    const [isAdding, setIsAdding] = useState(false);

    const allResolved = useMemo(
        () => queryTimeline(timeline, undefined),
        [timeline]
    );

    const resolved = useMemo(() => {
        if (!filter.trim()) return allResolved;
        const f = filter.toLowerCase();
        return allResolved.filter(e =>
            e.subject.toLowerCase().includes(f) ||
            e.object.toLowerCase().includes(f) ||
            (e.summary ?? '').toLowerCase().includes(f)
        );
    }, [allResolved, filter]);

    const displayed = collapsed ? resolved.slice(0, 10) : resolved;

    const handleDelete = async (eventId: string) => {
        if (!activeCampaignId) return;
        const ok = await api.timeline.remove(activeCampaignId, eventId);
        if (ok) {
            removeTimelineEvent(eventId);
        } else {
            toast.error('Failed to remove event');
        }
    };

    const handleAdd = async () => {
        if (!activeCampaignId || !form.subject.trim() || !form.object.trim()) return;

        setIsAdding(true);
        try {
            const openChapter = chapters.find(c => !c.sealedAt) || chapters[chapters.length - 1];
            const event = await api.timeline.add(activeCampaignId, {
                subject: form.subject.trim(),
                predicate: form.predicate as any,
                object: form.object.trim(),
                summary: form.summary.trim() || `${form.subject.trim()} ${form.predicate} ${form.object.trim()}`,
                importance: form.importance,
                sceneId: '000',
                chapterId: openChapter?.chapterId || 'CH00',
            });

            if (event) {
                addTimelineEvent(event);
                // Refresh full timeline to stay in sync
                const fresh = await api.timeline.get(activeCampaignId);
                setTimeline(fresh);
                setForm({ subject: '', predicate: 'status', object: '', summary: '', importance: 5 });
                setShowAddForm(false);
                toast.success('Event added');
            }
        } catch (err) {
            toast.error('Failed to add event');
        } finally {
            setIsAdding(false);
        }
    };

    const importanceColor = (imp: number) =>
        imp >= 8 ? 'text-ember' : imp >= 4 ? 'text-terminal' : 'text-text-muted';

    if (timeline.length === 0) return null;

    return (
        <div className="mb-3 border border-border rounded-lg overflow-hidden bg-void">
            {/* Header */}
            <div
                className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-void-lighter transition-colors select-none"
                onClick={() => setCollapsed(c => !c)}
            >
                <div className="flex items-center gap-2">
                    <Globe size={13} className="text-terminal" />
                    <span className="text-[13px] font-bold uppercase tracking-widest font-mono text-terminal">
                        World State
                    </span>
                    <span className="text-[12px] bg-void-dark px-1.5 py-0.5 rounded border border-border text-text-muted font-mono">
                        {resolved.length}
                    </span>
                </div>
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <button
                        onClick={() => setShowAddForm(f => !f)}
                        className="text-[12px] px-2 py-0.5 rounded border border-terminal/30 text-terminal bg-terminal/5 hover:bg-terminal/15 font-mono font-bold uppercase flex items-center gap-1 transition-colors"
                    >
                        <Plus size={10} />
                        Add
                    </button>
                    {collapsed ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronUp size={14} className="text-text-muted" />}
                </div>
            </div>

            {/* Add Form */}
            {showAddForm && (
                <div className="px-3 pb-2 border-t border-border/50 bg-void-dark/50" onClick={e => e.stopPropagation()}>
                    <div className="pt-2 grid grid-cols-2 gap-1.5">
                        <input
                            placeholder="Subject"
                            value={form.subject}
                            onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                            className="col-span-1 bg-void border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal"
                        />
                        <select
                            value={form.predicate}
                            onChange={e => setForm(f => ({ ...f, predicate: e.target.value }))}
                            className="col-span-1 bg-void border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal"
                        >
                            {PREDICATE_LIST.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <input
                            placeholder="Object"
                            value={form.object}
                            onChange={e => setForm(f => ({ ...f, object: e.target.value }))}
                            className="col-span-1 bg-void border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal"
                        />
                        <input
                            type="number"
                            min={1}
                            max={10}
                            placeholder="Importance (1-10)"
                            value={form.importance}
                            onChange={e => setForm(f => ({ ...f, importance: Math.min(10, Math.max(1, parseInt(e.target.value) || 5)) }))}
                            className="col-span-1 bg-void border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal"
                        />
                        <input
                            placeholder="Summary (optional)"
                            value={form.summary}
                            onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
                            className="col-span-2 bg-void border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal"
                        />
                        <div className="col-span-2 flex justify-end gap-1.5 mt-1">
                            <button
                                onClick={() => setShowAddForm(false)}
                                className="px-2 py-1 text-[12px] font-mono font-bold uppercase border border-border text-text-muted hover:text-text-primary rounded transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAdd}
                                disabled={isAdding || !form.subject.trim() || !form.object.trim()}
                                className="px-2 py-1 text-[12px] font-mono font-bold uppercase bg-terminal text-void rounded hover:bg-terminal-bright transition-colors disabled:opacity-50"
                            >
                                {isAdding ? 'Adding…' : 'Add'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Resolved list */}
            <div className="px-3 pb-2 space-y-0.5">
                {/* Filter */}
                <input
                    placeholder="Filter by subject or object…"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    className="w-full mt-2 bg-void-dark border border-border text-text-primary px-2 py-1 rounded text-[13px] font-mono focus:outline-none focus:border-terminal mb-1.5"
                    onClick={e => { e.stopPropagation(); setCollapsed(false); }}
                />
                {displayed.map(r => (
                    <div key={r.id} className="flex items-start gap-2 group py-0.5">
                        <span className={`text-[12px] font-mono font-bold shrink-0 ${importanceColor(r.importance)}`}>
                            [{r.importance}]
                        </span>
                        <div className="flex-1 min-w-0 text-[13px] font-mono leading-tight">
                            <span className="text-text-primary font-bold">{r.subject}</span>
                            <span className="text-text-muted mx-1">→</span>
                            <span className="text-terminal">{r.predicate}</span>
                            <span className="text-text-muted">: </span>
                            <span className="text-text-secondary">{r.object}</span>
                            <span className="text-text-muted text-[11px] ml-1">s{r.sceneId}</span>
                        </div>
                        <button
                            onClick={() => handleDelete(r.id)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-red-400"
                        >
                            <X size={11} />
                        </button>
                    </div>
                ))}
                {collapsed && resolved.length > 10 && (
                    <button
                        onClick={() => setCollapsed(false)}
                        className="text-[12px] text-text-muted hover:text-terminal font-mono mt-1 transition-colors"
                    >
                        +{resolved.length - 10} more — expand
                    </button>
                )}
                {resolved.length === 0 && (
                    <p className="text-[12px] text-text-muted font-mono py-1 italic">
                        {filter ? 'No matches' : 'No resolved truths yet'}
                    </p>
                )}
            </div>
        </div>
    );
};
