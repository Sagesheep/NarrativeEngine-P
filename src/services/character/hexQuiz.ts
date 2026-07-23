import type { HexAxis, PersonalityHex } from '../../types';
import { TRAIT_VOCAB } from '../npc/agency/agencyPools';

/**
 * WO-A2 §2.6 — engine-owned personality quiz (LLM-free, always).
 *
 * Weighted multiple choice ONLY. Never free text. Each option carries a fixed
 * `{ axis: delta }` table. Scoring is `sum → clamp ±3`. Fully deterministic,
 * unit-testable, identical every run. No model reads an answer.
 *
 * §0 invariant: `personalityHex` and `traits` are written ONLY by this quiz
 * or by the user's own hand on the sheet — never inferred from prose.
 */

export type QuizScenario = {
    id: number;
    prompt: string;
    options: QuizOption[];
};

export type QuizOption = {
    label: string;
    deltas: Partial<Record<HexAxis, number>>;
    /** Optional trait tags this option adds to the candidate pool. */
    traits?: string[];
};

// ── Scenario bank (~20 authored, 8 drawn) ────────────────────────────────────
// Each scenario hits ≥2 axes across its options. The drawer guarantees axis
// coverage (§2.6: each of the six axes hit at least twice across the drawn 8)
// by selecting scenarios whose option deltas cover that axis.

