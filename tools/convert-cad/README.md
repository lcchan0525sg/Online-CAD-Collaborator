# convert-cad — standalone STEP / IGES / STL → GLB / GLTF converter

**Version: v0.26** — native-only standalone tool, independent of the CAD Viewer web app.

A small, self-contained tool that converts one CAD file into a glTF asset
(either a binary **`.glb`** or a text **`.gltf`** + sibling `.bin`), ready for
Three.js / Babylon / any glTF viewer.

It runs the OpenCascade kernel through a native Windows Python environment
containing the tested `cadquery-ocp` 7.9.3.1.1 wheel. It is **independent** of
the web app — it does
not import the `chair-3d-web/converters` modules, so it can never disturb a
finished converter.

## What it converts

| Input | Notes |
|---|---|
| `.step`, `.stp` | B-rep; keeps assembly part names + per-part colours |
| `.igs`, `.iges` | B-rep; keeps colours; parts named `Part1..N` (IGES usually has no names) |
| `.stl` | Mesh (already triangulated); converted **host-side** by `stl2glb.mjs` (pure JS) as a single welded primitive — typically *smaller* than the source. The OCCT/B-rep path is avoided because it blows STL up ~10x (one glTF primitive per facet). |

> OBJ is intentionally **not** supported: it is a mesh-only format without B-rep
> semantics, so it cannot represent CAD assemblies/collaboration faithfully.

## STL is pure JS

`.stl` does **not** go through the OCCT converter. `stl2glb.mjs` parses
ASCII/binary STL and writes a single-primitive GLB (welded vertices + computed
normals + fallback colour) directly in Node — fast, tiny output, no container.
Wired in both the web server (`convert-cad-server.mjs`) and CLI
(`convert-cad.mjs`); the OCCT `convert_stl.py` remains only as a fallback if
the Python dispatcher is ever invoked directly on an STL.

## Modular structure (migrates to the CAD Viewer)

The conversion logic lives in **`converters/`** — a flat folder of per-format
modules (`step2glb.py` dispatcher + `convert_*.py` + `common.py`) that is laid
out **exactly** like what the CAD Viewer's `server.js` mounts at `/converters`.
`convert-cad.py` is now just a thin wrapper over it. So migrating to the main
app is: copy `converters/` into the app, point `CQ_DIR` at it, and add the
extension to the server's `CONVERT_EXT` map. Adding a format = one
`convert_<fmt>.py` module + one `FORMATS` entry in `step2glb.py`.

Output format is chosen by the **output file extension**: `.glb` → single
binary file; `.gltf` → text JSON + a companion `.bin`.

## Requirements

- **Python with OCP** installed. The tested environment uses
  `cadquery-ocp 7.9.3.1.1`.
- Set `CAD_PYTHON` to the native Python executable, or pass `--python`.
- **Node.js** on PATH (for the launcher).

## Usage

### Web UI (drag & drop) — recommended

```bash
node convert-cad-server.mjs          # or double-click convert-cad-web.bat
# open http://localhost:8787
```

Drag a STEP/IGES/STL onto the page, pick **.glb** or **.gltf**, choose the
appearance and mesh quality controls, hit **Convert**, then **Download**. After
converting you get a live **3D preview** of the model — drag to rotate, scroll
to zoom, right-drag / two-finger to pan. Options: `--port <n>` and `--host <ip>`.

### Large-model quality controls

The Web UI defaults to **Large assembly (recommended)** because the CAD Viewer
is intended to receive a prepared GLB for large models. These controls affect
the generated mesh before it reaches the viewer:

| Control | Effect |
|---|---|
| **Optimize mesh** | On uses the selected OpenCascade mesh settings; off uses faithful `0.20` deflection / `0.50` angular settings. |
| **Large assembly** | `1.00` deflection / `1.00` angular; fewer triangles and faster browser interaction, with less small-feature detail. |
| **Viewer balanced** | `0.50` / `0.70`; middle ground between detail and performance. |
| **CAD faithful** | `0.20` / `0.50`; more detail, larger output and heavier viewer load. |
| **Fast preview** | `2.00` / `1.50`; fastest/lightest preview, but small features may disappear. |
| **Deflection** | Chordal error in model units. Lower values preserve more geometric detail and increase triangles. |
| **Angular** | Angular meshing tolerance in radians. Lower values preserve more curved-surface detail and increase triangles. |
| **Draco** | Compresses GLB geometry bytes and reduces transfer/memory size. It does not reduce mesh/primitive draw-call count. |
| **Draco level** | Higher levels generally reduce size further but take longer to encode. Range `0–10`, default `7`. |
| **Colors only** | Removes GLB texture maps and UV attributes while keeping basic material/part colors. Recommended for large assemblies. |
| **Preserve textures** | Keeps texture maps in existing GLB/GLTF inputs. |

