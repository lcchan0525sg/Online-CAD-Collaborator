# Online CAD Collaborator

A browser-based, real-time collaborative viewer for CAD geometry. Load GLB/GLTF directly or convert STEP, IGES, and STL to GLB with a native OpenCascade/OCP backend; then share the same interactive 3D session with other browsers on your network.

## Features

- Portable Windows ZIP: download, extract, and run `start.bat` to start the application.
- Load GLB and GLTF models with assembly hierarchy, part names, materials, and colours.
- Convert STEP (`.step`, `.stp`), IGES (`.igs`, `.iges`), and STL (`.stl`) to GLB.
- Inspect assemblies: select, hide, isolate, make transparent, move, rotate, and explode parts.
- Measure corner-to-corner distances and use a section-cut view.
- Host collaborative sessions with synchronized camera, selection, transforms, visibility, measurements, section state, lighting, animation, and chat.
- Create session records with captures and reports.
- Use English by default; optional reviewed Chinese language packs are supported externally.

![Online CAD Collaborator assembly view](doc/manual-shots/17-hero.png)

## Quick start: portable Windows ZIP

1. [Download the portable ZIP (v1.047)](https://github.com/lcchan0525sg/Online-CAD-Collaborator/releases/download/v1.047/cad-viewer-portable-v1.047.zip), or visit [Releases](https://github.com/lcchan0525sg/Online-CAD-Collaborator/releases) for available versions.
2. Extract the ZIP to a folder on your computer.
3. Open the extracted folder and double-click `start.bat` to start the application.
4. Open [http://localhost:8088/](http://localhost:8088/) in your browser if it does not open automatically.

The portable ZIP includes the runtime and dependencies, so you do not need to install Node.js or npm separately. Keep the application running while using it in your browser.

## Requirements for running from source

- Node.js 20 or newer
- npm
- For STEP/IGES/STL conversion: a Python environment with `cadquery-ocp` / OpenCascade (OCP) 7.9.3 available

GLB and GLTF viewing do not require the native CAD converter.

## Run from source

```bash
npm ci
```

Set `CAD_PYTHON` to the Python executable that can run `import OCP`, then start the server:

```bash
CAD_PYTHON=/path/to/python npm start
```

On Windows, use `set CAD_PYTHON=C:\\path\\to\\python.exe` before `npm start`, or run `start.bat`. It detects a bundled `python\\python.exe` or `%USERPROFILE%\\venvs\\cad-native\\Scripts\\python.exe`. The application is served at `http://localhost:8088/` by default. Set `PORT` or create a local `port.txt` file to use another port.

## Verify the checkout

```bash
npm run check:syntax
npm run validate-language -- path/to/language-pack-directory
```

`npm run check-layout` runs browser layout checks against a running local server. It requires a valid optional language pack and Chrome at the configured path.

## Portable Windows build

The portable build bundles the viewer, a slim Node runtime, dependencies, documentation, notices, and—when configured—the native Python/OCP runtime.

```bash
CAD_NATIVE_PYTHON=/path/to/python \
CAD_LANGUAGE_SOURCE=/path/to/reviewed-languages \
CAD_ALLOW_UNREVIEWED_LANGUAGES=1 \
node build-portable.mjs v1.047 --keep
```

See `doc/USER-MANUAL.md` for user instructions and `doc/TRANSLATION-WORKFLOW.md` for language-pack validation and packaging.

## Project layout

- `src/` — browser client, HTTP/WebSocket server, and CAD conversion modules
- `tools/` — development validation tools
- `doc/` — user manual, screenshots, architecture, and technical reference
- `licenses/` and `THIRD-PARTY-NOTICES.txt` — third-party notices and license texts
- `build-portable.mjs` — Windows portable ZIP build

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Report security-sensitive issues using [SECURITY.md](SECURITY.md), not public issues.

## License

The source is available under the [MIT License](LICENSE). Third-party component notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
