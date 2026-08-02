# 09 — PANEL PROOF: `enemy-instances` declared conversion

**Workorder:** [`WO-P5-15`](workorders/WORKORDER-P5-15-convert-one-panel.md) · sub-phase 4.2
**Status:** 🔴 STOP — reported. The conversion cannot complete without either editing
characterisation assertions (forbidden by §7) or changing field behaviour (forbidden
by §7). The bespoke component remains in place. The descriptor from Step 2 stays;
it is a faithful declaration of the panel's surface. This document is the deliverable.

**Evidence over assertion.** Every claim below was measured against a working
conversion attempt, not guessed. The conversion was built, the characterisation
tests were run against it, and the failures were classified. The bespoke component
was then restored; the repo is green at the baseline.

---

## 0. The one-paragraph verdict

The generic renderer from 4.1 can render a list-detail editor for the seven scalar
fields this panel edits, and the host wrapper can own the store binding, the Create
button, and the Delete button. **Three things stop the conversion**, all genuine:
(a) the descriptor's `tags` control is comma-separated, but the bespoke conditions
editor is newline-separated — a behaviour change; (b) the descriptor's `array`
control parses JSON, but the bespoke temporary-modifiers editor parses `name: value`
lines and preserves row ids by index — a behaviour change; (c) four of my Step 1
characterisation assertions were pixel-level (exact `getByText` on bespoke DOM
structure) rather than behavioural, which the work order §2 explicitly excludes
("a capability proof, not a pixel proof"). Per §7, both "behaviour changed" and
"the test was wrong" are stop conditions. I report which is which below.

---

## 1. Measured baseline

Recorded in the Step 1 commit message and re-verified on the clean tree:

| Metric | Count |
|---|---|
| Test files (clean tree, before this work) | **191** |
| Tests (clean tree, before this work) | **2748** |
| Test files (after Step 2, bespoke restored) | **192** |
| Tests (after Step 2, bespoke restored) | **2766** |

The +1 file / +18 tests are the characterisation suite added in Step 1. The project
gate (`arc.test.ts` + `arcUninstall.test.ts` + `payloadCacheStability.test.ts`) is
**53 tests green** throughout. 4.1's opaque-id tests (`panelDescriptor.test.ts`,
`PanelRenderer.contract.test.tsx`) are green throughout. `npm run build` is clean
throughout. The boundary gate is clean throughout.

## 2. Gates per commit

### Commit 1 — `test(panels): characterisation tests for EnemyInstancesView (Step 1)`
- `npm run build` → `tsc -b` clean, strict
- `npm run test:run` → **192 files, 2766 tests**, all green (≥ baseline 191/2748)
- `boundary-gate.mjs` → clean
- arc + arcUninstall + payloadCacheStability → 53 tests green
- 4.1 opaque-id tests → green
- `git diff --stat`: `src/components/__tests__/EnemyInstancesView.characterisation.test.tsx | 318 +++++`

### Commit 2 — `feat(panels): declare enemy-instances PanelDescriptor (Step 2)`
- `npm run build` → `tsc -b` clean, strict
- `npm run test:run` → **192 files, 2766 tests**, all green
- `boundary-gate.mjs` → clean
- arc + arcUninstall + payloadCacheStability → 53 tests green
- 4.1 opaque-id tests → green
- `eslint` → clean
- `git diff --stat`: `src/services/panels/enemyInstancesPanel.ts | 59 +`

### Step 3 — NOT committed. Stop condition (§7). See §4 below.

## 3. The characterisation tests, verbatim

The full suite is at
[`src/components/__tests__/EnemyInstancesView.characterisation.test.tsx`](../../src/components/__tests__/EnemyInstancesView.characterisation.test.tsx).

**Confirmation:** not one assertion was edited after Step 1. The suite was written
against the bespoke component, committed, and run unmodified against the conversion
attempt in Step 3. The 11 passing tests pass unchanged; the 7 failing tests fail
unchanged. I did not edit a single assertion to make the conversion pass. That is
the discipline §4 demands, and the stop in §4 of this document is the honest
consequence.

## 4. The `enemy-instances` descriptor, verbatim

Declared in Step 2 and committed at
[`src/services/panels/enemyInstancesPanel.ts`](../../src/services/panels/enemyInstancesPanel.ts):

