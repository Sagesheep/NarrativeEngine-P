// WO-P5-12 §7 Step 3 — the Arc Engine tick as a self-contained compute mod.
//
// This file is the mod's compute source. It is loaded by the sandbox (browser
// Worker) as a classic script: the sandbox prelude strips `export default` and
// named `export` keywords before evaluating the source, so this file is a
// valid ES module that also runs as a classic script after the strip.
//
// What lives here (WO-P5-12 §5): the Arc Engine's pure logic — dice, stance
// scan, surface line, world-state read-model, constants, and the tick
// orchestrator (`runArcTick`). These moved out of `src/services/arc/` (deleted
// in this step) into the mod. The Arc state lives in a mod-declared table
// (`mod.arc.arcs`, Step 1). The tick is a pure function: read table → run tick
// → write table + updateContext.
//
// What stays host-side (WO-P5-12 §2b, §5): `arcSpawn.ts` (the +1 LLM call, fired
// from the ArcInjectorButton — a React component, outside the sandbox
// boundary), `openThreads.ts` (used by the spawn button), and `arcConstants.ts`
// (the spawn path imports it; the constants are duplicated here because the
// sandbox cannot import from `src/`). Chapter-tab rendering stays host-side
// until PANELS/SCREENS. Reported as a finding in the WO-P5-12 report.
//
// Named exports are for the oracle test (`arc.test.ts`), which imports the
// pure functions to assert their behaviour without exercising the sandbox.
// Every expectation in `arc.test.ts` is byte-identical to the in-tree version.

// ── Constants (duplicated from src/services/arc/arcConstants.ts — locked by
//   the WO-01 contract; the spawn path stays host-side and needs its own copy) ──
export const ARC_TICK_DC = { initial: 35, reduction: 5, floor: 5 };
export const LADDER_MIN = 5;
export const LADDER_MAX = 12;
export const MAX_ACTIVE_ARCS = 3;
export const TYPE_COOLDOWN_SEAMS = 6;
export const ARC_LIVE_RECENCY = 3;
export const ARC_STANCE_MOD = {
    opposed: -8,
    aided:   +6,
    fled:    +3,
    ignored:  0,
    unaware:  0,
};
export const ARC_BAND_RUNG_DELTA = {
    critSuccess: +2,
    success:     +1,
    successBut:  +1,
    failBut:      0,
    fail:         0,
    critFail:    -1,
};
export const ARC_SURFACE_EMIT_MIN = 'ambient';
export const ARC_SURFACE_TIER = {
    ambient: 0,
    rumor: 1,
    direct: 2,
};
export const ARC_LIVE_PRESSURE_THRESHOLD = 1;

// ── Dice (from arcDice.ts) ──
function rollArcTick(arc, rng) {
    rng = rng || Math.random;
    const roll = Math.floor(rng() * 100) + 1;
    if (roll >= arc.tickDC) {
        return { fired: true, nextDc: ARC_TICK_DC.initial };
    }
    return {
        fired: false,
        nextDc: Math.max(ARC_TICK_DC.floor, arc.tickDC - ARC_TICK_DC.reduction),
    };
}

function bandFromMargin(nat, margin) {
    // Mirrors src/services/npc/agency/agencyDice.ts:bandFromMargin exactly.
    // The Arc Engine reuses the agency band mapper (arcDice.ts imported it);
    // the mod inlines the same thresholds so behaviour is byte-identical.
    if (nat === 20) return 'critSuccess';
    if (nat === 1) return 'critFail';
    if (margin >= 10) return 'critSuccess';
    if (margin >= 3) return 'success';
    if (margin >= 0) return 'successBut';
    if (margin >= -3) return 'failBut';
    if (margin >= -9) return 'fail';
    return 'critFail';
}

function rollArcOutcome(arc, rng) {
    rng = rng || Math.random;
    const baseDc = 10;
    const extraMods = ARC_STANCE_MOD[arc.stance] ?? 0;
    const nat = Math.floor(rng() * 20) + 1;
    const roll = nat + extraMods;
    const margin = roll - baseDc;
    const band = bandFromMargin(nat, margin);
    return { band };
}

