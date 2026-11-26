import type { LoreChunk, WorldLoreDraft } from '../../types';
import { uid } from '../../utils/uid';
import { countTokens } from '../infrastructure/tokenizer';
import { chunkLoreFile } from './loreChunker';
import { exportDraftToMarkdown } from './worldLoreExport';
import { MAX_WORLD_FILE_BYTES, MAX_WORLD_PAYLOAD_BYTES, readSTWorldPng, readWorldPng } from './worldCardPng';

export const WORLD_CARD_FORMAT = 'narrative-engine-world';
export type WorldCard = {
    format: typeof WORLD_CARD_FORMAT;
    version: 1;
    world: { name: string; author: string; description: string; chunks: LoreChunk[]; draft?: WorldLoreDraft };
};
export type WorldImport = { card: WorldCard; source: 'native' | 'sillytavern'; warnings: string[] };
const FLAT = ['background', 'languages', 'powerSystem', 'techEconomy', 'timeline', 'toneBoundaries', 'houseRules', 'characterCreationQuestions'] as const;
const LISTS = ['locations', 'cultures', 'factions', 'threats', 'npcs'] as const;
const CATEGORIES = ['world_overview', 'faction', 'location', 'character', 'power_system', 'economy', 'event', 'relationship', 'rules', 'culture', 'misc'];

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a world data object.');
    return value as Record<string, unknown>;
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid lore keyword list.');
    return value;
}
function finite(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function bool(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : fallback;
}

/** Allowlist world fields: share files never include campaign state or credentials. */
export function validateChunks(value: unknown): LoreChunk[] {
    if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid lore entries (maximum 10,000).');
    const ids = new Set<string>();
    return value.map((raw, index) => {
        const c = record(raw);
        if (typeof c.content !== 'string' || typeof c.header !== 'string') throw new Error(`Invalid lore entry ${index + 1}.`);
        const id = text(c.id) || `entry-${index}`;
        if (ids.has(id)) throw new Error('Duplicate lore entry IDs.');
        ids.add(id);
        if (c.ragMode !== undefined && !['always', 'keyword', 'vector'].includes(text(c.ragMode))) throw new Error('Unsupported lore retrieval mode.');
        return {
            id, header: c.header, content: c.content,
            tokens: countTokens(`${c.header}\n${c.content}`),
            alwaysInclude: bool(c.alwaysInclude), triggerKeywords: strings(c.triggerKeywords ?? []),
            secondaryKeywords: c.secondaryKeywords === undefined ? undefined : strings(c.secondaryKeywords),
            ragMode: c.ragMode as LoreChunk['ragMode'], disabled: bool(c.disabled),
            scanDepth: Math.max(1, Math.min(100, finite(c.scanDepth, 3))),
            category: (CATEGORIES.includes(text(c.category)) ? c.category : 'misc') as LoreChunk['category'],
            linkedEntities: strings(c.linkedEntities ?? []), priority: finite(c.priority, 5),
            parentSection: typeof c.parentSection === 'string' ? c.parentSection : undefined,
            summary: typeof c.summary === 'string' ? c.summary : undefined,
            group: typeof c.group === 'string' ? c.group : undefined,
            groupWeight: typeof c.groupWeight === 'number' ? finite(c.groupWeight, 5) : undefined,
        };
    });
}

export function emptyWorldDraft(name: string): WorldLoreDraft {
    return { id: uid(), name, background: '', languages: '', powerSystem: '', techEconomy: '', timeline: '',
        toneBoundaries: '', houseRules: '', characterCreationQuestions: '', locations: [], cultures: [],
        factions: [], threats: [], npcs: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function validateDraft(value: unknown, name: string): WorldLoreDraft {
    const raw = record(value);
    const draft = emptyWorldDraft(name);
    for (const key of FLAT) {
        if (typeof raw[key] !== 'string') throw new Error(`Invalid world section: ${key}.`);
        draft[key] = raw[key];
    }
    for (const key of LISTS) {
        if (!Array.isArray(raw[key]) || raw[key].length > 10000) throw new Error(`Invalid world section: ${key}.`);
        draft[key] = raw[key].map(item => {
            const row = record(item);
            if (typeof row.title !== 'string' || typeof row.body !== 'string') throw new Error('Invalid world section entry.');
            return { id: uid(), title: row.title, body: row.body };
        });
    }
    if (raw.importedLoreChunks !== undefined) draft.importedLoreChunks = validateChunks(raw.importedLoreChunks);
    if (raw.worldCardMetadata) {
        const meta = record(raw.worldCardMetadata);
        draft.worldCardMetadata = { author: text(meta.author), description: text(meta.description) };
    }
    return draft;
}

export function createWorldCard(name: string, chunks: LoreChunk[], draft?: WorldLoreDraft): WorldCard {
    return { format: WORLD_CARD_FORMAT, version: 1, world: {
        name: name.trim() || 'Untitled World', author: '', description: '', chunks: validateChunks(chunks),
        ...(draft ? { draft: validateDraft(draft, name) } : {}),
    } };
}

export function cardFromDraft(draft: WorldLoreDraft): WorldCard {
    const chunks = chunkLoreFile(exportDraftToMarkdown({ ...draft, importedLoreChunks: undefined }));
    const imported = (draft.importedLoreChunks ?? []).map(c => ({ ...c, id: uid() }));
    const card = createWorldCard(draft.name, [...chunks, ...imported], draft);
    card.world.author = draft.worldCardMetadata?.author ?? '';
    card.world.description = draft.worldCardMetadata?.description ?? '';
    return card;
}

export function draftFromCard(card: WorldCard): WorldLoreDraft {
    const draft = card.world.draft ? validateDraft(card.world.draft, card.world.name)
        : { ...emptyWorldDraft(card.world.name), importedLoreChunks: card.world.chunks.map(c => ({ ...c, id: uid() })) };
    draft.worldCardMetadata = { author: card.world.author, description: card.world.description };
    return draft;
}

export function parseWorldJson(raw: unknown, fallbackName = 'Imported World'): WorldImport {
    const root = record(raw);
    if (root.format === WORLD_CARD_FORMAT) {
        if (root.version !== 1) throw new Error('This world card needs a newer version of Narrative Engine.');
        const world = record(root.world);
        if (typeof world.name !== 'string' || !world.name.trim()) throw new Error('The world card has no name.');
        const card = createWorldCard(world.name, validateChunks(world.chunks));
        card.world.author = text(world.author);
        card.world.description = text(world.description);
        if (world.draft !== undefined) card.world.draft = validateDraft(world.draft, world.name);
        return { card, source: 'native', warnings: [] };
    }
    if (root.format !== undefined) throw new Error('Unsupported world file format.');
    return adaptSTLore(root, fallbackName);
}

function adaptSTLore(root: Record<string, unknown>, fallbackName: string): WorldImport {
    const data = root.data && typeof root.data === 'object' ? record(root.data) : root;
    const isCard = root.spec !== undefined || data.character_book !== undefined || data.first_mes !== undefined;
    const book = isCard ? (data.character_book ? record(data.character_book) : null) : root;
    if (!book || !book.entries || typeof book.entries !== 'object') {
        throw new Error('No embedded lorebook found. Character descriptions and greetings are not world lore.');
    }
    const entries = Array.isArray(book.entries) ? book.entries : Object.values(record(book.entries));
    if (entries.length > 10000) throw new Error('Lorebooks may contain at most 10,000 entries.');
    const warnings = new Set<string>([
        'Imported lore uses Narrative Engine retrieval. SillyTavern prompt positions, probability, recursion, scripts and other advanced activation settings are not reproduced.',
    ]);
    if (isCard) warnings.add('Only the embedded lorebook is imported. Character identity, greetings, examples and system prompts are excluded.');
    const keyList = (value: unknown) => typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : strings(value ?? []);
    const chunks: LoreChunk[] = [];
    for (const raw of entries) {
        const e = record(raw);
        if (!text(e.content).trim()) { warnings.add('Empty entries were skipped.'); continue; }
        const ext = e.extensions && typeof e.extensions === 'object' ? record(e.extensions) : {};
        const header = text(e.comment) || text(e.name) || keyList(e.keys ?? e.key).join(', ') || `Lore ${chunks.length + 1}`;
        const content = text(e.content);
        const secondary = keyList(e.secondary_keys ?? e.keysecondary);
        const selective = bool(e.selective);
        const logic = finite(e.selectiveLogic ?? ext.selectiveLogic, 0);
        const unsupportedGate = selective && secondary.length > 0 && logic !== 0;
        const hasMacro = /\{\{|<BOT>|<USER>/i.test(content + header);
        if (unsupportedGate) warnings.add('Entries with unsupported secondary-key logic were imported disabled for review.');
        if (hasMacro) warnings.add('Entries containing SillyTavern macros were imported disabled; edit them before enabling.');
        const constant = bool(e.constant);
        chunks.push({ id: uid(), header, content, tokens: countTokens(`${header}\n${content}`),
            triggerKeywords: keyList(e.keys ?? e.key), secondaryKeywords: selective && secondary.length ? secondary : undefined,
            alwaysInclude: constant, ragMode: constant ? 'always' : 'keyword',
            disabled: unsupportedGate || hasMacro || !bool(e.enabled, !bool(e.disable)),
            scanDepth: Math.max(1, Math.min(100, finite(e.scanDepth ?? ext.scan_depth ?? book.scan_depth, 3))),
            category: 'misc', linkedEntities: [], priority: 5,
        });
    }
    if (!chunks.length) throw new Error('This lorebook contains no lore text.');
    const card = createWorldCard(text(book.name) || fallbackName, chunks);
    card.world.description = text(book.description);
    return { card, source: 'sillytavern', warnings: [...warnings] };
}

export async function readWorldFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer' | 'text'>): Promise<WorldImport> {
    if (file.size > MAX_WORLD_FILE_BYTES) throw new Error('World files must be smaller than 20 MB.');
    const name = file.name.replace(/\.[^.]+$/, '');
    if (/\.png$/i.test(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return parseWorldJson(readWorldPng(bytes) ?? readSTWorldPng(bytes), name);
    }
    if (!/\.json$/i.test(file.name)) throw new Error('Choose a world PNG or lorebook JSON file.');
    if (file.size > MAX_WORLD_PAYLOAD_BYTES) throw new Error('World JSON exceeds the 4 MB limit.');
    let raw: unknown;
    try { raw = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON.'); }
    return parseWorldJson(raw, name);
}
