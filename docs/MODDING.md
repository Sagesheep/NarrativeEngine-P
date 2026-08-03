# Making a Narrative Engine module

Narrative Engine extensions start with a `.mod.json` manifest in the app's `mods/` folder. A simple
mod needs only that file. Advanced modules may add campaign-owned tables, post-turn compute, panels,
and isolated screens. Open **Settings > Extensions** and select **Rescan** after changing files.

The module format is still evolving. Use `appVersion` to state the oldest compatible engine release.

## A basic prompt mod

Save this as `mods/grimdark-tone.mod.json`:

```json
{
  "id": "grimdark-tone",
  "name": "Grimdark Tone",
  "version": "1.0.0",
  "appVersion": ">=1.0.4",
  "description": "Wounds persist and mercy costs something.",
  "contributions": [{
    "id": "tone",
    "order": 250,
    "budget": 120,
    "text": "Tone: unforgiving. Injuries persist between scenes."
  }]
}
```

- `id`: unique module ID using letters, numbers, `_`, or `-`; no dots.
- `version`: the module version.
- `appVersion`: optional `">=X.Y.Z"` minimum, or `"*"`.
- `contributions`: one or more prompt blocks. Contribution IDs use the same character rules.
- `order`: prompt placement, from low to high. Built-in blocks occupy roughly 100 through 800.
- `budget`: maximum tokens for this block. The default is 512.
- `text`: non-empty prompt text.

### Conditions, slots, and suppression

`when` conditions are ANDed across keys and ORed within an array value. Text matching is
case-insensitive. Supported keys are `npcPresent`, `location`, `inCombat`, and `sceneTag`. Unknown
facts do not match. `sceneTag` is accepted but is not currently populated during prompt assembly.

The text slots `{{location}}` and `{{npcs}}` expand to the current place and on-stage NPC names.
Unknown slots remain visible verbatim.

An active contribution may declare `suppresses` for toggleable prompt IDs such as `gm.reminder`,
`director.brief`, `writer.cot`, and `watchdog.nudge`. Protected player/structural blocks cannot be
suppressed. A module is never permitted to remove the player's words.

## Campaign-persistent tables

Advanced modules can declare owned data:

```json
"tables": [
  { "name": "entries", "recordShape": "array", "label": "Entries" },
  { "name": "config", "recordShape": "single-object", "label": "Configuration" }
]
```

`recordShape` is `array` or `single-object`. The host namespaces each table as
`mod.<module-id>.<table-name>` and includes it in campaign hydrate/transfer data. A module cannot read
or write another module's tables.

## Mention-triggered prompt lookup

A contribution can inject rows from one of its own array tables when an exact name or alias appears
in recent play:

```json
{
  "id": "mentioned-entries",
  "order": 150,
  "budget": 1200,
  "text": "[MATCHED MODULE CONTEXT]",
  "lookup": {
    "table": "prompt-index",
    "termFields": ["terms"],
    "textField": "text",
    "recentMessages": 8
  }
}
```

The lookup table must belong to this module. Matching is case-insensitive and phrase-boundary aware;
the normal contribution budget still applies.

## Post-turn compute

```json
"compute": {
  "file": "my-module.compute.js",
  "hook": "postTurn",
  "capabilities": [
    "table:read:mod.my-module.entries",
    "table:write:mod.my-module.entries",
    "model:utility"
  ]
}
```

Compute is an ES module with a default async function. It runs after a committed turn in a
time-limited browser worker. Every table, host mutation, and model role must be declared. Writes are
journalled and applied together; a fault discards the compute result. The worker has no API keys,
network access, filesystem access, or unrestricted application state.

## Isolated screens

```json
"screens": [{
  "id": "manager",
  "file": "my-module.screen.js",
  "label": "Open Manager",
  "launch": { "surface": "header", "label": "My Module", "icon": "puzzle" },
  "capabilities": ["campaign:read:characters", "file:download"]
}]
```

A screen is an ES module with a default async function. It runs in an opaque, networkless iframe
under `sandbox="allow-scripts"`. The built-in bridge always provides:

- `table.read` / `table.write` for this module's declared tables only.
- `theme` for safe visual tokens.
- `resize` within host bounds.

Optional manifest capabilities are:

- `campaign:read:characters`
- `campaign:read:character-sheet`
- `campaign:read:inventory`
- `campaign:read:recent-play`
- `file:download`

Campaign reads return deliberately limited projections, not the complete store. Undeclared and
unknown capabilities are denied and stop the faulty screen without affecting the app.

The optional `launch` block asks the host to show a shortcut for this screen in the campaign header.
Supported icons are `sparkles`, `book-open`, and `puzzle`. The shortcut is host-rendered, opens the
same isolated screen, and disappears automatically when the user disables the module in Extensions.

## Boundaries

Modules cannot access secrets, make network requests, run server-side code, read arbitrary files or
campaign state, bypass prompt budgets, suppress protected blocks, or reach another module's tables.
Installing a mechanics module does not grant it authority to enforce player eligibility unless the
host explicitly offers such a capability; Narrative Engine currently does not.

## Troubleshooting

- A missing module must end in `.mod.json`, live in `mods/`, and be followed by **Rescan**.
- Rejected files appear in **Settings > Extensions** with their exact validation reason.
- If a contribution appears inactive, check its checkbox, `when` facts, `order`, and `budget`.
- Sibling compute/screen paths must be plain filenames in the same `mods/` folder.
- A module ID containing a dot, duplicate IDs, foreign table capability, unavailable screen
  capability, or protected suppression rejects that module safely.
