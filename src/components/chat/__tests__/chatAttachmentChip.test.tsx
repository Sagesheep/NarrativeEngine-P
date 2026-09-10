import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatAttachmentChip } from '../ChatAttachmentChip';
import type { ChatAttachment } from '../../hooks/useChatAttachment';

function chip(overrides: Partial<ChatAttachment> = {}) {
    const attachment: ChatAttachment = {
        previewUrl: 'blob:preview',
        localPath: '/assets/portraits/attachment_1.png',
        caption: 'A hand-drawn map of a coastal town.',
        status: 'ready',
        ...overrides,
    };
    const onCaptionChange = vi.fn();
    const onRemove = vi.fn();
    render(
        <ChatAttachmentChip attachment={attachment} onCaptionChange={onCaptionChange} onRemove={onRemove} />,
    );
    return { onCaptionChange, onRemove };
}

describe('ChatAttachmentChip', () => {
    it('shows the caption once the vision model has read the image', () => {
        chip();
        expect(screen.getByText('A hand-drawn map of a coastal town.')).toBeTruthy();
    });

    it('says plainly that the AI reads the text, not the picture', () => {
        chip();
        expect(screen.getByText(/reads this text, not the picture/i)).toBeTruthy();
    });

    it('reports progress while uploading and while captioning', () => {
        const { unmount } = render(
            <ChatAttachmentChip
                attachment={{ previewUrl: 'blob:x', localPath: '', caption: '', status: 'uploading' }}
                onCaptionChange={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        expect(screen.getByText(/Saving image/i)).toBeTruthy();
        unmount();

        render(
            <ChatAttachmentChip
                attachment={{ previewUrl: 'blob:x', localPath: '/a.png', caption: '', status: 'captioning' }}
                onCaptionChange={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        expect(screen.getByText(/Vision AI is reading it/i)).toBeTruthy();
    });

    it('surfaces the failure and still keeps the image so you can caption it yourself', () => {
        chip({ status: 'error', error: 'model does not support images', caption: '' });
        expect(screen.getByText(/model does not support images/i)).toBeTruthy();
        expect(screen.getByAltText('Attached')).toBeTruthy();
    });

    it('lets the caption be edited before it is sent', () => {
        const { onCaptionChange } = chip();
        fireEvent.click(screen.getByTitle(/Review or edit/i));
        const box = screen.getByPlaceholderText(/Describe the image/i);
        fireEvent.change(box, { target: { value: 'Actually a nautical chart.' } });
        expect(onCaptionChange).toHaveBeenCalledWith('Actually a nautical chart.');
    });

    it('hides the edit box while the model is still working', () => {
        chip({ status: 'captioning', caption: '' });
        fireEvent.click(screen.getByTitle(/Review or edit/i));
        expect(screen.queryByPlaceholderText(/Describe the image/i)).toBeNull();
    });

    it('removes the attachment on demand', () => {
        const { onRemove } = chip();
        fireEvent.click(screen.getByTitle(/Remove this image/i));
        expect(onRemove).toHaveBeenCalled();
    });
});
