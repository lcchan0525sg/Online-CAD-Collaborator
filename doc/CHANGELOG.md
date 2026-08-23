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

## [v1.02] — 2026-08-24

### Fixed

- Late-joining guests now receive the host's model corrections (units, scale,
  flip and rotation), named section-cut presets, hidden-part visibility and
  part-transparency state during the initial session replay.
- Section presets received before a guest's model finishes loading are buffered
  and restored after the model is ready instead of being cleared by model-load
  initialization.

### Verified

- Added a recorded-transform test hook so the pre-session transform-history
  replay path can be exercised with a genuine history entry.

## [v1.01] — 2026-08-23

### Fixed

- Session sync: a guest joining a session no longer resets the host's camera
  (view angle and zoom level). The guest's load-time auto-frame
  (`frameModel()` snapping to its default iso view) fired an OrbitControls
  `change` that broadcast the guest's default camera to the host — the same
  class of load-time-echo bug fixed for lighting/animation/explode in v1.00.
  Three coordinated changes, no server change needed (the server already
  stores and replays the host's camera):
  - `session.js` — new `broadcastCamera()`; the host now publishes its
    current camera position + target as part of its pre-join state publish,
    so a model opened *before* the session is created is replayed to late
    joiners (previously `session.camera` was null and the guest simply
    framed its own default view). `applyRemoteCamera` also marks the remote
    camera as valid.
  - `scene.js` — `frameModel()` now keeps the adopted host camera when a
    guest in a session has already received one, instead of snapping to the
    default iso view, and the load-time frame is wrapped so it is never
    broadcast back to the host.
  - `context.js` — new `remoteCamValid` flag.
- Verified with a two-browser headless harness (real load paths): the host's
  custom view angle + zoom are preserved exactly when a guest joins, the
  guest adopts the host's view, and negative control (fix reverted)
  reproduced the original clobbering.

## [v1.00] — 2026-08-23

### Fixed

- Session sync: a guest joining a session no longer clobbers the host's
  "module status" (lighting, animation, explode gap) with its own defaults.
  Two coordinated changes:
  - `session.js` — the host now publishes its current lighting / animation /
    explode state as part of its pre-join state publish (alongside
    corrections and section presets), so late joiners and resync replay
    receive the host's real settings instead of only ever seeing the
    guest's own defaults.
  - `scene.js` — the model-load-time state broadcast is now **host-only**.
    Previously, a guest that finished loading the shared model would
    broadcast its own *default* light/anim, the server relayed that back to
    the host, and `applyRemoteLight` / `applyRemoteAnim` overwrote the host's
    settings — i.e. the guest's join effectively "restarted" the host's
    module status. Guests now receive the host's state instead, and a
    guest's own mid-session change is still sent live by its control
    handlers.
- Verified across STEP, IGES and GLB (including a 35 MB model) with a
  two-browser headless harness: host state is preserved on guest join, the
  guest adopts the host's state, and live host→guest changes still sync.

### Changed

- `languages/` (the external, human-editable locale files) is now gitignored
  so it stays out of the source repo, matching the project convention that
  Chinese locale files are not committed.

## [v0.99] — 2026-08-23

### Changed

- Part detection (hover tooltip + Assembly-tree row highlight) now suspends
  while a camera navigation gesture is in progress — orbit, pan, zoom — and
  re-enables on the first mouse move after the gesture completes. Driven by a
  single `ctx.navigating` flag set from OrbitControls' `start`/`end` events;
  this avoids redundant full-model raycasts during navigation on large
  assemblies. Measure-mode corner-snap glow is suspended for the same reason.
  Click selection is unchanged: it already ignores drags via its own
  > 5 px movement threshold.

---

## [v0.98] — 2026-08-23

### Added

- Added a built-in English UI catalog with stable translation keys and safe
  per-key English fallback behavior.
- Added optional external `zh-Hant.json` and `zh-Hans.json` language add-ons,
  discovered through `CAD_LANGUAGE_DIR` or a portable build's `languages/`
  directory.
- Added a persistent Language selector in the About section of the left
  sidebar; changing language does not reload the model or session.
- Added translation coverage for static labels, tooltips, placeholders,
  accessibility labels, runtime conversion/session messages, and interaction
  status text.
- Added `tools/validate-language.mjs`, `tools/check-layout.mjs`, and the
  translation workflow documentation.

### Fixed

- Fixed translated text inside primary Load model and Create session buttons
  inheriting muted sidebar span styling and becoming difficult to read.
- Fixed dynamic backend status text remaining in English after switching locale.
- Fixed backend startup to discover bundled or user-installed native OCP Python
  before probing the generic `python` command.
- Added flexible wrapping and bounded toolbar sizing for longer translated
  labels at 1280, 1024, and 768 pixel viewports.

### Verification

- Full browser CAD/session regression: **115 passed, 0 failed**.
- Traditional Chinese, Simplified Chinese, and pseudo-locale layout checks:
  **0 overflow failures** at 1280, 1024, and 768 pixels.
- Locale validator: **240 strings** per Chinese draft file, with exact
  placeholder and catalog-key validation.

---

## [v0.97] — 2026-08-22

### Added

- Main CAD Viewer conversion now prefers a local Python environment with
  **OpenCascade/OCP 7.9.3**, selected with `CAD_PYTHON` or `--python`.
- Backend selection supports `auto` (native-first), `native`, and `docker` via
  `CAD_BACKEND` or the matching server option.
- `/health` reports the active conversion backend, and the Model panel displays
  whether conversion is using local OCP or Docker fallback.
- Portable viewer builds can bundle the native Python/OCP runtime when built
  with `CAD_NATIVE_PYTHON`; Docker remains available as a fallback.

### Changed

- STEP/IGES conversion in both direct uploads and shared-session uploads uses
  the selected backend while preserving the existing XCAF assembly hierarchy,
  part names, colours, and zero-triangle validation.
- About label and manual footer are updated to v0.97.

### Verification

- Native local server health: `backend=native` with the verified
  `cad-native` Python environment.
- Native `CAM_online.STEP`: valid GLB, 821,644 bytes, 16 nodes, 15 meshes,
  15 materials, and 12,148 triangles.
- Auto mode without local OCP: server reports Docker fallback.

---

## [v0.96] — 2026-08-22

### Fixed

- CAD assembly-tree parsing now recognizes direct `THREE.Mesh` part nodes
  produced by OCCT 8.0.1 Draco GLBs while continuing to ignore primitive meshes
  nested inside a part wrapper.
- Draco-compressed GearBox assemblies now display all 45 parts instead of only
  the first-level five group nodes.

### Changed

- Assembly trees start fully expanded so nested parts are immediately visible;
  users can still collapse individual assemblies.
- The floating assembly panel is taller and reports the loaded node count.
- About/version display and portable packaging are updated to v0.96.

### Verification

- Production viewer runtime: V7.9.3 GLB **46 rows**, OCCT 8.0.1 Draco GLB
  **46 rows**.
- Portable archive: `cad-viewer-portable-v0.96.zip` built and extracted-server
  smoke-tested successfully.

---

## [v0.95] — 2026-08-21

### Added

- Section View **interaction mode** in the viewport toolbar with a centre normal
  handle for directly dragging the cut plane along its normal.
- Section handle hover/drag feedback, constrained offset movement, and Escape
  cancellation while preserving the existing slider, presets, exports, and sync.

### Changed

- Model-correction **Scale** control is now an exact numeric textbox (`0.10×` to
  `10.00×`, `0.01` step) instead of a range slider. Values commit on Enter or
  field change and continue to synchronize with session members.

### Fixed

- Legacy `move`/`rot` session messages now carry actor names, so reset and other
  older transform paths also participate in actor-aware conflict notifications.
- Portable builds now include the `model.js` client module required by the Model
  corrections panel.

### Verification

- Full browser harness: **115 passed, 0 failed**.

---

## [v0.94] — 2026-08-21

### Fixed

- Section View now starts by keeping the front side of the model; **Reverse**
  switches to the opposite side.
- The transparent section reference plane and the actual clipping plane remain
  aligned when Reverse is enabled and the offset slider moves.
- Front-light slider position now matches its intensity default of 1.0 at startup.

### Verification

- Full harness: **109 passed, 0 failed** after the section-direction and lighting
  fixes.

---

## [v0.93] — 2026-08-21

### Added

- Section **2D drawing export**: **Export SVG** and **Export PNG** buttons under
  the section controls save the current cross-section contour silhouette as a
  flat, unit-scaled drawing (mm/in) with a small label.
- **Dimension annotations** in the viewport: each measurement now draws a
  CAD-style **dimension line** with **arrowheads** and an edge-snapped,
  camera-facing **distance label** that re-projects live as you orbit/zoom/pan.

### Verification

- Full two-client harness: **105 passed, 0 failed** (SVG/PNG export valid;
  dimension annotations drawn with arrowheads + label and clear correctly).

---

## [v0.92] — 2026-08-21

### Added

- Section-view **saved cuts (presets)**: name the current cut and save it as a
  chip; click to jump back, **✕** to delete. Shared with the session (new
  `section-preset` message) and replayed on resync / to late joiners.
- Assembly-tree **name filter** box (local, per-viewer): narrow the floating tree
  to matching parts, keeping ancestors visible.
- **Actor-aware conflict messages**: the server stamps the sender's name on every
  transform; when a peer changes a part you have selected you get a live
  "*name changed part*" notice, and an Undo/Redo refused because a part changed
  remotely names the actor.
- **Viewport snapshot** button (**📷** in the View panel) downloads the current
  view as a PNG (local, no sync).

### Verification

- Full two-client harness: **101 passed, 0 failed** (presets save/apply/delete +
  sync/resync, tree filter, actor attribution, snapshot PNG).

---

## [v0.91] — 2026-08-21

### Added

- Section cut-plane overlay: a semi-transparent reference plane at the cut plus
  orange surface-intersection contour lines that track the offset slider live.
- Floating **Model** corrections panel (bottom-left, collapsed by default):
  **Units** (mm/in), **Scale** (0.1×–10×), **Flip** (X/Y/Z), **Rotate**
  (axis + angle), and **Reset corrections**.
- Model corrections are session-shared state — a new `corr` wire message syncs
  units/scale/flip/rotate to every member, and the server replays them on resync
  and to late joiners.
- A pre-created Section state now transfers to a guest that joins later
  (alongside transforms and measurements).

### Changed

- Front light now defaults to 1.0 for clearer section views.
- The section plane quad is centred on the model's in-plane bounding-box centre
  (it was anchored at the world origin, so it overhung lopsidedly).

### Fixed

- Model corrections now compose on top of the model's auto-orientation instead of
  overwriting it — flip/rotate behaved in the wrong frame on Z-up models.
- The Model panel's flip/rotate-axis buttons were being disabled by the
  interaction toolbar's global `[data-axis]` manager; they now use
  `data-flip-axis` / `data-rot-axis`.

### Verification

- Full two-client harness: **91 passed, 0 failed** (section overlay, pre-session
  section sync, model-corrections panel, and corrections sync/resync covered).

---

## [v0.90] — 2026-08-21

### Added

- Viewport measurement labels positioned at measurement midpoints.
- Measurement labels and owning Assembly tree part names in the floating panel.

### Changed

- Measurement entry display order is part, P1, P2, distance, then angle.
- Floating measurement panel spacing and annotation styling refined.

### Verification

- Full two-client harness: **65 passed, 0 failed**.

---

## [v0.89] — 2026-08-21

### Added

- Authoritative guest Resync session action.
- Camera state replay for first join, reconnect, and manual Resync.
- Floating scrollable/collapsible measurement panel with editable labels and part names.

### Changed

- Host pre-session transforms, pivots, and measurements are published when the session is created.
- Guest transform state is buffered until the shared model finishes loading.
- Measurement panel is positioned below the floating View controls.
- Duplicate Explode Frame control removed; floating Fit remains the single framing action.

### Verification

- Full two-client harness: **65 passed, 0 failed**.

---

## [v0.88] — 2026-08-21

### Added

- Guest reconnect workflow with automatic retry and a manual Reconnect action.
- Session state replay on reconnect without unnecessary model reload.

### Changed

- First-time guests load the host model; reconnecting guests preserve their current model.
- Host shutdown remains authoritative: guests end the session and clear the model.
- Reconnect is never attempted after host removal, host shutdown, or explicit Leave.

### Verification

- Full two-client harness: **60 passed, 0 failed**.

---

## [v0.87] — 2026-08-21

### Added

- Selectable viewport background schemes: Graphite, Navy, Light CAD, and Blueprint.
- Persistent user background-scheme choice.

### Changed

- Blueprint theme is now a distinct light blue scheme rather than another dark blue.
- Transparent parts preserve their original material colours and use a moderate 16% opacity.
- Sidebar and floating Assembly tree controls refined for clearer model inspection.

### Verification

- Full two-client harness: **59 passed, 0 failed**.

---

## [v0.86] — 2026-08-21

### Added

- Orthogonal Section View with X/Y/Z plane selection, mm offset, reverse direction,
  reset, session synchronization, and late-joiner replay.
- Collapsible floating **Assembly tree** panel on the right side of the viewport.
- Grouped Move and Rotate operations for multi-selected parts.

### Changed

- Automatic model rotation is disabled by default.
- Group Move/Rotate actions share one Undo/Redo history group.
- Group gizmos use the selected group’s bounding-box centre.
- Corrected grouped Z-axis rotation initialization.
- Sidebar Assembly controls are labeled **MODEL CONTROL**.

### Verification

- Full two-client harness: **58 passed, 0 failed**.

---

## [v0.85] — 2026-08-21

### Added

- Per-part custom pivot persistence across selection changes.
- Ctrl-click multi-selection in the tree and viewport.
- Selection synchronization with backward-compatible `keys` payloads.
- Multi-part move deltas along the selected axis.

### Changed

- Undo/Redo now targets the recorded action directly; the affected part does
  not need to remain selected.
- Remote repeated selection messages are idempotent.
- Global Reset clears the saved per-part pivot map; model reload also starts a
  fresh pivot map.

### Verification

- Full two-client harness: **53 passed, 0 failed**.

---

## [v0.83] — 2026-08-21

### Added

- **Unified interaction toolbar** with Select, Move, Rotate, Pivot, and Measure
  modes, explicit active-axis state, contextual selected-part actions, and
  Escape cancellation.
- **Custom pivot editing** with a compact crosshair marker and rotation around
  an arbitrary pivot.
- **Unified transform history** for move, rotate, and pivot gestures.
- **Redo support** through the Assembly panel and `Ctrl+Y` / `Ctrl+Shift+Z`.
- **Transform completion/cancellation feedback** in the viewport toolbar.
- **HOST/GUEST connection badges** and clearer session connection-state colors.
- **Explicit Explode scope/readout** and separate Explode Reset and camera Frame
  actions.

### Changed

- Undo now restores complete position, quaternion, and pivot state rather than
  movement alone.
- Undo/Redo broadcasts the resulting atomic transform to session members.
- Stale Undo/Redo actions are refused when another user has changed the same
  part, preventing accidental overwrites.
- The measurement workflow now shows explicit first-point/second-point status
  and compact corner markers.

### Verification

- Full headless two-client viewer harness: **47 passed, 0 failed**.
- All client/server modules pass `node --check`.
- `git diff --check` passes.

---

## [v0.82] — 2026-08-20

### Added

- **Rotate parts.** The move gizmo now shows a **semi-circle arc with an arrow**
  in the plane perpendicular to the armed axis. Press **R** (or click the arc's
  arrowhead) to arm rotate, then drag to spin the part around that axis.
  Rotations join the same Undo/Reset history and **sync to guests** (`rot`
  message relayed by the server). Also fixed a rotation-math bug: the delta is
  now applied in the part's parent frame, so the axis is correct for
  already-rotated parts and parts nested under a rotated assembly.
- **Preset views.** A small floating **View** panel (top-right of the viewport)
  with **Iso / Front / Back / Left / Right / Top / Bottom** camera orientations,
  each framed on the model and synced to guests.
- **Floating Parts panel.** The parts list now lives in a collapsible assembly
  tree in a floating panel at the left edge of the viewport; the sidebar no
  longer shows its own parts tree (no duplicate explorer).
- **Part comment → chat.** The right-click part menu has a **Comment…** action
  that opens an inline text box; sending posts `[Part name] note` into the
  session chat. Requires being in a session.

### Changed

- `server.js` relays the new `rot` message type (rotate sync).

---

## [v0.81] — 2026-08-20

### Changed

- **Modularized the client code.** The single `src/main.js` (~3,169 lines) was
  split into concern-based ES modules with **no behaviour change**:
  `context.js` (single shared `ctx` state object), `scene.js`, `parts.js`,
  `measure.js`, `explode.js`, `move.js`, `session.js`, and a thin `main.js`
  (render loop, boot, `window.__viewer` debug hooks). Cross-module calls use
  explicit imports; shared mutable state all lives on `ctx`. The WebSocket
  wire protocol and `server.js` are untouched. See `doc/ARCHITECTURE.md`.
- Verified with `node --check` on all modules and a headless two-tab full
  function test (load, parts tree, selection/highlight, transparency, explode,
  measure, move with real drag, live session + host-left clears guests).

## [v0.80] — 2026-08-20

### Changed

- **Session ends when the host leaves or closes the browser.** The host owns the
  shared model, so when the host disconnects (Leave button or browser close) the
  session is terminated: every guest's shared model is **cleared from their
  view** and they see *"host left — session ended"*. Host promotion was removed —
  a hostless session is dead. The host keeps their own locally-opened model.

## [v0.79] — 2026-08-20

### Removed

- **OBJ support removed** from both the main viewer and the standalone
  `convert-cad` tool. OBJ is a mesh-only format without B-rep semantics, so it
  cannot represent CAD assemblies/collaboration faithfully (tessellation gaps,
  no guaranteed watertight bodies, no parametric history). Removed:
  `obj2glb.mjs`, `verify-orientation.mjs`, `convert_obj.py` (both trees), the
  OBJ/mtl branches in `server.js` (`/convert/mtl` staging endpoint, `x-mtl`
  header handling), the OBJ converter selector + hole-fill knob in the
  convert-cad web UI, and the CLI `--js`/`--mtl` flags. Supported inputs are
  now STEP / IGES / STL (+ GLB/GLTF passthrough).

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
real-time multi-user sessions. STEP/IGES/STL conversion is delegated to the
OpenCascade kernel through local OCP 7.9.3 when available, with the
`chair-cq:local` Docker image as the fallback; the result is served to all
members of a session.

```
Browser (Three.js)  ──HTTP──►  Node server (src/server.js)
      │  ▲                         │
      │  └── WebSocket (ws) ───────┤  session relay (camera/parts/move/...)
      │                            │
      │                ┌───────────┴───────────┐
      │                │  POST /convert/*      │
      │                │  local OCP or Docker  │
      │                ▼                       ▼
      │          OpenCascade (OCCT)      other guests (browsers)
```

## 2. Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | **Node.js** (ESM, `"type":"module"`) | `src/server.js`, `src/main.js` |
| 3D | **Three.js** `^0.185.1` + `OrbitControls`, `GLTFLoader` | ESM via import map |
| WebSocket | **ws** `^8.21.3` | Session relay |
| CAD kernel | **OpenCascade (OCCT) 7.9.3** via native OCP or Docker | `CAD_PYTHON` or `chair-cq:local` |
| Native Python | **cadquery-ocp 7.9.3.1.1** | `CAD_PYTHON` / optional portable `python/` |
| Docker | `docker run --rm` per conversion when selected/fallback | Container from `Dockerfile` |
| Tests / verify | headless Chrome CDP | in-repo `_*.cjs` probes |

## 2.1 Software component versions

> Record the exact versions in use at this release so upgrades are tracked and
> reproducible. Update when a dependency is bumped.

| Component | Version | Where pinned |
|---|---|---|
| Node.js (runtime) | **22.23.2** | dev machine / `node.exe` bundled in the zip |
| Three.js | **0.185.1** | `package.json` (`^0.185.1`) |
| ws | **8.21.3** | `package.json` (`^8.21.3`) |
| OpenCascade (OCCT) | **7.9.x** (OCP core **7.9.3.1**) | native `CAD_PYTHON` or `chair-cq:local` |
| pythonocc-core (OCP) | **7.9.3.1** | native `CAD_PYTHON` or Docker image |
| CadQuery | **2.8.0** | `chair-cq:local` image (`pip install cadquery`) |
| Python (in container) | **3.11.16** | `Dockerfile` (`python:3.11-slim`) |
| Docker | any modern Docker Desktop / engine | fallback when native OCP is unavailable |
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
cad-converter/       Standalone CAD Converter project (separate package)
```

## 4. Conversion method (STEP / IGES / STL → GLB)

- Server receives an upload and writes it to a temp dir.
- In `auto` mode, preflights `CAD_PYTHON` (or `python`) with `import OCP` and
  prefers native execution; otherwise it runs **`docker run --rm`** with the
  file mounted as `/w/model<ext>`.
- Invokes `/converters/step2glb.py`, which uses **OpenCascade's
  `RWGltf_CafWriter`** to write `model.glb`. The GLB is binary (not text glTF).
- Preserves **assembly part names** (via XCAF) and **per-part colours**.
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
| `move` | all | `path, pos` | legacy part move sync |
| `rot` | all | `path, quat` | legacy part rotation sync |
| `transform` | all | `path, pos, quat, pivot` | atomic move/rotate/pivot sync and Undo/Redo |
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
  the part along that axis in a camera-facing plane. Move, rotate, and custom
  pivot drags are recorded in a unified history (cap 200) with Undo, Redo, and
  Reset.
- **Custom pivot:** a crosshair handle moves the world-space rotation centre;
  rotation around the offset pivot stores and synchronizes position, quaternion,
  and pivot atomically.
- **Stale history protection:** an Undo/Redo command is applied only when the
  selected part still matches the command's expected state.
- **Part keys** are **paths** (child indices from the scene root), stable across
  every client that loads the same GLB — names can be empty/duplicated, so the
  path is used for sync.

## 7. Build & release process

1. Bump the version label in `src/index.html` (and manual footer).
2. Optionally set `CAD_NATIVE_PYTHON` to bundle local OCP 7.9.3, then run
   `node build-portable.mjs vX.Y --keep` — checks out the tag into a git
   worktree, assembles `dist/cad-viewer-portable` (bundled `node.exe`, slimmed
   three.js/ws, converters, optional `python/`, `doc/`), and zips to
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

## [v0.75] — 2026-08-20

> **Baseline:** v0.74 (tag `v0.74`). Release on top of the current working tree.

### Fixed

- **Explode slider now actually moves the assembly.** Dragging the slider had no
  visible effect because the displacement was always computed as zero: two
  `worldToLocal` results were written into the *same* temp vector, so
  `b.sub(a)` cancelled out to `(0,0,0)`. The offset math (which produced up to
  ~9.5 m of expected spread) was correct but never applied. Now uses two
  distinct temp vectors, so parts separate along the chosen axis, the
  separation scales smoothly with the slider, and `gap=0` restores every part
  exactly to its resting position (fully reversible).

## [v0.74] — 2026-08-20

> **Baseline:** v0.73 (tag `v0.73`). Release on top of the current working tree.

### Fixed

- **Smooth explode during slider drag — no more bouncing back.** A pure mm-gap
  change now applies directly (smooth delta from the resting layout) instead of
  collapsing to 0 and re-applying. This removes the visible snap-back that
  happened when a receiving viewer handled a synced gap change.

### Changed

- **Removed the `Radial` explode direction.** It had no effect in mm-gap mode
  (which is axis-based); the direction list is now **X / Y / Z** only.
- **Added an Explode **Reset** button.** It collapses the explode (gap → 0) and
  frames the model to fit the viewport — one click returns to the full view.

### Fixed (sync)

- **Session sync no longer causes a collapse-bounce on the receiving viewer.** A
  remote mm-gap change is applied directly (smooth); only a change of explode
  direction or scope triggers the recompute (collapse + recache) path.

---

## [v0.73] — 2026-08-20

### Changed

- **Explode simplified to a single mm-gap control driven by the slider.** The
  `%` (percentage) mode and the **Sep** mode dropdown are removed — the explode
  now uses one separation control: a **0–500 mm slider** that sets the clear
  space between adjacent bounding boxes along the chosen axis. The value label
  reads e.g. "120 mm". (This replaces the two-mode %-slider + mm-gap-number-input
  design.)
- Direction list is now **X / Y / Z / Radial** (Radial auto-switches to X, since
  mm gap is axis-based). Selection-driven scope, scope readout, hidden-part
  skipping, and non-destructive collapse are unchanged.

### Technical

- `src/index.html`: removed the `explode-mode` selector and `explode-gap` number
  input; the slider is now 0–500 and drives the gap.
- `src/main.js`: removed `explodeAmount`, `explodeScale`, `explodeMode`,
  `applyExplodeAmount`, `recomputeExplode`, `setExplodeGapUi`, `showExplodeModeUi`
  and their wiring. The slider's `input` handler now calls `applyExplodeGap`.
  `explodeSet(gap, dir)` is the debug hook.
- `src/server.js`: the `explode` message is now `{ gap, dir, scopeKey }` (no
  amount/mode); store/replay updated accordingly.

## [v0.72] — 2026-08-20

> **Baseline:** v0.71 (tag `v0.71`). Release on top of the current working tree.

### Fixed

- **Selecting a nested sub-assembly now correctly re-scopes the explode.** In a
  multi-level assembly (a sub-assembly that itself contains sub-assemblies),
  clicking a sub-assembly's name didn't switch the explode scope to its
  children — it stayed on the top level. Two causes, both fixed in `src/main.js`:
  - `explodeScopeNode()` checked `partRows.get(key).hasKids`, but `partRows`
    values are `{ cb, row }` and don't carry `hasKids` (that flag lives on
    `allPartRows`). It now looks up the row's `hasKids` in `allPartRows`.
  - The same bug was in the `selectPart()` re-scope hook.
- **Explode no longer treats light/helper nodes as parts.** GLB files exported
  with lights (`light_0`, `light_1`, …) would include them as named scene
  children, and the scope resolver counted them as explode targets. Explode
  targets and the "pure wrapper" descend now require the child to contain mesh
  geometry (`nodeHasMeshes`), so lights/helpers are excluded.

### Added

- `cad-samples/NestedAssembly.glb` — a small 3-level nested assembly (Frame /
  Gearbox / Motor, each with 3 parts) added for testing the drill-down explode
  (top level → select a sub-assembly → explode its children → repeat).

### Technical

- `src/main.js`: `explodeScopeNode()` now reads `hasKids` from `allPartRows`
  (not `partRows`), and both the scope resolver and the descend logic filter
  children by `nodeHasMeshes()` so lights are skipped. Debug hooks
  (`partRowInfo`, `explodeDiag`) added for headless verification.

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


