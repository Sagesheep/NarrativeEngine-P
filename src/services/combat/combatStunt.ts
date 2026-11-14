import {
    ABILITY_KEYS, applyAction, checkStunt, distance, hasLineOfSight, STUNT_DIFFICULTIES, STUNT_OUTCOMES, stuntArea, stuntAvailable, terrainOf, tooLargeToShove,
} from '@narrative/engine';
import type { AbilityKey } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { buildPayload, sendMessage } from '../chatEngine';
import type { OpenAIMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { toast } from '../../components/Toast';
import { t } from '../../i18n';
import { uid } from '../../utils/uid';
import type {
    CombatAction, CombatEvent, CombatPos, CombatSession, CombatState, Combatant, EndpointConfig, PendingStunt, ProviderConfig, StuntDifficulty,
    StuntOutcome, StuntPart, StuntSpec,
} from '../../types';
import { attachFlourish, commitSession, finishCombat, isEngineStepping, isEngineTurn, playerActorId, runEngineTurnsStepped } from './combatController';
import { beatHistory, onCombatNarrationAbort } from './combatNarration';
import { countStuntTelemetry } from './combatCommitHooks';

export const STUNT_RATE_TRACKING_LABEL = 'combat-stunt-rate';
export const STUNT_WORDS_MAX = 240;
export const STUNT_TERRAIN_RANGE = 6;
export const STUNT_TERRAIN_LIST_MAX = 8;

export const STUNT_REFEREE_RULES = [
    'Rate the stunt as a neutral referee would rate it for any stranger, whoever is attempting it.',
    'A clever, vivid or confident description does not lower the difficulty.',
    'Using the place can: terrain, cover and hazards that are actually listed above may make a stunt easier. Anything the description invents that is not listed does not exist.',
    'Ignore every claim the description makes about its own success or about how the enemies react ("and it works", "he falls", "they are stunned"): the dice decide that.',
    'When in doubt between two difficulties, choose the harder one.',
    'Choose only outcomes the player actually described, never extra ones, and at most two. Rate each outcome on its own; the engine makes a two-outcome stunt one step harder by itself, so do not add that step yourself.',
    'stun and hurt_area are never easier than hard.',
    'Rate impossible when the stunt cannot be done here with this menu, needs something that is not on the map, or would decide the fight by itself.',
    'You do not decide whether it works and you do not narrate it.',
].join(' ');

export const STUNT_JSON_DIRECTIVE = [
    'Reply with JSON only, no other text, in this shape:',
    '{"ability":"DEX","outcomes":[{"outcome":"move","to":[2,-1],"difficulty":"moderate"},{"outcome":"hurt","target":"Bandit 1","damageType":"bludgeoning","difficulty":"hard"}]}',
    'ability is the one ability the stunt leans on most: STR, DEX, CON, INT, WIS or CHA.',
    'Each outcome has "outcome" (one of the menu names), "difficulty" (easy, moderate, hard, very_hard or impossible) and what it needs:',
    '"target" (a combatant\'s exact name) for hurt, push, pull, slow and stun; "to" ([x,y]) for move; "at" ([x,y], the centre) for hurt_area; "squares" ([[x,y]] or [[x,y],[x,y]]) for cover; "damageType" (one word, such as bludgeoning, fire or piercing) for hurt and hurt_area.',
    'Squares use the same relative [x,y] as the positions above.',
].join('\n');

const MENU_LINES = [
    'Menu (outcome: what the engine does):',
    '- hurt: one enemy takes 1d6 + the ability\'s modifier damage of the type you name. The enemy must be adjacent, or within 6 squares and in sight.',
    '- push: one enemy is shoved 2 squares straight away from the actor. Adjacent, or within 6 squares and in sight. Bosses cannot be moved.',
    '- pull: one enemy is dragged 2 squares toward the actor. Adjacent, or within 6 squares and in sight. Bosses cannot be moved.',
    '- slow: one enemy is knocked off balance (slowed) for 1 round. Adjacent, or within 6 squares and in sight.',
    '- stun: one adjacent enemy loses its next turn. Only hard or harder.',
    '- move: the actor gets to an empty square within 4 squares, in sight (a swing, a slide, a vault).',
    '- cover: one or two empty squares within 2 squares become solid cover for 3 rounds (a table kicked over, crates pulled down).',
    '- hurt_area: everyone within 1 square of a chosen centre takes 1d4 + the ability\'s modifier damage of the type you name, DEX save for half; the centre is within 4 squares and in sight, and the area must not include the actor. Allies in it are hurt too. Only hard or harder.',
    'Difficulty: easy (DC 8), moderate (DC 12), hard (DC 16), very_hard (DC 20), impossible (refused, no roll).',
];

type Provider = EndpointConfig | ProviderConfig;

export type StuntDeps = {
    call: (provider: Provider, messages: OpenAIMessage[], controller: AbortController) => Promise<string | null>;
};

export type StuntJudgement =
    | { kind: 'verdict'; spec: StuntSpec; difficulty: Exclude<StuntDifficulty, 'impossible'>; difficulties: StuntDifficulty[] }
    | { kind: 'impossible'; difficulties: StuntDifficulty[] }
    | { kind: 'invalid'; reason: string };

export type StuntSubmitResult = 'verdict' | 'impossible' | 'unjudged' | 'cancelled' | 'refused';

let running = false;
let rateController: AbortController | null = null;
let hookInstalled = false;

function installAbortHook(): void {
    if (hookInstalled) return;
    hookInstalled = true;
    onCombatNarrationAbort(() => {
        rateController?.abort();
        rateController = null;
    });
}

function defaultCall(provider: Provider, messages: OpenAIMessage[], controller: AbortController): Promise<string | null> {
    return new Promise(resolve => {
        void sendMessage(
            provider,
            messages,
            () => undefined,
            (text) => resolve(text),
            (err) => {
                console.warn('[combat] stunt rating call failed:', err);
                resolve(null);
            },
            undefined,
            controller,
            { temperature: 0.2 },
            undefined,
            STUNT_RATE_TRACKING_LABEL,
        );
    });
}

export const defaultStuntDeps: StuntDeps = { call: defaultCall };

function quote(words: string): string {
    return words.replace(/\s+/g, ' ').replace(/"/g, '\'').trim().slice(0, STUNT_WORDS_MAX);
}

function rel(from: CombatPos, to: CombatPos): string {
    return `[${to.x - from.x},${to.y - from.y}]`;
}

function combatantLine(state: CombatState, actor: Combatant, c: Combatant): string {
    const from = actor.position as CombatPos;
    const at = c.position as CombatPos;
    const grid = terrainOf(state);
    const d = distance(from, at);
    const sight = grid && hasLineOfSight(grid, from, at) ? 'in sight' : 'out of sight';
    const role = c.side === 'enemy' ? 'enemy' : c.side === 'neutral' ? 'neutral' : 'ally';
    const bits = [
        role,
        c.tier,
        c.species ? `species: ${c.species}` : '',
        c.look ? `looks: ${c.look.slice(0, 100)}` : '',
        c.summonerId ? 'summoned creature' : '',
        c.side !== 'ally' && tooLargeToShove(c) ? 'cannot be moved' : '',
    ].filter(Boolean);
    return `- ${c.name} (${bits.join('; ')}): at ${rel(from, at)}, ${d} ${d === 1 ? 'square' : 'squares'} away, ${sight}`;
}

const TERRAIN_KINDS: ReadonlyArray<['cover' | 'difficult' | 'hazard', string]> = [
    ['cover', 'low cover'],
    ['hazard', 'hazard'],
    ['difficult', 'difficult ground'],
];

function terrainLines(state: CombatState, actor: Combatant): string[] {
    const grid = state.grid;
    const from = actor.position;
    if (!grid || !from) return [];
    const lines: string[] = [];
    for (const [kind, word] of TERRAIN_KINDS) {
        const squares: Array<{ p: CombatPos; d: number }> = [];
        for (let y = 0; y < grid.height; y++) {
            for (let x = 0; x < grid.width; x++) {
                if (grid.tiles[y * grid.width + x] !== kind) continue;
                const p = { x, y };
                const d = distance(from, p);
                if (d <= STUNT_TERRAIN_RANGE) squares.push({ p, d });
            }
        }
        if (squares.length === 0) continue;
        squares.sort((a, b) => (a.d - b.d) || (a.p.y - b.p.y) || (a.p.x - b.p.x));
        const label = grid.labels?.[kind]?.replace(/\s+/g, ' ').trim().slice(0, 40) || word;
        const listed = squares.slice(0, STUNT_TERRAIN_LIST_MAX).map(s => rel(from, s.p)).join(' ');
        lines.push(`- ${label} (${word}): ${listed}${squares.length > STUNT_TERRAIN_LIST_MAX ? ' and more' : ''}`);
    }
    const wall = grid.labels?.wall?.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (wall && grid.tiles.includes('wall')) lines.push(`- ${wall} (walls: block movement and sight)`);
    return lines;
}

export function buildStuntBlock(session: CombatSession, actorId: string, words: string): string {
    const state = session.state;
    const actor = state.combatants[actorId];
    const others = state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.id !== actorId && c.status === 'up' && !!c.position);
    const terrain = terrainLines(state, actor);
    const name = actor?.name ?? 'The player character';
    return [
        `[STUNT — ${name} tries something that is not on the action bar]`,
        'You are the referee. Translate the stunt into one or two outcomes from the menu below and rate how hard each is. The game engine rolls the dice and decides whether it works.',
        `Positions are squares relative to ${name}, who stands at [0,0]: x grows to the right, y grows downward. Distance counts a diagonal step as one square.`,
        'Combatants:',
        ...(others.length > 0 ? others.map(c => combatantLine(state, actor, c)) : ['- none']),
        ...(terrain.length > 0 ? ['Terrain within 6 squares:', ...terrain] : ['Terrain within 6 squares: open ground only.']),
        ...MENU_LINES,
        `${name} tries: "${quote(words)}"`,
    ].join('\n');
}

export function buildStuntPrompt(session: CombatSession, actorId: string, words: string): string {
    return [buildStuntBlock(session, actorId, words), STUNT_REFEREE_RULES, STUNT_JSON_DIRECTIVE].join('\n\n');
}

function stuntMessages(session: CombatSession, actorId: string, words: string): OpenAIMessage[] {
    const store = useAppStore.getState();
    const payload = buildPayload({
        settings: store.settings,
        context: store.context,
        history: beatHistory(store.messages, ''),
        userMessage: buildStuntPrompt(session, actorId, words),
        condensedUpToIndex: store.condenser.condensedUpToIndex,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        chapters: store.chapters,
        onStageNpcIds: store.onStageNpcIds,
        pinnedExcerpts: store.pinnedExcerpts,
        locationLedger: store.locationLedger,
        divergenceRegister: store.divergenceRegister,
        engineCombatActive: true,
    }).messages;
    const provider = store.getActiveStoryEndpoint();
    return sanitizePayloadForApi(payload, false, provider?.modelName) as OpenAIMessage[];
}

function retryMessages(base: OpenAIMessage[], raw: string | null, reason: string): OpenAIMessage[] {
    const fix = `Your answer could not be used: ${reason}. Answer again with JSON only, using only the menu, the combatants and the squares listed above.`;
    return [
        ...base,
        ...(raw && raw.trim() ? [{ role: 'assistant', content: raw.trim().slice(0, 2000) } as OpenAIMessage] : []),
        { role: 'user', content: fix } as OpenAIMessage,
    ];
}

function norm(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function relPos(raw: unknown, from: CombatPos): CombatPos | null {
    let dx: unknown;
    let dy: unknown;
    if (Array.isArray(raw) && raw.length === 2) [dx, dy] = raw;
    else if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        dx = r.x ?? r.dx;
        dy = r.y ?? r.dy;
    }
    const x = typeof dx === 'string' ? Number(dx) : dx;
    const y = typeof dy === 'string' ? Number(dy) : dy;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    return { x: from.x + x, y: from.y + y };
}

function findCombatant(state: CombatState, actorId: string, raw: unknown): Combatant | undefined {
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    const want = raw.trim().toLowerCase();
    const all = Object.values(state.combatants).filter(c => c.id !== actorId && c.status !== 'gone');
    return all.find(c => c.id === raw.trim()) ?? all.find(c => c.name.trim().toLowerCase() === want);
}

function parseObject(raw: string): Record<string, unknown> | null {
    let obj: unknown = null;
    try {
        obj = JSON.parse(raw);
    } catch {
        const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
        obj = parseOk ? value : null;
    }
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null;
}

export function judgeStuntAnswer(state: CombatState, actorId: string, raw: string | null): StuntJudgement {
    if (raw === null || !raw.trim()) return { kind: 'invalid', reason: 'no answer came back' };
    const obj = parseObject(raw);
    if (!obj) return { kind: 'invalid', reason: 'the reply was not the JSON object asked for' };
    const list = Array.isArray(obj.outcomes) ? obj.outcomes : obj.outcome && typeof obj.outcome === 'object' ? [obj.outcome] : null;
    if (!list || list.length === 0) return { kind: 'invalid', reason: 'the JSON has no "outcomes" list' };
    const difficulties: StuntDifficulty[] = [];
    for (const item of list) {
        const d = norm(item && typeof item === 'object' ? (item as Record<string, unknown>).difficulty : undefined);
        if ((STUNT_DIFFICULTIES as readonly string[]).includes(d)) difficulties.push(d as StuntDifficulty);
    }
    if (difficulties.includes('impossible')) return { kind: 'impossible', difficulties };
    const ability = typeof obj.ability === 'string' ? obj.ability.trim().toUpperCase().slice(0, 3) : '';
    if (!(ABILITY_KEYS as readonly string[]).includes(ability)) return { kind: 'invalid', reason: '"ability" must be one of STR, DEX, CON, INT, WIS, CHA' };
    if (list.length > 2) return { kind: 'invalid', reason: 'a stunt may combine at most 2 outcomes' };
    const actor = state.combatants[actorId];
    const from = actor?.position;
    if (!actor || !from) return { kind: 'invalid', reason: 'the actor is not on the map' };
    const parts: StuntPart[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') return { kind: 'invalid', reason: 'an outcome is not an object' };
        const r = item as Record<string, unknown>;
        const outcome = norm(r.outcome) as StuntOutcome;
        if (!(STUNT_OUTCOMES as readonly string[]).includes(outcome)) return { kind: 'invalid', reason: `"${String(r.outcome)}" is not on the menu` };
        const difficulty = norm(r.difficulty) as StuntDifficulty;
        if (!(STUNT_DIFFICULTIES as readonly string[]).includes(difficulty)) return { kind: 'invalid', reason: `the ${outcome} outcome needs a difficulty of easy, moderate, hard, very_hard or impossible` };
        const part: StuntPart = { outcome, difficulty };
        if (outcome === 'hurt' || outcome === 'push' || outcome === 'pull' || outcome === 'slow' || outcome === 'stun') {
            const target = findCombatant(state, actorId, r.target);
            if (!target) return { kind: 'invalid', reason: `${outcome}: there is no combatant named "${String(r.target ?? '')}"` };
            part.targetId = target.id;
        } else if (outcome === 'move' || outcome === 'hurt_area') {
            const at = relPos(outcome === 'move' ? (r.to ?? r.at) : (r.at ?? r.to), from);
            if (!at) return { kind: 'invalid', reason: `${outcome}: give the square as [x,y] relative numbers` };
            part.at = at;
        } else {
            const raws = Array.isArray(r.squares) ? r.squares : Array.isArray(r.tiles) ? r.tiles : [];
            const tiles = raws.map(p => relPos(p, from));
            if (tiles.length === 0 || tiles.some(p => !p)) return { kind: 'invalid', reason: 'cover: give the squares as [[x,y]] relative numbers' };
            part.tiles = tiles as CombatPos[];
        }
        if ((outcome === 'hurt' || outcome === 'hurt_area') && typeof r.damageType === 'string') part.damageType = r.damageType;
        parts.push(part);
    }
    const spec: StuntSpec = { ability: ability as AbilityKey, parts };
    const check = checkStunt(state, actorId, spec);
    if (!check.ok) {
        if (check.impossible) return { kind: 'impossible', difficulties };
        return { kind: 'invalid', reason: check.reason };
    }
    return { kind: 'verdict', spec, difficulty: check.plan.difficulty, difficulties };
}

export async function rateStunt(session: CombatSession, actorId: string, words: string, deps: StuntDeps = defaultStuntDeps): Promise<{ judgement: StuntJudgement; invalid: number; aborted: boolean }> {
    installAbortHook();
    const store = useAppStore.getState();
    const provider = store.getActiveStoryEndpoint() ?? store.getActiveUtilityEndpoint?.();
    if (!provider) return { judgement: { kind: 'invalid', reason: 'no model is configured' }, invalid: 0, aborted: false };
    const controller = new AbortController();
    rateController = controller;
    const base = stuntMessages(session, actorId, words);
    let messages = base;
    let invalid = 0;
    let last: StuntJudgement = { kind: 'invalid', reason: 'no answer came back' };
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            let raw: string | null = null;
            try {
                raw = await deps.call(provider, messages, controller);
            } catch (e) {
                console.warn('[combat] stunt rating call threw:', e);
            }
            if (controller.signal.aborted) return { judgement: last, invalid, aborted: true };
            last = judgeStuntAnswer(session.state, actorId, raw);
            if (last.kind !== 'invalid') return { judgement: last, invalid, aborted: false };
            invalid += 1;
            messages = retryMessages(base, raw, last.reason);
        }
        return { judgement: last, invalid, aborted: false };
    } finally {
        if (rateController === controller) rateController = null;
    }
}

