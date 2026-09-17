/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ChatMessage, GalleryEntry, SceneImageAttachment } from '../../types';

// ── Store double ─────────────────────────────────────────────────────────────
// The modal reads through selectors, so the fake applies the selector to a
// plain state object and exposes the same actions the component calls.
const setArmedGalleryRecall = vi.fn();
const updateGalleryEntry = vi.fn();
const removeGalleryUpload = vi.fn();
const addGalleryUpload = vi.fn();
const closeGallery = vi.fn();

let state: any;

vi.mock('../../store/useAppStore', () => {
    const useAppStore = (selector: (s: any) => unknown) => selector(state);
    useAppStore.getState = () => state;
    return { useAppStore };
});

const toastWarning = vi.fn();
const toastSuccess = vi.fn();
vi.mock('../Toast', () => ({
    toast: { warning: (...a: unknown[]) => toastWarning(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

import { GalleryModal } from '../GalleryModal';

const UPLOAD: GalleryEntry = {
    id: 'u1', source: 'uploaded', title: 'Detective coat',
    imageUrl: '/assets/portraits/attachment_1.png',
    caption: 'A long oilcloth coat over a grey waistcoat.', createdAt: 9_000,
};

const SCENE_ATT: SceneImageAttachment = {
    id: 'a1', kind: 'scene-image', status: 'complete',
    sourceMessageId: 'm1', selectedText: 'The lighthouse burned green.',
    imageUrl: '/assets/portraits/scene_1.png',
    sceneContext: { presentCharacters: [], recentMessageIds: [] },
    promptPackage: { focus: 'a green-lit lighthouse', positivePrompt: 'stone lighthouse lit green', style: 's', aspectRatio: '16:9' },
    generatedAt: '2026-09-01T10:00:00.000Z',
};

const MESSAGES: ChatMessage[] = [
    { id: 'm1', role: 'assistant', content: 'x', timestamp: 1_000, attachments: [SCENE_ATT] },
];

function setState(over: Partial<any> = {}) {
    state = {
        galleryOpen: true,
        galleryFilter: null,
        closeGallery,
        messages: MESSAGES,
        context: { galleryUploads: [UPLOAD] },
        setArmedGalleryRecall,
        updateGalleryEntry,
        removeGalleryUpload,
        addGalleryUpload,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setState();
});

describe('GalleryModal', () => {
    it('renders nothing when closed', () => {
        setState({ galleryOpen: false });
        const { container } = render(<GalleryModal />);
        expect(container.firstChild).toBeNull();
    });

    it('shows uploads and derived scene images together', () => {
        render(<GalleryModal />);
        expect(screen.getByText('Detective coat')).toBeTruthy();
        expect(screen.getByText('a green-lit lighthouse')).toBeTruthy();
    });

    it('opens on the filter the nav leaf asked for', () => {
        setState({ galleryFilter: 'uploaded' });
        render(<GalleryModal />);
        expect(screen.getByText('Detective coat')).toBeTruthy();
        expect(screen.queryByText('a green-lit lighthouse')).toBeNull();
    });

    it('filters when a tab is clicked', () => {
        render(<GalleryModal />);
        fireEvent.click(screen.getByText('AI Generated'));
        expect(screen.queryByText('Detective coat')).toBeNull();
        expect(screen.getByText('a green-lit lighthouse')).toBeTruthy();
    });

    it('arms the selected captions for the next turn and closes', () => {
        render(<GalleryModal />);
        fireEvent.click(screen.getByAltText('Detective coat'));
        fireEvent.click(screen.getByText(/Append to Story AI/i));

        expect(setArmedGalleryRecall).toHaveBeenCalledWith([
            { id: 'u1', title: 'Detective coat', caption: 'A long oilcloth coat over a grey waistcoat.' },
        ]);
        expect(closeGallery).toHaveBeenCalled();
    });

    it('arms several images at once', () => {
        render(<GalleryModal />);
        fireEvent.click(screen.getByAltText('Detective coat'));
        fireEvent.click(screen.getByAltText('a green-lit lighthouse'));
        fireEvent.click(screen.getByText(/Append to Story AI/i));
        expect(setArmedGalleryRecall.mock.calls[0][0]).toHaveLength(2);
    });

    it('refuses to arm nothing', () => {
        render(<GalleryModal />);
        const button = screen.getByText(/Append to Story AI/i).closest('button')!;
        expect(button.disabled).toBe(true);
    });

    it('edits an upload in place', () => {
        setState({ galleryFilter: 'uploaded' });
        render(<GalleryModal />);
        fireEvent.click(screen.getAllByTitle(/Edit name and description/i)[0]);
        fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Trench coat' } });
        fireEvent.click(screen.getByText('Save'));
        expect(updateGalleryEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 'Trench coat' }));
    });

    it('persists a row when a DERIVED scene image is edited, so the edit survives re-derivation', () => {
        setState({ galleryFilter: 'generated' });
        render(<GalleryModal />);
        fireEvent.click(screen.getAllByTitle(/Edit name and description/i)[0]);
        fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'The green light' } });
        fireEvent.click(screen.getByText('Save'));
        expect(addGalleryUpload).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'a1', title: 'The green light' }),
        );
        expect(updateGalleryEntry).not.toHaveBeenCalled();
    });

    it('offers delete for uploads but not for derived scene images', () => {
        setState({ galleryFilter: 'uploaded' });
        const { unmount } = render(<GalleryModal />);
        expect(screen.queryAllByTitle(/Remove from gallery/i)).toHaveLength(1);
        unmount();

        setState({ galleryFilter: 'generated' });
        render(<GalleryModal />);
        expect(screen.queryAllByTitle(/Remove from gallery/i)).toHaveLength(0);
    });

    it('tells the player the recall is for one message only', () => {
        render(<GalleryModal />);
        fireEvent.click(screen.getByAltText('Detective coat'));
        expect(screen.getByText(/next message only/i)).toBeTruthy();
    });

    it('shows an empty state on a fresh campaign', () => {
        setState({ messages: [], context: {} });
        render(<GalleryModal />);
        expect(screen.getByText(/Nothing here yet/i)).toBeTruthy();
    });
});

