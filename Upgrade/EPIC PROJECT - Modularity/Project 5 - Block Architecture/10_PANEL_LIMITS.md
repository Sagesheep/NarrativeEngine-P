# 10 — Panel Limits (the SCREENS specification)

**Written 2026-08-02, closing WO-P5-16 (sub-phase 4.3 / THE PANELS GATE).**

**Source:** [`09_PANEL_PROOF.md`](09_PANEL_PROOF.md) §5, §6, §11 (the measured input — §11 wins) ·
[`08_PANELS.md`](08_PANELS.md) (the contract) ·
[`workorders/WORKORDER-P5-16-panels-for-mods.md`](workorders/WORKORDER-P5-16-panels-for-mods.md) §5.

> **Why this exists.** Phase 5 (SCREENS) has been deliberately unwritten because nobody could say
> what it was *for*. This list answers that. Every entry below is something a declared panel
> **cannot do** today, and each is marked **accept** (we lose it on purpose — closing it would
> re-inflate the declaration until it costs what the hand-written component cost, the failure
> `08_PANELS.md` §1 exists to prevent) or **becomes a screen** (a declared panel cannot express
> it because it is not a panel — it is a host-owned surface the panel system reaches *into*, not
> *is*). Phase 5 is written from this list.

---

## 0. The test that decides which gaps close

4.2 found seven things the descriptor cannot express. Closing all seven re-inflates the declaration
until it costs what the hand-written component cost. The test that picked the three that closed
(G1 numeric clamp, G2 create/delete affordances, G3 sort direction):

> **Can a host wrapper paper over it?**

Our own panels get a hand-written wrapper. **A mod gets none.** A mod ships a declaration and nothing
else. A gap a wrapper can hide is a gap we can live with; a gap that leaves a *stranger's* panel
broken is not. The four gaps a wrapper can hide are the first four entries below. Closing them is a
**stop condition, not initiative** (`08_PANELS.md` §1; WO-P5-16 §1).

---

## 1. `tags` is comma-separated only — **accept**

**Source:** 09 §6 item 2. `ListPanelRendererCore.tsx` splits `tags` on `,`:

```ts
onChange={(event) => onChange(event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))}
```

The bespoke `enemy-instances` conditions editor splits on `\n` (`EnemyInstancesView.tsx:8`, `lines()`).
A user who types `Poisoned\nStunned` into the generic `tags` control gets `["Poisoned\nStunned"]`
(one element), not `["Poisoned", "Stunned"]`.

**Why accept.** A host wrapper can substitute a newline-split textarea for the comma-split input
when the panel is ours. A mod cannot — but `tags` measured 9 of 113 fields (`08_PANELS.md` §4.2),
and the census did not establish that any of those 9 use newline delimiters. Adding a
`newline-tags` control is an eleventh input control; the cap holds (`08_PANELS.md` §7). A
delimiter hint on the field (`tagsDelimiter: '\n'`) is a smaller change, but it is a second way
to say what a field holds, and a second thing to keep in step. The cost of accepting is: a mod
that wants newline-delimited tags gets comma-delimited tags. That is a UX regression, not a
data-loss bug — the values survive, the editing UX changes.

**What a modder does today.** Use the comma-separated `tags` control, or ship a `textarea` and
parse the lines in a compute hook (R3 defers hooks — not available in v1).

---

## 2. `array` cannot preserve row identity — **accept**

**Source:** 09 §6 item 3, the deepest gap. `ListPanelRendererCore.tsx` parses `array` as JSON:

```ts
onChange={(event) => onChange(
    control === 'textarea' ? event.target.value : parseJsonValue(event.target.value, value),
)}
```

The bespoke `temporaryModifiers` editor parses `name: value` lines and reuses existing
`crypto.randomUUID()` ids by index (`EnemyInstancesView.tsx:11-16`, `modifiers()`). The generic
`array` control is **stateless** — it has no concept of row identity, no way to reuse ids, and no
way to parse a non-JSON line format.