function advanceRung(arc, band) {
    const maxRung = arc.ladder.length - 1;
    if (maxRung < 0) return arc;
    const delta = ARC_BAND_RUNG_DELTA[band] ?? 0;
    const target = arc.currentRung + delta;
    if (target >= maxRung) {
        const atTop = arc.currentRung >= maxRung;
        if (delta > 0 || atTop) {
            return { ...arc, currentRung: maxRung, status: 'boiled_over' };
        }
        return { ...arc, currentRung: maxRung };
    }
    const clamped = Math.max(0, target);
    return { ...arc, currentRung: clamped };
}

// ── Surface line (from arcSurface.ts) ──
function arcSurfaceLine(arc) {
    if (arc.status !== 'active') return '';
    if (!arc.ladder || arc.ladder.length === 0) return '';
    const rung = arc.ladder[arc.currentRung];
    if (!rung || !rung.label) return '';
    const tierRank = ARC_SURFACE_TIER[rung.surface] ?? 0;
    const emitRank = ARC_SURFACE_TIER[ARC_SURFACE_EMIT_MIN] ?? 0;
    if (tierRank < emitRank) return '';
    return `[WORLD/${rung.surface}] ${rung.label}`;
}

// ── Stance scan (from arcStance.ts) ──
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryMatch(text, patterns) {
    const lower = text.toLowerCase();
    return patterns.some(function (p) {
        if (!p || p.length < 3) return false;
        return new RegExp('\\b' + escapeRegExp(p) + '\\b').test(lower);
    });
}

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'for',
    'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this',
    'that', 'these', 'those', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'from', 'into', 'over',
    'under', 'about', 'as', 'if', 'then', 'so', 'no', 'not', 'yes', 'their',
    'they', 'them', 'his', 'her', 'him', 'its', 'our', 'your', 'my', 'i', 'you',
    'he', 'she', 'we', 'who', 'which', 'what', 'when', 'where', 'how', 'why',
    'all', 'any', 'some', 'more', 'most', 'such', 'than', 'too', 'very', 'just',
]);

function extractKeywords() {
    const texts = Array.prototype.slice.call(arguments);
    const out = new Set();
    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!text) continue;
        const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        for (let j = 0; j < tokens.length; j++) {
            const t = tokens[j];
            if (t.length < 4) continue;
            if (STOPWORDS.has(t)) continue;
            out.add(t);
        }
    }
    return Array.from(out);
}

const STANCE_VERBS = [
    {
        stance: 'opposed',
        verbs: [
            'fight', 'oppose', 'resist', 'stop', 'prevent', 'defeat', 'attack',
            'counter', 'block', 'sabotage', 'undermine', 'strike', 'confront',
            'thwart', 'quell', 'suppress', 'crush', 'dismantle', 'disrupt', 'foil',
        ],
    },
    {
        stance: 'aided',
        verbs: [
            'help', 'aid', 'assist', 'support', 'fund', 'ally', 'join', 'back',
            'protect', 'accelerate', 'further', 'supply', 'equip', 'invest',
            'endorse', 'champion', 'bolster', 'abet', 'facilitate', 'promote',
        ],
    },
    {
        stance: 'fled',
        verbs: [
            'flee', 'run', 'retreat', 'escape', 'avoid', 'withdraw', 'pull back',
            'get away', 'get out', 'bug out', 'flee from', 'run from', 'back away',
            'slip away', 'duck out', 'lay low',
        ],
    },
    {
        stance: 'ignored',
        verbs: [
            'ignore', 'disregard', 'dismiss', 'skip', 'pass on', 'look away',
            'walk away', 'brush off', 'shrug off', 'pay no mind', 'tune out',
            'not my problem', 'leave it', 'let it be', 'write off', 'wash my hands',
        ],
    },
];

function classifyStance(playerInput) {
    const lower = playerInput.toLowerCase();
    for (let i = 0; i < STANCE_VERBS.length; i++) {
        const entry = STANCE_VERBS[i];
        for (let j = 0; j < entry.verbs.length; j++) {
            const v = entry.verbs[j];
            if (lower.includes(v)) return entry.stance;
        }
    }
    return null;
}

