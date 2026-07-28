import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, Send, Square, X } from 'lucide-react';
import { answerOocQuestion } from '../../services/ooc/oocService';
import { ASK_GM_BRIEF_MAX_CHARS, summarizeAskGmConversation } from '../../services/ooc/askGmHandoff';
import type { OocCampaignSnapshot, OocMessage } from '../../services/ooc/types';
import { uid } from '../../utils/uid';

type Props = {
    snapshot: OocCampaignSnapshot;
    utilityProvider?: OocCampaignSnapshot['provider'];
    storyBusy: boolean;
    hasArmedBrief: boolean;
    onBusyChange: (busy: boolean) => void;
    onArmBrief: (brief: string) => void;
    onClose: () => void;
};

function hasCompletedConversation(messages: OocMessage[]) {
    return messages.some(message => message.role === 'user' && message.content.trim())
        && messages.some(message => message.role === 'assistant' && message.content.trim());
}

export function AskGmPanel({ snapshot, utilityProvider, storyBusy, hasArmedBrief, onBusyChange, onArmBrief, onClose }: Props) {
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<OocMessage[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [forceSearch, setForceSearch] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [preview, setPreview] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => () => {
        abortRef.current?.abort();
        onBusyChange(false);
    }, [onBusyChange]);

    const finish = (controller: AbortController) => {
        if (abortRef.current === controller) abortRef.current = null;
        setIsBusy(false);
        onBusyChange(false);
    };

    const send = async () => {
        const question = input.trim();
        if (!question || storyBusy || isBusy) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setIsBusy(true); onBusyChange(true); setError(null); setInput('');
        const assistantId = uid();
        setMessages(current => [...current, { id: uid(), role: 'user', content: question }, { id: assistantId, role: 'assistant', content: '' }]);
        try {
            const answer = await answerOocQuestion({
                question, snapshot, history: messages, forceSearch, signal: controller.signal,
                onChunk: content => setMessages(current => current.map(message => message.id === assistantId ? { ...message, content } : message)),
            });
            setMessages(current => current.map(message => message.id === assistantId ? { ...message, content: answer.text, sources: answer.sources, archiveSearched: answer.archiveSearched } : message));
        } catch (caught) {
            if (!controller.signal.aborted) {
                setError(caught instanceof Error ? caught.message : 'Ask GM request failed.');
            }
            setMessages(current => current.filter(item => item.id !== assistantId));
        } finally { finish(controller); }
    };

    const passToStory = async () => {
        if (!hasCompletedConversation(messages) || storyBusy || isBusy) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setIsBusy(true); onBusyChange(true); setError(null);
        try {
            const brief = await summarizeAskGmConversation({ messages, utilityProvider, storyProvider: snapshot.provider, signal: controller.signal });
            if (!controller.signal.aborted) setPreview(brief);
        } catch (caught) {
            if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'Ask GM summary failed.');
        } finally { finish(controller); }
    };

    const close = () => { abortRef.current?.abort(); onBusyChange(false); onClose(); };
    const disabled = storyBusy || !snapshot.campaignId || !snapshot.provider?.endpoint;
    const canPass = hasCompletedConversation(messages) && !storyBusy && !isBusy && !preview;

    return (
        <aside className="absolute inset-y-0 right-0 z-40 w-full max-w-md border-l border-terminal/40 bg-void-darker/95 backdrop-blur flex flex-col shadow-2xl" aria-label="Ask GM side chat">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <div><h2 className="text-terminal text-sm font-bold tracking-widest">Ask GM</h2><p className="text-[10px] text-text-dim">Read-only - does not advance the story</p></div>
                <button onClick={close} title="Close Ask GM" className="text-text-dim hover:text-text-primary"><X size={18} /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-3 space-y-3 font-mono text-sm">
                {messages.length === 0 && <p className="text-text-dim text-xs">Ask the GM about your character, NPCs, places, enemies, past events, lore, or rules. This chat is kept only for this session.</p>}
                {messages.map(message => <div key={message.id} className={message.role === 'user' ? 'text-ice' : 'text-text-primary'}>
                    <div className="text-[10px] uppercase tracking-wider text-text-dim">{message.role === 'user' ? 'You' : 'Ask GM'}</div>
                    <div className="whitespace-pre-wrap">{message.content || <Loader2 size={14} className="animate-spin mt-1" />}</div>
                    {message.role === 'assistant' && message.sources && message.sources.length > 0 && <details className="mt-2 text-[10px] text-text-dim"><summary>{message.archiveSearched ? 'Sources - archive searched' : 'Sources'}</summary><ul className="mt-1 space-y-1">{message.sources.slice(0, 8).map(source => <li key={`${source.kind}-${source.id}`}><span className="text-terminal">{source.label}:</span> {source.excerpt}</li>)}</ul></details>}
                </div>)}
                {preview !== null && <div className="border border-terminal/40 bg-terminal/5 p-3 space-y-2"><p className="text-xs text-terminal">This will be sent to the Story AI with your next turn:</p><textarea aria-label="Ask GM brief preview" value={preview} maxLength={ASK_GM_BRIEF_MAX_CHARS} onChange={event => setPreview(event.target.value)} className="w-full min-h-28 resize-y bg-void border border-border p-2 text-sm outline-none focus:border-terminal" /><div className="flex justify-end gap-2"><button onClick={() => setPreview(null)} className="text-xs text-text-dim hover:text-text-primary">Cancel</button><button onClick={() => { const brief = preview.trim(); if (brief) { onArmBrief(brief); setPreview(null); } }} disabled={!preview.trim()} className="text-xs text-terminal disabled:opacity-40">{hasArmedBrief ? 'Replace armed note' : 'Confirm'}</button></div></div>}
                {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
            </div>
            <div className="border-t border-border p-3 space-y-2">
                {canPass && <button onClick={() => void passToStory()} className="w-full border border-terminal/50 text-terminal hover:bg-terminal/10 py-2 text-xs font-bold tracking-wide">Pass to Story AI</button>}
                {isBusy && <p className="text-[10px] text-terminal">{messages.some(message => message.role === 'assistant' && !message.content) ? 'Asking the GM...' : 'Preparing Story AI note...'}</p>}
                <label className="flex items-center gap-2 text-[10px] text-text-dim cursor-pointer"><input type="checkbox" checked={forceSearch} onChange={event => setForceSearch(event.target.checked)} /> <Search size={12} /> Search campaign archive</label>
                <div className="flex gap-2"><textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask the GM..." disabled={disabled || isBusy} className="flex-1 min-h-10 resize-none bg-void border border-border p-2 text-sm outline-none focus:border-terminal disabled:opacity-50" />
                    <button onClick={isBusy ? () => abortRef.current?.abort() : () => void send()} disabled={!isBusy && (!input.trim() || disabled)} title={isBusy ? 'Stop Ask GM response' : 'Send Ask GM question'} className="w-10 text-terminal disabled:opacity-30">{isBusy ? <Square size={16} fill="currentColor" /> : <Send size={16} />}</button></div>
                {storyBusy && <p className="text-[10px] text-amber-400">Wait for story generation to finish.</p>}
                {!snapshot.campaignId && <p className="text-[10px] text-amber-400">Open a campaign to use Ask GM.</p>}
                {snapshot.campaignId && !snapshot.provider?.endpoint && <p className="text-[10px] text-amber-400">Configure a story endpoint to use Ask GM.</p>}
            </div>
        </aside>
    );
}
