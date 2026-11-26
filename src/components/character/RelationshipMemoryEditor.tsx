import { useState } from 'react';
import { Pencil, Plus, Save, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { updateRelationshipMemories } from '../../store/relationshipMemoryStore';
import { MEMORY_LINE_CHARS, MEMORY_LINE_WORDS } from '../../services/archive-memory/relationshipMemory';
import { findEditedRecordIndex, latestArchivedSceneId, recordKey } from './relationshipMemoryEditorHelpers';
import {
    RELATIONSHIP_MEMORY_IMPACTS,
    RELATIONSHIP_MEMORY_MOODS,
    type RelationshipMemoryImpact,
    type RelationshipMemoryMood,
    type RelationshipMemoryRecord,
} from '../../types';

type Props = {
    records: readonly RelationshipMemoryRecord[];
    subjectId?: string;
    subjectLabel?: string;
    targetId?: string;
    targetLabel?: string;
    /** Scene a new memory is filed under. Defaults to the latest archived scene. */
    sceneId?: string;
    title?: string;
    allowAdd?: boolean;
    compact?: boolean;
};

type Draft = {
    subject: string;
    target: string;
    event: string;
    outcome: string;
    mood: RelationshipMemoryMood;
    impact: RelationshipMemoryImpact;
    carriedNote: string;
};

// Same caps as the recorder. The old 8 / 60 refused to save an edit of any recorded line
// longer than that.
const MAX_WORDS = MEMORY_LINE_WORDS;
const MAX_CHARS = MEMORY_LINE_CHARS;

function withinCap(value: string): boolean {
    return value.length <= MAX_CHARS && value.trim().split(/\s+/).filter(Boolean).length <= MAX_WORDS;
}

function emptyDraft(subject: string, target: string): Draft {
    return {
        subject,
        target,
        event: '',
        outcome: '',
        mood: 'companionable',
        impact: 'remembered',
        carriedNote: '',
    };
}

export function RelationshipMemoryEditor({
    records,
    subjectId,
    subjectLabel,
    targetId = 'MC',
    targetLabel = 'the player character',
    sceneId,
    title = 'Relationship memories',
    allowAdd = true,
    compact = false,
}: Props) {
    const npcLedger = useAppStore(s => s.npcLedger);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const archiveIndex = useAppStore(s => s.archiveIndex);
    const addRelationshipMemoryFault = useAppStore(s => s.addRelationshipMemoryFault);
    const [editing, setEditing] = useState<RelationshipMemoryRecord | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');

    const visibleRecords = records.filter(record =>
        (!subjectId || record.subject === subjectId) &&
        (!targetId || record.target === targetId),
    );

    const openEdit = (record: RelationshipMemoryRecord) => {
        setError('');
        setAdding(false);
        setEditing(record);
        setDraft({
            subject: record.subject,
            target: record.target,
            event: record.event ?? '',
            outcome: record.outcome,
            mood: record.mood,
            impact: record.impact,
            carriedNote: record.carriedNote ?? '',
        });
    };

    const openAdd = () => {
        setError('');
        setEditing(null);
        setAdding(true);
        setDraft(emptyDraft(subjectId ?? '', targetId));
    };

    const closeDraft = () => {
        setEditing(null);
        setAdding(false);
        setDraft(null);
        setError('');
    };

    const saveDraft = async () => {
        if (!draft) return;
        const isLegacyEdit = !adding && editing ? editing.event === undefined : false;
        if (!draft.subject || !draft.target) {
            setError('Choose both sides of the relationship.');
            return;
        }
        if (!draft.outcome.trim() || !withinCap(draft.outcome)) {
            setError(`Outcome is required and must be ${MAX_WORDS} words / ${MAX_CHARS} characters or fewer.`);
            return;
        }
        if ((!isLegacyEdit && !draft.event.trim()) || (draft.event.trim() && !withinCap(draft.event))) {
            setError(`New memories require an event; it must be ${MAX_WORDS} words / ${MAX_CHARS} characters or fewer.`);
            return;
        }

        if (!activeCampaignId) {
            setError('No campaign is open.');
            return;
        }
        const original = !adding ? editing ?? undefined : undefined;
        const nextRecord: RelationshipMemoryRecord = {
            ...(original ?? {}),
            sceneId: original?.sceneId ?? sceneId ?? latestArchivedSceneId(archiveIndex.map(entry => entry.sceneId)),
            subject: draft.subject,
            target: draft.target,
            mood: draft.mood,
            impact: draft.impact,
            event: draft.event.trim() || undefined,
            outcome: draft.outcome.trim(),
            carriedNote: draft.carriedNote.trim() || undefined,
            source: 'user',
            subjectInferred: original?.subjectInferred,
        };
        try {
            await updateRelationshipMemories(activeCampaignId, current => {
                const nextMc = [...current.npcToMc];
                const nextNpc = [...current.npcToNpc];
                const collection = nextRecord.target === 'MC' ? nextMc : nextNpc;
                const index = original ? findEditedRecordIndex(collection, original) : -1;
                if (index >= 0) collection[index] = nextRecord;
                else collection.push(nextRecord);
                return { npcToMc: nextMc, npcToNpc: nextNpc };
            }, { resetStances: true });
            closeDraft();
        } catch {
            addRelationshipMemoryFault({ sceneId: nextRecord.sceneId, message: 'Relationship memory storage failed.' });
            setError('Could not save this memory to the campaign.');
        }
    };

    return (
        <div className={compact ? 'space-y-2' : 'border border-terminal/20 rounded p-3 space-y-3'}>
            <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-widest text-terminal/70">{title}</div>
                {allowAdd && !draft && (
                    <button type="button" onClick={openAdd} className="inline-flex items-center gap-1 text-[9px] text-terminal hover:text-terminal/80 uppercase tracking-wider">
                        <Plus size={11} /> Add memory
                    </button>
                )}
            </div>
            {visibleRecords.length === 0 && !draft && (
                <p className="text-[10px] text-text-dim/50 italic">No memories recorded for this edge.</p>
            )}
            {visibleRecords.map((record, index) => {
                const key = recordKey(record) + '|' + index;
                return (
                    <div key={key} className="border border-border/40 rounded p-2 text-[10px] text-text-dim/80">
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <div className="text-text-primary">{record.event ? `${record.event} — ${record.outcome}` : record.outcome}</div>
                                <div className="text-text-dim/60">{record.sceneId} · {record.mood} · {record.impact} · {record.source === 'user' ? 'user' : 'engine'}</div>
                            </div>
                            <button type="button" onClick={() => openEdit(record)} className="text-text-dim hover:text-terminal" aria-label="Edit relationship memory">
                                <Pencil size={12} />
                            </button>
                        </div>
                        {record.carriedNote && <div className="mt-1 text-text-dim/60">carries: {record.carriedNote}</div>}
                    </div>
                );
            })}
            {draft && (
                <div className="border border-terminal/30 rounded p-2 space-y-2">
                    {adding && !subjectId && (
                        <select value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} className="w-full bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary">
                            <option value="">Choose NPC</option>
                            {npcLedger.filter(npc => !npc.archived && !npc.isPC).map(npc => <option key={npc.id} value={npc.id}>{npc.name}</option>)}
                        </select>
                    )}
                    <div className="text-[9px] text-text-dim/60">{subjectLabel || draft.subject || 'NPC'} → {targetLabel}</div>
                    <input value={draft.event} onChange={event => setDraft({ ...draft, event: event.target.value })} placeholder="Event (required for new memories)" className="w-full bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary" />
                    <textarea value={draft.outcome} onChange={event => setDraft({ ...draft, outcome: event.target.value })} placeholder="What did this subject do?" rows={2} className="w-full bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary resize-none" />
                    <div className="grid grid-cols-2 gap-2">
                        <select value={draft.mood} onChange={event => setDraft({ ...draft, mood: event.target.value as RelationshipMemoryMood })} className="bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary">
                            {RELATIONSHIP_MEMORY_MOODS.map(mood => <option key={mood} value={mood}>{mood}</option>)}
                        </select>
                        <select value={draft.impact} onChange={event => setDraft({ ...draft, impact: event.target.value as RelationshipMemoryImpact })} className="bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary">
                            {RELATIONSHIP_MEMORY_IMPACTS.map(impact => <option key={impact} value={impact}>{impact}</option>)}
                        </select>
                    </div>
                    <input value={draft.carriedNote} onChange={event => setDraft({ ...draft, carriedNote: event.target.value })} placeholder="Carried note — what they carry (for carried impact)" className="w-full bg-void border border-border rounded px-2 py-1 text-[10px] text-text-primary" />
                    {error && <div className="text-[9px] text-ember">{error}</div>}
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={closeDraft} className="inline-flex items-center gap-1 text-[9px] text-text-dim hover:text-text-primary"><X size={11} /> Cancel</button>
                        <button type="button" onClick={() => void saveDraft()} className="inline-flex items-center gap-1 text-[9px] text-terminal hover:text-terminal/80"><Save size={11} /> Save memory</button>
                    </div>
                </div>
            )}
        </div>
    );
}