export const SCENARIO_BANK: readonly QuizScenario[] = Object.freeze([
    {
        id: 1,
        prompt: 'A stranger blocks your path and won\'t move.',
        options: [
            { label: 'Shove past', deltas: { boldness: 2, warmth: -1 }, traits: ['defiant', 'impulsive'] },
            { label: 'Talk them around', deltas: { empathy: 1, composure: 1 }, traits: ['pragmatic'] },
            { label: 'Wait them out', deltas: { composure: 2, boldness: -1 }, traits: ['patient'] },
            { label: 'Threaten them', deltas: { boldness: 1, warmth: -2 }, traits: ['aggressive', 'territorial'] },
        ],
    },
    {
        id: 2,
        prompt: 'A locked door stands between you and your goal.',
        options: [
            { label: 'Kick it down', deltas: { boldness: 2, diligence: -1 }, traits: ['impulsive', 'defiant'] },
            { label: 'Pick the lock', deltas: { diligence: 2, composure: 1 }, traits: ['scheming', 'curious'] },
            { label: 'Look for another way', deltas: { composure: 1, empathy: 1 }, traits: ['pragmatic'] },
            { label: 'Find the keyholder and negotiate', deltas: { empathy: 1, warmth: 1 }, traits: ['diplomatic'] },
        ],
    },
    {
        id: 3,
        prompt: 'A friend confesses they betrayed your trust.',
        options: [
            { label: 'Forgive them immediately', deltas: { warmth: 2, empathy: 1 }, traits: ['loyal', 'generous'] },
            { label: 'Cut them off coldly', deltas: { composure: 2, warmth: -2 }, traits: ['mistrustful'] },
            { label: 'Plan a measured revenge', deltas: { drive: 1, empathy: -2 }, traits: ['vengeful', 'scheming'] },
            { label: 'Hear them out before deciding', deltas: { composure: 1, empathy: 1 }, traits: ['pragmatic'] },
        ],
    },
    {
        id: 4,
        prompt: 'You\'re offered power that demands a terrible price.',
        options: [
            { label: 'Take it, consequences be damned', deltas: { boldness: 2, composure: -1 }, traits: ['ambitious', 'impulsive'] },
            { label: 'Refuse outright', deltas: { composure: 1, drive: -1 }, traits: ['ascetic', 'honorable'] },
            { label: 'Bargain for better terms', deltas: { drive: 2, composure: 1 }, traits: ['scheming', 'pragmatic'] },
            { label: 'Accept and secretly plan to break the deal', deltas: { composure: 1, empathy: -1 }, traits: ['treacherous', 'scheming'] },
        ],
    },
    {
        id: 5,
        prompt: 'A weaker person is being bullied in front of you.',
        options: [
            { label: 'Step in fists first', deltas: { boldness: 2, empathy: 1 }, traits: ['protective', 'defiant'] },
            { label: 'Intervene with words', deltas: { empathy: 2, composure: 1 }, traits: ['generous', 'pacifist'] },
            { label: 'Report it to authority', deltas: { diligence: 2, boldness: -1 }, traits: ['honorable'] },
            { label: 'Walk away — not your problem', deltas: { empathy: -2, composure: 1 }, traits: ['mercenary'] },
        ],
    },
    {
        id: 6,
        prompt: 'You fail at something you tried hard for.',
        options: [
            { label: 'Try again immediately', deltas: { drive: 2, boldness: 1 }, traits: ['ambitious', 'stubborn'] },
            { label: 'Mourn, then move on', deltas: { composure: 1, warmth: 1 }, traits: ['pragmatic'] },
            { label: 'Obsess over what went wrong', deltas: { diligence: 1, composure: -2 }, traits: ['obsessive'] },
            { label: 'Pivot to a new goal', deltas: { drive: -1, boldness: 1 }, traits: ['nomadic', 'curious'] },
        ],
    },
    {
        id: 7,
        prompt: 'A stranger shares a secret with you.',
        options: [
            { label: 'Keep it forever', deltas: { composure: 2, warmth: 1 }, traits: ['loyal', 'secretive'] },
            { label: 'Use it to your advantage', deltas: { drive: 1, empathy: -2 }, traits: ['manipulative', 'scheming'] },
            { label: 'Share it with those it affects', deltas: { warmth: 1, composure: -1 }, traits: ['honorable'] },
            { label: 'Forget it immediately', deltas: { composure: -1, diligence: -1 }, traits: ['carefree'] },
        ],
    },
    {
        id: 8,
        prompt: 'You\'re stranded in an unfamiliar place.',
        options: [
            { label: 'Explore eagerly', deltas: { boldness: 2, drive: 1 }, traits: ['curious', 'nomadic'] },
            { label: 'Find shelter and wait', deltas: { composure: 2, boldness: -1 }, traits: ['pragmatic'] },
            { label: 'Ask locals for help', deltas: { warmth: 1, empathy: 1 }, traits: ['generous'] },
            { label: 'Track your way back methodically', deltas: { diligence: 2, composure: 1 }, traits: ['pragmatic', 'patient'] },
        ],
    },
    {
        id: 9,
        prompt: 'A long-held belief is challenged by new evidence.',
        options: [
            { label: 'Reject the evidence', deltas: { composure: 1, empathy: -1 }, traits: ['stubborn', 'ritual-bound'] },
            { label: 'Update your view', deltas: { empathy: 1, composure: -1 }, traits: ['curious', 'pragmatic'] },
            { label: 'Investigate further before deciding', deltas: { diligence: 2, composure: 1 }, traits: ['curious', 'patient'] },
            { label: 'Defend your view publicly', deltas: { boldness: 2, drive: 1 }, traits: ['fanatical', 'defiant'] },
        ],
    },
    {
        id: 10,
        prompt: 'A tedious but important task is yours to finish.',
        options: [
            { label: 'Grind through it', deltas: { diligence: 2, composure: 1 }, traits: ['oath-bound', 'patient'] },
            { label: 'Find a clever shortcut', deltas: { drive: 1, diligence: -1 }, traits: ['scheming', 'curious'] },
            { label: 'Delegate it', deltas: { drive: 1, empathy: -1 }, traits: ['authoritarian'] },
            { label: 'Procrastinate', deltas: { diligence: -2, composure: -1 }, traits: ['carefree'] },
        ],
    },
    {
        id: 11,
        prompt: 'Someone you dislike asks for your help.',
        options: [
            { label: 'Help them anyway', deltas: { empathy: 2, warmth: 1 }, traits: ['generous', 'pacifist'] },
            { label: 'Refuse', deltas: { composure: 1, warmth: -1 }, traits: ['mistrustful'] },
            { label: 'Help, but extract a favor', deltas: { drive: 1, empathy: -1 }, traits: ['mercenary', 'scheming'] },
            { label: 'Pretend you didn\'t hear', deltas: { composure: -1, empathy: -1 }, traits: ['secretive'] },
        ],
    },
    {
        id: 12,
        prompt: 'You witness something beautiful no one else will see.',
        options: [
            { label: 'Soak it in silently', deltas: { composure: 2, empathy: 1 }, traits: ['ascetic'] },
            { label: 'Paint or record it', deltas: { diligence: 1, warmth: 1 }, traits: ['curious'] },
            { label: 'Call others over to share it', deltas: { warmth: 2, empathy: 1 }, traits: ['generous', 'romantic'] },
            { label: 'Move on — beauty is fleeting', deltas: { composure: 1, warmth: -1 }, traits: ['pragmatic'] },
        ],
    },
    {
        id: 13,
        prompt: 'A decision must be made and others look to you.',
        options: [
            { label: 'Decide quickly and own it', deltas: { boldness: 2, drive: 1 }, traits: ['ambitious', 'authoritarian'] },
            { label: 'Weigh every option carefully', deltas: { diligence: 2, composure: 1 }, traits: ['pragmatic', 'patient'] },
            { label: 'Ask the group for input', deltas: { empathy: 2, warmth: 1 }, traits: ['generous'] },
            { label: 'Deflect — let someone else lead', deltas: { boldness: -2, composure: -1 }, traits: ['carefree'] },
        ],
    },
    {
        id: 14,
        prompt: 'You\'re wronged, but the culprit is powerful.',
        options: [
            { label: 'Confront them directly', deltas: { boldness: 2, composure: -1 }, traits: ['defiant', 'vengeful'] },
            { label: 'Bide your time', deltas: { composure: 2, drive: 1 }, traits: ['scheming', 'patient'] },
            { label: 'Forgive and avoid them', deltas: { empathy: 1, warmth: 1 }, traits: ['pacifist'] },
            { label: 'Rally others against them', deltas: { drive: 1, empathy: -1 }, traits: ['authoritarian', 'scheming'] },
        ],
    },
    {
        id: 15,
        prompt: 'A deadline looms and you\'re far behind.',
        options: [
            { label: 'Pull an all-nighter', deltas: { drive: 2, composure: -1 }, traits: ['ambitious', 'obsessive'] },
            { label: 'Negotiate an extension', deltas: { empathy: 1, composure: 1 }, traits: ['pragmatic'] },
            { label: 'Cut scope and ship what you have', deltas: { diligence: 1, boldness: 1 }, traits: ['pragmatic'] },
            { label: 'Accept the failure and move on', deltas: { composure: 1, drive: -1 }, traits: ['carefree'] },
        ],
    },
    {
        id: 16,
        prompt: 'A child asks you a hard question.',
        options: [
            { label: 'Answer honestly, fully', deltas: { empathy: 1, warmth: 1 }, traits: ['generous', 'honorable'] },
            { label: 'Tell a gentle half-truth', deltas: { warmth: 2, composure: 1 }, traits: ['protective'] },
            { label: 'Deflect with a joke', deltas: { composure: -1, boldness: 1 }, traits: ['eccentric'] },
            { label: 'Tell them to ask someone else', deltas: { empathy: -1, composure: 1 }, traits: ['mistrustful'] },
        ],
    },
    {
        id: 17,
        prompt: 'You inherit a fortune from a stranger.',
        options: [
            { label: 'Find deserving recipients', deltas: { empathy: 2, warmth: 1 }, traits: ['generous', 'ascetic'] },
            { label: 'Invest it in your ambitions', deltas: { drive: 2, boldness: 1 }, traits: ['ambitious', 'mercenary'] },
            { label: 'Spend it on pleasure', deltas: { warmth: 1, composure: -2 }, traits: ['impulsive'] },
            { label: 'Investigate why you got it', deltas: { diligence: 2, composure: 1 }, traits: ['curious', 'paranoid'] },
        ],
    },
    {
        id: 18,
        prompt: 'An old rival is now at your mercy.',
        options: [
            { label: 'Show mercy', deltas: { empathy: 2, warmth: 1 }, traits: ['honorable', 'pacifist'] },
            { label: 'Settle the score', deltas: { boldness: 1, empathy: -2 }, traits: ['vengeful', 'ruthless'] },
            { label: 'Let them sweat, then release', deltas: { composure: 2, empathy: -1 }, traits: ['scheming'] },
            { label: 'Use them as a tool', deltas: { drive: 1, empathy: -1 }, traits: ['manipulative', 'mercenary'] },
        ],
    },
    {
        id: 19,
        prompt: 'You\'re praised for something you didn\'t do.',
        options: [
            { label: 'Correct the record', deltas: { empathy: 1, composure: 1 }, traits: ['honorable'] },
            { label: 'Accept the praise quietly', deltas: { composure: 1, warmth: -1 }, traits: ['secretive', 'scheming'] },
            { label: 'Redirect praise to who earned it', deltas: { warmth: 2, empathy: 1 }, traits: ['generous', 'loyal'] },
            { label: 'Milk it for advantage', deltas: { drive: 1, empathy: -1 }, traits: ['opportunistic', 'manipulative'] },
        ],
    },
    {
        id: 20,
        prompt: 'A long journey stretches ahead.',
        options: [
            { label: 'March without rest', deltas: { drive: 2, diligence: 1 }, traits: ['ambitious', 'stubborn'] },
            { label: 'Savor the road', deltas: { composure: 1, warmth: 1 }, traits: ['nomadic', 'curious'] },
            { label: 'Plan every stop', deltas: { diligence: 2, composure: 1 }, traits: ['patient', 'pragmatic'] },
            { label: 'Find a faster route', deltas: { boldness: 1, diligence: -1 }, traits: ['curious', 'impulsive'] },
        ],
    },
]);

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