export function canStunt(session: CombatSession | null, busy: boolean): boolean {
    if (!session || busy || running || session.stunt || session.parley || session.state.outcome) return false;
    const actorId = playerActorId(session.state);
    return !!actorId && stuntAvailable(session.state, actorId).ok;
}

export function isStuntRunning(): boolean {
    return running;
}

function liveSession(campaignId: string, sessionId: string, attemptId: string): CombatSession | null {
    const live = useAppStore.getState();
    const session = live.combatSession;
    if (live.activeCampaignId !== campaignId || !session || session.state.id !== sessionId || session.stunt?.attemptId !== attemptId) return null;
    return session;
}

function clearStunt(campaignId: string, sessionId: string, attemptId: string): void {
    const live = liveSession(campaignId, sessionId, attemptId);
    if (!live) return;
    useAppStore.getState().setCombatSession({ ...live, stunt: undefined });
    debouncedSaveCampaignState();
}

export async function submitStunt(words: string, deps: StuntDeps = defaultStuntDeps): Promise<StuntSubmitResult> {
    const text = words.replace(/[\r\n]+/g, ' ').trim().slice(0, STUNT_WORDS_MAX);
    const store = useAppStore.getState();
    const campaignId = store.activeCampaignId;
    const session = store.combatSession;
    if (!text || !campaignId || !session || isEngineStepping() || !canStunt(session, store.combatBusy)) return 'refused';
    const actorId = playerActorId(session.state) as string;
    running = true;
    store.setCombatBusy(true);
    const attemptId = uid();
    const sessionId = session.state.id;
    try {
        const pending: PendingStunt = { attemptId, actorId, words: text, stage: 'rating' };
        store.setCombatSession({ ...session, stunt: pending });
        debouncedSaveCampaignState();
        const rated = await rateStunt(session, actorId, text, deps);
        const live = liveSession(campaignId, sessionId, attemptId);
        if (rated.aborted || !live || live.stunt?.stage !== 'rating') {
            clearStunt(campaignId, sessionId, attemptId);
            return 'cancelled';
        }
        const j = rated.judgement;
        for (let i = 0; i < rated.invalid; i++) countStuntTelemetry('invalid');
        if (j.kind === 'verdict') {
            countStuntTelemetry('judged', j.difficulties);
            useAppStore.getState().setCombatSession({ ...live, stunt: { ...pending, stage: 'verdict', spec: j.spec, difficulty: j.difficulty } });
            debouncedSaveCampaignState();
            return 'verdict';
        }
        clearStunt(campaignId, sessionId, attemptId);
        if (j.kind === 'impossible') {
            countStuntTelemetry('impossible', j.difficulties);
            toast.info(t('combat.stunt.impossible'));
            return 'impossible';
        }
        countStuntTelemetry('unjudged');
        toast.warning(t('combat.stunt.unjudged'));
        return 'unjudged';
    } finally {
        running = false;
        useAppStore.getState().setCombatBusy(false);
    }
}

