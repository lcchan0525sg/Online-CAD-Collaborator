# CAD Viewer — Changelog & Technical Reference

This document serves two purposes:

1. **Changelog** — records notable changes per version, newest first.
2. **Technical reference** — documents the architecture, methods and
   technology of the current release, so future versions can follow the same
   conventions, wire formats and build process.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/);
versioning follows `v0.x`.

- **Changelog format:** `## [vX.Y] — YYYY-MM-DD` with `### Added`, `### Fixed`,
  `### Changed`, `### Removed` subsections as needed.
- **How to add a release:** append a new `## [vX.Y]` block at the top, update
  the version label in `src/index.html`, tag it (`git tag vX.Y`), and rebuild
  the portable zip (`node build-portable.mjs vX.Y --keep`). Update the
  technical reference below if the architecture/protocol/build changed.
- **Cut a release when** a user-facing feature/fix is ready and tested; keep
  `[Unreleased]` for work-in-progress.

---

## [v0.55] — 2026-08-19

**Initial public release.** v0.55 is the first tagged release and the baseline
from which the changelog is kept. It includes every feature shipped up to this
point. Releases v0.1–v0.54 were developed before the changelog was introduced
and are intentionally not backfilled.

### Added — Model & conversion

- Load **GLB / GLTF** directly in the browser (OpenCascade kernel geometry,
  per-material colours).
- **STEP / IGES / OBJ** files converted to GLB by the OpenCascade kernel
  (Docker) on the server; part names + per-part colours preserved; OBJ colours
  read from a sibling `.mtl`.
- Auto-normalize scale (mm → m), rebase on the ground, robust Z-up detection.
- **GLB/GLTF passthrough** — uploading an already-converted `.glb`/`.gltf`
  skips conversion and goes straight to the 3D preview.
- Standalone **convert-cad** tool (v0.1): STEP/IGES/OBJ → GLB/GLTF drag-&-drop
  web UI with live 3D preview, plus a CLI; packaged separately from the viewer.

### Added — Real-time collaborative sessions

- Create / join a **session** with a short code; camera, part visibility,
  selection, lighting and animation sync live in **both directions**.
- Late joiners automatically receive the current model and view state.
- **Part selection** directly in the 3D viewport (click), or from the tree.
- **Right-click part menu:** Hide part / Move part / Show me only.
- **Move a part** along X/Y/Z via the axis gizmo — click a gizmo arrow to pick
  the direction, then drag; Undo (last 200 moves) and Reset.
- **Guest leaving a session clears the shared model** from their view (nothing
  retained after leaving); the host keeps their local model.
- Host can **kick** a viewer; server health indicator.
- **Security:** the model is streamed to guest memory only — no file is written
  to the guest's disk (IP/NDA friendly).

### Added — Viewing

- Assembly tree: expand/collapse, per-part show/hide (cascading), highlight,
  Show all / Hide all.
- Adjustable lighting (Ambient / Key / Fill / Front) with reset; synced across
  the session.
- GLB keyframe **animation** playback (Play/Pause, Loop, Speed, Clip); synced.
- Orbit / zoom / pan, wireframe overlay, ground grid, auto-rotate, frame model.

### Added — Packaging & docs

- **Portable Windows zip** (`dist/cad-viewer-portable-v0.55.zip`) with bundled
  `node.exe`, slimmed three.js and the CAD converter — no installs.
- One-time **`install-docker-opencascade.bat`** setup for STEP/IGES/OBJ
  conversion.
- **User manual** (`doc/`) in Markdown + self-contained HTML (sticky sidebar
  table of contents, scroll-spy) + PDF, served in-app at `/doc/`.
- **Changelog & technical reference** introduced (this file).

### License

OpenCascade (LGPL-2.1 + OCCT exception), pythonocc (LGPL-3.0), Three.js / ws
(MIT). Full texts in `THIRD-PARTY-NOTICES.txt` and `licenses/`.

---

# Technical reference (v0.56)

> Update this section when the architecture, protocol, conversion method or
> build process changes, so future versions can follow the established
> conventions.

## 1. Overview

A **Node.js** web server serves a **Three.js** single-page app. The server
exposes static files, a REST conversion API, and a **WebSocket** relay for
real-time multi-user sessions. STEP/IGES/OBJ conversion is delegated to an
**OpenCascade kernel running in Docker**; the result is served to all members
of a session.