function scanArcStance(playerInput, gmText, activeArcs) {
    const out = [];
    if (!activeArcs || activeArcs.length === 0) return out;

    const stanceVerb = classifyStance(playerInput);

    for (let i = 0; i < activeArcs.length; i++) {
        const arc = activeArcs[i];
        if (arc.status !== 'active') continue;

        const currentRungLabel = arc.ladder[arc.currentRung] ? (arc.ladder[arc.currentRung].label || '') : '';
        const keywords = extractKeywords(arc.title, arc.seed, currentRungLabel);
        if (keywords.length === 0) continue;

        const playerMentioned = wordBoundaryMatch(playerInput, keywords);
        const gmMentioned = wordBoundaryMatch(gmText, keywords);

        if (!playerMentioned && !(gmMentioned && stanceVerb)) continue;
        if (!stanceVerb) continue;

        out.push({ arcId: arc.id, stance: stanceVerb });
    }

    return out;
}

// ── World-state read-model (from arcWorldState.ts) ──
function parseSceneId(s) {
    if (!s) return 0;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
}

function hasLivePressure(pressure) {
    const values = Object.values(pressure);
    for (let i = 0; i < values.length; i++) {
        const p = values[i];
        if ((p.ignored ?? 0) > ARC_LIVE_PRESSURE_THRESHOLD) return true;
        if ((p.engaged ?? 0) > ARC_LIVE_PRESSURE_THRESHOLD) return true;
    }
    return false;
}

function hasRecentlyTickedArc(arcs, nowScene) {
    for (let i = 0; i < arcs.length; i++) {
        const arc = arcs[i];
        if (arc.status !== 'active') continue;
        const lastTick = parseSceneId(arc.lastTickScene);
        if (nowScene - lastTick <= ARC_LIVE_RECENCY && nowScene - lastTick >= 0) {
            return true;
        }
    }
    return false;
}

function arcWorldState(arcs, openThreads, pressure, nowScene) {
    const livePressure = hasLivePressure(pressure);
    const recentArcTick = hasRecentlyTickedArc(arcs, nowScene);

    if (livePressure || recentArcTick) return 'live';

    const hasOpenThreads = openThreads && openThreads.length > 0;
    const hasActiveArcs = arcs.some(function (a) { return a.status === 'active'; });

    if (hasOpenThreads || hasActiveArcs) return 'stalled';

    return 'dry';
}

// ── Tick orchestrator (from arcEngine.ts — pure, no side effects) ──
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function mergeSealEntries(register, facts, sceneId) {
    // Minimal merge: append the facts to the register's entries. The host-side
    // `mergeSealEntries` (campaign-state/divergenceRegister.ts) dedupes and
    // stamps; here we keep it simple — the host applies the merge via
    // `facade.write.setDivergenceRegister`, and the mod only needs to return
    // the facts. The actual merge happens host-side in the compute track's
    // `applyArcDivergenceFacts`. (Kept here for parity; the mod's tick returns
    // the facts and the host merges them.)
    return register;
}

