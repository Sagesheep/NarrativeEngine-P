# Making a mod

This is the **single author-facing reference** for the Narrative Engine mod
API. It is written to be read by a model before it writes a mod, not by a
human skimming for pleasure. Every sample here compiles against the shipped
`docs/narrative-mod-api.d.ts` and runs against the shipped host. If you find
yourself reaching for a file under `src/` to answer a question this document
should have answered, that is a doc bug — report it.

> **THE ONE RULE.** A mod talks to the `ModContext` object the host hands it.
> A mod **never imports from `src/`**. Nothing enforces this at runtime under
> the trust model — it holds because the context is better than the
> alternative, and because the consequence of breaking it is written down
> here. If the rule holds, the host can refactor behind the surface forever.
> If it breaks — even once, even for a first-party mod — the store becomes a
> public API and the modularity epic dies a second death.

A mod is **one folder** under `mods/` containing a `manifest.json` and
whatever source files the manifest points at. Three tiers ship today, all
expressible in one manifest:

- **Declarative** — JSON only. Adds text to the prompt under conditions you
  choose. No code, no UI. The lowest tier; the one a brand-new author
  starts with.
- **Sandboxed compute** — one JS file run in a Worker for a few hundred
  milliseconds after each turn. Real capability boundary; no page access.
  The tier a distrusted author's post-turn logic runs in.
- **Native** — one JS module imported into the page. Full host access
  (subject to the trust model in §"Trust and warnings"). Owns lifecycle
  hooks, mount points, the event bus, the pre-prompt interceptor, macros,
  facts, budgets, and the tokenizer. The tier a feature mod lives in.

One manifest may declare **all three**. A suite with native UI plus a
sandboxed post-turn scan plus a declarative prompt block is one folder, one
identity, one enable toggle.

> **This surface is frozen at mod API generation **1**.** Everything this
> document and `docs/narrative-mod-api.d.ts` describe is additive-only until
> the generation number changes. Everything else — anything under `src/` — is
> internal and may change in any release. Read
> §"Compatibility and the frozen surface" before you start; it is short, and
> it is the difference between a mod that keeps working and one that does not.

---

## Where mods go

Put a folder under `mods/` at the app root — next to `data/`. It is created
for you on first run.

```
Narrative Engine/
├── data/                        ← your campaigns
└── mods/                        ← your mods
    └── grimdark-tone/
        └── manifest.json
```

No restart needed. Drop a folder in, open **Settings → Extensions**, and
press **Rescan**. A directory without `manifest.json` is a fault with a
reason, never a silent skip.

A working **template mod** lives at `mods/template-mod/`. Copy that folder,
rename the `id` in its `manifest.json`, and edit from there — it demonstrates
every mount point, every table shape, and the canonical subscription /
cleanup patterns. The samples below are excerpts; the template is the whole
picture.

---

## Your first mod (declarative)

Save this as `mods/grimdark-tone/manifest.json`:

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

- **`id`** — a unique name for your mod. Letters, numbers, `_` and `-` only.
  **No dots.** This is the mod's identity; renaming the folder does not
  change it (the manifest wins, the folder is a path).
- **`name`** / **`description`** — what the user sees in the Extensions
  screen.
- **`version`** — `X.Y.Z`, optionally with a `-prerelease` suffix. Drives
  the `update` hook (fires when the string changes) and dependency-range
  satisfaction.
- **`contributions`** — the list of things this mod adds. May be empty or
  absent for a mod that does everything from code.
  - **`id`** — unique *within your mod*. Same character rules.
  - **`order`** — where the text lands relative to everything else. See below.
  - **`budget`** — the most tokens this may use. Default 512.
  - **`text`** — what gets added to the prompt. `{{location}}` and
    `{{npcs}}` expand; `{{mod.<yourId>.<macroName>}}` expands if you
    register a macro from native code.

Press Rescan and "Grimdark Tone" appears with a checkbox. That is the whole
declarative loop.

---

## `order` — where your text lands

Everything in the prompt's final section is sorted by `order`, low to high.
The engine's own blocks sit at round hundreds, leaving room between any two:

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

So `"order": 250` lands after the reasoning invocation and before the
Director Brief. `"order": 750` would land after the player's message — very
high emphasis, use sparingly. You can use any number, including negatives
and values above 800.

Read `ctx.api.suppressibleIds` from native code to know the set rather than
hard-coding it — see §"The pre-prompt interceptor".

---

## `budget` — how much room your text gets

`budget` is the maximum number of tokens your contribution may occupy. If
your text is longer, it is **trimmed to fit, not dropped** — you get the
first part of it.

If you leave `budget` out, a default cap of **512 tokens** is applied.
Built-in blocks are unbounded; mods are not, so one mod cannot quietly eat
the whole context window. A `budget` of `0` removes the contribution
entirely.

For token-accurate trimming of your own contribution from native code, use
`ctx.tokens.count(text)` — it uses the host's tokenizer (cl100k_base BPE),
the same encoder the host's trim logic uses. Native-tier only; a sandboxed
compute mod trims by character count.

---

## `when` — conditions

Add `when` to make a contribution appear only sometimes. Leave it out and
the text is always active.

```json
{
  "id": "tavern-mood",
  "order": 250,
  "budget": 80,
  "when": { "location": ["Tavern", "Inn"], "inCombat": false },
  "text": "The room is loud. Conversations carry further than people think."
}
```

**All keys must match** (AND). **Within one key, any value matches** (OR).
Above: location is Tavern *or* Inn, *and* combat is not active.

| Key | Matches against | Type |
|---|---|---|
| `npcPresent` | NPCs on stage this turn | string or array |
| `location` | The current place name | string or array |
| `inCombat` | Whether an enemy encounter is active | `true` / `false` |
| `sceneTag` | Scene tags | string or array |

Text matching is **case-insensitive**.

> ⚠️ **`sceneTag` does not work yet.** It is accepted by the file format, but
> the engine does not populate scene tags at the moment the prompt is built,
> so **a condition using `sceneTag` never matches**. It is documented here so
> the format will not change when it starts working. Do not use it yet.

**Unknown keys are rejected.** If you typo `npcsPresent`, the whole file is
rejected with a reason — deliberately, because silently ignoring it would
mean "no condition", i.e. always on, which is the most dangerous way to be
wrong.

**If the engine does not know a fact, the condition does not match.** No
current location means a `location` condition is false, not true.

### `inCombat` and the facts registry

`inCombat` is the one `when` fact a mod can **claim**. When enemies leave
core (Phase 8, the bundled `enemies` mod), the mod that owns them publishes
`inCombat` so every other mod's `when: { inCombat }` keeps working. See
§"Publishing facts" below.

---

## `suppresses` — turning off a built-in block

A contribution can remove another block while it is active:

```json
{
  "id": "no-nagging",
  "order": 250,
  "text": "Keep the narration lean.",
  "suppresses": ["gm.reminder"]
}
```

You may suppress the four toggleable blocks in the table above. Naming any
**protected** id (`user.message`, `volatile.block`, `askgm.brief`,
`absolute.command`) **rejects the whole file** — a mod is never allowed to
delete the player's own words.

Two rules worth knowing:

- **Suppression is one pass.** If A suppresses B and B suppresses C, then
  when both A and B are active you get A only — B's suppression of C still
  counts even though B itself was removed.
- **An inactive contribution suppresses nothing.** If your `when` does not
  match, your `suppresses` does not fire either.

