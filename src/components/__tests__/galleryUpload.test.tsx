/* eslint-disable @typescript-eslint/no-explicit-any */
// Bulk gallery upload — the decoupling contract.
//
// The behaviour worth protecting: an entry is STORED as soon as its bytes are
// saved, with an empty caption, before any vision call runs. That is what makes
// dropping eight images feel instant. If someone later "tidies" this by awaiting
// the caption before storing, these tests fail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { GalleryEntry } from '../../types';

const uploadImageToLocal = vi.fn();
const captionImage = vi.fn();
const loadImageForVision = vi.fn(async () => ({ base64: 'AAA', mediaType: 'image/png' }));

vi.mock('../../services/infrastructure/assetService', () => ({
    uploadImageToLocal: (...a: unknown[]) => uploadImageToLocal(...a),
}));
vi.mock('../../services/vision/imageSource', () => ({
    loadImageForVision: (...a: unknown[]) => loadImageForVision(...a),
}));
vi.mock('../../services/vision/describeImage', () => ({
    captionImage: (...a: unknown[]) => captionImage(...a),
}));

const toastWarning = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('../Toast', () => ({
    toast: {
        warning: (...a: unknown[]) => toastWarning(...a),
        error: (...a: unknown[]) => toastError(...a),
        success: (...a: unknown[]) => toastSuccess(...a),
    },
}));

const addGalleryUpload = vi.fn();
const updateGalleryEntry = vi.fn();
let visionProvider: any;
let storedUploads: GalleryEntry[];

vi.mock('../../store/useAppStore', () => {
    const state = {
        get context() { return { galleryUploads: storedUploads }; },
        getActiveVisionEndpoint: () => visionProvider,
        addGalleryUpload: (...a: unknown[]) => addGalleryUpload(...a),
        updateGalleryEntry: (...a: unknown[]) => updateGalleryEntry(...a),
    };
    const useAppStore = (selector: (s: any) => unknown) => selector(state);
    useAppStore.getState = () => state;
    return { useAppStore };
});

import { useGalleryUpload } from '../hooks/useGalleryUpload';

function imageFile(name = 'costume.png') {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

beforeEach(() => {
    vi.clearAllMocks();
    storedUploads = [];
    visionProvider = { endpoint: 'https://api.example.com/v1', apiKey: 'k', modelName: 'v', apiFormat: 'openai' };
    uploadImageToLocal.mockImplementation(async (f: File) => `/assets/portraits/${f.name}`);
    captionImage.mockResolvedValue('A long oilcloth coat.');
    addGalleryUpload.mockImplementation((e: GalleryEntry) => { storedUploads.push(e); });
});

describe('useGalleryUpload', () => {
    it('stores each entry with an EMPTY caption before any vision call runs', async () => {
        // Caption never resolves — the entries must still land.
        captionImage.mockImplementation(() => new Promise(() => {}));
        const { result } = renderHook(() => useGalleryUpload());

        await act(async () => { await result.current.addFiles([imageFile('a.png'), imageFile('b.png')]); });

        expect(addGalleryUpload).toHaveBeenCalledTimes(2);
        for (const [entry] of addGalleryUpload.mock.calls) {
            expect(entry.caption).toBe('');
            expect(entry.source).toBe('uploaded');
            expect(entry.imageUrl).toContain('/assets/portraits/');
        }
    });

    it('writes the caption back once the vision call lands', async () => {
        const { result } = renderHook(() => useGalleryUpload());
        await act(async () => { await result.current.addFiles([imageFile()]); });

        await waitFor(() => expect(updateGalleryEntry).toHaveBeenCalled());
        const [, patch] = updateGalleryEntry.mock.calls[0];
        expect(patch.caption).toBe('A long oilcloth coat.');
    });

    it('still stores images when NO vision provider is configured', async () => {
        visionProvider = undefined;
        const { result } = renderHook(() => useGalleryUpload());

        await act(async () => { await result.current.addFiles([imageFile()]); });

        expect(addGalleryUpload).toHaveBeenCalledTimes(1);
        expect(captionImage).not.toHaveBeenCalled();
        expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/No Vision AI/i));
    });

    it('keeps going when one file fails to save', async () => {
        uploadImageToLocal
            .mockRejectedValueOnce(new Error('disk full'))
            .mockImplementation(async (f: File) => `/assets/portraits/${f.name}`);
        const { result } = renderHook(() => useGalleryUpload());

        await act(async () => { await result.current.addFiles([imageFile('a.png'), imageFile('b.png')]); });

        expect(addGalleryUpload).toHaveBeenCalledTimes(1);
        expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/1 failed to save/i));
    });

    it('keeps going when one caption fails, leaving that entry describable', async () => {
        captionImage.mockRejectedValueOnce(new Error('model is not multimodal'));
        const { result } = renderHook(() => useGalleryUpload());

        await act(async () => { await result.current.addFiles([imageFile('a.png'), imageFile('b.png')]); });

        await waitFor(() => expect(updateGalleryEntry).toHaveBeenCalledTimes(1));
        expect(addGalleryUpload).toHaveBeenCalledTimes(2);
    });

    it('ignores non-image files', async () => {
        const { result } = renderHook(() => useGalleryUpload());
        const pdf = new File([new Uint8Array([1])], 'notes.pdf', { type: 'application/pdf' });

        await act(async () => { await result.current.addFiles([pdf]); });

        expect(uploadImageToLocal).not.toHaveBeenCalled();
        expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/No images/i));
    });

    it('upgrades the placeholder title from the caption, but never a user-written one', async () => {
        const { result } = renderHook(() => useGalleryUpload());
        // A camera-style filename derives the placeholder, so the caption should name it.
        await act(async () => { await result.current.addFiles([imageFile('IMG_20260911_004.png')]); });
        await waitFor(() => expect(updateGalleryEntry).toHaveBeenCalled());
        expect(updateGalleryEntry.mock.calls[0][1].title).toBe('A long oilcloth coat.');

        // Now the same flow where the stored title is the player's own.
        vi.clearAllMocks();
        storedUploads = [];
        addGalleryUpload.mockImplementation((e: GalleryEntry) => {
            storedUploads.push({ ...e, title: 'My detective coat' });
        });
        await act(async () => { await result.current.addFiles([imageFile('IMG_20260911_005.png')]); });
        await waitFor(() => expect(updateGalleryEntry).toHaveBeenCalled());
        expect(updateGalleryEntry.mock.calls[0][1].title).toBeUndefined();
    });

    it('describeMissing only targets uploads with no caption', async () => {
        const { result } = renderHook(() => useGalleryUpload());
        const entries: GalleryEntry[] = [
            { id: 'a', source: 'uploaded', title: 'A', imageUrl: '/a.png', caption: '', createdAt: 1 },
            { id: 'b', source: 'uploaded', title: 'B', imageUrl: '/b.png', caption: 'described', createdAt: 2 },
            { id: 'c', source: 'generated', title: 'C', imageUrl: '/c.png', caption: '', createdAt: 3 },
        ];

        await act(async () => { await result.current.describeMissing(entries); });

        expect(captionImage).toHaveBeenCalledTimes(1);
        expect(updateGalleryEntry).toHaveBeenCalledWith('a', expect.objectContaining({ caption: 'A long oilcloth coat.' }));
    });
});
