// Phase 4.2 — the Arc Engine's native-tier entry point.
//
// `MOUNTS.md` §2.3: the arc mod's "Inject Arc" button returns as a
// mod-claimed `composer.actions` entry registered from `activate`, NOT as
// host chrome. This is where `mods/arc/compute.js:14-20` always said it
// belonged ("stays host-side until PANELS/SCREENS" — Phase 4 is PANELS).
//
// What lives here: the `activate` hook that registers the composer entry,
// and the spawn logic (the +1 LLM call) that the entry's `onSelect` fires.
// The spawn logic duplicates `src/services/arc/arcSpawn.ts` because a mod
// never imports from `src/` — the same way `compute.js` duplicates the tick
// logic and constants from `src/services/arc/`. The prompt and validation
// are byte-identical to `arcSpawn.ts`; the constants are shared with
// `compute.js` by duplication (locked by the WO-01 contract).
//
// What stays host-side: nothing. The un-parking (Phase 4.0) restored the
// button as a temporary host-owned mount; 4.2 removes that and the mod owns
// the whole surface now. `ArcInjectorButton.tsx`, `arcSpawn.ts`,
// `openThreads.ts` stay in `src/` because other host code may still
// reference them, but the running app's Inject Arc button is THIS mod
// entry, not the host component.
//
// `ctx.data.chapters` (Phase 4.0 / API.md §4.4) carries the sealed chapters
// the spawn reads for open threads. `ctx.model.call('story', …)` is the LLM
// call. `ctx.table.read('arcs')` / `ctx.table.write('arcs', …)` are the
// mod's own table. `ctx.data.npcLedger` carries the NPC pressure. The
// pending-commit drain (MOUNTS.md §8.8) is handled by the host before
// `onSelect` fires, so the mod does not commit a turn itself (CONTRACT.md
// L3).
//
// ── Phase 5.1 decision: the `{{arcSurface}}` contribution is removed ──
// The manifest used to declare a contribution with `text: "{{arcSurface}}"`
// at order 820. Nothing resolved `{{arcSurface}}` — `renderTemplate`
// understood only `{{location}}` and `{{npcs}}`, so the literal string
// `{{arcSurface}}` was being emitted into the prompt at order 820 whenever
// Arc was enabled. Arc's REAL surfacing path goes through
// `ctx.write.updateContext({ arcDigest })` in `compute.js:446`, which the
// world builder reads at `src/services/payload/world.ts:560` and emits as
// `[WORLD UNDERCURRENT]\n${arcDigest}` — a host-owned, host-coupled path.
//
// Phase 5.1's macro registry COULD have registered `arcSurface` as a macro,
// but doing so would require exposing `context.arcDigest` on `ModData` (a
// new API surface) just to duplicate the world block `world.ts:560` already
// emits — emitting `[WORLD UNDERCURRENT]` twice (once from the world
// builder, once from the macro at order 820) would be a regression, not a
// fix. The `arcDigest` → `world.ts:560` path is load-bearing AND
// host-coupled; Phase 8.3 ("logic and prompt move") owns moving that path
// into the mod. Phase 5.1's job is the macro registry, not pre-empting
// 8.3's architectural decision.
//
// Decision: REMOVE the dead contribution. This fixes the live bug (the
// literal `{{arcSurface}}` is no longer emitted) and is reversible — when
// 8.3 moves the surfacing path into the mod, the mod can register an
// `arcSurface` macro through `ctx.macros.register()` at that point.

// ── Constants (duplicated from compute.js — locked by the WO-01 contract) ──
const LADDER_MIN = 5;
const LADDER_MAX = 12;
const ARC_TICK_DC_INITIAL = 35;
const TYPE_COOLDOWN_SEAMS = 6;

const VALID_ARC_TYPES = new Set([
    'economic', 'political', 'factional', 'social',
    'supernatural', 'criminal', 'environmental',
]);
const VALID_ARC_SURFACES = new Set(['ambient', 'rumor', 'direct']);