For **conditional** suppression ("drop the GM reminder on turns where the
Director spoke"), see §"The pre-prompt interceptor".

---

## Template slots

Two built-in placeholders can appear inside `text`:

| Slot | Becomes |
|---|---|
| `{{location}}` | The current place name |
| `{{npcs}}` | The on-stage NPC names, comma-separated |

```json
"text": "Anyone in {{location}} would notice a drawn blade."
```

A macro you register from native code expands under **the bare name you
registered it with** — `{{markedContent}}`, not `{{mod.yourId.markedContent}}`.
The host namespaces on its side; you never write the prefix. See §"Macros".

Anything else in `{{ }}` is left exactly as written, and records a fault in
**Settings → Extensions** naming the slot, so a typo costs you a line of prompt
rather than a feature you never find out was missing. There are no expressions,
no logic, no other variables.

---

## The manifest — full field set

Every key is camelCase. Unknown top-level keys are **rejected**, not ignored
— the forward-compatibility mechanism is `appVersion`: an author using a
field this host does not have declares `appVersion: ">=1.1.0"` and gets a
precise rejection on older hosts, instead of silently losing the field on
every one of them. Keys beginning `x-` are the escape hatch: allowed
anywhere, never validated, never read by the app.

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `id` | string, `/^[a-zA-Z0-9_-]+$/` | **yes** | — | Identity. Namespaces tables (`mod.<id>.<name>`), contribution ids, contribution `when` facts. Changing it strands the user's data. |
| `name` | non-empty string | **yes** | — | Display name. |
| `version` | `X.Y.Z` or `X.Y.Z-<pre>` | **yes** | — | Drives `update` hook and dependency-range satisfaction. |
| `description` | string | no | `""` | One paragraph in Mod Management. |
| `author` | non-empty string | no | absent | Shown in the native-mod trust warning (§"Trust and warnings"). |
| `homepage` | `http:`/`https:` URL | no | absent | The other half of the trust warning — *and source*. |
| `appVersion` | `">=X[.Y[.Z]]"` or `"*"` | no | `"*"` | Minimum app version — the feature floor. Rejected on mismatch *before any mod code runs*. |
| `apiVersion` | positive integer | no | `1` | The mod API generation you wrote against. Higher than the app's → refused, naming both. Lower → loads, flagged. See §"Compatibility and the frozen surface". |
| `loadOrder` | integer (may be negative) | no | `0` | One number governs load order, hook order, mount-point render order, interceptor order. Lower runs first. A dependency always precedes its dependent even when its `loadOrder` is higher. |
| `dev` | boolean | no | `false` | Marks a development fixture. **Inverts the enablement default**: a normal mod is on unless switched off, a `dev` mod is off unless switched on. Nothing else changes. See §"Development fixtures". |
| `dependencies` | `{ "<modId>": "<range>" }` | no | `{}` | A map so adding version ranges is never a shape change. Missing → fault on the dependent. Cycle → fault naming both. Self-dependency → fault. |
| `i18n` | `{ "<locale>": "<path>" }` | no | `{}` | Locale → flat-JSON translation file. Keys are namespaced `mod.<id>.<key>` on merge. A literal string misses the lookup and renders as itself. |
| `contributions` | `ModContribution[]` | no | `[]` | Declarative prompt text. Optional for native-only mods. |
| `tables` | `ModTableDeclaration[]` | no | `[]` | The mod's own durable tables. See §"Tables". |
| `panels` | `ModPanelDeclaration[]` | no | `[]` | L1 declarative editor panels (legacy screen-surface forms). |
| `screens` | `ModScreenDeclaration[]` | no | `[]` | L1 extension screens (iframe'd, sandboxed). |
| `compute` | `ModCompute` | no | absent | The sandboxed tier. One `postTurn` hook. |
| `native` | `NativeEntry` | no | absent | The native tier. Its presence alone makes the mod native-tier for trust and warning purposes. |
| `roles` | string[] | no | `[]` | Native service-role ids claimed at runtime through `ctx.roles`. |
| `tierEntries` | `ModTierEntryDeclaration[]` | no | `[]` | Phase 7.3. Per-tier `matrix` + optional `cooldown` so the user's Lite/Pro/Max setting governs a mod that calls a model. |
| `x-*` | anything | no | ignored | Author / third-party-tooling metadata. |

A manifest must declare at least one of `contributions`, `tables`, `panels`,
`screens`, `compute`, `native`, `i18n`, `roles`, `tierEntries`. A manifest
that declares none of them is a mod that does nothing, which is a typo, not
an intention.

### Development fixtures — `dev`

```jsonc
"dev": true
```

A fixture is a mod that exists to exercise this API, not to be played with.
This repo ships thirteen: the `example-*` mods, `probe`, `probe-two`, and
`template-mod`. Between them they annotate every message, claim header
buttons, open windows, and write probe records into campaign tables — all
correct behaviour for a regression test, and all of it noise in somebody's
campaign.

`dev: true` **inverts the enablement default, and does nothing else.**

| | absent from `moduleEnabled` | explicit `false` | explicit `true` |
|---|---|---|---|
| normal mod | **enabled** | disabled | enabled |
| `dev` mod | **disabled** | disabled | enabled |

Everything else is identical. A dev mod validates, sorts, resolves as a
dependency, fires hooks, and mounts exactly like any other, because a fixture
that behaved specially would stop being a useful test of the real path. In
**Settings → Extensions** they are collected under a closed *Developer
fixtures* disclosure that shows how many are switched on, so one left running
is never hidden.

Set it on anything whose output you would not want a player to see. If you
copy `template-mod` as a starting point, **delete the flag** — your mod wants
the normal default.

> **Compatibility.** Unknown manifest fields are rejected outright, so a mod
> carrying `dev` will not load on an app build older than the one that
> introduced it — it fails with `unknown field "dev"` rather than ignoring it.
> That is the general rule for every field in this table, not something
> specific to this one, but it is the first field most authors will be tempted
> to add to an existing published mod.

### `native` — the native tier

```jsonc
"native": {
  "js": "index.js",
  "css": "style.css",
  "hooks": { "activate": "onActivate", "disable": "onDisable" },
  "generateInterceptor": "interceptPrompt"
}
```

| Field | Type | Required | Default | What it is |
|---|---|---|---|---|
| `js` | mod-relative path | **yes** within `native` | — | One ES module, `import()`ed once per enabled mod at `activate` time. |
| `css` | mod-relative path | no | absent | Injected on activate, removed on disable. One file — `@import` others or ship one. |
| `hooks` | `{ [hookName]: exportName }` | no | `{}` | Lifecycle. Values are names of functions exported by `js`. |
| `generateInterceptor` | JS identifier | no | absent | The pre-prompt hook (§"The pre-prompt interceptor"). |

**`native` has no `capabilities` field, deliberately.** Native code runs in
the page with the app's full access; an allow-list would advertise an
isolation guarantee this app does not provide. `compute.capabilities` stays,
because the Worker boundary it describes is real. See §"Tables" for what
this means for native-tier table access.

**No build step.** The file served is the file executed. The host does not
transpile, bundle, or resolve bare imports for a mod. An author who writes
TSX ships the build output.

#### The seven hooks

| Hook | Fires | Notes |
|---|---|---|
| `install` | the first time this mod id is seen | Seed default rows. Never fires again, even after disable/enable. |
| `update` | at load, when `version` differs from the recorded last-seen string | Migrate the mod's own data. Forward migration only — downgrading a mod is unsupported. |
| `activate` | at every app load, for each enabled mod, after `install`/`update` | Register UI, subscribe to events. The common one. |
| `enable` | when the user toggles the mod on | Followed immediately by `activate`. |
| `disable` | when the user toggles the mod off | Tear down everything registered. **The only teardown moment that matters** — page close is the browser's job, which is why there is no `deactivate`. The host removes every mount, subscription and event listener the mod registered; you do not need to call `remove()` / `unsubscribe()` yourself. |
| `delete` | before the folder is removed **from within the app** | Cannot fire when a user deletes the folder with the app closed; the host detects the absence at next load. |
| `clean` | only from an explicit user action with confirmation | Never from a toggle. After `clean` returns the host removes the mod's provisioned tables itself, unconditionally. |

Firing order across mods is the resolved load order — a dependency activates
before its dependent. Each hook receives one argument: the `ModContext`
object (or `undefined` when `activate` fires from the load cycle before any
campaign is open — see §"The cold-start guard"). Timeouts, fault containment
and async behaviour are the lifecycle host's: 5s, contained as a fault,
surfaced in Extensions, never fatal.

### `compute` — the sandboxed tier

```jsonc
"compute": {
  "file": "compute.js",
  "hook": "postTurn",
  "capabilities": [
    "table:read:mod.<yourId>.<name>",
    "table:write:mod.<yourId>.<name>",
    "write:updateContext",
    "write:addMessage",
    "write:addTimelineEvent",
    "model:utility"
  ]
}
```

The server never evaluates `compute.file`. It is read as text and run in a
Worker sandbox for one post-turn hook only. The capability allow-list is the
real boundary — **only the capabilities you list here are honoured**. The
grammar: `table:read:<name>`, `table:write:<name>`, `write:<writeName>`,
`model:<role>`. The bare own-table name and the fully-qualified
`mod.<id>.<name>` are both accepted.

If a mod ever needs a second sandboxed hook, the additive change is a **new
sibling key**, not a re-shape of `compute` into an array.

---

## Tables — your own durable data

A mod declares its own tables in `tables[]`:

```json
"tables": [
  { "name": "entries", "recordShape": "array",         "label": "Entries" },
  { "name": "settings", "recordShape": "single-object", "label": "Settings" }
]
```

The host provisions a per-campaign file per table
(`<campaignId>.mod-<id>-<name>.json`) and hydrates it on campaign open. A
mod reads and writes its own tables through `ctx.table`:

```js
const rows = await ctx.table.read('entries');    // Promise<unknown[]>
await ctx.table.write('entries', nextRows);       // Promise<void>
const unsub = ctx.table.subscribe('entries', (rows) => { /* live */ });
```

### `recordShape` → `table.read` return shape

The shape a table holds is fixed by its manifest declaration. **Phase 9.1
§5.3 — stated explicitly so an author does not have to infer it from a
fixture:**

| `recordShape` | `table.read` returns | `table.write` expects |
|---|---|---|
| `"array"` (default) | the array itself (`unknown[]`); empty table → `[]` | the full replacement array |
| `"single-object"` | the object (`Record<string, unknown>`); empty table → `null` | the full replacement object |

`table.write` is **wholesale replacement**. There is no append and no merge;
a read-modify-write is the supported pattern:

```js
const read = await ctx.table.read('entries');
const rows = Array.isArray(read) ? read : [];
rows.push({ id: 'row-1', text: 'hi' });
await ctx.table.write('entries', rows);
```

**`read` takes an optional type parameter** so you get your own row shape back
instead of hand-casting `unknown` at every call site:

```ts
const rows = await ctx.table.read<Entry[]>('entries');
```

It is a claim, not a check — nothing validates the file against your type, and
a user can hand-edit these files. Guard anything that would break on a bad
row. The un-parameterised call still returns `unknown`, so existing code is
unaffected.

### Native vs sandboxed table access — **Phase 9.1 §5.2**

A **native** mod reads and writes its own declared tables through `ctx.table`
with **no capability string**. The `compute.capabilities` allow-list applies
to the sandboxed compute hook only. The `example-surface-mod` fixture uses
its `ledger` table from `activate` with no capabilities declared and no
fault; a native mod doing the same is the supported path.

A **sandboxed compute** mod must declare each own-table capability it uses in
`compute.capabilities`, by bare name (`table:read:entries`) or fully-qualified
name (`table:read:mod.<id>.entries`). A capability you forgot to declare is
`[sandbox] capability denied: table:read:entries` at run time — a fault, not
a silent no-op.

### The commit-point caveat

In the **sandboxed** binding, a `table.read` followed by a `table.write` of
the same table in the same run returns the **old** value on read
(`sandboxTypes.ts:68-73`, `API.md` §1.1) — the journal applies on clean
return. `ctx.api.commitPoint` is `'on-return'` in that binding and
`'immediate'` for native. A native mod's `table.write` lands straight away.

### Cross-mod table access is absent by design

`ctx.table.read('mod.other-mod.entries')` is rejected with a mod-named
error. A silent read of another mod's table is a dependency the manifest
cannot express and the loader cannot order. Use the event bus
(§"The event bus") or facts registry (§"Publishing facts") for soft
mod-to-mod relationships.

### `migrateFrom` — adopting a retired campaign file

Phase 8.5 added one optional field to a table declaration:

```json
{ "name": "compendium", "recordShape": "array", "migrateFrom": ".enemies.json" }
```

`migrateFrom` names a member of the app's **retired-table registry** — a
fixed list of campaign files core itself wrote and has since stopped serving.
The host copies that campaign file into the mod's table once, on the first
read after the file appears, and records it in `<campaignId>.migrations.json`.
The legacy file is never modified and never deleted. Anything outside the
retired-table registry is a load fault; `migrateFrom` is **not** a way to
name an arbitrary file (that would be an exfiltration hole with a friendly
name).

---

## Mount points — adding UI

A native mod registers UI from its `activate` hook through `ctx.mounts`. Six
regions, each a named method:

| Method | Region | Shape | Budget / mod | What it is |
|---|---|---|---|---|
| `ctx.mounts.header(entry)` | `header.actions` | chrome | 2 | A status readout in the right-hand header group, or a launcher indexed under the drawer's `Mods` group; status entries sit between built-ins and the trailing `settings` + `exit`. |
| `ctx.mounts.composer(entry)` | `composer.actions` | chrome | 2 | A pill in the row above the composer (Save / Trim / Deep Search / …), before the trailing `archive`. |
| `ctx.mounts.messageAction(entry)` | `message.actions` | chrome | 3 | An icon in each message's action rail (edit / rewind / speak / delete). Not rendered while editing. |
| `ctx.mounts.rail(panel)` | `chat.rail` | content | 1 | A tabbed panel in the right-hand dock, sibling of `ChatArea`. One tab per mod; no tab strip at one mod. |
| `ctx.mounts.messageBelow(slot)` | `message.below` | content | 1 | A node beneath each visible message's prose, above the swipe/continue affordance. |
| `ctx.mounts.window(decl)` | `window.layer` | content | 3 declared | A floating window the host owns the chrome of (title bar, drag, resize, z-order, close). Declared once, opened many times. |

**Chrome** means the host renders the element; you supply data and
callbacks. **Content** means the host hands you a DOM `node` and you fill it.
A content mount is in-page (no iframe); it inherits the app's CSS custom
properties for free, and a host error boundary unmounts it on throw.

### The chrome entry

```ts
interface ChromeEntry {
    id: string;            // qualified to mod.<modId>.<id> by the host
    icon: string;          // a lucide name — see §"Icons"
    label: string;         // literal, or a key in your i18n namespace
    tooltip?: string;      // same
    onSelect(ctx: ModContext, message?: MessageRef): void | Promise<void>;
    state?(message?: MessageRef): ChromeState;  // re-read on render and on handle.update()
}
```

**`message` is present only for `ctx.mounts.messageAction`.** `header` and
`composer` are not message-scoped and receive `undefined`. This is what lets a
rail button act on *the row it was rendered on* rather than on whatever your
mod happens to be tracking — and what lets `state()` be per row:

```js
ctx.mounts.messageAction({
    id: 'mark', icon: 'Bookmark', label: 'Mark',
    onSelect: (ctx, message) => toggleMark(message.id),
    // Without the argument this would light up EVERY row's button the moment
    // any one message was marked: the rail renders one button per message
    // from a single registration.
    state: (message) => ({ active: message ? marks.has(message.id) : false }),
});
```

`state()` returns an optional `ChromeState` (all fields optional):

```ts
interface ChromeState {
    icon?: string;      // override the declared icon for this render
    label?: string;
    tooltip?: string;
    badge?: number | string;
    active?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    busy?: boolean;     // host spins the icon (Save's SAVING… state)
    tone?: 'default' | 'active' | 'warn' | 'danger';
}
```

**Re-render cadence — Phase 9.1 §5.6, stated explicitly.** A `header.actions`
row re-renders when the host's header component re-renders (which is whenever
the store it reads changes) and on `handle.update()`. `state()` is called on
each render. For a button whose state depends on a `ModData` key, subscribe
to that key and call `handle.update()` in the listener — do **not** rely on
the host re-rendering on its own, because the header re-renders on a narrow
set of store changes that may not include yours. `composer.actions` and
`message.actions` follow the same rule for their rows.

Canonical pattern:

```js
const handle = ctx.mounts.header({
    id: 'compendium',
    icon: 'Swords',
    label: 'Enemies',
    tooltip: 'Open the enemy compendium',
    onSelect: () => win.open(),
    state: () => ({ badge: count, active: isOpen }),
});
ctx.subscribe('messages', () => handle.update());
```

### The content mounts

```ts
interface RailPanel {
    id: string;
    title: string;        // the tab label; i18n as above
    icon?: string;
    mount(node: HTMLElement, ctx: ModContext): void | (() => void);
}

interface MessageContentSlot {
    id: string;
    mount(node: HTMLElement, ctx: ModContext, message: MessageRef): void | (() => void);
}

interface WindowDeclaration {
    id: string;
    title: string;
    defaultSize: { width: number; height: number };
    minSize?: { width: number; height: number };
    resizable?: boolean;  // default true
    mount(node: HTMLElement, ctx: ModContext): void | (() => void);
}
```

The `mount` callback receives a stable DOM `node` and the `ModContext`. The
optional return is the mount's teardown. `message.below` additionally
receives a `MessageRef` (`{ id, role, sceneId }`) so the slot can act on that
specific message.

**Lease policy — Phase 9.1 §5.4.** The `ctx` handed to `mount(node, ctx)` is
the **activate-time lease** the mod's `activate` hook received. It is **not**
a fresh lease per mount invocation; the host hands the same context the mod
registered with. A mod that needs a fresh lease (for a fresh model budget —
see §"The model") calls `await ctx.refresh()` inside the mount body, which
returns a new `ModContext`. The activate-time lease is the right default —
building one per mount per open would be expensive and the mod already has
`refresh()` for the case it needs.

**Subscriptions inside `mount()` — Phase 9.1 §5.5, a real leak if missed.**
A subscription created inside `mount()` MUST be returned as the cleanup
function, or it lives until the mod is **disabled** — not until the mount is
unmounted. The host removes every subscription the mod registered on
`disable`, but a mount that opens and closes repeatedly without returning
its unsubscribe accumulates one listener per open for the mod's lifetime.
Return them:

```js
mount: (node, modCtx) => {
    paint(node, modCtx);
    const unsub = modCtx.subscribe('messages', () => paint(node, modCtx));
    return () => { unsub(); node.replaceChildren(); };  // ← return the unsub
}
```

The template mod's mount bodies carry this rule as a comment, so a copy-paste
does not lose it.

### Windows

`ctx.mounts.window(decl)` returns a `WindowHandle` with `open()`, `close()`,
`focus()` on top of `update()` / `remove()`. A window is **declared once**
and **opened many times** — what opens it is typically a `header.actions`
button's `onSelect` calling `handle.open()`:

```js
const win = ctx.mounts.window({
    id: 'editor',
    title: 'Compendium',
    defaultSize: { width: 720, height: 480 },
    minSize: { width: 360, height: 240 },
    mount: (node, modCtx) => { /* fill the interior */ },
});
ctx.mounts.header({ id: 'open', icon: 'Swords', label: 'Enemies',
                    onSelect: () => win.open() });
```

Geometry and open/closed state persist across sessions, keyed
`mod.<modId>.<windowId>`. The host closes the window and removes the
declaration on `disable`.

### Ordering

Within a region, entries sort by the mod's resolved load index, then by the
mod's own registration order within itself. Resolved load order is a
topological sort over `dependencies`, choosing among ready mods by
`loadOrder` ascending, then `id` ascending. A mid-session enable inserts at
its proper place — what the user sees after toggling a mod is what they see
after a restart. The UI for editing `loadOrder` is the load-order screen in
Settings → Extensions.

### Built-ins and the trailing group

Built-in entries render first in their fixed order. A region may declare a
**trailing group** the host pins to the end: `settings` + `exit` in
`header.actions`, `archive` in `composer.actions`. Mod entries insert between
the leading built-ins and the trailing group. This is a host-side per-region
fact; a mod cannot ask to be in it.

In `header.actions` the trailing group is also pinned *outside* the row's
scroll container, so "leave the campaign" stays reachable at any window width.
Launcher entries do not stay in that row: the host places them in the campaign
drawer's `Mods` group. An entry remains visible in the header only when its
`state()` returns a `badge`, `tone`, or state-driven `label`; those are status
readouts users need at a glance.

### How many entries actually render

`header.actions` is an open region, so the host gives each entry an obvious
home rather than trusting mods to be sparing. **Launchers collapse into the
drawer's `Mods` group; status entries stay visible in the header.** There is no
flat count cap that can hide a changing status readout.

Two consequences worth designing around:

- **A launcher is the shape to use for a panel or window.** It is listed by
  label under `Mods`, where several panels from one mod remain discoverable
  without filling the header.
- **A status is the shape to keep visible.** Return `badge`, `tone`, or a
  state-driven `label` when the value itself is useful while playing; returning
  only `active` does not make a launcher a header status.

`chat.rail` is bounded the same way: up to three panels render as a tab strip,
beyond that the strip becomes a picker showing the active panel's full title.

### Dispatch: the host drains a pending commit first

Before dispatching a mod entry's `onSelect` in `composer.actions`,
`message.actions`, or a `chat.rail` interaction, the host awaits any pending
turn commit. A mod cannot commit a turn itself (`CONTRACT.md` L3); the host
does it for the mod so the mod does not read mid-commit state.
`header.actions` is excluded — Settings / Exit handle their own flushing.

### Icons — Phase 9.1 §5.7

`icon` is a **lucide name**, resolved by the host against the `lucide-react`
version pinned in the app's `package.json` (currently `^0.564.0`). The name
is the **PascalCase export name** from `lucide-react` — `'Swords'`, not
`'swords'`; `'Syringe'`, not `'syringe'`. An unknown name is a fault plus a
neutral fallback glyph (`HelpCircle`), never a blank button — so a trial
load is safe and will tell you in **Settings → Extensions** which icon names
did not resolve.

There is no static list in this document because the set is the full
`lucide-react` export map — anything you can import from `lucide-react` is
valid. The canonical reference is the lucide icon gallery at
`https://lucide.dev/icons` — pick the name from the PascalCase above the
icon you want. A small **known-good** set used by the host and the template
mod, safe to copy:

```
Swords  Syringe  Tags  Bookmark  AppWindow  MapPin  Users  Settings
Archive  Pin  Cpu  BookOpen  Workflow  Trash2  Save  Package
ChevronDown  ChevronRight  Plus  X  Loader2  AlertTriangle  CheckCircle
```

### What a mod cannot do with mounts

- **Define a region.** Region ids are host-owned and never begin with `mod.`.
  A mod cannot host another mod's content (`CONTRACT.md` L5).
- **Specify an arbitrary colour on a chrome entry.** `tone` from a closed set
  is mapped to host tokens.
- **Replace or hide a built-in entry.** `CONTRACT.md` L2: a mod may not touch
  existing buttons. Suppression of *prompt* contributions exists because
  prompt text is a budget; chrome is not.
- **Draw a fake dialog over the app.** The only surface that floats above
  the page is `window.layer`, which always wears host chrome.
- **Set its own z-index.** Host owns z-order, or "two windows, one on top"
  stops being decidable.
- **`message.above`.** One placement in v1 (`message.below`); a second is a
  new region id, additive later.
- **A `mounts` manifest key.** Declined — a JSON declaration cannot carry a
  function. Register from `activate` through `ctx.mounts`.

---

## The `ModContext` — what every hook and mount receives

```ts
interface ModContext {
    readonly mod: ModIdentity;    // { id, name, version } — no folder (path → bypass)
    readonly api: ModApi;         // version, apiVersion, commitPoint, suppressibleIds
    readonly data: ModData;       // frozen, cloned reads (see below)
    readonly config: ModConfig;   // { aiTier: 'lite'|'pro'|'max'|undefined }
    readonly write: ModWrites;    // synchronous, void (see below)
    readonly model: ModModel;     // brokered by role; no credentials cross
    readonly table: ModTables;    // the mod's own declared tables
    readonly events: ModEventsApi;
    readonly mounts: ModMountsApi;     // native-tier only
    readonly macros: ModMacrosApi;     // native-tier only
    readonly facts: ModFactsApi;       // native-tier only
    readonly budgets: ModBudgetsApi;   // native-tier only
    readonly tokens: ModTokensApi;     // native-tier only
    readonly oocSections: ModOocSectionsApi;  // native-tier only
    readonly roles: ModRolesApi;       // native-tier only
    readonly signal: AbortSignal;
    subscribe<K extends keyof ModData>(key: K, listener: (value: ModData[K]) => void): () => void;
    refresh(): Promise<ModContext>;
    log(...args: unknown[]): void;
}
```

The host constructs one per mod per **lease**. A compute run is one lease.
A lifecycle hook invocation is one lease. `refresh()` returns a new lease
with a fresh model budget. A mount is handed the activate-time lease (see
§"Mount points").

### `ctx.data` — reads

Frozen, cloned per handout. A mod must never be able to mutate host state by
writing to a read. Live values arrive through `subscribe`, never by
unfreezing this.

| Field | Type | What it is |
|---|---|---|
| `campaignId` | `string \| null` | The active campaign, or `null` at load before one is open. |
| `playerInput` | `string` | The player's input for the current turn. |
| `messages` | `readonly ChatMessage[]` | The chat history. |
| `archiveIndex` | `readonly ArchiveIndexEntry[]` | Long-term memory index. |
| `chapters` | `readonly ModChapter[]` | Projected `ArchiveChapter`. `sealedAt: number \| null` — `null` is the open chapter. Read-only; sealing is the host's. |
| `timeline` | `readonly TimelineEvent[]` | The campaign timeline. Append through `write.addTimelineEvent`. |
| `npcLedger` | `readonly ModNpcEntry[]` | Every NPC the host knows about. See §"NPC entries" below. |
| `onStageNpcIds` | `readonly string[]` | The subset currently on stage. |
| `loreChunks` | `readonly LoreChunk[]` | Retrieved lore chunks. |
| `divergenceRegister` | `DivergenceRegister` | The divergence register. Whole-replacement writable. |
| `playerCharacter` | `PlayerCharacter \| null` | The PC. |
| `characterSheet` | `CharacterProfile` | The character sheet. Whole-replacement writable. |
| `inventory` | `readonly InventoryItem[]` | The inventory. Whole-replacement writable. |
| `location` | `ModLocation` | `{ currentPlaceId, currentFeature, ledger }`. The ledger is whole-replacement writable. |

### NPC entries — Phase 9.1 §5.1

`ctx.data.npcLedger` is `readonly ModNpcEntry[]`. `ModNpcEntry` is a
**projection** of the host's ~30-field `NPCEntry`, carrying the fields a mod
may read and patch. The full field list is in the shipped
`docs/narrative-mod-api.d.ts`; the short version:

- **Readable + writable through `updateNPC`:** `name`, `aliases`,
  `appearance`, `faction`, `storyRelevance`, `disposition`, `status`,
  `goals`, `voice`, `personality`, `exampleOutput`, `affinity`, `portrait`,
  `condition`, `traits`, `region`, `haunt`, `pcRelation`.
- **Readable, host-managed (read-only in a patch):** `id`, `isPC`, `tier`,
  `archived`, `archivedAtTurn`, `archivedReason`, `populated`,
  `agencyLocked`.

```js
// Read: filter on-stage NPCs by faction
const onStageGuild = ctx.data.npcLedger
    .filter(n => ctx.data.onStageNpcIds.includes(n.id))
    .filter(n => n.faction === 'Thieves Guild');

// Patch: nudge an NPC's affinity
ctx.write.updateNPC(npcId, { affinity: -1 });
```

The internal agency-engine fields (`previousSnapshot`, `shiftNote`,
`shiftTurnCount`, `drives`, `behavioralTriggers`, `hardBoundaries`,
`softBoundaries`, `pressure`, `wants`, `personalityHex`, `signatureKit`,
`skillRung`, `rungCeiling`, `goalRecords`, `agencyActivity`,
`repressionPressure`, `relationMeter`, `primaryGroup`, `secondaryGroup`,
`fieldTags`, `lastUpdateScene`, `transmigrated`, `pcMeta`) are **not** on
the projection — reaching for them is reaching into internals the surface
deliberately did not publish.

The previous `.d.ts` declared `NPCEntry { id, name }` only; that two-field
shell was actively misleading, and a mod author who wrote
`updateNPC(id, { faction: '…' })` against it hit a type error for a
legitimate call. `ModNpcEntry` is the fix. `NPCEntry` remains as a legacy
alias so existing JSDoc `@param {NPCEntry}` references keep compiling.

### `ctx.write` — writes (synchronous, void)

| Write | Shape | Notes |
|---|---|---|
| `updateContext(patch)` | `Partial<GameContext>` | **PROVISIONAL.** Only `arcDigest` is supported. Replaced by Phase 5.4. |
| `updateNPC(id, patch)` | `ModNpcPatch` | See §"NPC entries" above. |
| `archiveNPC(id, turn, reason)` | — | Pairs with `restoreNPC`. |
| `restoreNPC(id)` | — | |
| `addNpcSuggestions(names, context?)` | — | Append-only; needs no read. |
| `addMessage(msg)` | `ChatMessage` | |
| `addTimelineEvent(event)` | `TimelineEvent` | Append-only, deduped by `id`. |
| `updatePlayerCharacter(patch)` | `Partial<PlayerCharacter>` | |
| `setCharacterSheet(profile)` | `CharacterProfile` | **Whole-replacement** — pair with `data.characterSheet`. |
| `setInventory(items)` | `InventoryItem[]` | **Whole-replacement** — pair with `data.inventory`. |
| `setLocationLedger(locations)` | `LocationEntry[]` | **Whole-replacement** — pair with `data.location.ledger`. |
| `addLocationSuggestions(suggestions)` | `LocationSuggestion[]` | Append-only. |
| `setDivergenceRegister(register)` | `DivergenceRegister` | **Whole-replacement** — pair with `data.divergenceRegister`. |
| `requestBackup(trigger)` | `string` | Phase 8.2 — fires the host's pre-op backup endpoint. |

Writes are synchronous and void: the store callbacks are synchronous. A
promise here would promise a durability we do not deliver. The sandbox
binding journals writes and applies them on clean return; native commits
immediately.

### The model — `ctx.model`

```ts
interface ModModel {
    call(role, req): Promise<{ content: string }>;
    callJson(role, req, options?): Promise<unknown>;
    available(role): boolean;
}
```

Brokers by role (`'story' | 'utility' | 'auxiliary' | 'summariser' |
'raw-auxiliary' | 'raw-summariser'`). No endpoint, no provider config, no
credential ever crosses the surface. Caps: **3 calls per lease, 2048 output
tokens per call**. `refresh()` returns a new lease with a fresh budget. For
a sandboxed mod this cap is enforced at the host boundary and is real; for a
native mod it is a guardrail against a runaway loop, not a security control
(`TRUST.md` §C).

### Subscriptions — `ctx.subscribe` and `ctx.table.subscribe`

```js
const unsub = ctx.subscribe('messages', (messages) => { /* live */ });
const unsubT = ctx.table.subscribe('entries', (rows) => { /* live */ });
```

The key space for `ctx.subscribe` is exactly `ModData`'s — a mod can
subscribe to anything it can read, and to nothing it cannot. The listener
receives a new frozen value, never a live reference. Wakeups coalesce within
a tick. A throwing listener is contained as a fault naming the mod and leaves
the turn intact. The handle is revoked by the host on `disable` and on
campaign switch — a frozen value from the wrong campaign is a lie. `ctx.table.subscribe`
is the same contract for the mod's own tables, including a change a compute
hook made mid-turn.

**ONE subscription for the whole mod, not one per row.** A `message.below`
slot that opened one subscription per visible message would open 500 on a
long chat. Subscribe once in `activate` (or once inside `mount()` and return
the unsubscribe) and let `paint` be cheap.

### Control

| Entry | What it is |
|---|---|
| `ctx.signal` | An `AbortSignal`. A mod that ignores it gets terminated at the deadline; one that honours it exits cleanly. |
| `await ctx.refresh()` | Returns a fresh `ModContext` with a fresh model budget. |
| `ctx.log(...args)` | Prefixed with the mod id by the host, so a noisy mod is identifiable in the console. |

### The cold-start guard

`activate` fires at app load, which can be **before any campaign is open**.
In that lease `ctx.data.campaignId` is `null` and every campaign-scoped read
is empty; `ctx.table.read` / `ctx.table.write` reject with
`[facade] no active campaign`. The lifecycle host may pass `undefined` for
the context entirely. Guard against it:

```js
export function onActivate(ctx) {
    if (!ctx) return;  // load cycle before a campaign — nothing to do
    // …register mounts, subscribe, read tables…
}
```

The `campaign.opened` event is **sticky** (§"The event bus") — a late
subscriber gets the last payload with `replayed: true`, which closes the
cold-start race. Subscribe in `activate` and you will see
`campaign.opened` whether hydration won the race or lost it.

---

## The event bus — `ctx.events`

Native-tier only. A sandboxed compute mod cannot hold a listener across
turns (the worker is gone) and an emit would have to be journalled; a
compute mod that wants to publish writes to its own table and the native
half subscribes with `ctx.table.subscribe`.

Twenty core events across six families (`app`, `campaign`, `turn`,
`message`, `archive`, `settings`), plus mod events under `mod.<id>.<name>`.
The full payload table is in `docs/narrative-mod-api.d.ts` (`ModEvents`); the
short version of what you will actually subscribe to:

| Event | Fires | Payload highlights |
|---|---|---|
| `app.ready` | Once per page load after the first mod refresh. Sticky. | `modIds`, `faultCount` |
| `campaign.opened` | After a campaign is hydrated. Sticky. | `campaignId` |
| `campaign.closing` | Immediately before `activeCampaignId` changes. | `campaignId`, `nextCampaignId` |
| `turn.start` | After the facade + TurnContext, before the first stage. | `turnId`, `campaignId`, `playerInput`, `tier` |
| `turn.generated` | After the GM reply is complete and persisted. | `turnId`, `messageId`, `text`, `sceneStakes` |
| `turn.committed` | The post-turn pipeline finished; the turn is ordinary history. | `turnId` (null on crash recovery), `messageId`, `sceneId` |
| `archive.sceneAppended` | A scene is in long-term memory. | `campaignId`, `sceneId`, `messageId` |
| `archive.chapterSealed` | A chapter closed. **No ordering guarantee vs the turn sequence** (background queue). | `campaignId`, `chapterId`, `trigger` |
| `message.deleted` | One or more messages removed. | `campaignId`, `messageIds` |
| `settings.tierChanged` | The user's Lite/Pro/Max setting changed. | `tier`, `previous` |

### The rules

- **Observational.** A listener's return value is ignored. No
  `preventDefault`, no veto, no mutation, no reordering. Interception is a
  different seam (§"The pre-prompt interceptor") and deserves the opposite
  treatment.
- **Synchronous and cheap.** The emit does not `await` a listener. A
  listener that wants to do slow work schedules it and returns.
- **One argument: the frozen payload.** No context is passed. A listener
  that needs current host state uses the `ctx` it closed over —
  `await ctx.refresh()` or a subscription set up in `activate`.
- **Registration order = resolved load order** for every mod that subscribes
  in `activate` (which is what you should do). A listener that subscribes
  late (from a UI callback) appends.
- **Sticky events** (`app.ready`, `campaign.opened`) replay the last payload
  to a late subscriber with `replayed: true`. Everything else is
  fire-and-forget.
- **Custom events: yes, namespaced.** `ctx.events.emit('threadOpened',
  payload)` → the host emits `mod.<id>.threadOpened`. Cross-mod subscription
  is allowed (by fully-qualified name); cross-mod table reads are not. The
  asymmetry is the design: the emitting mod chose to publish; a silent read
  of another mod's table is a dependency the manifest cannot express.
- **No wildcards.** No `turn.*`, no `*`. An author who wants three events
  subscribes three times.
- **Faults:** a throwing listener is caught, recorded as a fault naming the
  mod and the event, and the emit continues. No strikes, no latching —
  surfacing it in Extensions is the whole remedy.
- **Teardown:** the host removes every subscription on `disable` and on
  `reset`; the mod is never trusted to call `off`. Campaign switch does
  **not** revoke event subscriptions (an event carries its own
  `campaignId`; a mod filters on it).

---

## The pre-prompt interceptor — suppressing *conditionally*

`suppresses` in a manifest is either always on or always off. When you need
"drop the GM reminder **on turns where the Director spoke**", you need code,
and code means the native tier.

Name one exported function in your manifest:

```json
"native": {
  "js": "index.js",
  "generateInterceptor": "interceptPrompt"
}
```

The host calls it **once per turn**, after it knows every input the prompt
consumes and before assembly begins:

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

Returning nothing is normal — a mod with nothing to say this turn says
nothing.

**Five rules.**

1. **Add and suppress, nothing else.** There is no field for rewriting a
   block, replacing the player's message, or reordering assembly.
2. **The protected four stay protected.** `user.message`, `volatile.block`,
   `askgm.brief` and `absolute.command` can never be suppressed. Naming one
   does *not* reject the mod the way the declarative `suppresses` does — it
   drops that one entry, shows you why in **Settings → Extensions**, and
   honours the rest of your interception.
3. **You get one argument, and it is not `ctx`.** Building a fresh mod
   context every turn would copy the whole message list on the hot path.
   Subscribe in `activate` and read the closure:

   ```js
   let messageCount = 0;
   export function onActivate(ctx) {
       ctx.subscribe('messages', (m) => { messageCount = m.length; });
   }
   ```

4. **There is a hard deadline (1.5 seconds).** It is not the place for a
   model call. Compute off the turn path — a compute hook, or a
   `turn.committed` listener — write the result to your own table, and read
   the table here.
5. **Be deterministic.** Two identical turns with the same mods must produce
   the same prompt. The host guarantees run order; the rest is yours.

Your text is budgeted exactly like a declarative contribution — declare a
`budget` or take the default. If your interceptor throws, hangs, or returns
something malformed, the fault shows up in **Settings → Extensions** and the
turn goes ahead with the un-intercepted prompt. It cannot break a turn.

**Phase 8.3 — swipes and continuations reuse the turn's blocks.** A mod's
interceptor fires **once per turn**, and its output is reused verbatim by
any swipe or continuation of that turn. There is no second interceptor fire
point: the turn's interception is cached alongside the turn in the
pending-commit snapshot, and the swipe / scene-continue paths read the
cached payload. A mod that calls a model is not charged twice for one turn,
and what the player saw is what the continuation sees.

---

## Macros — `ctx.macros`

A mod registers a name and a resolver; the host expands `{{name}}` — the bare
name — during prompt assembly.

```js
export function onActivate(ctx) {
    ctx.macros.register('markedContent', () => {
        // Pure and synchronous: runs on the hot path of every turn.
        // Reading ctx.data.* is fine; awaiting or mutating is not.
        // Returning '' is the defined "inactive this turn" path.
        return buildMacroText();
    });
}
```

The host qualifies the name to `mod.<yourId>.<name>`, so two mods cannot
collide and a mod cannot shadow a built-in slot (`{{location}}`,
`{{npcs}}`). Native-tier only. Shadowing a built-in is rejected with a fault;
never throws — a shadow / duplicate / revoked registration records a fault
and returns a no-op `unregister`. The host removes every registration on
`disable`.

A manifest contribution's `text` references the macro by its **bare** name:

```json
"contributions": [
  { "id": "marked", "order": 650, "budget": 600, "text": "{{markedContent}}" }
]
```

> **Changed in generation 1.** Earlier drafts of these docs told you to write
> the host-qualified form `{{mod.<yourId>.<name>}}`. That never worked: it
> matched no macro and shipped the literal braces to the model, silently. The
> qualified spelling is now **rejected at load** with the bare form in the
> message. You only ever write your macro's own name — you cannot reference
> another mod's macro, so there is nothing to disambiguate.

---

## Publishing facts — `ctx.facts`

A `when` condition reads four facts the host computes: `npcPresent`,
`location`, `inCombat`, `sceneTag`. When a subsystem leaves core (Phase 8,
enemies), the mod that owns it can keep publishing the fact so every other
mod's `when` keeps working — that is what `ctx.facts` is for.

```js
export function onActivate(ctx) {
    ctx.facts.register(
        'inCombat',
        () => currentEncounterIsActive(),
        { claims: 'inCombat' },
    );
}
```

The publisher runs **once per turn**, after the interceptor and before
conditions are evaluated. It must be **synchronous** and **pure** — reading
`ctx.data` is fine; awaiting or mutating is not.

### Claiming a core fact

`inCombat` is the only core fact open for claims today. You claim it by
passing `{ claims: 'inCombat' }` — and the `name` you register **must
match** the claim. The claim is what prevents the footgun: a mod cannot set
`inCombat` by accident, only deliberately.

### Conflicts

Two mods claiming the same core fact is a conflict. The one **earlier in
`loadOrder`** wins; the loser is surfaced in **Settings → Extensions** with
both mods named.

### Throwing

A throwing publisher yields no fact (no match) plus a surfaced fault. The
turn never breaks.

### What is NOT claimable

`location`, `sceneTags`, and `onStageNpcNames` are core facts but are **not
open for claims** today. Registering a publisher for one of these names
(even with `claims:`) is rejected with a fault.

### Namespaced mod facts

A mod may register a fact without a claim — e.g.
`ctx.facts.register('mood', () => 'tense')`. The host namespaces it to
`mod.<modId>.mood`. It is not read by `when` conditions today; the
namespacing exists so a future expansion of `when` can read mod-owned facts
without a second registration surface.

### Zero mods

With no mod registered, facts behave exactly as today — the host computes
them. `ctx.facts` is native-tier only.

---

## Budgets — `ctx.budgets`

Phase 7.4. A budget is claimed by id, not hardcoded. Built-in claims
(`stable`, `world`, `volatile`, `npc`, `enemy`) register at module load;
mods claim through `ctx.budgets.claim`:

```js
ctx.budgets.claim(
    'myFeature',
    (allocCtx) => {
        // Pure: reads only the context and closed-over constants.
        // Runs once per buildPayload; the result is exposed through the
        // budget map (budgetMap.get('mod.<modId>.myFeature')).
        return Math.floor(allocCtx.remainingAfterRules * 0.10);
    },
    { name: 'My Feature', description: 'A mod budget.' },
);
```

The host qualifies the id to `mod.<modId>.<id>` so a mod cannot collide with
a built-in or another mod. The allocator receives `{ limit,
remainingAfterRules, hasDeepContext }` — exactly the three values
`computeBudgets` used. Native-tier only. Never throws; a shadow / duplicate
/ revoked registration records a fault and returns a no-op `unregister`.
The host removes every claim on `disable`; `budgetMap.get` returns `0` for a
disabled mod's claim.

---

## Ask-GM sections — `ctx.oocSections`

Phase 8.3. A mod registers a section that contributes lines to the Ask-GM
brief, after the ledgers and before the verified facts:

```js
ctx.oocSections.register({
    id: 'mySection',
    order: 500,
    build: (c) => ({
        lines: [`Question mentions: ${c.namedIn(c.recentText, 'Aldric') ? 'Aldric' : '—'}`],
        sources: [],
    }),
});
```

`c` is `{ question, recentText, excerpt(value, max?), namedIn(haystack, name, aliases?) }`.
The `build` function runs on every Ask-GM call; a throwing section is
skipped and the rest of the brief still renders. Native-tier only.

---

## Service roles — `ctx.roles`

Phase 7.1.1. This is the one rung where a mod **replaces** a core
implementation instead of adding beside it. A role is a named ask core makes
and consumes an answer to.

**Generation 1 ships exactly one role: `memory.recall`** — which archived
scenes are recalled into this turn's prompt. The id list is frozen; a claim for
an id the host does not publish is rejected with a fault, so there is no point
guessing at one.

```json
"roles": ["memory.recall"]
```

```js
export function onActivate(ctx) {
    if (!ctx) return;
    ctx.roles.provide('memory.recall', async (input, signal) => {
        // Return the shape the role validates, or the host discards it and the
        // ask resolves to nothing.
        return { sceneIds: input.archiveIndex.slice(-3).map((s) => s.sceneId) };
    });
}
```

Declaring is not claiming: the manifest declares, `activate` provides. A
declared role that is never provided is faulted, and so is a claim for an
undeclared id.

**The rules you cannot change, and should design around:**

- **Resolution is per ask.** Disable your mod and the role goes back to core on
  the very next ask — no reload.
- **Two claimants are decided by resolved load order**, lowest wins; the loser
  is never asked. The user can flip it from the load-order screen.
- **If your provider throws, there is NO answer — not core's.** There is no
  per-ask fallback, because falling back would make a broken claimant look
  exactly like a working one. Three throws latch you off for the session, with
  a fault naming you.
- **Teardown is the host's.** `provide` returns an unregister function for
  symmetry; `disable` revokes your claim whether you call it or not.

---

## Trust and warnings

Three tiers, one trust consequence:

- A **declarative** or **sandboxed compute** mod is safe to enable without
  further warning. No page access; the Worker boundary is real.
- A manifest with **any native entry** is a **native-tier mod for trust and
  warning purposes**. Its sandboxed pieces do not make the suite safe to
  enable. Phase 6.1's Mod Management screen shows this confirmation before
  first enablement:

  > This mod contains native code that will run inside Narrative Engine
  > with the same access as the app. It can read and change your campaigns,
  > settings, and data available to the app, including API keys currently
  > available in the browser. Only enable it if you trust its author and
  > source. Sandboxed-compute and declarative mods do not receive this
  > access. Do you want to enable **{modName}**?

  The dialog's affirmative action is **Enable native mod**; its safe action
  is **Cancel**. This wording is a required security disclosure, not a
  generic terms-of-service notice, and is pasted without editing.

Under `TRUST.md` §C, native code can read API keys reachable from the page.
This is a known and accepted consequence of the user-trust model — native
mods are fully trusted software, with the same practical risk category as a
third-party npm package. The app discloses it; it does not claim native mods
are sandboxed.

---

## Compatibility and the frozen surface

**This surface is frozen at mod API generation 1.** Read this section before
you start; everything after it assumes you have.

### The promise

1. **Inside a generation, this surface is additive only.** Nothing in
   `docs/narrative-mod-api.d.ts`, and nothing this document describes as part
   of the API, will be removed, renamed, or have its signature changed. New
   things may appear. Your mod keeps working across every release that does not
   change the generation number.
2. **A breaking change bumps the generation, and the bump is the
   announcement.** There is no deprecation period, no compatibility shim, and
   no parallel old-and-new surface. When the number goes up, mods update.
3. **Everything not on the frozen list is not promised at all** — see
   §"What is NOT frozen". If you can reach it, you can still reach it
   tomorrow; nobody says it will still mean the same thing.

**Mods follow the app, not the other way round.** That is a deliberate choice
and you should plan around it: it is why the app can keep moving, and it is
why the frozen part is genuinely frozen rather than frozen-with-exceptions. If
your mod matters to you, watch the generation number.

### `apiVersion` — the generation you wrote against

Optional, one integer. Absent means **1**.

```json
"apiVersion": 1
```

| Your `apiVersion` vs the app's | What happens |
|---|---|
| **Higher** | **Refused at load**, with a message naming both numbers: *"requires mod API version 2, but this app provides 1"*. You wrote against a surface this app does not have. |
| **Equal** | Loads normally. |
| **Lower** | **Loads**, and Mod Management says so: *"Written for mod API 1; this app provides 2. It still loads — if it misbehaves, the author needs to update it."* No shim runs. The app does not know whether you are broken, and does not pretend to. |

Read the app's generation at runtime from `ctx.api.apiVersion`.

### `appVersion` — the minimum app version you need

A different question, so a different field. `apiVersion` is *"what shape was I
written against"*; `appVersion` is *"I need the build that added
`ctx.oocSections`"*. Optional. Two forms only:

```json
"appVersion": ">=1.0.0"     // or ">=1.0", or ">=1"
"appVersion": "*"           // any version (same as leaving it out)
```

Anything else — `^1.0.0`, `~1.0.0`, `<2.0.0`, a bare `1.0.0` — is
**rejected**. If the app is older than your floor, the mod is rejected with a
message naming both versions, before any mod code runs. `ctx.api.version` is
the app version this is compared against.

**There are no upper bounds on either field**, and there will not be. An
author-declared ceiling is a guess about a future release, made by someone who
may not be around to revise it, that refuses to load a mod which would have
worked. The generation number is the ceiling, and the host owns it.

### What IS frozen

Exactly this, and it is enumerated in code as well as prose —
`src/services/mods/__tests__/frozenSurface.test.ts` fails if any of it moves,
including if something is *added* without being written down here:

| Frozen | Meaning |
|---|---|
| **The `ModContext` object** | Its 19 entries, and the method set of every sub-API on it (`table`, `events`, `mounts`, `macros`, `facts`, `budgets`, `tokens`, `oocSections`, `roles`, `model`, `write`, `data`, `config`, `api`, `mod`). |
| **`ctx.data`'s fields** | The 14 host reads. |
| **`ctx.write`'s methods** | The 13 host writes, and their patch semantics. |
| **The 20 core event names and their payload shapes** | Plus the `mod.<id>.<name>` grammar for your own events. |
| **The six mount region ids and their per-mod budgets** | `header.actions`, `composer.actions`, `message.actions`, `chat.rail`, `message.below`, `window.layer`. Renaming one breaks every mod that mounted there. |
| **The manifest field set** | Every field in §"The manifest", the seven lifecycle hook names, and the two table `recordShape` values. |
| **The suppressible built-in contribution ids** | Read them from `ctx.api.suppressibleIds` rather than hardcoding. |
| **The service role ids** | Generation 1 ships one: `memory.recall`. |
| **Everything in `docs/narrative-mod-api.d.ts`** | The `.d.ts` is the surface. If it is not in there, it is not frozen. |

### What is NOT frozen

Said loudly, because *anything reachable will be reached* and the one rule only
holds if the consequence of breaking it is written down in advance:

- **Everything under `src/`.** Module paths, file names, component structure,
  the Zustand store's shape, every internal function. A mod **never imports
  from `src/`** — and if you do it anyway, nothing stops you at runtime and
  nothing will warn you when it breaks. It will break, in a patch release,
  silently, and that is not a bug we will fix.
- **The server's routes, the on-disk file layout, and the database.** Your data
  goes through `ctx.table`. A mod that reads a campaign file directly is a mod
  that stops working the first time a suffix changes — and it is the reason
  disable, backup, export and migration could not be guaranteed for anyone.
- **The prompt's actual text.** Block wording, ordering constants, and budget
  numbers change as the engine is tuned. Your `order` is a position *relative*
  to other blocks, not a promise about what sits at 300.
- **Anything reachable from native code that is not on the frozen list.**
  Native mods run with the app's own access (§"Trust and warnings"). Being able
  to call something is not the same as being allowed to depend on it.
- **The internal names behind a published one.** `ModNpcEntry` is a projection
  of a host type with more fields; the projection is frozen, the host type is
  not.

### What this means when we get it wrong

If a frozen thing turns out to be a mistake — a bad signature, a field that
should never have been published — it stays until the generation bumps. That
is the cost of the promise and we took it knowingly. It is why this surface is
smaller than what the app can do, and why several obvious conveniences are on
the §"What a mod cannot do" list instead of here.

---

## Recipes — phrased the way a user actually asks

### "Put a button in the header that opens a window"

```js
export function onActivate(ctx) {
    if (!ctx?.mounts) return;
    const win = ctx.mounts.window({
        id: 'myWindow',
        title: 'My Window',
        defaultSize: { width: 480, height: 360 },
        mount: (node, modCtx) => {
            node.textContent = 'Hello from the mod';
            // No subscription needed for static content; return nothing.
        },
    });
    ctx.mounts.header({
        id: 'open',
        icon: 'AppWindow',
        label: 'OPEN',
        onSelect: () => win.open(),
    });
}
```

Manifest: `"native": { "js": "index.js", "hooks": { "activate": "onActivate" } }`.

### "Show something in a panel next to the chat"

```js
export function onActivate(ctx) {
    if (!ctx?.mounts) return;
    ctx.mounts.rail({
        id: 'myPanel',
        title: 'My Panel',
        icon: 'Bookmark',
        mount: (node, modCtx) => {
            const paint = () => {
                const npcs = modCtx.data.onStageNpcIds;
                node.textContent = `On stage: ${npcs.join(', ') || '—'}`;
            };
            paint();
            // ONE subscription for the whole panel — return the unsubscribe,
            // or it leaks until disable (Phase 9.1 §5.5).
            const unsub = modCtx.subscribe('onStageNpcIds', paint);
            return () => { unsub(); node.replaceChildren(); };
        },
    });
}
```

### "Add text to what the AI sees, only during combat"

Declarative, if the host already knows combat is active:

```json
{
  "id": "combat-tone",
  "order": 250,
  "budget": 80,
  "when": { "inCombat": true },
  "text": "Combat is live. Injuries persist."
}
```

If "combat is active" is something only your mod knows (because you own the
encounter state), publish the `inCombat` fact from native code (§"Publishing
facts") and the declarative `when` above will match it.

For text that depends on the turn (e.g. "drop the GM reminder on turns
where the Director spoke"), use the pre-prompt interceptor
(§"The pre-prompt interceptor").

### "Store my own data and show it in a table"

Declare a table in the manifest:

```json
"tables": [
  { "name": "entries", "recordShape": "array", "label": "Entries" }
]
```

Read-modify-write from `activate` or a mount:

```js
const rows = Array.isArray(await ctx.table.read('entries')) ? await ctx.table.read('entries') : [];
rows.push({ id: 'row-1', text: 'hi', at: Date.now() });
await ctx.table.write('entries', rows);
```

A native mod does this with **no capability string** (Phase 9.1 §5.2). A
sandboxed compute mod declares `table:read:entries` and
`table:write:entries` in `compute.capabilities`. To show the data, use a
`chat.rail` panel (above) or a `panels[]` declaration bound to the table
(L1 declarative editor).

### "Run something after every turn"

Three options, strongest first:

1. **Sandboxed compute** — declare a `compute` block with `hook: "postTurn"`.
   Runs in a Worker after each turn, bounded by the sandbox deadline. The
   supported path for a distrusted author's post-turn logic.
2. **`turn.committed` listener** (native) — subscribe to the event and do
   work when the turn becomes ordinary history:
   ```js
   ctx.events.on('turn.committed', (p) => {
       // p.turnId, p.campaignId, p.messageId, p.sceneId
       // Do slow work here; the emit does not await you.
   });
   ```
3. **`turn.generated` listener** (native) — fires earlier, before the
   commit; the GM's reply is complete and persisted but the post-turn
   pipeline has not run. Use this if you need to act on the reply text
   before scene extraction.

---

## What a mod cannot do

The honest list. Every row is a decision, not a gap.

- **No editing existing prompt blocks.** You can add or suppress, never
  rewrite — and the player's own message, the world state, the confirmed
  ask-GM handoff and the player's absolute command cannot even be
  suppressed.
- **No direct store handle.** Exposing Zustand *is* exposing internals. All
  reads go through `ctx.data`; all writes go through `ctx.write`.
- **No arbitrary host function invocation.** "Calling an internal function
  is never a supported surface, even if native code can technically do it"
  (`CONTRACT.md`).
- **No save-pipeline control** — debounce timers, `flushAllPendingSaves`,
  hydration, `rebuildStateFromLiveStore`. A mod writes; the host decides
  when bytes hit disk. Persistence transport is core's, or
  disable/backup/migration cannot be guaranteed.
- **No credentials, provider config, or endpoints.** `ctx.model` brokers by
  role and no `EndpointConfig` ever crosses. Native code can reach keys
  anyway — that is disclosed (§"Trust and warnings"), not granted.
- **No `ctx.mod.folder`.** A path is a `fetch` away from bypassing the table
  API.
- **No cross-mod table access.** Use the event bus or facts registry for
  soft mod-to-mod relationships.
- **No `data.context` (the raw `GameContext` blob).** ~70 fields of
  deprecated carriers and wizard drafts. The five fields a measured
  consumer actually reaches for are promoted to named entries on `ctx.data`.
- **No enemy / ability compendium fields.** Phase 8 moved enemies into a
  bundled mod that owns its data in its own tables; the ability compendium
  is the same shape. Freezing a host field the epic exists to remove is the
  trap `CONTRACT.md` describes.
- **No chapter writes.** Sealing, elevation and summary depth are core's
  (`CONTRACT.md` L3). A mod reads `data.chapters`; it never seals one.
- **No `write.batch()`.** A sandboxed hook gets atomicity free (the journal
  applies on clean return); an interactive native cascade is N separate
  writes. Additive v1.1.
- **No upper version bounds.** Decided, not deferred: the generation number
  is the ceiling and the host owns it. See §"Compatibility and the frozen
  surface".

If you find yourself reaching for one of these, the surface deliberately did
not publish it — and the consequence of reaching into `src/` instead is
written down in §"THE ONE RULE" at the top of this document.

---

## Troubleshooting

**My mod does not show up.** Open **Settings → Extensions**. If the file was
rejected it appears under **Rejected files** with the exact reason. If it is
not there at all, check the folder contains `manifest.json` and is in
`mods/`.

**Common rejections:**

| Reason | Fix |
|---|---|
| `id` contains a dot | Use letters, numbers, `_`, `-` only |
| unknown key in `when` | Check spelling against the table above |
| `contributions` must be a non-empty array | Add at least one contribution, or declare a `native`/`compute`/`tables`/… block instead |
| `text` required | Every contribution needs non-empty `text` |
| suppressing a protected id | You cannot suppress those four |
| unsupported `appVersion` | Only `">=X.Y.Z"` and `"*"` |
| duplicate id | Two folders declare the same mod `id`; both are named in the fault |
| `loading_order` present | This app spells it `loadOrder` |
| `display_name` present | This app spells it `name` |
| `minimum_client_version` present | This app spells it `appVersion` |
| unknown icon name | Fault in **Settings → Extensions**; button renders with a fallback glyph. Name is the PascalCase lucide export (`'Swords'`, not `'swords'`) |
| `{{mod.<id>.<name>}}` in a contribution | Reference your own macro by its bare name: `{{<name>}}`. See §"Macros" |
| requires mod API version N | Your `apiVersion` is higher than this app's. See §"Compatibility and the frozen surface" |
| `apiVersion` must be a positive integer | It is a number, not a range string — `1`, not `">=1"` |

**My mod loads but nothing changes.** Check its checkbox is on. If it has a
`when`, remember the conditions must *all* match — and `sceneTag` never
matches yet. If it is a native mod, check **Settings → Extensions** for
faults — a throwing `activate` is contained as a fault, not a crash.

**My macro's text never appears — I see `{{something}}` in the prompt
instead.** The slot matched no registered macro. Check **Settings →
Extensions**: an unresolved slot is now a fault naming it. The two usual causes
are writing the host-qualified form (`{{mod.myId.thing}}` — use the bare
`{{thing}}`) and registering the macro from a hook that did not run.

**My text gets cut off.** Raise `budget`, or write less. Remember the
512-token default when `budget` is omitted. For token-accurate trimming of
your own contribution, use `ctx.tokens.count` (native only).

**My `updateNPC` patch silently does nothing.** You probably tried to patch
a read-only field (`id`, `isPC`, `tier`, `archived*`, `populated`,
`agencyLocked`). The host drops those silently. Archiving is through
`archiveNPC` / `restoreNPC`, not a patch. See §"NPC entries" for the
writable-field list.

**My mount's subscription leaks across opens.** You did not return the
unsubscribe from `mount()`. See §"Mount points" — Phase 9.1 §5.5.

**My header button's `state()` does not update.** The host's header only
re-renders on a narrow set of store changes. Subscribe to the key your
`state()` reads and call `handle.update()` in the listener. See §"Mount
points" — Phase 9.1 §5.6.

---

## Reference documents

This file is the author-facing reference. The design records behind it live
under `Upgrade/EPIC Project - Full Modularity/` and are the binding input
when this document and the implementation disagree:

- `API.md` — the `getContext()` v1 surface, every entry with its
  `HARVEST.md` row, the deliberately-absent list.
- `EVENTS.md` — the twenty core events, the grammar, the payload rule, the
  commit-path exclusion.
- `MOUNTS.md` — the six regions, ordering, conflict, budget, isolation,
  teardown.
- `MANIFEST.md` — the folder-per-mod format, every field, every rejection
  reason, the migration map.
- `TRUST.md` — the tier and trust model, the verbatim native-mod warning.
- `COMPAT.md` — the freeze: what is frozen and why, the two version fields,
  the breakage policy, and the amendment log every future generation is
  recorded in.

The shipped type declarations live at `docs/narrative-mod-api.d.ts` and are
the highest-density reference: types are the only kind of documentation that
fails loudly. If this document and the `.d.ts` disagree, the `.d.ts` is
right and this document is the bug.
