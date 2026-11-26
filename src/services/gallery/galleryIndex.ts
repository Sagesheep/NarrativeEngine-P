import type { ArmedGalleryRecall, ChatMessage, GalleryEntry, GallerySource, SceneImageAttachment } from '../../types';

/**
 * Building the gallery list.
 *
 * The `generated` half is DERIVED, not stored. Scene images already live on
 * `message.attachments` and are already persisted with the chat, so indexing
 * them costs nothing and the gallery arrives pre-populated with every scene
 * image the campaign ever made — retroactively, with no migration.
 *
 * The `uploaded` half is stored on `context.galleryUploads`, because a pasted
 * image's caption has nowhere else to live once its turn is over.
 */

/** Longest title we will auto-derive before trimming. */
const TITLE_CAP = 48;

function trimTitle(raw: string): string {
    const flat = raw.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    return flat.length <= TITLE_CAP ? flat : flat.slice(0, TITLE_CAP).trim() + '…';
}

/**
 * Name a generated image. `focus` is the prompt's own summary of the subject
 * and is the best available name; the highlighted prose is the fallback.
 */
export function titleForAttachment(att: SceneImageAttachment): string {
    return trimTitle(att.promptPackage?.focus || '')
        || trimTitle(att.selectedText || '')
        || 'Scene image';
}

/**
 * Describe a generated image using the prompt that produced it. Deliberately
 * not a vision call — the positive prompt is the ground truth for what was
 * asked for, and the highlighted prose is the moment it belongs to.
 */
export function captionForAttachment(att: SceneImageAttachment): string {
    const parts: string[] = [];
    const prompt = att.promptPackage?.positivePrompt?.trim();
    const selected = att.selectedText?.trim();
    if (prompt) parts.push(prompt);
    if (selected && selected !== prompt) parts.push(`From the scene: "${trimTitle(selected)}"`);
    return parts.join(' ');
}

/** Index every completed scene image in the chat as a gallery entry. */
export function collectGeneratedEntries(messages: ChatMessage[]): GalleryEntry[] {
    const entries: GalleryEntry[] = [];
    for (const msg of messages) {
        for (const att of msg.attachments ?? []) {
            if (att.status !== 'complete' || !att.imageUrl) continue;
            entries.push({
                id: att.id,
                source: 'generated',
                title: titleForAttachment(att),
                imageUrl: att.imageUrl,
                caption: captionForAttachment(att),
                createdAt: att.generatedAt ? Date.parse(att.generatedAt) || msg.timestamp : msg.timestamp,
                sourceMessageId: msg.id,
            });
        }
    }
    return entries;
}

/**
 * The full gallery: stored uploads plus derived scene images, newest first.
 * A stored upload wins over a derived entry of the same id so a user-edited
 * title or caption is never clobbered by re-derivation.
 */
export function buildGallery(
    messages: ChatMessage[],
    uploads: GalleryEntry[] | undefined,
    filter?: GallerySource,
): GalleryEntry[] {
    const stored = uploads ?? [];
    const storedIds = new Set(stored.map(e => e.id));
    const derived = collectGeneratedEntries(messages).filter(e => !storedIds.has(e.id));

    const all = [...stored, ...derived];
    const scoped = filter ? all.filter(e => e.source === filter) : all;
    return scoped.sort((a, b) => b.createdAt - a.createdAt);
}

/** Derive a title for an uploaded file, so entries aren't named IMG_20260911_004. */
export function titleForUpload(fileName: string | undefined, caption: string): string {
    const base = (fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    // A camera/screenshot filename carries no meaning — prefer the caption's opening.
    const looksGeneric = !base || /^(image|img|screenshot|photo|pasted|attachment|unknown)\b/i.test(base) || /^\d+$/.test(base);
    if (!looksGeneric) return trimTitle(base);
    const firstSentence = caption.split(/(?<=[.!?])\s/)[0] ?? caption;
    return trimTitle(firstSentence) || 'Uploaded image';
}

/** Resolve explicitly configured keywords against player text only, merging manual recalls once. */
export function resolveGalleryRecall(
    text: string,
    entries: GalleryEntry[],
    armed: ArmedGalleryRecall[] | null | undefined,
): ArmedGalleryRecall[] | null {
    const recalls = new Map<string, ArmedGalleryRecall>();
    for (const entry of armed ?? []) {
        if (entry.caption.trim()) recalls.set(entry.id, entry);
    }
    const body = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
    for (const entry of entries) {
        const keyword = entry.autoInjectKeyword?.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
        if (!keyword || !entry.caption.trim() || recalls.has(entry.id)) continue;
        // Literal matching avoids treating player keywords as regular expressions.
        let start = body.indexOf(keyword);
        while (start !== -1) {
            const before = [...body.slice(0, start)].at(-1) ?? '';
            const after = [...body.slice(start + keyword.length)][0] ?? '';
            const word = /[\p{L}\p{N}\p{M}_]/u;
            if (!word.test(before) && !word.test(after)) {
                recalls.set(entry.id, { id: entry.id, title: entry.title, caption: entry.caption });
                break;
            }
            start = body.indexOf(keyword, start + 1);
        }
    }
    return recalls.size ? [...recalls.values()] : null;
}
