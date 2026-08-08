# Making a mod

A mod for Narrative Engine is **one JSON file**. It adds text to the prompt the AI sees, optionally
only under conditions you choose. No code runs, so a mod can't break your game or touch your API
keys — the worst a bad mod can do is get rejected with a reason.

If you've edited a SillyTavern character card, you already know enough to do this.

> **This format is not frozen.** The engine is still changing quickly, so a future version may
> require small edits to your mod file. We'll keep those changes small and documented, but we're not
> promising a stable contract yet.

---

## Where mods go

Put `.mod.json` files in the **`mods/` folder** at the app root — next to `data/`. It's created for
you on first run.

```
Narrative Engine/
├── data/                        ← your campaigns
└── mods/                        ← your mods
    └── grimdark-tone.mod.json
```

No restart needed. Drop a file in, open **Settings → Extensions**, and press **Rescan**.

---

## Your first mod

Save this as `mods/grimdark-tone.mod.json`:

```json
{
  "id": "grimdark-tone",
  "name": "Grimdark Tone",
  "version": "1.0.0",
  "description": "Wounds persist and mercy costs something.",
  "contributions": [
    {
      "id": "tone",
      "order": 250,
      "budget": 120,
      "text": "Tone: unforgiving. Injuries persist between scenes and mercy costs the one who gives it."
    }
  ]
}
```

Line by line:

- **`id`** — a unique name for your mod. Letters, numbers, `_` and `-` only. **No dots.**
- **`name`** / **`description`** — what the user sees in the Extensions screen.
- **`version`** — your mod's version. Any string.
- **`contributions`** — the list of things this mod adds. At least one.
  - **`id`** — unique *within your mod*. Same character rules.
  - **`order`** — where the text lands relative to everything else. See below.
  - **`budget`** — the most tokens this may use.
  - **`text`** — what gets added to the prompt.

Press Rescan and "Grimdark Tone" appears with a checkbox. That's the whole loop.

---

## `order` — where your text lands

Everything in the prompt's final section is sorted by `order`, low to high. The engine's own blocks
sit at round hundreds, leaving room between any two:

| `order` | Block | Can you suppress it? |
|--------:|-------|----------------------|
| 100 | World state (rules, world, enemies, scene state) | **No** — protected |
| 200 | Chain-of-thought invocation | Yes — `writer.cot` |
| 300 | Director Brief | Yes — `director.brief` |
| 400 | GM Reminder | Yes — `gm.reminder` |
| 500 | Director Watchdog nudge | Yes — `watchdog.nudge` |
| 600 | Ask-GM handoff | **No** — protected |
| 700 | The player's message | **No** — protected |
| 800 | Absolute Command | **No** — protected |

So `"order": 250` lands after the reasoning invocation and before the Director Brief. `"order": 750`
would land after the player's message — very high emphasis, use sparingly.

You can use any number, including negatives and values above 800.

---

## `budget` — how much room your text gets

`budget` is the maximum number of tokens your contribution may occupy. If your text is longer, it is
**trimmed to fit, not dropped** — you get the first part of it.

If you leave `budget` out, a default cap of **512 tokens** is applied. Built-in blocks are unbounded;
mods are not, so one mod can't quietly eat the whole context window.

A `budget` of `0` removes the contribution entirely.

---

## `when` — conditions

Add `when` to make a contribution appear only sometimes. Leave it out and the text is always active.

```json
{
  "id": "tavern-mood",
  "order": 250,
  "budget": 80,
  "when": { "location": ["Tavern", "Inn"], "inCombat": false },
  "text": "The room is loud. Conversations carry further than people think."
}
```

**All keys must match** (AND). **Within one key, any value matches** (OR). Above: location is Tavern
*or* Inn, *and* combat is not active.

| Key | Matches against | Type |
|---|---|---|
| `npcPresent` | NPCs on stage this turn | string or array |
| `location` | The current place name | string or array |
| `inCombat` | Whether an enemy encounter is active | `true` / `false` |
| `sceneTag` | Scene tags | string or array |

Text matching is **case-insensitive**.

> ⚠️ **`sceneTag` does not work yet.** It's accepted by the file format, but the engine doesn't
> populate scene tags at the moment the prompt is built, so **a condition using `sceneTag` never
> matches**. It's documented here so the format won't change when it starts working. Don't use it yet.

**Unknown keys are rejected.** If you typo `npcsPresent`, the whole file is rejected with a reason —
deliberately, because silently ignoring it would mean "no condition", i.e. always on, which is the
most dangerous way to be wrong.

**If the engine doesn't know a fact, the condition doesn't match.** No current location means a
`location` condition is false, not true.