export function cancelStunt(): void {
    const session = useAppStore.getState().combatSession;
    if (!session?.stunt) return;
    if (session.stunt.stage === 'rating') {
        rateController?.abort();
        rateController = null;
    }
    useAppStore.getState().setCombatSession({ ...session, stunt: undefined });
    debouncedSaveCampaignState();
}

export function backFromStunt(): void {
    const session = useAppStore.getState().combatSession;
    if (!session?.stunt || session.stunt.stage !== 'verdict') return;
    useAppStore.getState().setCombatSession({ ...session, stunt: undefined });
    debouncedSaveCampaignState();
}

export async function rollStunt(): Promise<CombatEvent[]> {
    const store = useAppStore.getState();
    const session = store.combatSession;
    const pending = session?.stunt;
    if (!session || !pending || pending.stage !== 'verdict' || !pending.spec || running || store.combatBusy || isEngineStepping()) return [];
    const cleared: CombatSession = { ...session, stunt: undefined };
    if (session.state.outcome || playerActorId(session.state) !== pending.actorId) {
        store.setCombatSession(cleared);
        debouncedSaveCampaignState();
        return [];
    }
    const action: CombatAction = { type: 'stunt', actorId: pending.actorId, spec: pending.spec };
    const applied = applyAction(session.state, action, { driven: true });
    if (applied.events.some(e => e.type === 'rejected')) {
        store.setCombatSession(cleared);
        debouncedSaveCampaignState();
        toast.warning(t('combat.stunt.stale'));
        return [];
    }
    const withFlourish = attachFlourish(cleared, action, applied.events, pending.words);
    const next = commitSession({ ...withFlourish, state: applied.state, log: [...session.log, ...applied.events] });
    const events = [...applied.events];
    if (next.state.outcome) {
        await finishCombat();
        return events;
    }
    if (isEngineTurn(next.state)) events.push(...await runEngineTurnsStepped());
    return events;
}

