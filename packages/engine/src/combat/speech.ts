import type { Combatant, Speech } from './types';

export const SPEECH_VALUES: readonly Speech[] = ['speaks', 'sounds', 'silent'];

export const SOUNDS_KEYWORDS: readonly string[] = [
    'dog', 'hound', 'wolf', 'wolfhound', 'mastiff', 'jackal', 'hyena', 'fox', 'coyote', 'pup', 'cub',
    'bear', 'boar', 'pig', 'hog', 'rat', 'mouse', 'rodent', 'vermin', 'cat', 'panther', 'lion', 'tiger', 'leopard', 'cougar', 'lynx',
    'spider', 'snake', 'serpent', 'viper', 'cobra', 'lizard', 'crocodile', 'alligator', 'toad', 'frog', 'crab',
    'bat', 'crow', 'raven', 'hawk', 'eagle', 'owl', 'vulture', 'bird', 'raptor',
    'shark', 'fish', 'eel', 'piranha', 'wasp', 'bee', 'hornet', 'scorpion', 'beetle', 'ant', 'centipede', 'leech', 'worm',
    'stag', 'deer', 'bull', 'ox', 'horse', 'mare', 'stallion', 'ape', 'gorilla', 'monkey', 'baboon',
    'beast', 'animal',
];

export const SILENT_KEYWORDS: readonly string[] = [
    'slime', 'ooze', 'jelly', 'pudding', 'blob', 'golem', 'construct', 'automaton', 'turret', 'drone', 'robot', 'mech', 'bot',
    'skeleton', 'zombie', 'husk', 'shambler', 'swarm', 'elemental', 'mimic', 'wisp', 'spore', 'fungus', 'statue', 'scarecrow',
];

export const SPEAKS_KEYWORDS: readonly string[] = [
    'human', 'person', 'man', 'woman', 'elf', 'dwarf', 'orc', 'goblin', 'halfling', 'gnome', 'humanoid', 'android', 'cyborg',
];

const WORN_AFTER: ReadonlySet<string> = new Set([
    'pelt', 'hide', 'skin', 'fur', 'cloak', 'cape', 'mantle', 'tooth', 'teeth', 'fang', 'claw', 'tattoo', 'mask', 'helm', 'helmet',
    'brand', 'emblem', 'sigil', 'banner', 'head', 'skull', 'motif', 'print', 'collar', 'tail', 'coat', 'vest', 'hood',
]);

const IRREGULAR: Readonly<Record<string, string>> = { mice: 'mouse', geese: 'goose', lice: 'louse', wolves: 'wolf', oxen: 'ox', men: 'man', women: 'woman', elves: 'elf', dwarves: 'dwarf' };

function singular(word: string): string {
    if (IRREGULAR[word]) return IRREGULAR[word];
    if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
    if (word.endsWith('ves') && word.length > 4) return `${word.slice(0, -3)}f`;
    if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
    if (word.endsWith('s') && word.length > 2) return word.slice(0, -1);
    return word;
}

function tokens(text: string | undefined): string[] {
    return (text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

function matches(word: string, list: ReadonlySet<string>): boolean {
    return list.has(word) || list.has(singular(word)) || (word.endsWith('es') && list.has(word.slice(0, -1)));
}

const SOUNDS_SET: ReadonlySet<string> = new Set(SOUNDS_KEYWORDS);
const SILENT_SET: ReadonlySet<string> = new Set(SILENT_KEYWORDS);
const SPEAKS_SET: ReadonlySet<string> = new Set(SPEAKS_KEYWORDS);

function anyIn(words: readonly string[], list: ReadonlySet<string>, skipWorn = false): boolean {
    return words.some((w, i) => matches(w, list) && !(skipWorn && i + 1 < words.length && WORN_AFTER.has(singular(words[i + 1]))));
}

export function normalizeSpeech(raw: unknown): Speech | undefined {
    if (typeof raw !== 'string') return undefined;
    const lower = raw.trim().toLowerCase();
    return (SPEECH_VALUES as readonly string[]).includes(lower) ? lower as Speech : undefined;
}

export function inferSpeech(c: Pick<Combatant, 'name' | 'species' | 'look'>): Speech {
    const species = tokens(c.species);
    const named = [...tokens(c.name), ...species];
    if (anyIn(species, SPEAKS_SET)) return 'speaks';
    if (anyIn(named, SILENT_SET)) return 'silent';
    if (anyIn(named, SOUNDS_SET)) return 'sounds';
    const look = tokens(c.look);
    if (anyIn(look, SILENT_SET, true)) return 'silent';
    if (anyIn(look, SOUNDS_SET, true)) return 'sounds';
    return 'speaks';
}

export function speechOf(c: Pick<Combatant, 'speech' | 'npcId' | 'side' | 'name' | 'species' | 'look'>): Speech {
    if (c.speech) return c.speech;
    if (c.npcId || c.side === 'player') return 'speaks';
    return inferSpeech(c);
}

export function canSpeak(c: Pick<Combatant, 'speech' | 'npcId' | 'side' | 'name' | 'species' | 'look'>): boolean {
    return speechOf(c) === 'speaks';
}
