// ─── Image Gallery (Vision v2) ──────────────────────────────────────────────

/**
 * One recallable image in the campaign gallery.
 *
 * The gallery exists because a caption was being thrown away. Vision v1.5 paid
 * for a vision call on every pasted image, spent the caption on a single turn,
 * and dropped it. An entry keeps that text so the same image can be handed back
 * to the story AI at turn 700 without paying to look at it again.
 *
 * Two sources, and they differ in where the text comes from:
 *  - `generated` — a scene image the app made. Its description is FREE: the
 *    prompt that produced the picture is a better account of it than a vision
 *    model reading it back. Derived live from `message.attachments`, never stored.
 *  - `uploaded`  — a player's own image. Needs the vision call, and is stored on
 *    `context.galleryUploads`.
 */
export type GallerySource = 'generated' | 'uploaded';

export type GalleryEntry = {
    id: string;
    source: GallerySource;
    /** Shown in the gallery and in the `🖼 Image recalled — <title>` reveal line. */
    title: string;
    /** Local asset path, e.g. `/assets/portraits/attachment_123.png`. */
    imageUrl: string;
    /** The text the story AI actually receives. User-editable. */
    caption: string;
    /** Optional whole word or phrase that recalls this caption on matching player input. */
    autoInjectKeyword?: string;
    createdAt: number;
    /** `generated` only — the message the scene image hangs beneath. */
    sourceMessageId?: string;
};

/** An entry armed for the next turn. Cleared once it fires (see `armedOneShot`). */
export type ArmedGalleryRecall = {
    id: string;
    title: string;
    caption: string;
};