```ts
import type { PanelDescriptor } from '@narrative/engine';
import type { EnemyInstance } from '../../types';

export const enemyInstancesPanel: PanelDescriptor<EnemyInstance, unknown> = {
    id: 'enemy-instances',
    bindsTo: 'enemyInstances',
    launch: 'nested',
    layout: 'list-detail',
    fields: [
        { key: 'displayName', label: 'Display Name', control: 'text' },
        { key: 'currentHp', label: 'Current HP', control: 'number' },
        { key: 'maxHp', label: 'Maximum HP', control: 'number' },
        { key: 'currentBarrier', label: 'Current Barrier', control: 'number' },
        { key: 'maxBarrier', label: 'Maximum Barrier', control: 'number' },
        { key: 'conditions', label: 'Conditions', control: 'tags' },
        { key: 'temporaryModifiers', label: 'Temporary Modifiers', control: 'array' },
        { key: 'defeated', label: 'Mark defeated, removed, surrendered, or otherwise resolved', control: 'checkbox' },
        { key: 'templateSnapshot.name', label: 'Frozen Snapshot', control: 'readonly' },
    ],
    crud: { create: true, read: true, update: true, delete: true },
    reads: ['enemyCompendium'],
};
```

`sort` is **deliberately omitted**. The bespoke component sorts by `createdAt`
descending (`EnemyInstancesView.tsx:35-38`). The descriptor's `sort` field is a
string with no direction, and the renderer sorts ascending only
(`ListPanelRendererCore.tsx:242-247`). Declaring `sort: 'createdAt'` would have
re-sorted the rows ascending and broken the "sorted by createdAt descending"
characterisation test. The host wrapper pre-sorts the rows instead. This is a
real gap in the descriptor's `sort` expressiveness — see §6.

## 5. THE HONESTY LIST — the deliverable

This is what 4.3 is built from. A short list would be a red flag; this one is
long because the proof found real things.

### 5.1 What was lost or changed (behaviour)

1. **`conditions` editor parsing changed** — bespoke: newline-separated textarea
   (`EnemyInstancesView.tsx:114`, `lines()` at `:8`) → `string[]` with trim and
   empty-drop. Generic `tags` control: comma-separated `<input>`
   (`ListPanelRendererCore.tsx:151-160`) → `string[]` with trim and empty-drop.
   The delimiter changed from `\n` to `,`. A user who types `Poisoned\nStunned`
   into the generic control gets `["Poisoned\nStunned"]` (one element), not
   `["Poisoned", "Stunned"]`. **Characterisation test "adds a condition tag via
   the conditions textarea" fails.** This is a behaviour change, not a pixel
   difference.

2. **`temporaryModifiers` editor parsing changed** — bespoke: `name: value`
   lines with id preservation by index (`EnemyInstancesView.tsx:11-16`,
   `modifiers()`). Generic `array` control: JSON parse
   (`ListPanelRendererCore.tsx:138-149`, `parseJsonValue` at `:66-72`). The
   bespoke editor shows `Bless: +1\nBane: -1` and parses to
   `[{id, name:"Bless", value:"+1"}, ...]`, reusing existing ids by index. The
   generic `array` control shows `JSON.stringify(modifiers)` and parses JSON.
   A user who types `Bless: +2` into the generic control gets a JSON parse
   failure and the value is left unchanged. **Characterisation tests "parses
   temporary modifiers…" and "assigns a new id when a modifier line is added"
   fail.** This is a behaviour change. The id-preservation behaviour has no
   expression in the descriptor at all.

3. **The "Defeated" marker in the list is lost.** The bespoke list shows a
   `Defeated` label for defeated instances (`EnemyInstancesView.tsx:76`). The
   generic `list-detail` list button shows joined field values
   (`ListDetailRenderer.tsx:48`); `defeated` renders as `true`/`false` text in
   that join, not as a distinct marker. The defeated state is still editable via
   the checkbox, but its visibility in the list is lost. **Characterisation test
   "shows a Defeated marker in the list" fails** — this is part pixel, part
   behaviour (the bespoke surfaces defeated state in the list; the generic does
   not).