```
Browser (Three.js)  ──HTTP──►  Node server (src/server.js)
      │  ▲                         │
      │  └── WebSocket (ws) ───────┤  session relay (camera/parts/move/...)
      │                            │
      │                ┌───────────┴───────────┐
      │                │  POST /convert/*      │
      │                │  docker run chair-cq  │
      │                ▼                       ▼
      │          OpenCascade (OCCT)      other guests (browsers)
```

## 2. Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | **Node.js** (ESM, `"type":"module"`) | `src/server.js`, `src/main.js` |
| 3D | **Three.js** `^0.185.1` + `OrbitControls`, `GLTFLoader` | ESM via import map |
| WebSocket | **ws** `^8.21.3` | Session relay |
| CAD kernel | **OpenCascade (OCCT)** via **pythonocc** in Docker | `chair-cq:local` image |
| Docker | `docker run --rm` per conversion | Container from `Dockerfile` |
| Tests / verify | headless Chrome CDP | in-repo `_*.cjs` probes |

## 2.1 Software component versions

> Record the exact versions in use at this release so upgrades are tracked and
> reproducible. Update when a dependency is bumped.

| Component | Version | Where pinned |
|---|---|---|
| Node.js (runtime) | **22.23.2** | dev machine / `node.exe` bundled in the zip |
| Three.js | **0.185.1** | `package.json` (`^0.185.1`) |
| ws | **8.21.3** | `package.json` (`^8.21.3`) |
| OpenCascade (OCCT) | **7.9.x** (OCP core **7.9.3.1**) | `chair-cq:local` image (pythonocc-core) |
| pythonocc-core (OCP) | **7.9.3.1** | `chair-cq:local` image |
| CadQuery | **2.8.0** | `chair-cq:local` image (`pip install cadquery`) |
| Python (in container) | **3.11.16** | `Dockerfile` (`python:3.11-slim`) |
| Docker | any modern Docker Desktop / engine | required for STEP/IGES/OBJ conversion |
| Headless Chrome | any recent stable | used by in-repo CDP verification probes |
| GLB/GLTF format | glTF 2.0 (binary `.glb`) | written by `RWGltf_CafWriter` |

**How to record:** after any dependency bump, update the version here and note
it in the release's changelog entry (`### Technical`). The exact pinned values
are authoritative in `package.json`, `Dockerfile`, and the committed image; this
table is a fast reference.

## 3. File layout

```
src/server.js        Node server: static + REST + WebSocket relay + conversion
src/main.js          Three.js viewer + session client + part interactions
src/index.html       App UI (sidebar, viewport, part menu)
src/style.css        Styles
doc/                 User manual (MD + HTML + PDF), changelog, screenshots
build-portable.mjs   Builds dist/cad-viewer-portable-vX.Y.zip
Dockerfile           chair-cq:local (OpenCascade + pythonocc)
install-docker-opencascade.bat   One-time Docker/OCCT setup for Windows
tools/convert-cad/   Standalone converter tool (separate package)
```

## 4. Conversion method (STEP / IGES / OBJ → GLB)

- Server receives an upload and writes it to a temp dir.
- Runs **`docker run --rm`** with the file mounted as `/w/model<ext>`, invoking
  `/converters/step2glb.py` which uses **OpenCascade's `RWGltf_CafWriter`** to
  write `/w/model.glb`. The GLB is binary (not text glTF).
- Preserves **assembly part names** (via XCAF) and **per-part colours**;
  OBJ colours come from a sibling `.mtl` uploaded together.
- The server **verifies the result** (`countGlbTriangles`): a 0-triangle GLB is
  rejected with a clear error instead of a silent blank view.
- GLB/GLTF uploads bypass conversion (passthrough).

## 5. WebSocket protocol (sessions)

One WebSocket per client at `/ws?<session>&<id>`. Messages are JSON
`{ t: <type>, ... }`:

| Type | Direction | Payload | Purpose |
|---|---|---|---|
| `cam` | all | `pos, target` | camera sync |
| `parts` | all | `[{path, visible}]` | part visibility |
| `tree` | all | `path, collapsed` | assembly-tree expand/collapse |
| `sel` | all | `key` | part selection highlight |
| `move` | all | `path, pos` | part move (X/Y/Z) |
| `light` / `light-ambient` / `light-front` | all | levels | lighting sync |
| `anim` | all | clip/play/loop/speed | animation sync |
| `model` | host→server→guests | GLB bytes | model sharing |
| `model-ack` | guest→host | — | confirms model received |
| `peer-join` / `peer-gone` / `roster` | server | member info | membership |
| `kick` | host→server | `id` | remove a viewer |

**Model delivery:** the host streams the GLB to the server, which relays the
bytes to each guest over WebSocket; the guest loads it **in memory only** and
ACKs once the bytes arrive (fixes transfer races). Guests never write the model
to disk.

## 6. Part interactions

- **Selection:** raycast the loaded GLB on pointer-up (click-vs-drag threshold),
  resolve the hit to a part path, highlight via emissive on per-mesh **material
  clones** (so shared source materials aren't mutated).
- **Move gizmo:** X/Y/Z arrows sized to ~1/8 of viewport height; **screen-space
  segment picking** lets a click on an arrow set the move axis. Drag translates
  the part along that axis in a camera-facing plane; moves are recorded for
  **Undo** (cap 200) and **Reset**.
- **Part keys** are **paths** (child indices from the scene root), stable across
  every client that loads the same GLB — names can be empty/duplicated, so the
  path is used for sync.

## 7. Build & release process

1. Bump the version label in `src/index.html` (and manual footer).
2. `node build-portable.mjs vX.Y --keep` — checks out the tag into a git
   worktree, assembles `dist/cad-viewer-portable` (bundled `node.exe`, slimmed
   three.js/ws, converters, `doc/`), and zips to
   `dist/cad-viewer-portable-vX.Y.zip`. The working tree is untouched.
3. `git tag vX.Y`; append the release to this changelog.
4. Verify with headless Chrome probes (upload → convert → preview, session sync,
   part selection/move).

## 8. Security model

- Guests need only a browser; the model is **streamed to memory** and never
  written to their disk.
- Part-move/session state syncs only within a session; there is no cross-user
  persistence on the server.
- For external sharing: port-forward on the router, or deploy the server on a
  public/virtual host; use HTTPS/VPN for sensitive geometry (see manual §14).

---

## [v0.56] — 2026-08-19

> **Baseline:** v0.55 (tag `v0.55`). Release on top of the current working tree.

### Added

- **Part context menu** — right-click a part (its name in the Assembly tree, or
  the part itself in the 3D viewport) to open a menu with:
  - **Hide part** — turn that part (and its subtree) off in the viewport.
  - **Move part** — select the part and arm the axis gizmo.
  - **Show me only** — hide everything except that part and its children;
    ancestors stay visible so the isolated part still renders.
- **Move a part** — reposition any part along X, Y or Z using the axis gizmo
  (red/green/blue arrows, ~1/8 screen at any zoom; the armed arrow glows).
  Pick an axis by clicking a gizmo arrow, then left-drag in the viewport to
  slide the part along it — siblings stay put. Undo (up to 200 steps) and
  Reset are provided.
- **Live sync of part moves** — in a session, a part move is mirrored to every
  member in real time.

### Fixed

- _(none for this release)_

### Technical

- Part moves sync via the existing per-message sync protocol; each move is an
  undoable, resetable operation. The right-click menu and gizmo live in
  `src/main.js`; the menu markup is in `src/index.html`.

---

## [v0.71] — 2026-08-20

> **Baseline:** v0.70 (tag `v0.70`). Release on top of the current working tree.

### Fixed

- **Editing the mm-gap value after exploding no longer does nothing.** The
  explode gap `<input>` `change` handler called `recomputeExplodeGap()`, which
  re-applied the **stale global `explodeGap`** (the value from the last apply)
  instead of the number the user had just typed into the field. The handler now
  reads the input's value into `explodeGap` first, so typing a new mm value
  actually re-lays-out the explode.

### Technical

- `src/main.js`: `explodeGapEl` `change` handler now sets
  `explodeGap = Math.max(0, Number(explodeGapEl.value) || 0)` before calling
  `recomputeExplodeGap()`.

## [v0.70] — 2026-08-20

> **Baseline:** v0.69 (tag `v0.69`). Release on top of the current working tree.

### Added

- **Explode is now selection-driven** (replaces the **Level: All parts / Top
  sub-assembly** dropdown). You pick an assembly in the tree and the explode
  spreads that assembly's **immediate children**; a child that is itself a
  sub-assembly moves as a **rigid unit** (its descendants ride along). The
  default scope is the **top level** — the highest assembly with more than one
  child, descending past any single-child "pure wrapper" (so a one-node wrapper
  around a whole model like the GearBox's "GearBox" node correctly explodes its
  45 parts).
  - **Select a sub-assembly** → scope jumps to that assembly's children (targets
    recompute, the slider/gap value stays). **Select a leaf part** → scope
    unchanged.
  - A **scope readout** shows **"Exploding: <assembly> — N children"** so
    selection-driven changes are visible.
  - Selecting an assembly with **≤1 child** (or a single-part model) shows
    "nothing to spread (select an assembly)" instead of silently doing nothing.