---

## Template slots

Two placeholders can appear inside `text`:

| Slot | Becomes |
|---|---|
| `{{location}}` | The current place name |
| `{{npcs}}` | The on-stage NPC names, comma-separated |

```json
"text": "Anyone in {{location}} would notice a drawn blade."
```

Anything else in `{{ }}` is left exactly as written. There are no expressions, no logic, no other
variables.

---

## `suppresses` — turning off a built-in block

A contribution can remove another block while it's active:

```json
{
  "id": "no-nagging",
  "order": 250,
  "text": "Keep the narration lean.",
  "suppresses": ["gm.reminder"]
}
```

You may suppress the four toggleable blocks in the table above. Naming any **protected** id
(`user.message`, `volatile.block`, `askgm.brief`, `absolute.command`) **rejects the whole file** — a
mod is never allowed to delete the player's own words.

Two rules worth knowing:

- **Suppression is one pass.** If A suppresses B and B suppresses C, then when both A and B are
  active you get A only — B's suppression of C still counts even though B itself was removed.
- **An inactive contribution suppresses nothing.** If your `when` doesn't match, your `suppresses`
  doesn't fire either.

### Finding out what you may suppress

The four toggleable ids above are the set today. Rather than hard-coding them, a native mod can
read the published list from the context:

```js
export function onActivate(ctx) {
    // ctx.api.suppressibleIds — frozen array of built-in ids a mod may suppress.
    // The complement of the protected four; grows deliberately, never silently.
    const maySuppress = ctx.api.suppressibleIds;
}
```

`ctx.api.suppressibleIds` always agrees with what the loader enforces. A Megumin-class mod that
stands up a parallel system uses this to decide which built-in blocks it may turn off, rather
than guessing from a static document that goes stale the moment the set grows.

---

## The pre-prompt interceptor — suppressing *conditionally*

`suppresses` in a manifest is either always on or always off. When you need "drop the GM reminder
**on turns where the Director spoke**", you need code, and code means the native tier.

Name one exported function in your manifest:

```json
"native": {
  "js": "index.js",
  "generateInterceptor": "interceptPrompt"
}
```

The host calls it **once per turn**, after it knows every input the prompt consumes and before
assembly begins:

```js
export function interceptPrompt(input) {
    if (input.hasAbsoluteCommand) return;   // nothing to say — the quiet path

    return {
        contributions: [
            { id: 'scene-ledger', order: 450, budget: 120, text: `Turn ${input.turnId}.` },
        ],
        suppress: input.hasDirectorBrief ? ['gm.reminder'] : [],
    };
}
```

`input` is frozen and carries only this:

| Field | What it is |
|---|---|
| `turnId` | Correlates with the `turn.start` / `turn.committed` events |
| `campaignId` | The active campaign, or `null` |
| `tier` | The tier this turn runs at |
| `playerInput` | The player's message **as the prompt will carry it** — dice, loot and one-shot injections included |
| `hasDirectorBrief` | The Director authored a Brief this turn |
| `hasWatchdogNudge` | The deterministic watchdog nudge is armed |
| `hasAbsoluteCommand` | The player armed an Absolute Command |

Returning nothing is normal — a mod with nothing to say this turn says nothing.

**Five rules.**

1. **Add and suppress, nothing else.** There is no field for rewriting a block, replacing the
   player's message, or reordering assembly.
2. **The protected four stay protected.** `user.message`, `volatile.block`, `askgm.brief` and
   `absolute.command` can never be suppressed. Naming one does *not* reject the mod the way the
   declarative `suppresses` does — it drops that one entry, shows you why in **Settings →
   Extensions**, and honours the rest of your interception.
3. **You get one argument, and it is not `ctx`.** Building a fresh mod context every turn would
   copy the whole message list on the hot path. Subscribe in `activate` and read the closure:

   ```js
   let messageCount = 0;
   export function onActivate(ctx) {
       ctx.subscribe('messages', (messages) => { messageCount = messages.length; });
   }
   ```

4. **There is a hard deadline (1.5 seconds).** It is not the place for a model call. Compute off the
   turn path — a compute hook, or a `turn.committed` listener — write the result to your own table,
   and read the table here.
5. **Be deterministic.** Two identical turns with the same mods must produce the same prompt. The
   host guarantees the order interceptors run in; the rest is yours.

Your text is budgeted exactly like a declarative contribution — declare a `budget` or take the
default. If your interceptor throws, hangs, or returns something malformed, the fault shows up in
**Settings → Extensions** and the turn goes ahead with the un-intercepted prompt. It cannot break a
turn.