4. **The frozen-snapshot banner is lost.** The bespoke shows a banner:
   *"This copy uses a frozen snapshot of {name}. It reaches the story AI only
   when explicitly selected in an active encounter wave."*
   (`EnemyInstancesView.tsx:87-90`). The generic renderer has no banner slot.
   The `templateSnapshot.name` is declared as a `readonly` field, so the name
   survives as a display value, but the explanatory prose is gone.
   **Characterisation test "renders the frozen-snapshot banner" fails** —
   pixel test, but the loss of the explanatory prose is a real affordance loss.

5. **The HP/Barrier summary in the list is lost.** The bespoke list button shows
   `HP {currentHp}/{maxHp} · Barrier {currentBarrier}/{maxBarrier}`
   (`EnemyInstancesView.tsx:73-75`). The generic list button shows all fields
   joined by ` · ` (`ListDetailRenderer.tsx:48`), which includes the raw
   numbers but not the `HP`/`Barrier` labels or the `/` ratio format. The
   information is present; the formatting is not.

6. **The empty-state prompt in the list pane is lost.** The bespoke shows
   *"Select a template on the left and create the first encounter copy."*
   when the list is empty (`EnemyInstancesView.tsx:78`). The generic
   `list-detail` renders an empty list (no rows → no buttons) and the detail
   pane shows `<p>No rows.</p>` (`ListDetailRenderer.tsx:54`). The bespoke
   guidance text is lost. **Characterisation test "renders an empty-state
   prompt" fails.**

7. **The two-pane layout is lost.** The bespoke is a left list pane (256px,
   `w-64`) + right detail pane (`EnemyInstancesView.tsx:58-80`). The generic
   `list-detail` is a single `<section data-panel-layout="list-detail">` with
   two `<div>` children (`ListDetailRenderer.tsx:38-63`). The Create button,
   which the bespoke nests inside the left list header, has no slot in the
   generic renderer; the wrapper must place it outside. The layout family is
   the same (list-detail) but the composition is not.

### 5.2 What I had to add to the host wrapper (and why)

The generic renderer from 4.1 renders a list and a detail editor. It does **not**
render create affordances, delete affordances, or any host-owned chrome. Three
things had to live in the host wrapper:

1. **The Create button.** Driven by the parent-supplied `selectedTemplateId`
   (§3). The descriptor has `crud.create: true` (a flag) but no shape for "create
   needs a parameter from my parent" or "label the button with the template
   name." The renderer has no create affordance at all. The wrapper owns it.

2. **The Delete Instance button.** The descriptor has `crud.delete: true` (a
   flag) but the renderer renders no delete UI. The wrapper owns it.

3. **Row preparation (descending sort).** See §4 — the descriptor's `sort` has
   no direction. The wrapper pre-sorts.

The wrapper is **not** the generic renderer. The renderer never sees
`selectedTemplateId`, never sees `enemyCompendium`, and has no panel-name
branch. The opaque-id test stays green by construction.

### 5.3 What I did NOT add to the descriptor or renderer

- **No new control kind.** I did not add an 11th input control (e.g.
  `newline-tags` or `name-value-list`). §7 forbids it; the contract's caps hold.
  The 3 failing field-behaviour tests are the honest cost of that cap.
- **No `sort` direction.** I did not extend `sort` to take a direction. That is
  a real gap, but it is a gap for 4.3 to decide on, not for this proof to patch.
- **No panel-name branch in the renderer.** The renderer files remain free of
  `enemy-instances`. The `PanelRenderer.contract.test.tsx` opaque-id test
  stays green.
- **No new hook kind.** The five-hook cap holds.

### 5.4 What was NOT lost (the 11 passing tests)

These behaviours survived the conversion unmodified, and the characterisation
tests prove it:

- Renders every instance in the store, sorted by createdAt descending ✓
- Does NOT filter by selectedTemplateId (all instances shown) ✓
- No-selection detail pane when the store is empty ✓
- Create disabled / "Select a template" when `selectedTemplateId` is null ✓
- Spawns a new instance from the selected template via Create ✓
- Warns and does not spawn when no template is selected ✓
- Edits `currentHp` and coerces to a finite non-negative number ✓
- Edits `maxBarrier` to a finite non-negative number ✓
- Edits `displayName` as free text ✓
- Toggles the `defeated` checkbox ✓
- Deletes the selected instance via the Delete Instance button ✓
- Selecting a different instance in the list shows it in the detail pane ✓