// ── UID (duplicated from compute.js) ──
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Spawn prompt + validation (duplicated from src/services/arc/arcSpawn.ts) ──
function coerceSurface(raw) {
    if (typeof raw === 'string' && VALID_ARC_SURFACES.has(raw)) return raw;
    return 'ambient';
}

function coerceType(raw, suppressed) {
    if (typeof raw !== 'string') return null;
    if (!VALID_ARC_TYPES.has(raw)) return null;
    if (suppressed.has(raw)) return null;
    return raw;
}

function asString(v) {
    return typeof v === 'string' ? v.trim() : '';
}

function extractSpawnJson(raw) {
    const cleaned = String(raw || '')
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?\s*([\s\S]*?)```/i, (_, body) => body);
    const start = cleaned.indexOf('{');
    if (start === -1) return null;
    const end = cleaned.lastIndexOf('}');
    if (end === -1 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

function validateLadder(rawLadder) {
    if (!Array.isArray(rawLadder)) return null;
    if (rawLadder.length < LADDER_MIN || rawLadder.length > LADDER_MAX) return null;
    const stages = [];
    for (const item of rawLadder) {
        if (!item || typeof item !== 'object') return null;
        const label = asString(item.label);
        if (label.length === 0) return null;
        stages.push({ label, surface: coerceSurface(item.surface) });
    }
    return stages;
}

function joinPromptSections(...sections) {
    return sections.filter(Boolean).join('\n\n');
}

const TTRPG_PERSONA_GM_ASSISTANT = 'You are a background GM assistant running silently.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const INPUT_DELIMITER = '----- INPUT -----';

function buildSpawnPrompt(input) {
    const anchorBlock = input.anchor.kind === 'agent'
        ? `[GROUNDING ANCHOR — one NPC the player already knows]
Name: ${input.anchor.name}
What they want: ${input.anchor.want}
The seed must grow out of THIS character's situation — their want, their faction, their relationships — not out of the whole world at once.`
        : `[GROUNDING ANCHOR — one open story thread]
${input.anchor.text}
The seed must grow out of THIS unresolved thread — what it implies, what it pressures, what it will worsen — not out of the whole world at once.`;

    const suppressedLine = input.suppressedTypes.length > 0
        ? input.suppressedTypes.join(', ')
        : '(none)';

    return joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,

        `TASK: Author ONE story ARC — a standing condition in the world that worsens over time and will eventually demand the player's attention. Not an encounter. Not a one-scene event. A systemic pressure (economic, political, factional, social, supernatural, criminal, or environmental) that climbs a ladder from a quiet first rumble to a crisis. The arc is GROUNDED in the single anchor below — its seed grows out of that one NPC's want OR that one open thread, not out of the whole world at once.

Output schema — ONE JSON object, no prose, no markdown fences:
{
  "title": "short debug title (not shown to the player as-is)",
  "type":  "economic" | "political" | "factional" | "social" | "supernatural" | "criminal" | "environmental",
  "seed":  "the ONE grounding sentence the ladder grew from (tied to the anchor)",
  "ladder": [
    { "label": "rung 0 — quiet, distant",          "surface": "ambient" },
    { "label": "rung 1",                            "surface": "ambient" | "rumor" },
    ... 5 to 12 rungs total ...
    { "label": "the final crisis rung",            "surface": "direct" }
  ]
}`,

        `RULES — binding:
- SYSTEMIC + INDIRECT, NOT A STRANGER WALKING UP. The seed is a STANDING CONDITION in the world — a harvest failure, a regent's decree, a faction consolidating, a cult spreading, a syndicate cornering a market, a plague rumored in a distant port. It does NOT open with someone approaching the player at their current location. The opening hook is something the player hears about, notices in a price, or learns through rumor — never something that arrives at them.
- WORSENS OVER TIME. Each rung is the same condition one step further along. Rung 0 is distant and quiet; the final rung is the crisis landing in the player's lap. The ladder is the arc — it must feel like ONE thread tightening, not a sequence of unrelated events.
- GROUNDED IN THE ANCHOR ONLY. The seed grows from the single anchor (one NPC's want OR one open thread) below. Do NOT pull in the whole world. The anchor is the root; the ladder is what its consequences become.
- EARLY RUNGS ARE QUIET. The first 1–2 rungs should be 'ambient' (a price shift, a background detail, a distant report). Middle rungs 'rumor' (a merchant mentions it, a traveler brings word). Only the last 1–2 rungs are 'direct' (it arrives in the player's scene — a riot, a lockdown, a death they witness). The crisis is EARNED by the quiet rungs beneath it.
- TROUBLE, NOT A GIFT. The arc is a threat, pressure, complication, ticking-clock, or escalation. Never a free opportunity or a reward.
- AVOID SUPPRESSED TYPES. The type you pick MUST NOT be one of: ${suppressedLine}. Pick a different flavor.
- 5–12 RUNGS, NO MORE, NO LESS.
- NO PROSE AROUND THE JSON. No markdown fences. No explanation. Just the object.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        anchorBlock,
        `[WORLD CONTEXT — brief, for grounding only]\n${input.worldContext || '(none)'}`,
    );
}

/**
 * Author ONE arc: a systemic, indirect, laddered condition grounded against
 * the single anchor. +1 LLM (the only deliberate cost in the Arc Engine).
 * Returns a fully-formed, validated `ArcRecord`, or `null` on
 * generation/validation failure. Duplicated from `src/services/arc/arcSpawn.ts`
 * because a mod never imports from `src/`.
 */
async function spawnArc(ctx, input) {
    const prompt = buildSpawnPrompt(input);
    let raw;
    try {
        const response = await ctx.model.call('story', { prompt, maxTokens: 2000 });
        raw = response?.content ?? '';
    } catch (err) {
        ctx.log('[ArcInjector] LLM call failed:', err);
        return null;
    }

    const parsed = extractSpawnJson(raw);
    if (!parsed) {
        ctx.log('[ArcInjector] no JSON object found in response');
        return null;
    }

    const suppressed = new Set(input.suppressedTypes);
    const type = coerceType(parsed.type, suppressed);
    if (!type) {
        ctx.log('[ArcInjector] rejected: type missing, invalid, or suppressed');
        return null;
    }

    const title = asString(parsed.title);
    const seed = asString(parsed.seed);
    if (title.length === 0 || seed.length === 0) {
        ctx.log('[ArcInjector] rejected: empty title or seed');
        return null;
    }

    const ladder = validateLadder(parsed.ladder);
    if (!ladder) {
        ctx.log(`[ArcInjector] rejected: ladder length outside ${LADDER_MIN}..${LADDER_MAX} or malformed`);
        return null;
    }

    return {
        id: uid(),
        type,
        title,
        seed,
        ladder,
        currentRung: 0,
        tickDC: ARC_TICK_DC_INITIAL,
        stance: 'unaware',
        status: 'active',
        bornScene: input.bornScene,
        lastTickScene: input.bornScene,
    };
}

// ── Open-threads + anchor selection (duplicated from src/services/arc/openThreads.ts
//    and src/services/arc/arcSpawn.ts::pickArcSpawnInput) ──

function computeOpenThreads(chapters) {
    const allUnresolved = [];
    for (const ch of chapters) {
        if (ch.invalidated) continue;
        if (ch.unresolvedThreads) {
            for (const t of ch.unresolvedThreads) {
                allUnresolved.push({ text: t, chapterId: ch.chapterId });
            }
        }
    }
    // Desktop's ArchiveChapter doesn't carry resolvedThreads in the mod
    // projection; treat as no resolved threads (the open list is just the
    // unresolved set). Matches `openThreads.ts`'s defensive read.
    return allUnresolved.slice(-12);
}

function pickArcSpawnInput(params) {
    const { arcs, openThreads, pressure, npcLedger, worldContext, bornScene, nowScene, fallbackAnchorText } = params;

    // Type cooldown → suppressedTypes only (variety steer). Never blocks.
    const suppressedTypes = new Set();
    for (const a of arcs) {
        const born = parseInt(a.bornScene, 10);
        if (Number.isFinite(born) && nowScene - born < TYPE_COOLDOWN_SEAMS) {
            suppressedTypes.add(a.type);
        }
    }

    // Anchor: freshest open thread → most-pressured NPC → fallback snippet.
    let anchor = null;
    if (openThreads.length > 0) {
        anchor = { kind: 'thread', text: openThreads[openThreads.length - 1].text };
    } else {
        let best = null;
        let bestScore = 0;
        for (const npc of npcLedger) {
            const p = pressure[npc.id];
            if (!p) continue;
            const score = (p.ignored ?? 0) + (p.engaged ?? 0);
            if (score > bestScore) { bestScore = score; best = npc; }
        }
        if (best) {
            const want = best.wants?.long?.[0] ?? best.wants?.medium?.[0] ?? best.storyRelevance ?? 'unknown';
            anchor = { kind: 'agent', name: best.name, want };
        } else if (fallbackAnchorText && fallbackAnchorText.trim()) {
            anchor = { kind: 'thread', text: fallbackAnchorText.trim().slice(0, 400) };
        }
    }
    if (!anchor) return null;

    return { anchor, worldContext, suppressedTypes: Array.from(suppressedTypes), bornScene };
}

// ── The composer entry's spawn flow ──
//
// `onSelect` receives a `ModContext`. The host already drained a pending
// commit (MOUNTS.md §8.8) before calling this, so the engine state the
// spawn reads is current. The flow:
//   1. Read `mod.arc.arcs`, chapters, archiveIndex, npcLedger, messages.
//   2. Build the spawn input (anchor + suppressed types).
//   3. Call the LLM via `ctx.model.call('story', …)`.
//   4. Validate and append the new arc to `mod.arc.arcs`.
//
// The entry's `state()` returns the four-phase feedback the host button
// used to show (idle/loading/success/error) via `busy`, `icon`, `label`,
// `tone` (MOUNTS.md §8.2 table — the Inject Arc row).

// Per-press state. A module-scoped object so `state()` and `onSelect`
// share it. One press at a time: a second press while loading is ignored
// by the `onSelect` guard.
let pressState = { phase: 'idle' };

// The `composer.actions` mount handle, kept so `setPhase` can repaint.
// `mounts.composer()` returns a `MountHandle` whose `update()` is the ONLY
// way a mod makes its own button re-render: the generic chrome renderer
// reads `state()` at render time, and the row re-renders only when the
// region's listeners are woken (`mountRegistry.ts::notifyRegion`), which
// happens on register, unregister, and `handle.update()`. Nothing observes
// `pressState` on its own.
//
// Dropping this handle is what made the button look dead: every terminal
// branch of `onSelect` — success, no-anchor, LLM rejection, thrown error —
// sets a phase nothing repaints, and `ModContext` carries no toast surface,
// so there was no feedback channel left at all. `anno-mark` and
// `ability-compendium` both keep their handles for exactly this reason.
let composerHandle;

function setPhase(phase) {
    pressState = { phase };
    if (composerHandle) composerHandle.update();
}

// ── One arc at a time ──
//
// The Arc Engine runs ONE arc. A second arc spawned alongside the first does
// not add a second story — it adds a second voice whispering into
// `[WORLD UNDERCURRENT]` every scene, and the GM gets two unrelated systemic
// pressures to weave at once. `MAX_ACTIVE_ARCS = 3` exists in `compute.js` and
// is read by nothing; the only description of it as a gate is a comment in the
// host's `arcSpawn.ts`, describing the automatic seam spawn that was deleted
// when the button became the spawn gate. So the rule was never enforced
// anywhere, and every press stacked another arc.
//
// The gate is self-clearing by construction: an arc that finishes climbing its
// ladder is flipped to `boiled_over` by the tick (`compute.js::advanceRung`),
// and one crit-failed at rung 0 while opposed becomes `defused`. Neither is
// `active`, so the button frees itself the moment the arc is spent — nothing
// has to remember to release it.
//
// The count the BUTTON paints from is cached here, because `state()` is
// synchronous and reading the table is not. The cache is refreshed on
// `turn.committed` (the tick has settled by then — the post-turn pipeline
// awaits its tracks) and on `campaign.opened`. The cache is a display
// convenience only: `onSelect` enforces the rule against the table as it reads
// it, so a stale cache can never let a second arc through.
let activeArcCount = 0;

function countActiveArcs(arcs) {
    let count = 0;
    for (const arc of arcs) {
        if (arc && arc.status === 'active') count += 1;
    }
    return count;
}

/** Re-read the arcs table and repaint the button if the gate changed. */
async function refreshActiveArcs(ctx) {
    if (!ctx) return;
    try {
        // Always through a refreshed context: `activate` fires before a
        // campaign is open (the 4.0 load cycle), so the context captured there
        // is bound to no campaign and its table reads would stay empty for the
        // life of the session.
        const live = typeof ctx.refresh === 'function' ? await ctx.refresh() : ctx;
        if (!live || !live.table) return;
        const arcs = await live.table.read('arcs');
        const next = countActiveArcs(Array.isArray(arcs) ? arcs : []);
        if (next === activeArcCount) return;
        activeArcCount = next;
        if (composerHandle) composerHandle.update();
    } catch (err) {
        if (ctx.log) ctx.log('[ArcInjector] could not read arcs for the active gate:', err);
    }
}

export async function onActivate(ctx) {
    if (!ctx || !ctx.mounts) {
        // No context (load before a campaign) or no mounts API (sandbox).
        // The 4.0 load cycle fires `activate` before a campaign is open;
        // a mod that needs state guards against `undefined`. Register
        // anyway — the entry's `state()` returns `hidden` when there is
        // no campaign, so it does not show.
    }
    const mounts = ctx && ctx.mounts;
    if (!mounts) return;

    composerHandle = mounts.composer({
        id: 'injectArc',
        icon: 'Syringe',
        label: 'INJECT ARC',
        tooltip: 'Inject a new story arc (manual spawn)',
        onSelect: async (modCtx) => {
            if (!modCtx) return;
            if (pressState.phase === 'loading') return;
            setPhase('loading');
            try {
                const arcs = await modCtx.table.read('arcs');
                const arcList = Array.isArray(arcs) ? arcs : [];

                // One arc at a time, enforced against the table as it reads
                // right now rather than against the cached count the button
                // painted from. The button is already greyed in this case, so
                // reaching here means the cache was stale (an arc spawned in
                // another window, a press racing the tick) — repaint and stop
                // before spending the LLM call.
                if (countActiveArcs(arcList) > 0) {
                    activeArcCount = countActiveArcs(arcList);
                    modCtx.log('[ArcInjector] an arc is already active — nothing to inject');
                    setPhase('idle');
                    return;
                }

                const chapters = modCtx.data.chapters ?? [];
                // The mod projection (`ModChapter`) carries `sealedAt` and
                // `sceneIds`; the open-threads extractor reads the raw
                // `unresolvedThreads` field, which is NOT on `ModChapter`
                // (it stayed internal, API.md §4.4). So the mod reads
                // open threads from the chapters the host projects — but
                // `ModChapter` has no `unresolvedThreads`. This is the
                // gap MOUNTS.md §12 finding 2 names: `data.chapters` is
                // designed but the open-threads field is not projected.
                // For 4.2 we read what IS there and fall back to the
                // fallback anchor when no threads are available.
                const sealedChapters = chapters.filter((c) => c.sealedAt != null);
                // `unresolvedThreads` is not on `ModChapter`; treat as no
                // open threads until the projection widens (finding 2).
                const openThreads = [];
                const archiveIndex = modCtx.data.archiveIndex ?? [];
                const nowScene = archiveIndex.length > 0
                    ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
                    : 0;
                const bornScene = archiveIndex.length > 0
                    ? archiveIndex[archiveIndex.length - 1].sceneId
                    : '000';

                const latestChapter = sealedChapters[sealedChapters.length - 1];
                const worldContext = latestChapter?.summary
                    ? `Recently sealed chapter "${latestChapter.title}": ${latestChapter.summary}`
                    : '';

                // Fallback anchor: the last GM line.
                const messages = modCtx.data.messages ?? [];
                let fallbackAnchorText;
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === 'assistant' && messages[i].content) {
                        fallbackAnchorText = typeof messages[i].content === 'string' ? messages[i].content : undefined;
                        break;
                    }
                }

                // NPC pressure: rebuild the map from the ledger (desktop
                // stores it inside each NPCEntry.pressure).
                const npcLedger = modCtx.data.npcLedger ?? [];
                const pressure = {};
                for (const npc of npcLedger) {
                    if (npc.pressure) pressure[npc.id] = npc.pressure;
                }

                const spawnInput = pickArcSpawnInput({
                    arcs: arcList,
                    openThreads,
                    pressure,
                    npcLedger,
                    worldContext,
                    bornScene,
                    nowScene,
                    fallbackAnchorText,
                });

                if (!spawnInput) {
                    // No anchor: no open thread, no pressured NPC, and no GM
                    // line to fall back on. Surfaced as `error` rather than a
                    // silent return to `idle` — a press that resolves to
                    // nothing visible is indistinguishable from a dead button,
                    // which is the failure mode this whole path just had.
                    modCtx.log('[ArcInjector] no anchor available — nothing to ground an arc on');
                    setPhase('error');
                    setTimeout(() => setPhase('idle'), 2500);
                    return;
                }

                const arc = await spawnArc(modCtx, spawnInput);
                if (!arc) {
                    setPhase('error');
                    setTimeout(() => setPhase('idle'), 2500);
                    return;
                }

                const nextArcs = [...arcList, arc];
                await modCtx.table.write('arcs', nextArcs);
                // Close the gate immediately, so the button goes straight from
                // INJECTED to ARC ACTIVE without a window in which it invites a
                // second press.
                activeArcCount = countActiveArcs(nextArcs);
                setPhase('success');
                setTimeout(() => setPhase('idle'), 1600);
            } catch (err) {
                modCtx.log('[ArcInjector] spawn failed:', err);
                setPhase('error');
                setTimeout(() => setPhase('idle'), 2500);
            }
        },
        state: () => {
            switch (pressState.phase) {
                case 'loading':
                    return { icon: 'Loader2', label: 'INJECTING…', busy: true, tone: 'warn', disabled: true };
                case 'success':
                    return { icon: 'Check', label: 'INJECTED', tone: 'active', disabled: true };
                case 'error':
                    return { icon: 'AlertCircle', label: 'FAILED — TAP TO RETRY', tone: 'danger' };
                default:
                    // An arc is still climbing: greyed out and saying so. It
                    // releases itself when the tick spends the arc — no press,
                    // no timer, nothing to remember.
                    if (activeArcCount > 0) {
                        return {
                            icon: 'Hourglass',
                            label: 'ARC ACTIVE',
                            tooltip: 'An arc is already simmering — it frees up once it plays out',
                            disabled: true,
                        };
                    }
                    return { tone: 'warn' };
            }
        },
    });

    // Keep the gate honest without a press.
    //
    // `turn.committed` fires downstream of `runPostTurnPipeline`, which awaits
    // its tracks — so by the time it lands, this turn's arc tick has already
    // run and written back. An arc that boiled over on that tick is no longer
    // `active`, and this is what un-greys the button for it.
    //
    // `campaign.opened` covers the switch: arcs are per-campaign, so the gate
    // has to be re-read against the campaign now in front of the player.
    if (ctx.events) {
        ctx.events.on('turn.committed', () => { void refreshActiveArcs(ctx); });
        ctx.events.on('campaign.opened', () => { void refreshActiveArcs(ctx); });
    }
    // And once now, so a reload into a campaign with a live arc paints the
    // gate on first render rather than after the next turn.
    void refreshActiveArcs(ctx);
}

export function onDisable() {
    // The host removes the composer entry on disable (MOUNTS.md §8.5 —
    // teardown is host-owned). Drop our handle to the removed entry first,
    // so the reset below cannot call `update()` on it, then reset the press
    // state so a re-enable starts clean.
    composerHandle = undefined;
    pressState = { phase: 'idle' };
    // The gate is re-read from the table on the next activate; a stale count
    // here would grey out a freshly re-enabled button against nothing.
    activeArcCount = 0;
}