---

## Publishing facts — `ctx.facts`

A `when` condition reads four facts the host computes: `npcPresent`, `location`, `inCombat`,
`sceneTag`. When a subsystem leaves core (Phase 8, enemies), the mod that owns it can keep publishing
the fact so every other mod's `when` keeps working — that is what `ctx.facts` is for.

Register a publisher in your `activate` hook:

```js
export function onActivate(ctx) {
    ctx.facts.register(
        'inCombat',
        () => currentEncounterIsActive(),  // return the fact value for this turn
        { claims: 'inCombat' },
    );
}
```

The publisher runs **once per turn**, after the interceptor and before conditions are evaluated.
It must be **synchronous** and **pure** — reading `ctx.data` is fine; awaiting or mutating is not.

### Claiming a core fact

`inCombat` is the only core fact open for claims today. You claim it by passing
`{ claims: 'inCombat' }` — and the `name` you register **must match** the claim. The claim is what
prevents the footgun: a mod cannot set `inCombat` by accident, only deliberately.

### Conflicts

Two mods claiming the same core fact is a conflict. The one **earlier in `loadOrder`** wins; the
loser is surfaced in **Settings → Extensions** with both mods named, so you can see who collided.

### Throwing

A throwing publisher yields no fact (no match) plus a surfaced fault. The turn never breaks.

### What is NOT claimable

`location`, `sceneTags`, and `onStageNpcNames` are core facts but are **not open for claims** today.
Registering a publisher for one of these names (even with `claims:`) is rejected with a fault. The
host opens a name for claims when a subsystem leaving core owns that domain.

### Namespaced mod facts

A mod may register a fact without a claim — e.g. `ctx.facts.register('mood', () => 'tense')`. The
host namespaces it to `mod.<modId>.mood`. It is not read by `when` conditions today (the four keys
above are the only ones `when` understands); the namespacing exists so a future expansion of `when`
can read mod-owned facts without a second registration surface.

### Zero mods

With no mod registered, facts behave exactly as today — the host computes them. `ctx.facts` is
native-tier only: a sandboxed compute mod cannot hold a closure across turns, so `ctx.facts` throws
"native-tier only" on the worker side.

---

## `appVersion` — requiring a minimum app version

Optional. Two forms only:

```json
"appVersion": ">=1.0.0"     // or ">=1.0", or ">=1"
"appVersion": "*"           // any version (same as leaving it out)
```

Anything else — `^1.0.0`, `~1.0.0`, `<2.0.0`, a bare `1.0.0` — is **rejected**. If the app is older
than your floor, the mod is rejected with a message naming both versions.

---

## What a text-only mod can't do

This list is about the **declarative** tier — a manifest with `contributions[]` and no `native`
block. That mod adds text, under conditions, in a chosen order, within a budget, and that is its
whole surface:

- **No code.** No JavaScript, no logic, no loops.
- **No custom UI.** You can't add a panel, button, or tab.
- **No algorithms.** Nothing that inspects, scores, or reorders what the engine already built.
- **No new mechanics.** You can *describe* a rule to the AI; you can't make the engine resolve one.
- **No post-turn scans.** You can't add something that runs after a turn and writes to a ledger.

A `native` block lifts the first five: it gets you lifecycle hooks, mount points, macros, the event
bus, and the pre-prompt interceptor above.

One limit survives at **every** tier, and it is a rule rather than a gap:

- **No editing existing blocks.** You can add or suppress, never rewrite — and the player's own
  message, the world state, the confirmed ask-GM handoff and the player's absolute command cannot
  even be suppressed.

---

## Troubleshooting

**My mod doesn't show up.**
Open **Settings → Extensions**. If the file was rejected it appears under **Rejected files** with the
exact reason. If it isn't there at all, check the filename ends in `.mod.json` and it's in `mods/`.

**Common rejections:**

| Reason | Fix |
|---|---|
| `id` contains a dot | Use letters, numbers, `_`, `-` only |
| unknown key in `when` | Check spelling against the table above |
| `contributions` must be a non-empty array | Add at least one contribution |
| `text` required | Every contribution needs non-empty `text` |
| suppressing a protected id | You can't suppress those four |
| unsupported `appVersion` | Only `">=X.Y.Z"` and `"*"` |
| duplicate id | Two files declare the same mod `id`; the first alphabetically wins |

**My mod loads but nothing changes.**
Check its checkbox is on. If it has a `when`, remember the conditions must *all* match — and
`sceneTag` never matches yet.

**My text gets cut off.**
Raise `budget`, or write less. Remember the 512-token default when `budget` is omitted.