- **Two separation modes** (the **Sep** selector):
  - **% (percentage)** — the slider, 0–100%, works with **Radial** and **X/Y/Z**.
  - **mm gap** — a numeric input; the **clear space (mm) between adjacent
    bounding boxes** along the chosen axis. **Axis-only**: choosing gap while in
    Radial auto-switches to **X**. Bounding boxes are computed once and cached
    (only the scope's immediate children, a few ms), and the layout is fully
    reversible (gap 0 restores every part exactly).

### Changed

- **Hidden parts are skipped** in the explode layout — no phantom gap around
  hidden geometry.
- Explode state now syncs as `{ amount, mode, gap, dir, scopeKey }`; late joiners
  receive the full current state.

### Technical

- Rewrote the explode section in `src/main.js`: scope resolution
  (`explodeScopeNode` / `explodeScopeInfo`), percentage separation
  (`applyExplodeAmount`), bbox-gap axis layout (`applyExplodeGap`, reversible via
  `resetExplodeToResting`), mode UI (`showExplodeModeUi`), scope readout
  (`renderExplodeScope`), and the extended `explode` sync message. Server
  (`src/server.js`) stores/replays the new shape. Removed `explodeLevel` and the
  Level dropdown. The `explode` message protocol doc was updated.

## [v0.69] — 2026-08-20

> **Baseline:** v0.68 (tag `v0.68`). Documentation release — no code changes.

### Added / Changed

- **User manual rewritten and expanded to v0.69.** The manual now documents the
  full feature set shipped since v0.56, with five new screenshots:
  - **§6 Measuring distances** — the two-point corner-snap Measure tool
    (new shot `20-measure.png`).
  - **§7 Exploded view** — the Explode slider with Direction / Level options
    (new shot `18-explode.png`).
  - **§8 Part transparency** — the right-click Make transparent / Make opaque
    toggle (new shot `19-transparent.png`).
  - **§13 Session chat** — the chat window, history replay and transcript
    download (new shot `21-chat.png`).
  - **Part name on hover** added to the Assembly section (new shot
    `22-part-hover.png`).
  - The right-click context menu is documented as four actions (Hide / Move /
    Show me only / Make transparent); the "What stays in sync" list now covers
    measurements, transparency and the exploded view; and the troubleshooting
    table gains Measure and Explode entries.
- Regenerated `USER-MANUAL.html` (self-contained, images embedded) and
  `USER-MANUAL.pdf` from the updated markdown.

### Technical

- `doc/USER-MANUAL.md` → `build-manual.py` → `doc/USER-MANUAL.html`; the PDF is
  rendered from the HTML via headless Chrome `Page.printToPDF`. New screenshots
  captured with a self-contained headless-Chrome harness (which kills Chrome and
  removes its profile afterwards).

## [v0.68] — 2026-08-19

> **Baseline:** v0.67 (tag `v0.67`). Release on top of the current working tree.

### Added

- **Chat opens by default when entering a session.** Creating or joining a
  session now shows the chat window immediately, so members can talk right away.
  It can still be closed (✕) and reopened via the **Chat** button.

### Changed

- **Chat transcript download verified.** The ⬇ button in the chat header saves
  the conversation as `chat-<session-code>-<date>.txt` (already present since
  v0.63); this release adds a debug hook and confirms the generated filename and
  transcript content are correct (each line `HH:MM  name: message`, with a
  generated-at header).

### Technical

- `showSessionUI(active, …)` now sets `chatWindowEl.hidden = false` when entering
  a session. `window.__viewer.userName` debug hook added. Lives in `src/main.js`.

## [v0.67] — 2026-08-19

> **Baseline:** v0.66 (tag `v0.66`). Release on top of the current working tree.

### Fixed

- **Selection highlight and part transparency no longer interfere — rewritten to
  be derived from state instead of accumulated material clones.** The repeated
  bugs ("clicking a transparent part restores its colour", "turning a second part
  transparent off leaves both stuck in the highlight colour") all came from one
  root cause: transparency and the selection highlight each swapped `mesh.material`
  for cloned materials and kept their own bookkeeping, so the two systems fought
  over `mesh.material` and leaked state into each other in certain orderings.
  This version removes that fragility entirely:
  - Each mesh's **pristine base material is captured once at load** (`meshBase`)
    and **never mutated**.
  - Transparency is stored as a **Set of part keys** (`transparentParts`); the
    selected part is stored as a single **key** (`selectedPartKey`).
  - **Every** material is **derived fresh from the base** by `applyAllMaterials()`
    on each change: `base → (if transparent) opacity clone → (if selected) emissive
    clone`. Because each recompute starts from the pristine base, transparency and
    selection can never leak into each other, and the ordering of
    select / make-transparent / deselect / make-opaque is irrelevant.
  - Result: toggling two parts transparent and turning them off one at a time
    always returns both to their original colour with the highlight cleared, in
    any order. Selection and transparency compose correctly on shared materials
    too (each mesh clones from its own base).

### Technical

- New state + derivation in `src/main.js`: `meshBase` / `meshPartKey` maps,
  `captureMeshBases(root)` (called on model load after the tree is built, records
  each mesh's pristine material and its deepest part row — including the flat
  single-part case where the mesh itself is the row), `applyAllMaterials()` /
  `applyMeshMaterial()`, `partIsTransparent()` / `partIsSelected()`. Removed the
  old `selectedMaterialCopies` and `transparentMaterialCopies` clone-accumulation
  maps. `setPartTransparent` and `selectPart`/`clearPartSelection` now only mutate
  state and call `applyAllMaterials()`. Session sync and late-joiner replay of
  transparency are preserved unchanged.

## [v0.66] — 2026-08-19

> **Baseline:** v0.65 (tag `v0.65`). Release on top of the current working tree.

### Fixed

- **Turning a second part transparent off no longer leaves both parts stuck in
  the selection-highlight colour.** Root cause was a reference-aliasing bug in
  `setPartTransparent()`: when a *selected* part was made transparent, the
  selection's stored `original` was assigned the **same** material-clone objects
  that then received the blue highlight. So deselect (or toggling the next part
  off) restored the already-highlighted clone, making every previously-transparent
  part appear permanently highlighted. The stored `original` is now a `.clone()`
  copy, so the highlight can never taint the material that deselect restores.
  - Selection and transparency now compose correctly through any ordering:
    select→transparent→deselect keeps it transparent; two transparent parts can
    be turned off one at a time and both return to their original colour with the
    highlight cleared.
  - The per-part transparency `original` (`transparentMaterialCopies`) is also
    cloned where needed so mutating a part's highlight never leaks into another
    part's stored base.

### Technical

- In `setPartTransparent()`, the selected-mesh branch stores
  `selectedMaterialCopies[selIdx].original = clones.map((c) => c.clone())` (and
  the opaque-restore branch already cloned `restored`) instead of a reference to
  the objects subsequently highlighted. Lives in `src/main.js`.

## [v0.65] — 2026-08-19

> **Baseline:** v0.64 (tag `v0.64`). Release on top of the current working tree.

### Fixed

- **Clicking a transparent part no longer restores its colour.** Two systems both
  swap `mesh.material` — the selection highlight (emissive clones) and
  transparency (opacity clones) — and they were fighting: making a part
  transparent, then clicking to select/deselect it, restored the opaque
  pre-transparency material. Selection and transparency now compose:
  - Transparency is applied to the part's **base** material, not the selection
    clone, so the true colour (not the highlight tint) becomes transparent.
  - When a selected part is made transparent (or opaque), the selection's stored
    `original` is updated to the new transparent/opaque material, so deselecting
    restores to the *current* state instead of reverting transparency.
  - The selection highlight is re-applied on top of the transparent/opaque
    material, and the stored original is cloned so mutating the highlight can't
    taint the base.
  - Also fixed: toggling a part **off** transparent now actually restores opacity
    (previously the apply loop re-applied transparency regardless of the target
    state).

### Technical

- Reworked `setPartTransparent()`: it now only swaps in opacity clones when the
  target part row is actually transparent (`target` true); when making a part
  opaque it restores the base and just re-applies the selection highlight. It
  keeps `selectedMaterialCopies` in sync (updating each mesh's stored `original`
  and re-applying emissive) so selection and transparency stay consistent through
  any ordering of select/transparent/deselect. Lives in `src/main.js`.

## [v0.64] — 2026-08-19

> **Baseline:** v0.63 (tag `v0.63`). Release on top of the current working tree.

### Added / Changed

- **Transparent menu shows the current state** — the right-click part menu item
  now reflects the part's transparency: it reads **"Make transparent"** when the
  part is opaque and **"Make opaque"** when it's transparent, so you can toggle it
  back to normal colour from the same menu. The label updates live based on the
  part's state.

### Fixed

- _(none for this release)_

### Technical

- `showPartMenu()` now sets the menu item's text from `partTransparent(key)`
  before showing the menu. Lives in `src/main.js`.

## [v0.63] — 2026-08-19

> **Baseline:** v0.62 (tag `v0.62`). Release on top of the current working tree.

### Added

- **Download chat transcript** — a **⬇** button in the chat window header saves
  the full conversation to a `.txt` file (`chat-<session-code>-<date>.txt`). Each
  line is `HH:MM  name: message`; a header records when it was generated. Uses the
  current chat history (whatever the viewer has loaded, including late-joiner
  replay), so it's a client-side export — no server change needed.

### Fixed

- _(none for this release)_

### Technical

- `downloadChat()` builds a `Blob` from `chatHistory`, creates a temporary
  download anchor with `download = chat-<code>-<date>.txt`, clicks it, and revokes
  the object URL. Lives in `src/main.js`; the button is in `src/index.html`.

## [v0.62] — 2026-08-19

> **Baseline:** v0.61 (tag `v0.61`). Release on top of the current working tree.

### Added

- **Part transparency** — right-click a part and choose **Make transparent** (or
  **Make opaque**). The part (and its subtree) renders at 25% opacity, cloning its
  per-mesh materials so shared materials on other parts are untouched. Toggling a
  parent updates all its descendants. **Syncs across the session** like
  visibility/move: whoever toggles it, everyone follows, and late joiners get the
  current transparent state.
- **Session chat** — a **Chat** button (in the session panel) opens a chat window
  in the viewport. Members can send messages that appear to everyone in real time.
  - Each message shows the sender's name, text, and local time; your own messages
    are highlighted.
  - **History is preserved** — the server stores the chat log (capped at 200) and
    replays it to **late joiners**, so a new member sees the conversation so far,
    not just messages sent after they joined.

### Fixed

- _(none for this release)_

### Technical

- **Protocol:** client→server `trans { key, transparent }` and `chat { text }`;
  server→client relays plus `trans-sync { keys }` and `chat-sync { history }`
  late-joiner snapshots. The server stores `session.trans` (key→bool) and
  `session.chat` (id, name, text, ts; capped 200), replaying both on join.
- **Transparency:** clones each part mesh's material(s), sets `transparent:true`,
  `opacity:0.25`, `depthWrite:false`, and stores `{ mesh, original }` copies so
  the toggle is reversible (same clone rule as the selection highlight, because
  GLB parts share materials). `clearTransparency()` restores all on model clear.
  Late-joiner transparency is queued in `pendingRemoteTransKeys` and flushed on
  model load (mirrors parts/measure). Lives in `src/main.js`; server in
  `src/server.js`.

## [v0.61] — 2026-08-19

> **Baseline:** v0.60 (tag `v0.60`). Release on top of the current working tree.

### Fixed

- **Reset also collapses the exploded view.** Pressing the **Reset** button (part
  positions) now first collapses the Explode slider to 0, so the model returns to
  its assembled resting state alongside the position reset.

### Technical

- `resetPartPositions()` calls `resetExplode()` (collapse to 0) before restoring
  baseline positions, so the explode offset is removed first and the parts land
  exactly at their original resting positions.

## [v0.60] — 2026-08-19

> **Baseline:** v0.59 (tag `v0.59`). Release on top of the current working tree.

### Added

- **Explode direction option** — the Explode control now has a **Dir** selector:
  **Radial** (spread outward from the assembly centre) or an explicit **X / Y / Z**
  axis (parts on the + side move +, on the − side move −). Syncs across the
  session.
- **Explode level option** — the Explode control now has a **Level** selector:
  **All parts** (every leaf part separates, so you see the actual components) or
  **Top sub-assembly** (each top-level sub-assembly moves as a rigid unit).

### Fixed

- **Explode moved the whole assembly instead of separating parts.** The tool
  previously exploded only `root.children` — for the GearBox that's a single
  top-level wrapper node ("GearBox", 3029 meshes) containing all 45 real parts,
  so the whole model slid as one unit. It now collects parts with the **same rule
  the assembly tree uses** (`isPartNode`), so it explodes the 45 actual parts.
- **Explode no longer re-derives directions from the spread positions.** The
  remote/debug apply path recomputed each part's direction from its *current*
  (already-spread) position, so collapsing to 0 couldn't reverse — parts ended up
  displaced. Directions are now only recomputed when the direction/level actually
  change (collapse first, then re-derive, then re-apply); otherwise the stored
  directions are reused so the delta path reverses cleanly.

### Technical

- `collectExplodeNodes()` mirrors `buildPartsTree`'s `isPartNode` rule to gather
  every part row, then selects **leaf parts** (rows that aren't an ancestor of any
  other row) for "parts" level, or **depth-0 rows** for "sub" level. Each target's
  direction is computed in its **own parent's** local frame (via
  `parent.worldToLocal`) so `node.position` can be offset directly regardless of
  nesting depth. The `explode` session message now carries `{ amount, dir, level }`;
  the server stores the whole object and replays it to late joiners.

## [v0.59] — 2026-08-19

> **Baseline:** v0.58 (tag `v0.58`). Release on top of the current working tree.

### Added

- **Measure sync across session members** — a committed measurement (dimension
  line + points) made by any member now appears on every viewer in real time.
  - Only committed measurements sync (the hover glow and in-progress first point
    stay local to the viewer making them).
  - Each measurement gets a stable **id**; add/remove/clear are relayed to the
    session, so a delete by one member removes the same line for everyone (id-based
    delete, not index-based, so concurrent deletes stay correct).
  - The server **snapshots** the committed measurements, so a **late joiner** sees
    the measurements that were already made (replayed on join).
  - Points are sent in world coords; length / elevation / azimuth are recomputed
    locally, so both viewers always agree on the numbers.
- **Exploded view** — an **Explode** slider spreads the assembly's top-level
  sub-assemblies/parts radially outward from the assembly centre, revealing the
  sub-assembly structure at a glance.
  - Explodes at the **top-level sub-assembly level** (the depth-0 tree nodes), so
    each sub-assembly moves as a rigid unit and its internals stay together.
  - **Non-destructive**: it only adds a per-part offset on top of each part's
    resting position (even if the part was moved), and collapsing the slider to 0
    returns every part exactly to where it was.
  - **Synced across the session** like light/anim: whoever moves the slider, the
    whole session follows, and late joiners get the current explode state.

### Fixed

- _(none for this release)_

### Technical

- **Protocol:** new client→server messages `measure-add`/`measure-del`/
  `measure-clear`/`explode`; new server→client relays plus a `measure-sync`
  (late-joiner snapshot) and `explode` replay. The server stores `session.measures`
  (capped at 200) and `session.explode`, and replays both on join. Client handlers
  in `onSessionMsg` route to `applyRemoteMeasure*` / `applyRemoteExplode`, each
  guarded by an `applyingRemoteMeasure`/`applyingRemoteExplode` flag so applied
  ops aren't echoed back. Measure ops are queued in `pendingRemoteMeasures` and
  flushed on model load (mirrors `pendingRemoteParts`).
- **Explode math:** `computeExplodeDirs()` computes, per top-level part, the radial
  world direction from the assembly centre to the part's bounding-box centre,
  converted to the root's local frame (so `node.position`, root-local, can be
  offset directly). `applyExplodeAmount(new)` moves each part by
  `dir * (new - prev) * scale`, where `scale` is 50% of the model's bounding-box
  diagonal — so collapsing to 0 subtracts back exactly. Works with parts that were
  already moved. Lives in `src/main.js`; server handlers in `src/server.js`.

