# CAD Viewer — Changelog

All notable changes to this project are recorded here, newest first.
Version numbers follow the format `v0.x`; the format is inspired by
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
semantic-ish versioning for the viewer tool.

- **Format:** `## [vX.Y] — YYYY-MM-DD` with `### Added`, `### Fixed`,
  `### Changed`, `### Removed` subsections as needed.
- **How to add:** append a new `## [vX.Y]` block at the top (under `[Unreleased]`
  if one exists). Update the tag in git: `git tag v0.x` and rebuild the portable
  zip when you cut a release.

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
- **Changelog** introduced (this file).

### License

OpenCascade (LGPL-2.1 + OCCT exception), pythonocc (LGPL-3.0), Three.js / ws
(MIT). Full texts in `THIRD-PARTY-NOTICES.txt` and `licenses/`.

---

## [Unreleased]

Add new versions here (newest at the top). Example:

```markdown
## [v0.56] — YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

