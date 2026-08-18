# convert-cad — standalone STEP / IGES / OBJ → GLB / GLTF converter

**Version: v0.1** — a standalone tool, independent of the CAD Viewer web app.

A small, self-contained tool that converts one CAD file into a glTF asset
(either a binary **`.glb`** or a text **`.gltf`** + sibling `.bin`), ready for
Three.js / Babylon / any glTF viewer.

It runs the OpenCascade kernel inside the existing **`chair-cq:local`** Docker
image (the same one the CAD Viewer web app uses), because OCP has no Windows
wheels. It is **independent** of the web app — it does not import the
`chair-3d-web/converters` modules, so it can never disturb a finished converter.

## What it converts

| Input | Notes |
|---|---|
| `.step`, `.stp` | B-rep; keeps assembly part names + per-part colours |
| `.igs`, `.iges` | B-rep; keeps colours; parts named `Part1..N` (IGES usually has no names) |
| `.obj` | Mesh; part names from `o`/`g` lines; colours from a sibling `.mtl` |

Output format is chosen by the **output file extension**: `.glb` → single
binary file; `.gltf` → text JSON + a companion `.bin`.

## Requirements

- **Docker Desktop** running.
- The **`chair-cq:local`** image built (from the cad-viewer-web `Dockerfile`):
  ```
  docker build -t chair-cq:local .
  ```
  or run `install-docker-opencascade.bat` once.
- **Node.js** on PATH (for the launcher).

## Usage

### Web UI (drag & drop) — recommended

```bash
node convert-cad-server.mjs          # or double-click convert-cad-web.bat
# open http://localhost:8787
```

Drag a STEP/IGES/OBJ onto the page (drop an OBJ together with its `.mtl` in
one drag for colours), pick **.glb** or **.gltf**, hit **Convert**, then
**Download**. After converting you get a live **3D preview** of the model —
drag to rotate, scroll to zoom, right-drag / two-finger to pan. Options:
`--port <n>` and `--host <ip>`.

### Command line

```
node convert-cad.mjs <input.(step|stp|igs|iges|obj)> [out.glb|out.gltf] [opts]
```

Windows shortcut (same options):

```
convert-cad.bat <input> [out.glb|out.gltf] [opts]
```

### Options

| Option | Meaning |
|---|---|
| `-o, --out <path>` | Output path (default: `<input dir>/<stem>.glb`) |
| `--mtl <path>` | OBJ companion `.mtl` (auto-found next to the `.obj` if omitted) |
| `--container <img>` | Docker image (default `chair-cq:local`) |
| `--keep` | Keep the temp work dir on failure (debugging) |

### Examples

```bash
# STEP -> binary GLB
node convert-cad.mjs Asm1.stp out.glb

# IGES -> text GLTF (writes out.gltf + out.bin)
node convert-cad.mjs Asm1.igs out.gltf

# OBJ -> GLB, colours from a companion .mtl
node convert-cad.mjs Asm1.obj out.glb --mtl asm1.mtl

# OBJ -> GLTF, output to another folder
node convert-cad.bat part.obj -o C:/exports/part.gltf --mtl part.mtl
```

## What it does

1. **Pre-flights** — checks Docker is up and `chair-cq:local` exists.
2. **Stages** the input into a temp dir as `model.<ext>` (plus `model.mtl` for
   OBJ).
3. **Runs** `convert-cad.py` inside the container (mounted read-only) against
   the staged file.
4. **Post-processes** — renames part nodes to clean `Part1..N` (only junk
   source names, so STEP's real names survive) and names the root after the
   input stem.
5. **Verifies** the output (triangles present, indices in range) — exits non-zero
   on failure, so a corrupt GLB/GLTF is never written.
6. **Copies** the output (and `.bin`) back and cleans up.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (prints `RESULT_OK`) |
| 1 | Conversion / verification / docker failure |
| 2 | Usage error / unsupported extension |

## Files

- `convert-cad.py` — the actual converter (runs inside the container)
- `convert-cad.mjs` — Node host launcher (stages + runs Docker + copies back)
- `convert-cad.bat` — Windows shortcut for the launcher
- `convert-cad-server.mjs` — Node HTTP server for the drag & drop web UI
- `index.html` — the drag & drop page (upload → Convert → Download → 3D preview)
- `convert-cad-web.bat` — Windows shortcut to launch the web UI
- `build-convert-cad-portable.mjs` — build the portable zip (`dist/convert-cad-portable-v0.1.zip`)

## Portable zip

```bash
node build-convert-cad-portable.mjs 0.1     # -> dist/convert-cad-portable-v0.1.zip
```

Bundles `node.exe`, the slimmed three.js modules, the CLI launcher, and the
web UI. Unzip → double-click `start.bat` → the UI opens with a 3D preview.
Independent of the CAD Viewer web app. Docker + the `chair-cq:local` image are
still required at runtime for conversion (not bundled).

## Testing

Sample files live in `cad-samples/` at the repo root (`Asm1.stp`, `Asm1.igs`,
`Asm1.obj` + `asm1.mtl`, `cube.obj`, `abc-00000050.step`). Verified on those:
STEP 904 tris / IGES 1096 tris / OBJ 5142 tris, with colours and part names
preserved in both GLB and GLTF output.
