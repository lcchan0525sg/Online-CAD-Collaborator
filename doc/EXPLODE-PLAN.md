# Explode — Selection-Driven Scope (Plan)

**Status:** Approved proposal — implement on next work session.
**Scope constraint:** Touch **only** the explode code. Do not change any other
feature (tree, selection, materials/transparency, measure, chat, sync plumbing).

## 0. Sequencing decision (updated)

**Order of work:**
1. **Explode refactor first** (this plan) — land it now; the explode block is
   already self-contained, so it moves cleanly either way, and it delivers the
   feature sooner.
2. **Modularize the code second** — split `main.js` into concern-based modules
   as a follow-up phase (see §11 below). The explode work lands on the current
   single-file layout, then the whole thing gets organized.

Rationale: explode is a bounded, well-understood change; doing it first gets you
the feature now, and its self-contained block will port to the modular layout
unchanged. The refactor is deferred so we never refactor a moving target.

---

## 1. Goal

Replace the current **Level dropdown** (All parts / Top sub-assembly) with a
**selection-driven scope**: you pick an assembly in the tree, and the explode
spreads that assembly's **immediate children**. Defaults to the top level.

## 2. Core model

- **Explosion units = the immediate children of a selected assembly.**
- A child that is a **sub-assembly** (has children) moves **rigid** — its
  descendants ride along with it (no separate offsets).
- A child that is a **leaf part** moves on its own.
- **Default scope = top level** (works with no selection).

## 3. Default "top level" rule

> **The highest assembly with more than one child** — descend past any
> single-child "pure wrapper" node.

Examples:
- **GearBox** (one wrapper `GearBox` → 45 parts): top level = the wrapper, so the
  default explodes the **45 real parts**.
- **Clean multi-part assembly** (root has many named children directly): top
  level = the root's children.

## 4. Interaction

1. **Nothing selected** → default top level.
2. **Select a sub-assembly** → scope jumps to that assembly's **immediate
   children**; targets recompute, slider/gap value **stays**.
3. **Select a leaf part** → scope stays on the last valid assembly (selection
   still highlights/moves normally).
4. Adjust the separation control.

Typical flow: explode first level → click a sub-level → explode that level →
repeat deeper.

## 5. Separation control — two user-selectable modes

| Mode | Control | Applies to | Notes |
|---|---|---|---|
| **Percentage** | Slider (0–100%) | Radial + X/Y/Z | Realtime, cheap |
| **mm gap** | **Numeric input** (e.g. `25`), applied on Enter/Apply | **X/Y/Z axis only** | Physical spacing between bboxes |

- If the user is in **Radial** and switches to **mm gap**, **auto-switch to X**
  (or grey it out with a hint).
- mm-gap is ill-defined for Radial → axis-only by design.

## 6. Implementation notes

- **Compute bounding boxes once at selection time and cache.** Only the
  immediate children (a handful of nodes) — a few milliseconds. Layout recomputes
  on a **discrete change**, never per-frame.
- Numeric input stands as decided (we *could* later upgrade to a live slider, but
  keep the entered-value UX for now).
- **Skip hidden parts** in the gap layout — no phantom gap around hidden geometry.
- **Graceful nothing-to-explode** — if the scope's assembly has ≤1 child (or the
  model is a single part), show **"nothing to explode"** instead of silently
  doing nothing.
- **Scope readout** in the panel: **"Exploding: <assembly> — N children"** so
  selection-driven changes are visible.
- Axis = **world axis** (matches current X/Y/Z behavior).

## 7. UI / controls

- **Remove** the Level dropdown (`#explode-level`, `explodeLevel`).
- **Keep** Dir selector: Radial / X / Y / Z.
- **Separation**: mode toggle — **Percentage** (slider) **or** **mm gap**
  (numeric input).
- **Scope readout**: "Exploding: <assembly> — N children".
- Keep **non-destructive collapse** (slider to 0 restores exactly; **Reset** also
  collapses it).
