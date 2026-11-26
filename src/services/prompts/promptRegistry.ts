/**
 * Prompt Modification — every built-in AI prompt, overridable per campaign.
 *
 * Each built-in prompt is a template in the catalog (`promptCatalog.ts`) with
 * `{{name}}` placeholders that the calling service fills at run time. A campaign
 * may store its own text for any prompt in `context.promptOverrides`; when one is
 * present it is rendered instead of the built-in text, with the same values.
 *
 * Rendering is one pass: only `{{name}}` keys the caller supplies are replaced,
 * and the inserted values are never scanned again, so story text that happens to
 * contain `{{char}}` or JSON braces is left alone. Rendering the built-in text
 * gives exactly the string the service built before this feature existed.
 */
import type { PromptOverride } from '../../types';
import { PROMPT_CATALOG, type PromptDefinition, type PromptId } from './promptCatalog';

export type { PromptDefinition, PromptId, PromptGroup } from './promptCatalog';
export { PROMPT_GROUPS } from './promptCatalog';

const BY_ID: ReadonlyMap<string, PromptDefinition> = new Map(PROMPT_CATALOG.map(def => [def.id, def]));

type OverrideSource = () => Record<string, PromptOverride> | undefined;
let overrideSource: OverrideSource = () => undefined;

/** The store registers the active campaign's overrides here (useAppStore.ts). */
export function setPromptOverrideSource(source: OverrideSource): void {
    overrideSource = source;
}

export function listPrompts(): readonly PromptDefinition[] {
    return PROMPT_CATALOG;
}

export function getPromptDefinition(id: string): PromptDefinition | undefined {
    return BY_ID.get(id);
}

/** A usable override for `id`, or undefined. Blank text counts as no override. */
export function activeOverride(id: string, overrides: Record<string, PromptOverride> | undefined): PromptOverride | undefined {
    const entry = overrides?.[id];
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return undefined;
    return entry;
}

/** The template text in force for `id`: the campaign's override, else the built-in. */
export function getPromptTemplate(id: PromptId): string {
    const def = BY_ID.get(id);
    if (!def) throw new Error(`Unknown prompt id: ${id}`);
    let overrides: Record<string, PromptOverride> | undefined;
    try { overrides = overrideSource(); } catch { overrides = undefined; }
    return activeOverride(id, overrides)?.text ?? def.text;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Fill `{{name}}` placeholders from `vars` in one pass. Unknown names stay as written. */
export function fillTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
    return template.replace(PLACEHOLDER, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/** Render the prompt in force for `id` with the caller's values. */
export function renderPrompt(id: PromptId, vars: Readonly<Record<string, string | number>> = {}): string {
    return fillTemplate(getPromptTemplate(id), vars);
}

/** Placeholder names a template uses, in first-seen order. */
export function placeholdersIn(text: string): string[] {
    const seen = new Set<string>();
    for (const match of text.matchAll(PLACEHOLDER)) seen.add(match[1]);
    return [...seen];
}

/** Placeholders the built-in text uses that `text` has dropped (that data would no longer reach the AI). */
export function missingPlaceholders(id: string, text: string): string[] {
    const def = BY_ID.get(id);
    if (!def) return [];
    const used = new Set(placeholdersIn(text));
    return placeholdersIn(def.text).filter(name => !used.has(name));
}

/** Placeholders in `text` the app never fills for this prompt (they reach the AI as written). */
export function unknownPlaceholders(id: string, text: string): string[] {
    const def = BY_ID.get(id);
    if (!def) return [];
    const known = new Set(Object.keys(def.placeholders));
    return placeholdersIn(text).filter(name => !known.has(name));
}

/** Short stable fingerprint of a built-in text (FNV-1a, 32-bit), to notice when it changes. */
export function hashPromptText(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** True when the built-in text has changed since this override was written. */
export function isOverrideStale(id: string, override: PromptOverride): boolean {
    const def = BY_ID.get(id);
    return !!def && !!override.baseHash && override.baseHash !== hashPromptText(def.text);
}

/**
 * Next overrides map after the user edits `id` to `text`. Text equal to the
 * built-in (or blank) removes the override, so "back to default" never leaves a
 * stale copy behind. Returns undefined when nothing is left.
 */
export function withOverride(
    overrides: Record<string, PromptOverride> | undefined,
    id: string,
    text: string,
    now: number = Date.now(),
): Record<string, PromptOverride> | undefined {
    const def = BY_ID.get(id);
    const next = { ...(overrides ?? {}) };
    if (!def || !text.trim() || text === def.text) delete next[id];
    else next[id] = { text, baseHash: hashPromptText(def.text), updatedAt: now };
    return Object.keys(next).length ? next : undefined;
}

/** Overrides map with `id` back on the built-in text. */
export function withoutOverride(overrides: Record<string, PromptOverride> | undefined, id: string): Record<string, PromptOverride> | undefined {
    if (!overrides || !(id in overrides)) return overrides;
    const next = { ...overrides };
    delete next[id];
    return Object.keys(next).length ? next : undefined;
}

/** Drop entries that are not objects with text or that name no known prompt. */
export function normalizePromptOverrides(value: unknown): Record<string, PromptOverride> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, PromptOverride> = {};
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!BY_ID.has(id) || !raw || typeof raw !== 'object') continue;
        const entry = raw as Partial<PromptOverride>;
        if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
        out[id] = {
            text: entry.text,
            baseHash: typeof entry.baseHash === 'string' ? entry.baseHash : '',
            ...(typeof entry.updatedAt === 'number' ? { updatedAt: entry.updatedAt } : {}),
        };
    }
    return Object.keys(out).length ? out : undefined;
}
