// Author Prose Style mod — dedicated extension for selecting a prose voice
// archetype at runtime.
//
// Pure mod control: declares a `settings` table (single-object, keepOnCleanCopy),
// a `chat.rail` panel with a `<select>` dropdown for voice selection, and a
// `generateInterceptor` hook that injects the selected archetype's prose style at
// order 245 (between world-tone 240 and dnd-rules 250) every turn.
//
// Voice profiles are embedded here as generic archetypes — no named authors, no
// book titles — so the mod can be shared and published freely. Add a profile to
// the AUTHORS map and add an `<option>` to the rail panel's select — nothing
// else changes.
//
// THE ONE RULE: talks to `ctx` only. Never imports from `src/`.

// ─── Module-scope state ─────────────────────────────────────────────────────
// Kept live by subscriptions set up in `activate`. The interceptor and the rail
// panel both read closures — the pattern the template mod established.
let _modCtx = null;        // activate-time context lease (interceptor closure)
let railHandle = null;     // chat.rail mount handle
let unsubs = [];           // cleanup hooks for disable
let _settings = {};        // mirror of the settings table (single-object)

const SETTINGS_TABLE = 'settings';
const DEFAULT_AUTHOR = 'tactical-analytical';
const ORDER = 245;
const BUDGET = 520;

// ─── Voice archetypes embedded in the mod ────────────────────────────────────
//
// Each profile:
//   id        — unique key, stored in settings as `authorId`
//   label     — what shows in the dropdown
//   proseGuide│ token-bounded style instructions injected into the prompt
//
// Archetypes are deliberately generic. Unknown or legacy saved ids resolve to
// DEFAULT_AUTHOR via the fallback, so no migration is needed.

