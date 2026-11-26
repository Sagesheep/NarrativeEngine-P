/**
 * Composer keyboard handling, extracted from ChatArea:
 * Enter sends, Shift+Enter inserts a newline.
 */
export function useChatKeyboard(onSend: () => void) {
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    };

    return { handleKeyDown };
}