describe('Gallery auto-inject keyword editor', () => {
    it('saves a trimmed keyword on an uploaded image', () => {
        setState({ galleryFilter: 'uploaded' });
        render(<GalleryModal />);
        fireEvent.click(screen.getByTitle('Edit name and description'));
        fireEvent.change(screen.getByLabelText('Auto-inject keyword'), { target: { value: '  red cloak  ' } });
        fireEvent.click(screen.getByText('Save'));
        expect(updateGalleryEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ autoInjectKeyword: 'red cloak' }));
    });
    it('loads and clears a saved keyword, including previously edited generated images', () => {
        const generated = { ...UPLOAD, source: 'generated', autoInjectKeyword: 'coat' };
        setState({ messages: [], context: { galleryUploads: [generated] } });
        render(<GalleryModal />);
        expect(screen.getByText('Auto-inject: coat')).toBeTruthy();
        fireEvent.click(screen.getByTitle('Edit name and description'));
        expect(screen.getByLabelText('Auto-inject keyword')).toHaveValue('coat');
        fireEvent.change(screen.getByLabelText('Auto-inject keyword'), { target: { value: '' } });
        fireEvent.click(screen.getByText('Save'));
        expect(updateGalleryEntry).toHaveBeenCalledWith('u1', expect.objectContaining({ autoInjectKeyword: '' }));
        expect(addGalleryUpload).not.toHaveBeenCalled();
    });
    it('does not save a cancelled keyword edit', () => {
        setState({ galleryFilter: 'uploaded' });
        render(<GalleryModal />);
        fireEvent.click(screen.getByTitle('Edit name and description'));
        fireEvent.change(screen.getByLabelText('Auto-inject keyword'), { target: { value: 'coat' } });
        fireEvent.click(screen.getByText('Cancel'));
        expect(updateGalleryEntry).not.toHaveBeenCalled();
    });
});
