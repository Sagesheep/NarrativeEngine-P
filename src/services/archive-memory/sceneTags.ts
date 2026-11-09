import type { ArchiveIndexEntry, SceneHook, SceneHookType, SceneTagLevel, SceneTags } from '../../types';
import { safeSceneNum } from '../../utils/helpers';
import { NON_NAME_WORDS } from '../npc/witnessCapture';

/**
 * archive-memory/sceneTags.ts
 *
 * Generic scene tags and story hooks: what they are, how a model's answer is
 * validated, and how they score at recall.
 *
 * Tags say what KIND of scene something is (combat, conversation, travel...), never
 * its specific content: "which scene" is the job of keyword and meaning search.
 * They are a soft filter, a strong preference for scenes of the kind happening now,
 * never a hard one, because the memory a turn needs is often a different kind of
 * scene (reading a letter now, recalling the negotiation it refers to).
 */

export const SCENE_TAG_GROUPS = {
    kind: ['combat', 'danger', 'horror', 'mystery', 'romance', 'comedy', 'drama', 'intrigue', 'exploration', 'downtime'],
    activity: ['conversation', 'negotiation', 'investigation', 'stealth', 'travel', 'trade', 'training', 'rest_meal', 'ritual_magic', 'planning', 'reading_message', 'crafting'],
    relationship: ['bonding', 'romance_beat', 'conflict', 'trust_gained', 'trust_broken'],
    tone: ['lighthearted', 'tense', 'grim', 'eerie'],
} as const;

export type SceneTagGroup = keyof typeof SCENE_TAG_GROUPS;

/** How much a match in each group is worth. A shared mood alone says little about relevance. */
const GROUP_WEIGHTS: Record<SceneTagGroup, number> = {
    kind: 1,
    relationship: 1,
    activity: 0.8,
    tone: 0.25,
};

/** One-line meanings the model sees, so generic tags are applied the same way every time. */
const TAG_HINTS: Partial<Record<string, string>> = {
    danger: 'a threat with no fight yet',
    downtime: 'a quiet stretch with nothing at stake',
    drama: 'emotional weight between characters',
    intrigue: 'schemes, politics, hidden agendas',
    rest_meal: 'eating, drinking, sleeping, resting',
    ritual_magic: 'casting, rituals, using powers',
    reading_message: 'reading or writing letters, notes, reports',
    romance_beat: 'a romantic moment inside another kind of scene',
};

const MAX_TAGS_PER_GROUP = 3;
const MAX_HOOKS_PER_SCENE = 3;
const HOOK_TEXT_MAX_CHARS = 160;
// Sized against keyword relevance (median ~20 on a long campaign); at a tenth of that,
// tags almost never changed a rank in the probes.
const TAG_SCORE_SCALE = 6;
const PAIR_SCORE_SCALE = 4.5;
const HOOK_SCORE = 4;
/** Hooks per person at which a hook about them still counts in full. */
const HOOKS_PER_PERSON_FULL_WEIGHT = 3;
/** Below this, a name was only seen in older messages, not in the current exchange. */
const ACTIVE_NAME_MIN = 0.7;

/** The player's message says what is happening now. The GM's reply is not read for cues:
 *  a long reply names a dozen kinds of scene, which drowns the one that matters. */
const CUE_WEIGHT_PLAYER = 1;
/** The newest tagged scene, for continuity when the message itself gives no cue. */
const LAST_SCENE_WEIGHT = 0.3;

/**
 * Word cues that mark a turn as a kind of scene. English only, word starts (so
 * "fight" matches "fighting"). A cue is a hint, not a verdict: tags score softly.
 */