const AUTHORS = {
    'tactical-analytical': {
        id: 'tactical-analytical',
        label: 'Tactical & Analytical',
        proseGuide: `AUTHOR STYLE — Tactical & Analytical Adventure:

Run each scene like a game session where you play every character. Model each on-stage character's goals, emotional state, physical state, and knowledge before deciding their reaction. Few instances of the "idiot ball" — characters act on their own motives, not to serve the plot.

Analytical internal monologue: show the POV character thinking through options step by step. "He considered X, weighed Y, decided Z."

Straightforward prose, dry wit, not taking itself too seriously. Plain words, clear actors. No purple prose, no clichés, no unearned moralising.

RHYTHM — vary paragraph lengths by pace: short paragraphs (1-2 sentences) for fast beats, action peaks, or lone dialogue lines that land harder on their own; medium paragraphs (3-5 sentences) for development, description, and reaction; longer ones only for dense atmosphere when the scene calls for it. Scan for paragraph-length monotony: if every paragraph is roughly the same size, drop a short one into the middle of a cluster — a lone line of dialogue, a sharp action, or a sentence fragment. A line of dialogue without surrounding narration is a legitimate tool; use it when the words alone carry the weight. Vary where your shortest sentence lands within each paragraph (opener, middle, closer), and if the last passage you wrote (or are extending into) was all medium-length, break the pattern here.

Combat = tactical problem-solving: mechanical resolution, resource management, leveraging system rules. The MC is frequently outmatched.

Spark scenes: include details not central to plot for imaginative value (unused options, alternate outcomes, overlooked choices).

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'epic-high-fantasy': {
        id: 'epic-high-fantasy',
        label: 'Epic High Fantasy',
        proseGuide: `AUTHOR STYLE — Epic High Fantasy:

Elevated but clear diction. Sweep into mythic scale — ancient evils, oaths, destinies — then ground every epic beat in a concrete, human moment so the scope never floats. Landscapes are presences: forests watch, roads remember, mountains judge. Heroes act with conviction; doubt is something they earn in private.

Set-pieces are built in three moves: the calm that makes the threat feel real, the clash that is tactical and felt, the aftermath where the cost is counted. Villains believe they are right. Gods and fate are real forces — distant but pointed.

Dialogue carries formality without stiffness: characters speak in full sentences, but with warmth, wit, and argument. Recurring motifs (a name, a phrase, an heirloom) return at turning points.

RHYTHM — vary paragraph length by pace: short beats for blows, oaths, and lone lines that should land alone; medium paragraphs for development and description; longer ones for ceremony and sweeping vista. Break any run of same-sized paragraphs with a sharp short line.

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'hardboiled-noir': {
        id: 'hardboiled-noir',
        label: 'Hardboiled Noir / Pulp',
        proseGuide: `AUTHOR STYLE — Hardboiled Noir / Pulp:

Terse, cynical, world-weary. Short declarative sentences. Plain nouns, hard verbs. Show the city as a character — rain, steam, neon, cheap coffee, doors that slam. Characters talk around what they mean; dialogue circles the subject, lands an oblique jab, then cuts away.

A scene is a series of small defeats. Violence arrives suddenly and ends quickly, and stays felt for the rest of the page. Trust is earned in bad trades. Everyone has a past and a price.

Fragments work as punctuation. A line of description can carry an entire mood: "The window was dirty. So was the truth in that room."

RHYTHM — keep paragraphs short. Long ones only for a hard gut-check or a confession. Vary sentence length inside each paragraph; end paragraphs on the heaviest word.

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'cozy-slice-of-life': {
        id: 'cozy-slice-of-life',
        label: 'Cozy / Slice-of-Life',
        proseGuide: `AUTHOR STYLE — Cozy & Slice-of-Life:

Warm, character-first, low-key. Build scenes from small concrete sensory details — the smell of fresh bread, a chair that creaks, the particular way rain sounds on a familiar roof. Show community as texture: neighbours with names, habits, running jokes.

Conflicts are real but humane — misunderstanding, worry, a debt, a secret — resolved through conversation and small brave acts, not spectacle. Kindness is a plot force. Found family matters. Pacing is unhurried; let characters sit with a cup of tea and actually talk.

Gentle humour, never mocking. Dialogue is warm, specific, and full of shorthand between people who know each other. Every scene leaves the reader a little warmer or a little more worried for its people.

RHYTHM — paragraph lengths stay even and comfortable, like someone telling a story; drop a short line only to land a moment (a confession, a quiet fear, an answered question).

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'mythic-lyrical': {
        id: 'mythic-lyrical',
        label: 'Mythic / Lyrical',
        proseGuide: `AUTHOR STYLE — Mythic & Lyrical:

Poetic, rhythmic, metaphor-forward. Every sentence earns its weight; imagery does the work of explanation. Trust the reader: imply, evoke, leave gaps. Repetition is structure — anaphora, refrains, a phrase that returns like a tide.

Set the scene with cadence before content. Nature and fate are active forces, watching, answering. Speech is spare and formal, every line a stone dropped in still water. Silence between exchanges carries meaning.

Action is ritualised and consequential — every blow an irreversible verb. Description luxuriates where it matters and vanishes elsewhere. Avoid modern idioms and clichés entirely; coin fresh imagery instead.

RHYTHM — build through long cadenced paragraphs, then shatter the run with a single short line that echoes. Break rhythm deliberately, at turning points only.

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'pulp-swashbuckling': {
        id: 'pulp-swashbuckling',
        label: 'Pulp Swashbuckling',
        proseGuide: `AUTHOR STYLE — Pulp Swashbuckling:

Fast, fun, larger-than-life. High-colour action with momentum — chases, narrow escapes, last-second saves, rooftops and rigging. Heroes are capable and just a little too confident; villains relish their own villainy. Keep description lean and propulsive; let energy carry the reader.

Banter is snappy and plentiful. Good guys spar with words the way they spar with blades. Every scene ends on a tilt — a hook, a reversal, a door kicked open. Fortune favours the bold, and boldness is shown, not claimed.

Showmanship over grit: when someone is wounded, it's dramatic; when someone fights, it's a spectacle of near-misses and clever tricks. Morality is clear without being preachy — the hero wins by wit and nerve, and it costs them something worth paying.

RHYTHM — short to medium paragraphs; cut through anywhere with a one-line punch. Open scenes mid-motion. End on snappy dialogue or a cliff-hanger-tilted image.

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
    'grimdark': {
        id: 'grimdark',
        label: 'Grimdark',
        proseGuide: `AUTHOR STYLE — Grimdark:

Bleak and visceral, morally gray. No euphemism: people bleed, suffer, and remember it. The world is harsh — mud, cold, hunger, authority that doesn't care — and the environment is a character that grinds against the cast.

Prose is blunt and grounded, sparing of ornament; when metaphor appears, it cuts. Every victory costs something, and hope is rare, specific, and earned across pain. Gallows humour is the valve: wit in the face of it, never at the protagonist's expense.

Characters do terrible things for survivable reasons and good things for selfish ones. Consequences follow. Show what hardship does to the body and the temper before it hardens into courage.

RHYTHM — short, blunt paragraphs; long ones only for grinding description of suffering or a rare quiet moment. End paragraphs on the cost, not the reprieve.

Hard constraints: never reference [[SCENE_STAKES: ...]] tag in prose. Never show WRITER REASONING FRAMEWORK steps in output.`,
    },
};

// ─── Lifecycle hooks ────────────────────────────────────────────────────────

/**
 * `install` fires once, the first time this mod id is seen.
 * Seed the `settings` single-object table with the default voice.
 * Never fires again, even after disable/enable.
 */
export function onInstall(ctx) {
    if (!ctx) return;
    ctx.log('author-style installed');
    if (ctx.data.campaignId !== null) {
        void ctx.table.write(SETTINGS_TABLE, { authorId: DEFAULT_AUTHOR });
    }
}

/**
 * `activate` fires at every app load and after a user toggles the mod back on.
 * Register mounts (chat.rail panel), subscriptions.
 */
export async function onActivate(ctx) {
    if (!ctx || !ctx.mounts) return;

    unsubs = [];
    railHandle = null;
    _modCtx = ctx;

    // ── Load own settings table into module scope ─────────────────────────
    _settings = await loadSettings(ctx);

    // ── Subscriptions: keep _settings live for interceptor and rail ──────
    unsubs.push(ctx.table.subscribe(SETTINGS_TABLE, (rows) => {
        if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
            _settings = { ...rows };
        } else {
            _settings = {};
        }
        if (railHandle) railHandle.update();
    }));

    // Sticky `campaign.opened` — fires on every campaign open and replays to a
    // late subscriber. Event subscriptions survive campaign switches while
    // reactive handles (ctx.subscribe / ctx.table.subscribe) are revoked on
    // switch, so this is the recovery path for the settings table: a mod that
    // activated before any campaign was open, or just survived a switch,
    // re-reads the newly opened campaign's settings and repaints the rail.
    unsubs.push(ctx.events.on('campaign.opened', () => {
        void Promise.resolve(loadSettings(ctx)).then((s) => {
            _settings = s;
            railHandle?.update();
        });
    }));

    // ── Mount: chat.rail panel ───────────────────────────────────────────
    railHandle = ctx.mounts.rail({
        id: 'author-style',
        title: 'Prose Style',
        icon: 'PenTool',
        mount: (node, modCtx) => mountRailPanel(node, modCtx),
    });

    ctx.log('author-style activated; authorId =', _settings.authorId);
}

/**
 * `disable` fires when the user toggles the mod off.
 * The host removes every mount, subscription and interceptor; we tear down
 * defensively so closures don't leak.
 */
export function onDisable(ctx) {
    for (const u of unsubs) {
        try { if (typeof u === 'function') u(); } catch { /* ignore */ }
    }
    unsubs = [];
    railHandle = null;
    _modCtx = null;
    _settings = {};
    if (ctx) ctx.log('author-style disabled');
}

/**
 * `generateInterceptor` — pre-prompt hook. Fires once per turn.
 * Reads the selected voice from `_settings` (module scope, kept live by
 * subscription) and returns the prose guide as a contribution at order 245.
 */
export function interceptPrompt(input) {
    // Under an Absolute Command the player has overridden standing instructions.
    if (input && input.hasAbsoluteCommand) return;

    const authorId = (typeof _settings.authorId === 'string' && _settings.authorId)
        ? _settings.authorId
        : DEFAULT_AUTHOR;

    const profile = AUTHORS[authorId];
    if (!profile || !profile.proseGuide) return;

    return {
        contributions: [
            {
                id: 'author-style',
                order: ORDER,
                budget: BUDGET,
                text: profile.proseGuide,
            },
        ],
    };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadSettings(ctx) {
    try {
        const obj = await ctx.table.read(SETTINGS_TABLE);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            return obj;
        }
    } catch (e) {
        ctx.log('settings read failed:', e instanceof Error ? e.message : String(e));
    }
    // Seed default on first read.
    try {
        await ctx.table.write(SETTINGS_TABLE, { authorId: DEFAULT_AUTHOR });
    } catch (e) {
        ctx.log('settings seed failed:', e instanceof Error ? e.message : String(e));
    }
    return { authorId: DEFAULT_AUTHOR };
}

async function persistSettings(ctx, obj) {
    try {
        await ctx.table.write(SETTINGS_TABLE, obj);
    } catch (e) {
        ctx.log('settings write failed:', e instanceof Error ? e.message : String(e));
    }
}

// ─── Mount interior: chat.rail panel ────────────────────────────────────────

function mountRailPanel(node, modCtx) {
    const root = document.createElement('div');
    root.style.fontFamily = 'inherit';
    root.style.fontSize = '13px';
    root.style.color = 'inherit';
    root.style.padding = '8px';
    root.style.boxSizing = 'border-box';
    root.style.maxWidth = '100%';
    root.style.overflowWrap = 'break-word';
    node.append(root);

    const paint = () => {
        root.replaceChildren();

        // Read from module-scope state (kept live by subscription).
        const authorId = (typeof _settings.authorId === 'string' && _settings.authorId)
            ? _settings.authorId
            : DEFAULT_AUTHOR;

        const title = document.createElement('div');
        title.textContent = 'Prose Author';
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';
        root.append(title);

        const desc = document.createElement('div');
        desc.textContent = 'Select a prose voice. Applied to every GM turn.';
        desc.style.fontSize = '11px';
        desc.style.marginBottom = '10px';
        root.append(desc);

        const select = document.createElement('select');
        select.style.width = '100%';
        select.style.boxSizing = 'border-box';
        select.style.padding = '6px 8px';
        select.style.fontSize = '12px';
        select.style.fontFamily = 'inherit';
        select.style.color = 'inherit';
        select.style.backgroundColor = 'var(--bg-void, #1a1a2e)';
        select.style.border = '1px solid var(--border-color, #3a3a5c)';
        select.style.borderRadius = '4px';
        select.style.outline = 'none';
        select.style.cursor = 'pointer';
        select.style.appearance = 'auto';
        select.style.maxWidth = '100%';
        select.style.overflow = 'hidden';
        select.style.textOverflow = 'ellipsis';

        // Build options from the embedded profiles.
        for (const [id, profile] of Object.entries(AUTHORS)) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = profile.label;
            if (id === DEFAULT_AUTHOR) option.textContent += ' (default)';
            select.append(option);
        }

        // Set the current value from module-scope state (normalize unknown or
        // legacy saved ids to the default).
        select.value = AUTHORS[authorId] ? authorId : DEFAULT_AUTHOR;

        // Handle user selection changes.
        select.addEventListener('change', async (ev) => {
            const chosen = ev.target.value;
            const settings = await loadSettings(modCtx);
            settings.authorId = chosen;
            await persistSettings(modCtx, settings);
            // _settings will be updated by the subscription callback.
            modCtx.log('author-style switched to:', chosen);
        });

        root.append(select);

        const active = document.createElement('div');
        active.style.fontSize = '11px';
        active.style.marginTop = '6px';
        const p = AUTHORS[authorId] ?? AUTHORS[DEFAULT_AUTHOR];
        active.textContent = `Active: ${p.label}`;
        root.append(active);
    };

    paint();
    // ONE subscription for the whole panel; returned as cleanup.
    const u = modCtx.table.subscribe(SETTINGS_TABLE, paint);
    return () => { u(); node.replaceChildren(); };
}