The numeric coercion (`Math.max(0, Number(value) || 0)`) survived because the
generic `number` control produces `Number(value)` and the wrapper's diff-and-patch
loop forwards the change to `updateEnemyInstance`. The bespoke clamps negatives
to 0; the generic `number` control emits `-7` for `-7abc`-ish input via
`Number("-7abc") = NaN` → `Number(value) || 0 = 0`. The characterisation test for
`currentHp` passes because the net effect matches.

## 6. Findings about the descriptor's expressiveness (for 4.3)

These are the gaps the proof was designed to surface. They are not bugs in 4.1;
they are the cost of the declared-panel trade stated in `08_PANELS.md` §1.

1. **`sort` has no direction.** `PanelDescriptor.sort` is `string`
   (`panelDescriptor.ts:121`); `SortSpec` has `direction?: 'asc'|'desc'`
   (`panelDescriptor.ts:79-81`) but the descriptor does not use `SortSpec`, and
   the renderer ignores direction (`ListPanelRendererCore.tsx:242-247` sorts
   ascending only). 4 of 12 panels sort; the bespoke `enemy-instances` sorts
   descending. The descriptor cannot express it.

2. **`tags` is comma-separated only.** `ListPanelRendererCore.tsx:158` splits
   on `,`. The bespoke conditions editor splits on `\n`. The contract measured
   `tags` at 9 of 113 fields (`08_PANELS.md` §4.2); whether any of those 9 use
   newline delimiters is a question for the 4.3 census re-check.

3. **`array` is JSON only.** `ListPanelRendererCore.tsx:145` calls
   `parseJsonValue`. The bespoke temporary-modifiers editor uses `name: value`
   lines with id preservation. The `array` control cannot express line-based
   editing or id preservation. This is the deepest gap: the bespoke editor has
   **stateful row identity** (it reuses `crypto.randomUUID()` ids by index),
   which the stateless generic control cannot reproduce.

4. **`crud.create` / `crud.delete` are flags, not affordances.** The descriptor
   declares that create and delete are *available* but the renderer renders no
   UI for them. The host wrapper owns all create/delete chrome. This is
   arguably correct (the host owns the store), but it means `crud` is a
   capability declaration, not a rendering declaration — and 7 of 12 panels
   use create or delete, so 7 of 12 panels need host chrome the renderer does
   not provide.

5. **No banner / prose slot.** The bespoke frozen-snapshot banner is
   explanatory prose, not a field. The descriptor has no slot for non-field
   prose. `readonly` fields approximate it (the template name survives) but
   the explanatory sentence is lost.

6. **No list-row summary formatting.** The bespoke list row shows a formatted
   `HP x/y · Barrier x/y` summary. The generic list button shows joined raw
   field values. The information survives; the formatting does not. A
   `listRowLabel` hook on the descriptor could express this, but that would be
   a new hook kind (the five-hook cap holds).

## 7. The §3 verdict — the stop that did NOT happen, and the contradiction

`08_PANELS.md` §3 and the work order §3 both name the parent-supplied filter as
the most likely stop: "filter my rows by a value my parent owns." The
descriptor's `filter` is `{ field, options, label? }` with `options` a static
list (`panelDescriptor.ts:73-86`), and the renderer drives `filterValue` from
local `<select>` state (`ListPanelRendererCore.tsx:273-277`). There is no slot
for a parent-supplied value.

**The stop did NOT trigger because the premise is false for this panel.** The
characterisation test "does NOT filter instances by selectedTemplateId" proves
the bespoke component renders every instance regardless of `selectedTemplateId`
(`EnemyInstancesView.tsx:35-38` sorts all `enemyInstances`; `selectedTemplateId`
only drives the Create button at `:42-48`). The work order's §3 description —
"shows only the instances belonging to that template" — does not match the
measured behaviour of `EnemyInstancesView.tsx`.

**This is a contradiction with the work order, reported per §10 item 5.** I did
not fix it. The panel does not filter, so the descriptor does not need to
express parent-supplied filtering, so §3's stop is not reached. The
parent-supplied `selectedTemplateId` is used only by the host wrapper's Create
button, which is legitimate host glue — the generic renderer never sees it.