function runArcTick(arcs, archiveIndex, aiTier, displayInput, lastAssistantContent) {
    // Redundant inner guard — the caller (the compute track / sandbox) already
    // gates on the real tierAllows. On lite this function is never entered.
    if (!arcs || arcs.length === 0) {
        return { arcs: null, arcDigest: null, divergenceFacts: [] };
    }

    const sceneId = archiveIndex.length > 0
        ? archiveIndex[archiveIndex.length - 1].sceneId
        : '000';

    const activeArcs = arcs.filter(function (a) { return a.status === 'active'; });
    if (activeArcs.length === 0) {
        return { arcs: null, arcDigest: null, divergenceFacts: [] };
    }

    const stanceUpdates = scanArcStance(displayInput, lastAssistantContent, activeArcs);
    const stanceById = new Map(stanceUpdates.map(function (u) { return [u.arcId, u.stance]; }));

    let arcsChanged = false;
    const nextArcs = [];
    const digestLines = [];
    const divergenceFacts = [];

    for (let i = 0; i < arcs.length; i++) {
        const arc = arcs[i];
        if (arc.status !== 'active') {
            nextArcs.push(arc);
            continue;
        }

        const newStance = stanceById.get(arc.id) ?? arc.stance;
        const stanceChanged = newStance !== arc.stance;
        let working = stanceChanged ? Object.assign({}, arc, { stance: newStance }) : arc;

        const tick = rollArcTick(working);
        if (tick.fired) {
            const outcome = rollArcOutcome(working);
            const advanced = advanceRung(working, outcome.band);
            working = Object.assign({}, advanced, { lastTickScene: sceneId });
            arcsChanged = true;

            const currentRung = working.ladder[working.currentRung];
            const isDirectOrBoiled = (currentRung && currentRung.surface === 'direct') || working.status === 'boiled_over';
            const isAvoidant = working.stance === 'ignored' || working.stance === 'fled';
            if (isDirectOrBoiled && isAvoidant) {
                divergenceFacts.push({
                    id: uid(),
                    chapterId: 'arc:' + working.id,
                    category: 'world_state',
                    text: (currentRung ? currentRung.label : working.seed),
                    sceneRef: sceneId,
                    npcIds: [],
                    pinned: false,
                    source: 'auto',
                });
            }

            if (working.stance === 'opposed' && working.currentRung === 0 && outcome.band === 'critFail') {
                working = Object.assign({}, working, { status: 'defused' });
            }
        } else {
            if (tick.nextDc !== working.tickDC) {
                working = Object.assign({}, working, { tickDC: tick.nextDc });
                arcsChanged = true;
            }
            if (stanceChanged) arcsChanged = true;
        }

        const line = arcSurfaceLine(working);
        if (line) digestLines.push(line);

        nextArcs.push(working);
    }

    let arcDigest = null;
    if (digestLines.length > 0) {
        arcDigest = Array.from(new Set(digestLines)).join('\n');
    }

    return {
        arcs: arcsChanged ? nextArcs : null,
        arcDigest: arcDigest,
        divergenceFacts: divergenceFacts,
    };
}

// Export the pure functions for the oracle test (arc.test.ts). The sandbox
// prelude strips the `export ` keyword before evaluating the source as a
// classic script, so these exports do not affect the worker runtime.
export {
    rollArcTick,
    rollArcOutcome,
    advanceRung,
    arcSurfaceLine,
    scanArcStance,
    arcWorldState,
    runArcTick,
};

// ── The postTurn compute hook (the mod's entry point) ──
// Reads `mod.arc.arcs` from the table, runs the pure tick, and persists the
// writes through the sandbox context:
//   - arcs → ctx.table.write('mod.arc.arcs', nextArcs)
//   - arcDigest → ctx.write.updateContext({ arcDigest })
//   - divergence facts → ctx.write.addMessage (the mod path; the host-side
//     track merges via setDivergenceRegister when it has a live register, but
//     the sandbox does not expose the merge helper — system messages are the
//     same fallback the in-tree tick used)
//
// The tick never calls a model (WO-P5-12 §2b). The only LLM in the Arc Engine
// is the spawn (arcSpawn.ts), which fires from the host-side ArcInjectorButton.
//
// `displayInput` and `lastAssistantContent` are derived from the frozen facade
// snapshot: `ctx.data.input` is the player's turn input; the last assistant
// message in `ctx.data.messages` is the GM reply the tick processes (mirrors
// `lastAssistantContent()` in directorBrief.ts).
function lastAssistantMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.content) return m.content;
    }
    return '';
}

export default async function arcCompute(ctx) {
    const arcs = await ctx.table.read('mod.arc.arcs');
    if (!Array.isArray(arcs) || arcs.length === 0) return;

    const archiveIndex = ctx.data.archiveIndex;
    const displayInput = ctx.data.input;
    const lastAssistantContent = lastAssistantMessage(ctx.data.messages);

    const result = runArcTick(
        arcs,
        archiveIndex,
        ctx.config.aiTier,
        displayInput,
        lastAssistantContent,
    );

    if (result.arcs) {
        await ctx.table.write('mod.arc.arcs', result.arcs);
    }
    if (result.arcDigest !== null) {
        ctx.write.updateContext({ arcDigest: result.arcDigest });
    }
    if (result.divergenceFacts.length > 0) {
        for (let i = 0; i < result.divergenceFacts.length; i++) {
            const f = result.divergenceFacts[i];
            ctx.write.addMessage({
                id: uid(),
                role: 'system',
                name: 'arc-fact',
                content: '[World moved] ' + f.text,
                timestamp: Date.now(),
            });
        }
    }
}