const NEUTRAL_HEX: PersonalityHex = { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 };

function clamp(v: number): number {
    return Math.max(-3, Math.min(3, Math.round(v)));
}

/**
 * Draw 8 scenarios from the bank, guaranteeing every axis is hit at least
 * twice across the drawn set's option deltas. Never random-fills untouched
 * axes (§2.6 amendment to WO-A §5) — assigning a value to an axis the player
 * never expressed an opinion on means the sheet lies to them.
 */
export function drawScenarios(bank: readonly QuizScenario[] = SCENARIO_BANK, count = 8, rng: () => number = Math.random): QuizScenario[] {
    if (bank.length === 0) return [];
    const available = [...bank];
    const drawn: QuizScenario[] = [];
    const axisHits: Record<HexAxis, number> = { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 };

    // First pass: greedily cover under-represented axes.
    while (drawn.length < count && available.length > 0) {
        const minHits = Math.min(...HEX_AXES.map(a => axisHits[a]));
        // Find scenarios that hit the least-represented axis.
        const underAxis = HEX_AXES.find(a => axisHits[a] === minHits)!;
        let candidates = available.filter(s => s.options.some(o => o.deltas[underAxis] !== undefined));
        // If all axes are covered ≥2 times, fall back to any scenario.
        const allCovered = HEX_AXES.every(a => axisHits[a] >= 2);
        if (allCovered || candidates.length === 0) candidates = available;

        const pick = candidates[Math.floor(rng() * candidates.length)];
        drawn.push(pick);
        available.splice(available.indexOf(pick), 1);
        for (const opt of pick.options) {
            for (const a of HEX_AXES) {
                if (opt.deltas[a] !== undefined) axisHits[a]++;
            }
        }
    }

    return drawn;
}