export function resumeStunt(): void {
    const store = useAppStore.getState();
    const session = store.combatSession;
    const pending = session?.stunt;
    if (!session || !pending || running) return;
    const keep = pending.stage === 'verdict' && !!pending.spec && !session.state.outcome
        && playerActorId(session.state) === pending.actorId && checkStunt(session.state, pending.actorId, pending.spec).ok;
    if (keep) return;
    store.setCombatSession({ ...session, stunt: undefined });
    debouncedSaveCampaignState();
}

export type StuntPartView = { outcome: StuntOutcome; target?: string; squares?: number; count?: number; caught?: string[]; damageType?: string };

export function stuntParts(state: CombatState, actorId: string, spec: StuntSpec): StuntPartView[] {
    const grid = terrainOf(state);
    let from = state.combatants[actorId]?.position;
    return spec.parts.map(p => {
        const base: StuntPartView = { outcome: p.outcome, ...(p.damageType ? { damageType: p.damageType } : {}) };
        if (p.targetId) return { ...base, target: state.combatants[p.targetId]?.name ?? p.targetId };
        if (p.outcome === 'cover') return { ...base, count: p.tiles?.length ?? 0 };
        if (!p.at || !from) return base;
        const squares = distance(from, p.at);
        if (p.outcome === 'move') {
            from = p.at;
            return { ...base, squares };
        }
        const area = grid ? stuntArea(grid, p.at) : [];
        const caught = state.order
            .map(id => state.combatants[id])
            .filter((c): c is Combatant => !!c && c.id !== actorId && c.status === 'up' && !!c.position && area.some(t => t.x === c.position?.x && t.y === c.position?.y))
            .map(c => c.name);
        return { ...base, squares, caught };
    });
}

export function resetStuntForTests(): void {
    running = false;
    rateController = null;
}