- Keep **session sync** — scope + amount/gap + mode match across viewers (scope
  follows automatically since selection already syncs).

## 8. Code locality (current state)

Explode lives as a **self-contained section** in `src/main.js` (~lines 2607–2750),
not a separate file. It is already modular in shape:

- **Own state**: `explodeAmount`, `explodeScale`, `explodeTargets`, `explodeDir`,
  `explodeLevel`, `applyingRemoteExplode`
- **Own functions**: `collectExplodeNodes()`, `computeExplodeDirs()`,
  `applyExplodeAmount()`, `recomputeExplode()`, `resetExplode()`,
  `applyRemoteExplode()`, `explodeSet()`, `broadcastExplode()`, `setExplodeUi()`
- **Own DOM + listeners**: slider / dir / level elements

**External touchpoints** (the only things outside the block that explode uses):
- `model` and the tree `isPartNode` rule (shared with `buildPartsTree`)
- `session` + WS message `{ t:'explode', amount, dir, level }` (server handler in
  `server.js`)
- Called from `loadFromGltf` (re-apply on model load) and
  `clearModel`/`resetPartPositions`

The refactor can therefore be **contained entirely within this section** plus a
small extension to the existing `explode` sync message shape. No other feature
needs to change.

## 9. Sync message shape (to extend)

Current client→server / server→client `explode` payload:
`{ amount, dir, level }`

Will become something like:
`{ amount, mode: 'pct'|'gap', gap, dir, scopeKey }`

- `scopeKey` = the selected assembly's path key (or null = top level).
- Server stores + replays the whole object; late joiners get current state.
- Selection already syncs separately, so scope mostly follows for free, but we
  send `scopeKey` explicitly to be robust.

## 10. Decisions locked

| # | Item | Decision |
|---|---|---|
| 1 | Select re-scopes immediately, value stays | ✅ |
| 2 | Leaf-part selection | leaves scope unchanged |
| 3 | Slider semantics | **both** — Percentage slider + mm-gap numeric input |
| 4 | Direction | Radial + X/Y/Z |
| 5 | mm-gap scope | **axis-only**, auto-switch to X from Radial |
| 6 | Scope readout | show "Exploding: <assembly> — N children" |
| 7 | Hidden parts | skipped in gap layout |
| 8 | ≤1 child | show "nothing to explode" |
| 9 | Bbox compute | once at selection + cache, discrete recompute |
| 10 | Code locality | contain within the explode section + extend `explode` sync message only |

---

## 11. Follow-up phase (AFTER explode lands): modularize the code

Not part of the explode work — scheduled next. Summary of the agreed direction:

**Why:** `main.js` is 2,974 lines / 145 top-level functions / 11 sections, and
multiple features share one global scope, which has caused cross-feature bugs
(e.g. transparency vs. selection). Size is manageable, but coupling is real and
the file keeps growing.

**Plan:** split `main.js` into concern-based ES modules (project is already
`"type": "module"`), keeping the shared mutable state in one explicit "app
context" module, and leave the WS sync protocol untouched.

Proposed split:
- `scene.js` — scene / camera / renderer / lighting / grid / resize / loop
- `parts.js` — tree build, visibility, selection, transparency, hover
- `measure.js` — measure tool (already self-contained)
- `explode.js` — explode (already self-contained; this plan's changes land here)
- `move.js` — part move + axis gizmo
- `session.js` — WS client, roster, sync, chat
- `context.js` — shared mutable globals (`model`, `selectedPartKey`, `session`,
  `partRows`, `renderer`, `camera`, `controls`, …)
- `main.js` — imports everything and wires up

**Deliberately not doing:** no sync-protocol rewrite, no class/DI framework,
no big-bang rewrite. Landed as **one atomic, tested commit** (never a broken
half-split); verified with `node --check` + the headless harness.

**Sequencing:** explode first (this plan), modularize second — so the explode
block ports cleanly and we never refactor a moving target.

---

*Plan for the next work session. Implement explode changes only; modularization
(§11) is the follow-up.*