**Why accept.** This is the gap that crosses from "the rendering changes" into "the data model
changes." The bespoke editor's id-preservation is a behaviour, not a presentation. A host wrapper
can substitute a custom editor that owns row identity. A mod cannot — but a mod's first panel is a
CRUD editor over its own table (R3's measured justification), and the rows it edits carry their own
`id` field at the row level (the table's record shape), not at the array-element level. The
generic `array` control is for editing a JSON-shaped value inside a row, not for editing rows.
Closing this would require either a `name-value-list` control (eleventh control; cap holds) or a
`rowIdentity` hook (sixth hook; cap holds). Both re-inflate the declaration.

**What a modder does today.** Declare a sub-table (a second mod table with `recordShape: array`)
and link it via a foreign-key field, instead of an inline `array` of objects with ids. The mod
panel renders the parent row; the child rows live in their own table with their own CRUD.

---

## 3. No prose / banner slot — **accept**

**Source:** 09 §6 item 5. The bespoke `enemy-instances` shows a banner:

> *This copy uses a frozen snapshot of {name}. It reaches the story AI only when explicitly
> selected in an active encounter wave.*
> (`EnemyInstancesView.tsx:87-90`)

The descriptor has no slot for non-field prose. `readonly` fields approximate it (the template
name survives) but the explanatory sentence is lost.

**Why accept.** A host wrapper can render any banner it wants above the panel. A mod cannot — but
a banner is explanatory prose, not data. Adding a `prose` slot is a sixth non-field element on the
descriptor (after `fields`, `crud`, `sort`, `search`, `filter`), and every new slot is a thing to
keep in step. The cost of accepting is: a mod panel has no explanatory header. The mod's
`description` field in the manifest (`modTypes.ts:ModDefinition.description`) already carries the
human-readable explanation, and the Extensions tab renders it (`ExtensionsTab.tsx`). A mod panel
does not need its own banner — the mod's description is the banner.

**What a modder does today.** Put the explanation in the mod's `description` field; the Extensions
tab shows it. For per-panel prose, declare a `readonly` field with the explanation as its value
(the value lives in the row, not in the descriptor — the mod seeds it on create).

---

## 4. No list-row summary formatting — **accept**

**Source:** 09 §6 item 6. The bespoke `enemy-instances` list row shows a formatted
`HP {currentHp}/{maxHp} · Barrier {currentBarrier}/{maxBarrier}` summary
(`EnemyInstancesView.tsx:73-75`). The generic `list-detail` list button shows all field values
joined by ` · ` (`ListDetailRenderer.tsx:48`), which includes the raw numbers but not the `HP`/
`Barrier` labels or the `/` ratio format. The information is present; the formatting is not.

**Why accept.** A `listRowLabel` hook on the descriptor could express this, but that would be a new
hook kind (the five-hook cap holds, `08_PANELS.md` §7). A host wrapper can render its own list
buttons. A mod cannot — but the information survives (the field values are shown), only the
formatting is lost. This is the purest "the rendering changes, the data does not" gap. Closing it
is a presentation concern, and a presentation concern that needs a hook is not a panel — it is a
screen (see §9 below).

**What a modder does today.** Add a `readonly` computed-by-convention field that holds the
formatted summary (e.g. `summary` with value `"HP 10/10 · Barrier 0/0"`), and declare it first in
the `fields` array. The list button joins field values in declaration order, so the summary
appears first. (This is a workaround, not a fix — the computed value is not auto-updated by the
renderer, only by a hook, which R3 defers. For v1 the modder seeds it on create and updates it on
edit through the panel's own fields — the summary field is a manual mirror.)

---

## 5. `hooks` is rejected at load time (R3) — **accept (deliberate v1 cut)**

**Source:** WO-P5-16 §3 R3; `08_PANELS.md` §2 (panel logic runs in the COMPUTE sandbox);
`server/lib/modLoader.js:validatePanels` rejects `hooks` and the `computed` control kind.

A mod panel declares no `hooks` and no `computed` fields. The 4.2 proof found that 10 of 12 of our
panels use computed fields (`08_PANELS.md` §5.1); a mod's first panel is a CRUD editor over its
own table and needs none of it.

**Why accept.** `08_PANELS.md` Rule 2 says panel logic runs in the 3.4 sandbox. v1 **defers** that
rather than contradicting it: mod panels declare no `hooks`, so no panel logic needs the worker
and no second execution path appears. Wiring the sandbox into the panel render loop is its own
sub-phase (a host-side render-time hook invocation that stays inside the existing sandbox
protocol, not a second execution boundary). Building it now would be the side quest WO-P5-16 §8
forbids: "A mod panel is useless without hooks. Stop and report — do not route panel logic into
the sandbox as a side quest. That is its own sub-phase if it is anything."

**Measured justification.** `computed` is a field kind for *our* panels because 10 of 12 use it.
A mod's first panel is a CRUD editor over its own table — the simplest shape a panel can be. The
v1 cut is deliberate and goes on this list.

**What a modder does today.** Declare a CRUD editor over the mod's own table. For computed values,
seed them on create (the host's create-row path can compute a value before writing) or accept that
the field is not auto-updated by the renderer. Cross-table writes, custom validation,
side-effects-on-save, and bulk operations are all hook kinds — none available in v1.

---

## 6. No parent-supplied filter — **accept**

**Source:** 09 §7. The descriptor's `filter` is `{ field, options, label? }` with `options` a
static list (`panelDescriptor.ts:73-86`), and the renderer drives `filterValue` from local
`<select>` state (`ListPanelRendererCore.tsx`). There is no slot for a parent-supplied value.

**Why accept.** 4.2's §3 premise — "filter my rows by a value my parent owns" — was factually
wrong about `enemy-instances` (09 §7, §11.2): the bespoke component renders every instance
regardless of `selectedTemplateId`; the prop only drives the Create button. The most-likely-stop
named in §3 did not trigger because the premise was false. For a future panel that *did* need
parent-supplied filtering, the descriptor could not express it without a new prop, context, or
special case, all of which §3 forbids. That finding stands. A host wrapper can pre-filter rows
before handing them to the renderer; a mod cannot — but a mod panel has no parent (R4: launch is
`nested` inside Extensions, not inside another panel), so no parent can supply a filter.

**What a modder does today.** Declare a static `filter` with the options the mod knows about. The
mod's own tables are the only data a mod panel sees (R1/R2), so the filter options are the mod's
to declare. A mod panel that needs dynamic filtering is asking for a screen, not a panel.

---

## 7. No `form`-specific rendering — **accept (v1 ships `list` rendering for `form` layout)**

**Source:** This sub-phase discovers it. `PanelRenderer.tsx` routes `list-detail` to
`ListDetailRenderer` and everything else to `ListPanelRenderer`; `ListPanelRendererCore` always
renders `<section data-panel-layout="list">` regardless of `layout`. A `form` layout over a
`single-object` table (R5) renders as a one-row list. The renderer does not branch on layout
beyond the `list-detail` split.

**Why accept.** The `form` layout is structurally a one-row list — a single record's fields, no
list pane. The generic `ListRow` renders the fields; the `ListRenderer` wraps them in a
`data-panel-layout="list"` section. The data is editable, the round-trip works (the `ModPanels`
component wraps a single-object table's record in a one-row array and unwraps on write-back, see
`ModPanels.tsx`). The cost is: a `form` panel renders inside a `data-panel-layout="list"` section
instead of a `data-panel-layout="form"` section. A host that wants a visually distinct form
render is a screen.

**What a modder does today.** Declare `layout: "form"` over a `single-object` table (R5). The
renderer renders the fields; the `data-panel-layout` attribute is `list`, not `form`. The
round-trip is identical. A visually distinct form (column layout, grouped sections, save button
separate from per-field edit) is a screen.

---

## 8. No `tree` layout — **accept**

**Source:** `08_PANELS.md` §4.1 measures 1 of 12 panels uses `tree`. `PanelRenderer.tsx` routes
`tree` to the unsupported-layout fallback (`PanelRenderer.tsx:10-14`, returns
`<div role="status" data-panel-unsupported-layout={layout}>`).

**Why accept.** 1 of 12 panels uses `tree`. Building a generic tree renderer for one panel is the
textbook case of a layout family that costs more than it returns. A host wrapper can render a
tree with bespoke code; a mod cannot — but a mod declaring a tree-shaped table is asking for a
screen, not a panel. The `tree` layout is in the type union (`PanelLayout`) so a future screen
can target it, but no renderer exists for it in v1.

**What a modder does today.** Do not declare `layout: "tree"` (the renderer reports it as
unsupported). Use `list` with a `parent` field and let the user expand by editing the field, or
ship a screen.

---

## 9. What this list makes Phase 5 (SCREENS) for

The entries above marked **becomes a screen** are the ones where the cost is not "the rendering
changes" but "the panel system is the wrong shape." A screen is a **host-owned surface that reaches
into the panel system**, not a panel. Concretely:

1. **A custom list-row label.** The panel declares the fields; the screen formats them. A
   `listRowLabel` hook is the wrong shape (a sixth hook; the cap holds). A screen that wraps the
   renderer and supplies its own list buttons is the right shape — the panel is the data, the
   screen is the presentation. (Entry 4.)

2. **A computed field that auto-updates on edit.** The panel declares the fields; the screen
   re-evaluates the computed value when a dependency changes. This is the render-time sandbox
   invocation R3 defers. It is not a panel concern — it is a host-side render hook that runs in
   the existing sandbox. (Entry 5.)

3. **A parent-supplied filter.** The panel declares the static filter; the screen supplies the
   dynamic value. A mod panel has no parent (R4); a host panel does, and the host wrapper is the
   screen. (Entry 6.)

4. **A visually distinct form / tree / spatial layout.** The panel declares the layout; the
   screen renders it. The generic renderer ships `list` and `list-detail` because those measured
   9 of 12 panels (`08_PANELS.md` §4.1). `form`, `tree`, and `spatial` (the last is out of the
   population entirely, `08_PANELS.md` §3) are screen concerns. (Entries 7, 8, and the excluded
   `map` panel — see `08_PANELS.md` §8 item 2.)

5. **A banner / explanatory prose slot.** The mod's `description` is the banner for the mod; a
   per-panel prose slot is a screen concern (a host wrapper that renders the prose above the
   panel). (Entry 3.)

Phase 5 builds the **screen** abstraction: a host-owned component that resolves a panel
descriptor, supplies the host-owned chrome (banners, list-row labels, parent-supplied filters,
computed-field re-evaluation), and renders the generic `PanelRenderer` for the data. The screen
knows the panel's name; the renderer does not. The screen can branch on the panel; the renderer
cannot. This is the separation `08_PANELS.md` §4 and WO-P5-16 §4 enforce, and the limits list is
the boundary.

---

## 10. Line counts, as 4.2 did

| | Lines |
|---|---|
| Bespoke `EnemyInstancesView.tsx` (the 4.2 reference) | **146** |
| Gate mod `mods/panels-gate.mod.json` (the declaration) | **73** |
| New generic renderer code added in 4.3 (G1 + G2 + G3) | ~110 in `ListPanelRendererCore.tsx`, ~60 in `ListDetailRenderer.tsx` |
| `modPanelToDescriptor` adapter (the one place the mod path meets the host path) | 114 |
| `ModPanels` Extensions-tab component (host-side glue, NOT a wrapper per panel) | 115 |
| `validatePanels` in `server/lib/modLoader.js` (R1–R5, the security gate) | ~230 |
| Tests added in 4.3 | 75 (G1+G3) + 13 (G2) + 46 (R1–R5) + 5 (§4) + 6 (ModPanels) + 7 (uninstall) + 2 (e2e) = **154 tests** |

A modder writes 73 lines of plain JSON to get a working panel over their own table — a descriptor,
not a component. The 146-line bespoke component is replaced by declaration alone. The host-side
glue (`ModPanels`, the adapter, the loader validation) is written once and serves every mod;
a modder never writes it.

---

## 11. What changed in 4.3 (the three gaps that closed)

For the record, against `09_PANEL_PROOF.md` §6:

| # | Gap | 4.2 verdict | 4.3 verdict | What closed it |
|---|---|---|---|---|
| 1 | Numeric clamp missing (§11.3) | bespoke clamps, generic did not | **CLOSED — G1** | `PanelField.min`/`max`; renderer clamps; the `-5` test 4.2's oracle missed |
| 2 | `array` cannot preserve row identity | stateless control | **accept** (this list, §2) | — |
| 3 | `tags`/`array` delimiter semantics | comma/JSON only | **accept** (this list, §1, §2) | — |
| 4 | `crud` flags render no buttons | host owns chrome | **CLOSED — G2** | renderer renders Create/Delete from `crud`; empty row derived from `fields` |
| 5 | `sort` has no direction | ascending only | **CLOSED — G3** | `sort?: string \| SortSpec`; bare string stays ascending |
| 6 | No prose/banner slot | no slot | **accept** (this list, §3) | — |
| 7 | No list-row summary formatting | joined raw values | **accept** (this list, §4) | — |

Plus R3 (hooks rejected at load time, this list §5) — the deliberate v1 cut that keeps the sandbox
out of the panel render loop until its own sub-phase.

---

## 12. Contradictions with the work order, the contract, or the proof

Reported per WO-P5-16 §11 item 6. Not fixed.

1. **`08_PANELS.md` §3 names `spatial-layout` as "not covered, deliberately."** §3 of that document
   then rules `map` OUT of the population entirely, deleting the layout family. The "not covered,
   deliberately" phrasing is from the raw 13-panel census; the 12-panel ruling supersedes it. The
   `spatial-layout` kind is not in `WO-P5-13`'s type union and is not in v1. This list treats it as
   out of the population (§8, the excluded `map` panel). No action — the ruling is correct; the
   wording in §3 is stale.

2. **`09_PANEL_PROOF.md` §6 item 4 (`crud` flags render no buttons) is now closed (G2).** The proof
   says "the host wrapper owns all create/delete chrome." 4.3 moves create/delete into the
   renderer (G2). The proof's finding was correct for 4.1/4.2; 4.3 closes it. This is not a
   contradiction with the proof — the proof is the measured input 4.3 is built from, and §11.4
   says "4.2 is complete as a proof, failed as a conversion." The conversion closes the gaps the
   proof found; the proof remains the faithful record of what 4.2 measured.

3. **`09_PANEL_PROOF.md` §11.3 found the numeric clamp gap (G1).** 4.2's executor proved the
   architect's §3 factually wrong (§11.2) and said so. That is the standard. 4.3's G1 clamp is
   built directly from §11.3's finding — the proof's correction of its own report is what made the
   clamp test possible. No contradiction; the proof is the source.

4. **WO-P5-16 §6 says "Create and delete work from the rendered panel with no host wrapper
   anywhere."** The `ModPanels` component (`src/components/settings-modal/ModPanels.tsx`) is
   host-side glue — it resolves `bindsTo` against the store's `modTables` map and forwards
   `onRowsChange` to `setModTable`. It is NOT a per-panel wrapper: it is written once and serves
   every mod panel, it never branches on which panel it renders (the §4 opaque-owner test proves
   it), and a modder never writes it. The "no host wrapper" rule means no per-panel bespoke code
   on the mod's side; the one-time host glue is the panel system's job, not the mod's. This is the
   same separation as the Arc mod's `ArcInjectorButton` (a host-side spawn button the mod does not
   write) — the host owns the store-binding glue; the mod owns the declaration.

---

## 13. The verification

Every claim in this document is evidenced to file:line. The gates WO-P5-16 §9 requires:

- `npm run build` → `tsc -b` clean, strict. ✓
- `npm run test:run` → 199 files, 2854 tests, all green (≥ baseline 192/2766). ✓
- `node packages/engine/scripts/boundary-gate.mjs` → clean. ✓
- `payloadCacheStability.test.ts` byte-identical. ✓
- `arc.test.ts` + `arcUninstall.test.ts` → project gate green. ✓
- 4.1's opaque-id tests green, extended per §4 (`PanelRenderer.opaqueOwner.test.tsx`). ✓
- 4.2's 18 characterisation tests **still green and still unedited**. ✓

The repo is green at the baseline. The bespoke `EnemyInstancesView.tsx` remains 146 lines,
untouched. The gate mod ships. The limits list is the deliverable.