const TAG_CUES: Partial<Record<string, string[]>> = {
    combat: ['fight', 'attack', 'strike', 'stab', 'slash', 'punch', 'shoot', 'battle', 'duel', 'dodge', 'parry', 'ambush', 'kill', 'sword', 'weapon'],
    danger: ['danger', 'threat', 'trap', 'chase', 'flee', 'escape', 'hunted', 'pursu', 'warn'],
    horror: ['horror', 'corpse', 'scream', 'dread', 'blood', 'monster', 'rotting', 'haunt'],
    mystery: ['mystery', 'clue', 'strange', 'puzzle', 'riddle', 'unknown'],
    romance: ['kiss', 'love', 'embrace', 'blush', 'date', 'flirt', 'romance', 'hold her hand', 'hold his hand'],
    comedy: ['joke', 'laugh', 'tease', 'prank', 'funny'],
    drama: ['cry', 'tears', 'grief', 'confess', 'apolog', 'forgive', 'mourn'],
    intrigue: ['scheme', 'plot', 'spy', 'blackmail', 'conspir', 'politic', 'faction', 'secret'],
    exploration: ['explore', 'ruins', 'map', 'wander', 'venture'],
    downtime: ['relax', 'unwind', 'quiet'],
    conversation: ['ask', 'tell', 'talk', 'say', 'speak', 'chat', 'reply', 'answer'],
    negotiation: ['deal', 'bargain', 'negotiat', 'offer', 'terms', 'promise', 'contract', 'price', 'owe'],
    investigation: ['investigat', 'examine', 'inspect', 'search', 'look over', 'study', 'analy', 'clue'],
    stealth: ['sneak', 'hide', 'quietly', 'stealth', 'unseen', 'eavesdrop'],
    travel: ['travel', 'journey', 'ride', 'road', 'ship', 'sail', 'carriage', 'walk to', 'head to', 'on the way'],
    trade: ['buy', 'sell', 'shop', 'market', 'merchant', 'coin', 'gold', 'haggle'],
    training: ['train', 'practice', 'spar', 'drill', 'exercise'],
    rest_meal: ['eat', 'meal', 'dinner', 'breakfast', 'lunch', 'tea', 'drink', 'sleep', 'rest', 'nap'],
    ritual_magic: ['spell', 'ritual', 'cast', 'magic', 'enchant', 'summon'],
    planning: ['plan', 'strategy', 'prepare', 'scheme out', 'next step'],
    reading_message: ['letter', 'read', 'note', 'message', 'report', 'write to', 'scroll', 'envelope'],
    crafting: ['craft', 'forge', 'repair', 'build', 'brew', 'smith'],
};

export const SCENE_HOOK_TYPES: readonly SceneHookType[] = ['promise', 'debt', 'secret', 'threat', 'grudge', 'question'];

const TAG_GROUP = new Map<string, SceneTagGroup>(
    (Object.keys(SCENE_TAG_GROUPS) as SceneTagGroup[]).flatMap(group => SCENE_TAG_GROUPS[group].map(tag => [tag, group] as [string, SceneTagGroup])),
);

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CUE_PATTERNS = new Map<string, RegExp>(
    Object.entries(TAG_CUES).map(([tag, cues]) => [tag, new RegExp(`\\b(?:${(cues ?? []).map(escapeRegex).join('|')})`, 'i')]),
);

/** The tag list as the model sees it. */
export function renderSceneTagList(): string {
    return (Object.keys(SCENE_TAG_GROUPS) as SceneTagGroup[])
        .map(group => `- ${group}: ${SCENE_TAG_GROUPS[group].map(tag => (TAG_HINTS[tag] ? `${tag} (${TAG_HINTS[tag]})` : tag)).join(', ')}`)
        .join('\n');
}

/** Keeps defined tags only, levels 1-3, at most three per group (highest first). */
export function parseSceneTags(raw: unknown): SceneTags {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const byGroup = new Map<SceneTagGroup, [string, SceneTagLevel][]>();
    const add = (tag: string, value: unknown) => {
        const name = tag.trim().toLowerCase();
        const group = TAG_GROUP.get(name);
        if (!group || typeof value !== 'number' || !Number.isFinite(value)) return;
        const level = Math.min(3, Math.max(1, Math.round(value))) as SceneTagLevel;
        byGroup.set(group, [...(byGroup.get(group) ?? []), [name, level]]);
    };
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        // Accept both { combat: 3 } and { kind: { combat: 3 } }.
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [tag, level] of Object.entries(value as Record<string, unknown>)) add(tag, level);
        } else {
            add(key, value);
        }
    }
    const tags: SceneTags = {};
    for (const entries of byGroup.values()) {
        for (const [tag, level] of entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TAGS_PER_GROUP)) tags[tag] = level;
    }
    return tags;
}

