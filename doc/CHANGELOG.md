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

# Technical reference (v0.55)

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

## [Unreleased]

Add new versions here (newest at the top). Example:

```markdown
## [v0.56] — YYYY-MM-DD

### Added
- ...

### Fixed
- ...

### Technical
- (note any protocol/architecture/build changes here)
```