The quality profile and tuning values apply to STEP/IGES OpenCascade meshing.
STL already uses the direct welded single-primitive writer; Draco still applies
to STL GLB output. **Colors only** is applied to GLB output after conversion;
for STEP/IGES/STL it is normally already the natural output because those paths
use basic colors rather than texture maps. It is also useful for existing GLB
passthrough files and future JT conversion output.

### Command line

```
node convert-cad.mjs <input.(step|stp|igs|iges|stl)> [out.glb|out.gltf] [opts]
```

Windows shortcut (same options):

```
convert-cad.bat <input> [out.glb|out.gltf] [opts]
```

### Options

| Option | Meaning |
|---|---|
| `-o, --out <path>` | Output path (default: `<input dir>/<stem>.glb`) |
| `--python <path>` | Native Python executable; defaults to `CAD_PYTHON` or `python` |
| `--profile <name>` | `faithful`, `balanced`, `large` (default), `preview`, or `custom` |
| `--optimize` / `--no-optimize` | Enable/disable selected OpenCascade mesh tuning |
| `--deflection <value>` | Override chordal deflection, clamped to `0.01–10` |
| `--angular <value>` | Override angular tolerance, clamped to `0.05–5` |
| `--appearance preserve|colors` | Keep textures or strip GLB textures/UVs and use basic colors; default `preserve` |
| `--compress draco` | Compress GLB geometry after conversion |
| `--level <0–10>` | Draco encoding level, default `7` |
| `--keep` | Keep the temp work dir on failure (debugging) |

### Examples

```bash
# STEP -> binary GLB
node convert-cad.mjs Asm1.stp out.glb

# IGES -> text GLTF (writes out.gltf + out.bin)
node convert-cad.mjs Asm1.igs out.gltf

# STL -> binary GLB (host-side JS writer)
node convert-cad.mjs Eiffel_tower_sample.STL out.glb

# STEP -> GLB using native Windows OCP (7.9.3.1.1)
set CAD_PYTHON=C:\Users\you\venvs\cad-native\Scripts\python.exe
node convert-cad.mjs Asm1.step out.glb
```

Native conversion requires a Python executable where `import OCP` succeeds.

## What it does

1. **Pre-flights** — checks the selected native Python can import `OCP`.
2. **Stages** the input into a temp dir as `model.<ext>`.
3. **Runs** `convert-cad.py` with the native Python environment against the
   staged file.
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
| 1 | Conversion / verification / native runtime failure |
| 2 | Usage error / unsupported extension |

## Files

- `convert-cad.py` — the actual converter (runs with native OCP)
- `convert-cad.mjs` — Node host launcher (stages + runs native Python + copies back)
- `convert-cad.bat` — Windows shortcut for the launcher
- `convert-cad-server.mjs` — Node HTTP server for the drag & drop web UI
- `index.html` — the drag & drop page (upload → Convert → Download → 3D preview)
- `convert-cad-web.bat` — Windows shortcut to launch the web UI
- `build-convert-cad-portable.mjs` — build the native-only portable zip

## Portable zip

```bash
set CAD_NATIVE_PYTHON=C:\Users\you\venvs\cad-native\Scripts\python.exe
node build-convert-cad-portable.mjs v0.25   # -> dist/convert-cad-portable-v0.25.zip
```

Bundles `node.exe`, the slimmed three.js modules, the CLI launcher, the web UI,
and the complete native Python/OCP runtime. Unzip → double-click `start.bat` →
the UI opens with a 3D preview. No Docker or external CAD runtime is required.

## Testing

Sample files live in `cad-samples/` at the repo root (`Asm1.stp`, `Asm1.igs`,
`abc-00000050.step`, `Eiffel_tower_sample.STL`). Verified on those:
STEP 904 tris / IGES 1096 tris, with colours and part names
preserved in both GLB and GLTF output.