export function parseSceneHooks(raw: unknown, sceneId: string): SceneHook[] {
    if (!Array.isArray(raw)) return [];
    const hooks: SceneHook[] = [];
    for (const item of raw) {
        if (hooks.length >= MAX_HOOKS_PER_SCENE) break;
        if (!item || typeof item !== 'object') continue;
        const h = item as Record<string, unknown>;
        const type = typeof h.type === 'string' ? h.type.trim().toLowerCase() as SceneHookType : undefined;
        const what = typeof h.what === 'string' ? h.what.trim().slice(0, HOOK_TEXT_MAX_CHARS) : '';
        if (!type || !SCENE_HOOK_TYPES.includes(type) || !what) continue;
        const withNames = Array.isArray(h.with)
            ? h.with.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map(n => n.trim())
            : [];
        hooks.push({ id: `${sceneId}:${hooks.length}`, type, with: withNames, what, status: 'open' });
    }
    return hooks;
}

export function openHooks(index: readonly ArchiveIndexEntry[]): SceneHook[] {
    return index.flatMap(entry => (entry.hooks ?? []).filter(hook => hook.status === 'open'));
}

/** Open hooks about someone this text names, the only ones it could plausibly resolve. */
export function hooksNamedInText(hooks: readonly SceneHook[], text: string): SceneHook[] {
    const lower = text.toLowerCase();
    return hooks.filter(hook => hook.with.some(name => {
        const full = name.toLowerCase();
        return lower.includes(full) || full.split(/\s+/).some(word => word.length >= 3 && !NON_NAME_WORDS.has(word) && lower.includes(word));
    }));
}

/**
 * The index patches that mark hooks closed, one per scene holding them. Hook ids
 * start with their scene id, so an unknown id simply matches nothing.
 */
export function closeHookPatches(
    index: readonly ArchiveIndexEntry[],
    hookIds: readonly string[],
    closedBy: string,
): { sceneId: string; hooks: SceneHook[] }[] {
    if (hookIds.length === 0) return [];
    const closing = new Set(hookIds);
    const patches: { sceneId: string; hooks: SceneHook[] }[] = [];
    for (const entry of index) {
        if (!entry.hooks?.some(hook => closing.has(hook.id) && hook.status === 'open')) continue;
        patches.push({
            sceneId: entry.sceneId,
            hooks: entry.hooks.map(hook => (closing.has(hook.id) && hook.status === 'open' ? { ...hook, status: 'closed' as const, closedBy } : hook)),
        });
    }
    return patches;
}

/** Tags whose cue words appear in the text, weighted. */
export function tagsCuedByText(text: string, weight: number): Record<string, number> {
    const cued: Record<string, number> = {};
    if (!text) return cued;
    for (const [tag, pattern] of CUE_PATTERNS) if (pattern.test(text)) cued[tag] = weight;
    return cued;
}

/**
 * Tag → weight 0-1 for what is happening now: the player's message, then (weakly) the
 * newest tagged scene for continuity.
 */
export function deriveActiveTags(
    index: readonly ArchiveIndexEntry[],
    userMessage = '',
): Record<string, number> {
    const active: Record<string, number> = {};
    const merge = (tags: Record<string, number>) => {
        for (const [tag, weight] of Object.entries(tags)) active[tag] = Math.max(active[tag] ?? 0, weight);
    };
    merge(tagsCuedByText(userMessage, CUE_WEIGHT_PLAYER));

    let newest: ArchiveIndexEntry | undefined;
    for (const entry of index) {
        if (!entry.tags || Object.keys(entry.tags).length === 0) continue;
        if (!newest || safeSceneNum(entry.sceneId) > safeSceneNum(newest.sceneId)) newest = entry;
    }
    const fromScene: Record<string, number> = {};
    for (const [tag, level] of Object.entries(newest?.tags ?? {})) fromScene[tag] = LAST_SCENE_WEIGHT * (level / 3);
    merge(fromScene);
    return active;
}

/** BM25-style rarity: a key on every scene adds almost nothing. */
function rarity(counts: Record<string, number>, total: number): Record<string, number> {
    const idf: Record<string, number> = {};
    for (const [key, count] of Object.entries(counts)) idf[key] = Math.log(1 + (total - count + 0.5) / (count + 0.5));
    return idf;
}

