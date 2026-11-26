import { useState } from 'react';
import { ASK_GM_BRIEF_MAX_CHARS } from '../../services/ooc/askGmHandoff';

type Props = {
    brief: string;
    onUpdate: (brief: string) => void;
    onRemove: () => void;
};

/** Visible, editable session-only handoff state; it deliberately has no store dependency. */
export function ArmedAskGmNote({ brief, onUpdate, onRemove }: Props) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(brief);

    return <div className="border-b border-terminal/40 bg-terminal/5 px-4 py-2 font-mono text-xs">
        <div className="flex items-center justify-between gap-3">
            <span className="text-terminal font-bold">Story AI note armed</span>
            <div className="flex gap-2">
                <button onClick={() => { setDraft(brief); setEditing(true); }} className="text-text-dim hover:text-text-primary">Edit</button>
                <button onClick={onRemove} className="text-text-dim hover:text-red-300">Remove</button>
            </div>
        </div>
        {editing ? <div className="mt-2 flex gap-2"><textarea aria-label="Edit Story AI note" value={draft} maxLength={ASK_GM_BRIEF_MAX_CHARS} onChange={event => setDraft(event.target.value)} className="flex-1 min-h-16 resize-y bg-void border border-border p-2 text-xs" /><button onClick={() => { const text = draft.trim(); if (text) { onUpdate(text); setEditing(false); } }} className="text-terminal">Save</button></div> : <p className="mt-1 whitespace-pre-wrap text-text-primary">{brief}</p>}
    </div>;
}
