import { describe, it, expect } from 'vitest';
import {
    buildGallery, collectGeneratedEntries, titleForAttachment, captionForAttachment, titleForUpload,
} from '../galleryIndex';
import type { ChatMessage, GalleryEntry, SceneImageAttachment } from '../../../types';

function attachment(over: Partial<SceneImageAttachment> = {}): SceneImageAttachment {
    return {
        id: 'att-1',
        kind: 'scene-image',
        status: 'complete',
        sourceMessageId: 'm1',
        selectedText: 'The lighthouse burned green against the storm.',
        imageUrl: '/assets/portraits/scene_1.png',
        sceneContext: { presentCharacters: [], recentMessageIds: [] },
        promptPackage: {
            focus: 'a green-lit lighthouse in a storm',
            positivePrompt: 'a stone lighthouse lit green, storm clouds, crashing waves',
            style: 'Painterly Realism',
            aspectRatio: '16:9',
        },
        generatedAt: '2026-09-01T10:00:00.000Z',
        ...over,
    };
}

function message(over: Partial<ChatMessage> = {}): ChatMessage {
    return { id: 'm1', role: 'assistant', content: 'x', timestamp: 1_000, ...over };
}

describe('generated entries', () => {
    it('derives an entry from a completed scene image', () => {
        const out = collectGeneratedEntries([message({ attachments: [attachment()] })]);
        expect(out).toHaveLength(1);
        expect(out[0].source).toBe('generated');
        expect(out[0].imageUrl).toBe('/assets/portraits/scene_1.png');
    });

    it('skips images that are still generating or failed', () => {
        const msgs = [message({
            attachments: [
                attachment({ id: 'a', status: 'generating' }),
                attachment({ id: 'b', status: 'failed' }),
                attachment({ id: 'c', status: 'complete' }),
            ],
        })];
        expect(collectGeneratedEntries(msgs).map(e => e.id)).toEqual(['c']);
    });

    it('skips a complete image with no URL', () => {
        const msgs = [message({ attachments: [attachment({ imageUrl: undefined })] })];
        expect(collectGeneratedEntries(msgs)).toHaveLength(0);
    });

    it('names the image from the prompt focus, not the raw prose', () => {
        expect(titleForAttachment(attachment())).toBe('a green-lit lighthouse in a storm');
    });

    it('falls back to the highlighted prose when there is no focus', () => {
        const att = attachment({ promptPackage: { ...attachment().promptPackage, focus: '' } });
        expect(titleForAttachment(att)).toContain('lighthouse burned green');
    });

    it('describes a generated image from its own prompt — no vision call needed', () => {
        const caption = captionForAttachment(attachment());
        expect(caption).toContain('stone lighthouse lit green');
        expect(caption).toContain('From the scene:');
    });

    it('does not repeat the prompt when the prose is identical to it', () => {
        const att = attachment({ selectedText: 'a stone lighthouse lit green, storm clouds, crashing waves' });
        const caption = captionForAttachment(att);
        expect(caption.match(/stone lighthouse/g)).toHaveLength(1);
    });

    it('handles a message with no attachments', () => {
        expect(collectGeneratedEntries([message()])).toHaveLength(0);
    });
});

describe('buildGallery', () => {
    const upload: GalleryEntry = {
        id: 'u1', source: 'uploaded', title: 'My costume',
        imageUrl: '/assets/portraits/attachment_1.png',
        caption: 'A long coat over a grey waistcoat.', createdAt: 5_000,
    };

    it('merges stored uploads with derived scene images, newest first', () => {
        const out = buildGallery([message({ attachments: [attachment()] })], [upload]);
        expect(out).toHaveLength(2);
        expect(out[0].createdAt).toBeGreaterThanOrEqual(out[1].createdAt);
    });

    it('filters by source', () => {
        const msgs = [message({ attachments: [attachment()] })];
        expect(buildGallery(msgs, [upload], 'uploaded').map(e => e.id)).toEqual(['u1']);
        expect(buildGallery(msgs, [upload], 'generated').map(e => e.id)).toEqual(['att-1']);
    });

    it('lets a stored edit win over re-derivation of the same image', () => {
        // The user renamed a scene image; saving persisted a row with the same id.
        const edited: GalleryEntry = {
            id: 'att-1', source: 'generated', title: 'Renamed by hand',
            imageUrl: '/assets/portraits/scene_1.png', caption: 'my own words', createdAt: 9_000,
        };
        const out = buildGallery([message({ attachments: [attachment()] })], [edited]);
        expect(out).toHaveLength(1);
        expect(out[0].title).toBe('Renamed by hand');
    });

    it('survives an empty campaign', () => {
        expect(buildGallery([], undefined)).toEqual([]);
    });
});

describe('titleForUpload', () => {
    it('uses a meaningful filename', () => {
        expect(titleForUpload('detective_coat.png', 'A long coat.')).toBe('detective coat');
    });

    it('ignores camera and screenshot junk and uses the caption instead', () => {
        expect(titleForUpload('IMG_20260911_004.png', 'A rusted iron key on a wooden table.'))
            .toBe('A rusted iron key on a wooden table.');
        expect(titleForUpload('Screenshot 2026-09-11.png', 'A hand-drawn map.')).toBe('A hand-drawn map.');
    });

    it('falls back when there is no name and no caption', () => {
        expect(titleForUpload(undefined, '')).toBe('Uploaded image');
    });

    it('trims a very long derived title', () => {
        const title = titleForUpload(undefined, 'x'.repeat(200));
        expect(title.length).toBeLessThanOrEqual(49);
    });
});
