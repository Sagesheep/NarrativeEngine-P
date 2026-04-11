import { useState } from 'react';
import type { ChatMessage } from '../../types';

interface UseMessageEditorDeps {
    messages: ChatMessage[];
    input: string;
    setInput: (v: string) => void;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    resetTextareaHeight: () => void;
    rollbackArchive: (timestamp: number) => Promise<void>;
    deleteMessagesFrom: (id: string) => void;
    updateMessageContent: (id: string, content: string) => void;
    onAfterEdit: (text: string) => void;
    onAfterRegenerate: (text: string) => void;
}

export function useMessageEditor(deps: UseMessageEditorDeps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        deps.setInput(msg.displayContent || msg.content);
        deps.inputRef.current?.focus();
    };

    const cancelEditing = () => {
        setEditingMessageId(null);
        deps.setInput('');
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = deps.messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            deps.rollbackArchive(msg.timestamp);
            deps.deleteMessagesFrom(msg.id);
            const textToResend = deps.input.trim();
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
            setTimeout(() => {
                deps.onAfterEdit(textToResend);
            }, 50);
        } else {
            deps.updateMessageContent(msg.id, deps.input.trim());
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = deps.messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            deps.rollbackArchive(lastUser.timestamp);
            deps.deleteMessagesFrom(lastUser.id);
            setTimeout(() => {
                deps.onAfterRegenerate(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };

    return {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
    };
}