## [v0.58] — 2026-08-19

> **Baseline:** v0.57 (tag `v0.57`). Release on top of the current working tree.

### Added

- **Part hover labels** — mouse over a part in the 3D viewport and a small
  tooltip appears at the cursor with the part's name, and its row in the
  Assembly tree highlights. Directly answers "which part is this?".
  - The tooltip follows the cursor and shows the deepest named part under it.
  - The hovered tree row gets an `.hov` highlight (distinct from the `.sel`
    selection highlight).
  - Raycasting is throttled to ~30fps and only re-runs when the cursor crosses
    into a different part, so it stays cheap even on large models. Leaving the
    viewport clears the hover.

### Fixed

- _(none for this release)_

### Technical

- `hoverPickKey()` raycasts and resolves the hit mesh up to its deepest named
  part ancestor — the same path-key rule as tree rows and `pickPartKey`, so the
  tooltip and highlight always refer to the same part the tree lists. The
  tooltip is a `#part-hover-tip` overlay positioned at the cursor (offset from
  the canvas origin by `clientX - rect.left`, its containing block being
  `#viewport`); a `pointermove` handler throttled to `HOVER_TICK_MS` (33ms)
  updates it. The `.partrow.hov` CSS distinguishes hover from selection. Lives
  in `src/main.js`; markup in `src/index.html`.