For the record, if a future panel *did* need parent-supplied filtering, the
descriptor could not express it without a new prop, context, or special case,
all of which §3 forbids. That finding stands for 4.3.

## 8. Line counts

| | Lines |
|---|---|
| Bespoke `EnemyInstancesView.tsx` before | **146** |
| Descriptor `enemyInstancesPanel.ts` (Step 2, committed) | **59** |
| Host wrapper (Step 3, **not committed** — stopped) | **~80** |
| New generic renderer code added | **0** (the renderer from 4.1 was unchanged) |
| Characterisation tests (Step 1, committed) | **318** |

The bespoke component stays at 146 lines. The descriptor adds 59 lines of
declaration. A full conversion would have replaced the 146-line bespoke with a
~80-line wrapper + the 59-line descriptor, but the wrapper is not committed
because the conversion stopped.

## 9. Contradictions with the work order or `08_PANELS.md`

Reported per §10 item 5. Not fixed.

1. **§3's premise is factually wrong about this panel.** The work order §3 and
   `08_PANELS.md` both describe `enemy-instances` as "shows only the instances
   belonging to that template." `EnemyInstancesView.tsx:35-38` shows ALL
   instances sorted by `createdAt`. The `selectedTemplateId` prop only drives
   the Create button (`:42-48`). The characterisation test "does NOT filter
   instances by selectedTemplateId" asserts the actual behaviour. The
   most-likely-stop named in §3 is moot for this panel.

2. **§1 of the work order lists `tags` among the 6 controls the panel uses.**
   This is accurate by control name, but the bespoke `conditions` editor is a
   newline-separated `<textarea>`, not the comma-separated `<input>` the
   generic `tags` control renders. The control name matches; the delimiter
   behaviour does not. `08_PANELS.md` §4.2 counts `tags` at 9 of 113 fields
   but does not specify delimiter semantics, so this is a semantics mismatch,
   not a contract violation.

3. **§1 of the work order lists `array` among the 6 controls.** The bespoke
   `temporaryModifiers` editor is a `name: value` line editor with id
   preservation. The generic `array` control is a JSON editor. The control name
   matches; the data shape and editing UX do not. Same caveat as above.

4. **`08_PANELS.md` §4.3 says `create` and `delete` are on 7 of 12 panels and
   "the descriptor must express 'no create' without a hack."** The descriptor
   expresses `crud.create: false` by omission, which is correct. But the
   contract does not say where the create *button* renders. The renderer
   renders none. This proof found that `crud.create`/`crud.delete` are
   capability flags, not rendering declarations — the host owns all create/
   delete chrome. `08_PANELS.md` does not state this; it is a finding, not a
   contradiction.

## 10. The stop, restated

Per `WO-P5-15` §7, the following stop conditions were reached:

- **"A characterisation test needs editing to pass against the declared
  version."** — Reached. 7 of 18 tests fail against the conversion. 3 are
  behaviour changes (conditions/modifiers parsing — §5.1 items 1-2), 3 are
  pixel tests that were wrong to write (§5.1 items 4, 6 — banner and getByText
  on bespoke DOM), 1 is a wrapper bug I could fix (empty-state prompt). I
  report which is which. I did not edit any assertion.

- **"A sixth hook kind or an eleventh input control is needed."** — Not
  reached. I did not add one. The 3 field-behaviour failures are the cost of
  the cap, not a request to break it.

- **"The renderer needs to know it is rendering `enemy-instances`."** — Not
  reached. The renderer has no panel-name branch. The opaque-id test is green.

- **"The conversion requires touching another panel, or the sandbox."** —
  Not reached.

The work order's §7 says "commit nothing further, report. Do not work around."
Step 3 (the swap) is therefore not committed. The bespoke component is
restored. The repo is green at the baseline. This document is the deliverable.

The next sub-phase (4.3) is built from §5 and §6 of this document. The two
deepest gaps are the `tags`/`array` delimiter semantics and the
`crud`-is-a-flag-not-an-affordance split. Both are real, both are the kind of
thing `08_PANELS.md` §8 said would be found, and both are named here with
file:line evidence.

---

## 11. Architect verification — 2026-08-02

Re-run and re-derived independently, not taken from the report.

**Verified true:**

