import type { RefObject } from 'react';

/**
 * Composer textarea height management, extracted from ChatArea: grows with
 * content up to 240px, snaps back to the 40px baseline after a send.
 */
export function useAutoresizeInput(inputRef: RefObject<HTMLTextAreaElement | null>) {
    const resetTextareaHeight = () => {
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
        }
    };

    const resizeToContent = () => {
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    return { resetTextareaHeight, resizeToContent };
}