## [v0.57] — 2026-08-19

> **Baseline:** v0.56 (tag `v0.56`). Release on top of the current working tree.

### Added

- **Measure tool (2-point, corner snap)** — a Measure toggle (mutually exclusive
  with Move). With it armed, the cursor glow-snaps to a part's corner vertices;
  click a first corner, then a second, and a dimension line with a live mm
  readout is committed and added to a list.
  - **Corner snapping** — corners are detected from the mesh's sharp crease
    edges (dihedral angle), so it works on closed solids (boxes) as well as open
    faces, and skips mid-edge / mid-face tessellation vertices. The cursor
    snaps within a ~12px screen tolerance; a hover glow shows exactly which
    corner will be picked, and the distance updates live.
  - **2-point flow** — click 1 places a blue marker and the status reads "click
    the second corner"; click 2 commits an amber dimension line + end dots, a
    "measured … mm" toast, and a row in the measurements list (each row has a
    per-entry ✕ to delete). **Esc** cancels the in-progress first point.
  - **Clear** button removes all measurements. Measurements are listed with
    tabular-nums and remain in the scene. Each list entry shows the point 1 and
    point 2 positions (mm), the length, and the elevation + azimuth angles of
    the measured segment.
- **Mutual exclusion** — turning on Measure turns off Move, and vice-versa.

### Fixed

- **Layout** — the "Move part"/"Measure" toggle labels and their `off`/`on`
  chips no longer overlap. The generic `.row span` rule (34px slider-value
  width) was leaking onto the toggle labels and status chips; the label text
  and the chips now use `width:auto`, left-aligned, `nowrap`.
- **Status text** — the Measure status chip now reads simply `off`/`on`
  instead of instructional "click a corner to start" prompts.

### Technical

- Corner detection: per mesh (cached, stored in local coords, transformed by
  `mesh.matrixWorld` on snap) it builds an edge→triangle map, marks crease edges
  (boundary edges, or edges whose adjacent face normals differ by >~35°), and
  keeps vertices with ≥2 non-collinear incident crease-edge directions. The
  snap is a screen-space nearest-corner search within a 12px tolerance. Committed
  measurements live in a scene-level `measureLayer` group (amber `Line` + dot
  `Mesh`es); the hover glow and first-point marker are also in it. mm readout =
  world distance × 1000 (scene normalized mm→m). Measurements are **local-only**
  in this release (not synced to session members) — sync is a future candidate.
  Debug hooks (`window.__viewer.measure*`) are provided for headless
  verification. The tool lives in `src/main.js`; markup in `src/index.html`.