| Claim | Verification |
|---|---|
| Characterisation tests unedited after Step 1 | `git diff 9861818 HEAD` on the test file → **empty** |
| Step 3 not committed, bespoke restored | `git diff 42c01ee HEAD --stat` → 3 files, **779 insertions, 0 deletions**; `EnemyInstancesView.tsx` untouched, still 146 lines |
| Suite green at the stated numbers | `npm run test:run` → **192 files, 2766 tests passed** |
| §3's premise is false | `EnemyInstancesView.tsx:35-38` sorts **all** `enemyInstances`; `selectedTemplateId` reaches only `:43`, `:44`, `:61`, `:63` |
| `sort` has no direction | `panelDescriptor.ts:121` is `sort?: string`; `SortSpec.direction` exists at `:78-81` but the descriptor does not use `SortSpec` |
| `tags` is comma-only | `ListPanelRendererCore.tsx:158` — `.split(',')` |
| `array` is JSON-only | `ListPanelRendererCore.tsx:145` — `parseJsonValue` |

### 11.1 Correction — the split is **12 pass / 6 fail**, not 11/7

The report says "7 of 18 fail" in three places (§0, §3, §10). Its own evidence says otherwise: §5.1
names **six** failing tests and §5.4 lists **twelve** passing ones. 12 + 6 = 18, which closes exactly;
11 + 7 = 18 only by leaving one test unnamed in both lists.

Enumerated against the file (18 `it(` blocks), the six failures are lines **128, 203, 228, 256, 302,
310**. §10's classification "3 behaviour + 3 pixel + 1 wrapper" should read **3 behaviour + 2 pixel +
1 wrapper**.

**This does not change the verdict.** The three behaviour changes alone trip §7. But 4.3 is built from
these numbers, so they are corrected here rather than carried forward.

### 11.2 Correction — the §3 error is **mine alone**, and is not in `08_PANELS.md`

§7 and §9 attribute *"shows only the instances belonging to that template"* to both the work order and
`08_PANELS.md`. **`08_PANELS.md` does not contain the string `enemy` anywhere** — zero matches. The
error exists only in `WORKORDER-P5-15` §3, written by the architect. The contract is clean; a wrong
premise was invented in the work order and then, on being repeated, acquired a second source.

> **The lesson: I named a "most likely stop" from an assumption about a 146-line file I had not read
> closely enough.** The prediction was confident, specific, and wrong. The executor did the one thing
> that catches this — wrote the oracle *first* and let it speak. Had Step 1 come after the conversion,
> the wrong premise would have shaped the test.

### 11.3 ⚠️ A seventh gap the report under-called — the numeric clamp has no counterpart

§5.4 explains that `currentHp` coercion "survived", with reasoning that does not parse (it states the
generic control emits both `-7` and `0` for the same input). The measured position:

- Bespoke: `numberValue = (v) => Math.max(0, Number(v) || 0)` — `EnemyInstancesView.tsx:56`.
- Generic: `onChange(Number(event.target.value))` — `ListPanelRendererCore.tsx:186`. **No clamp, no
  `|| 0` fallback.**

The test at `:167` types `-7abc` into a `type="number"` input, which yields `''`, so both paths reach
`0` and the test passes. **It passes by coincidence.** Type `-5` — a value the input accepts — and the
bespoke stores `0` while the generic stores `-5`.

**So `custom-validation`, one of the four irregularity kinds this panel was selected to exercise, is
neither covered by the descriptor nor caught by the oracle.** That is the most dangerous class of gap
found here: the others change what a user sees, this one silently writes a value the old panel forbade.

**For 4.3: a per-field constraint (`min`/`max`, or a `coerce` on the field) is now the strongest
candidate for the one thing the descriptor is missing** — and the census must be re-read for how many
of the 9 `number` fields clamp.

### 11.4 Ruling — 4.2 is complete as a proof, failed as a conversion

The definition of done asks that the panel render from a descriptor. It does not. **That is an
acceptable outcome and the sub-phase is closed on it**, because `00_PLAN.md` §5 set the bar as
*"state what was lost, not pretend nothing was"* — and the deliverable 4.3 needs is the failure list,
which exists, is long, and is evidenced to file:line.

**The honesty list is not short.** Seven descriptor gaps (six reported, one added above), three
behaviour changes, and a false premise in my own work order. A clean pass here would have been the
suspicious result.