/**
 * Derive `personalityHex` + ≤5 traits from quiz answers. Deterministic.
 *
 * @param drawn        The drawn scenarios (8).
 * @param optionIndices A map `{ scenarioId: chosenOptionIndex }`. Missing
 *                      scenarios contribute nothing; untouched axes stay 0.
 * @returns `{ hex, traits }`. Hex is clamped ±3. Traits are drawn from the
 *          option tags the user picked (deduped, ≤5, intersected with
 *          TRAIT_VOCAB so only controlled-vocab traits are emitted).
 */
export function deriveHexFromAnswers(
    drawn: QuizScenario[],
    optionIndices: Record<number, number>,
): { hex: PersonalityHex; traits: string[] } {
    const hex: PersonalityHex = { ...NEUTRAL_HEX };
    const traitCounts = new Map<string, number>();

    for (const scenario of drawn) {
        const idx = optionIndices[scenario.id];
        if (idx === undefined || idx < 0 || idx >= scenario.options.length) continue;
        const opt = scenario.options[idx];
        for (const a of HEX_AXES) {
            const d = opt.deltas[a];
            if (typeof d === 'number' && Number.isFinite(d)) hex[a] += d;
        }
        if (opt.traits) {
            for (const t of opt.traits) {
                traitCounts.set(t, (traitCounts.get(t) ?? 0) + 1);
            }
        }
    }

    for (const a of HEX_AXES) hex[a] = clamp(hex[a]);

    const vocabSet = new Set(TRAIT_VOCAB.map(t => t.text));
    const sortedTraits = [...traitCounts.entries()]
        .filter(([t]) => vocabSet.has(t))
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t)
        .slice(0, 5);

    return { hex, traits: sortedTraits };
}