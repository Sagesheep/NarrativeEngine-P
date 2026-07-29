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

## What mods can't do (yet)

Being straight with you about the current boundary:

- **No code.** No JavaScript, no logic, no loops.
- **No custom UI.** You can't add a panel, button, or tab.
- **No algorithms.** Nothing that inspects, scores, or reorders what the engine already built.
- **No new mechanics.** You can *describe* a rule to the AI; you can't make the engine resolve one.
- **No post-turn scans.** You can't add something that runs after a turn and writes to a ledger.
- **No editing existing blocks.** You can add or suppress, not rewrite.

A mod adds text, under conditions, in a chosen order, within a budget. That's the whole surface today.

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