export function computeTagIdf(index: readonly ArchiveIndexEntry[]): Record<string, number> {
    const df: Record<string, number> = {};
    for (const entry of index) {
        for (const tag of Object.keys(entry.tags ?? {})) df[tag] = (df[tag] ?? 0) + 1;
    }
    return rarity(df, index.length);
}

/** The people in a scene, lowercase: who was there and who it names. */
function scenePeople(entry: ArchiveIndexEntry): string[] {
    return [...new Set([...(entry.witnesses ?? []), ...Object.keys(entry.npcStrengths ?? {})].map(n => n.toLowerCase()))];
}

const pairKey = (person: string, tag: string) => `${person}|${tag}`;

/** Rarity of each person + tag pair, so "Rin + romance" outweighs "Rin + tense". */
export function computePairIdf(index: readonly ArchiveIndexEntry[]): Record<string, number> {
    const df: Record<string, number> = {};
    for (const entry of index) {
        const tags = Object.keys(entry.tags ?? {});
        if (tags.length === 0) continue;
        for (const person of scenePeople(entry)) for (const tag of tags) df[pairKey(person, tag)] = (df[pairKey(person, tag)] ?? 0) + 1;
    }
    return rarity(df, index.length);
}

export function scoreSceneTags(
    entry: ArchiveIndexEntry,
    activeTags: Record<string, number>,
    tagIdf: Record<string, number>,
): number {
    let score = 0;
    for (const [tag, level] of Object.entries(entry.tags ?? {})) {
        const active = activeTags[tag];
        const group = TAG_GROUP.get(tag);
        if (!active || !group) continue;
        score += active * (level / 3) * GROUP_WEIGHTS[group] * (tagIdf[tag] ?? 1);
    }
    return score * TAG_SCORE_SCALE;
}

/**
 * The same kind of moment with the same person: someone named in the current exchange
 * was in this scene, and the scene has a tag matching now. Only the best pair counts,
 * so a scene crowded with people and tags gains nothing extra.
 */
export function scorePersonTagPairs(
    entry: ArchiveIndexEntry,
    activeTags: Record<string, number>,
    activations: Record<string, number>,
    pairIdf: Record<string, number>,
): number {
    let best = 0;
    for (const person of scenePeople(entry)) {
        const named = activations[person] ?? 0;
        if (named < ACTIVE_NAME_MIN) continue;
        for (const [tag, level] of Object.entries(entry.tags ?? {})) {
            const active = activeTags[tag];
            const group = TAG_GROUP.get(tag);
            if (!active || !group) continue;
            best = Math.max(best, named * active * (level / 3) * GROUP_WEIGHTS[group] * (pairIdf[pairKey(person, tag)] ?? 1));
        }
    }
    return best * PAIR_SCORE_SCALE;
}

/** Open hooks per person (lowercase full name), for weighting popular characters down. */
export function countOpenHooksByPerson(index: readonly ArchiveIndexEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const hook of openHooks(index)) {
        for (const name of new Set(hook.with.map(n => n.toLowerCase()))) counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
}

function hookActivation(hook: SceneHook, activations: Record<string, number>, hookCounts: Record<string, number>): number {
    let best = 0;
    for (const name of hook.with) {
        const lower = name.toLowerCase();
        let named = activations[lower] ?? 0;
        for (const word of lower.split(/\s+/)) {
            if (word.length >= 3 && !NON_NAME_WORDS.has(word)) named = Math.max(named, activations[word] ?? 0);
        }
        if (named < ACTIVE_NAME_MIN) continue;
        // Someone with dozens of open hooks (a constant companion) matches every turn,
        // so each of their hooks says less about this one.
        const count = hookCounts[lower] ?? 1;
        const popularity = count <= HOOKS_PER_PERSON_FULL_WEIGHT ? 1 : Math.sqrt(HOOKS_PER_PERSON_FULL_WEIGHT / count);
        best = Math.max(best, named * popularity);
    }
    return best;
}

/** Unfinished business with someone in the current exchange. */
export function scoreOpenHooks(
    entry: ArchiveIndexEntry,
    activations: Record<string, number>,
    hookCounts: Record<string, number> = {},
): number {
    let best = 0;
    for (const hook of entry.hooks ?? []) {
        if (hook.status !== 'open') continue;
        best = Math.max(best, hookActivation(hook, activations, hookCounts));
    }
    return best * HOOK_SCORE;
}
