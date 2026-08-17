// Build a portable zip of the CAD viewer: bundled node.exe + slimmed node_modules
// (only the three.js files the app imports) + server + client + STEP converter +
// start.bat / start.sh + README. Output: dist/cad-viewer-portable.zip
import { mkdirSync, copyFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const APP = join(DIST, 'cad-viewer-portable');
const NODE_EXE = process.env.NODE_EXE || 'C:\\Users\\chan_\\AppData\\Local\\hermes\\node\\node.exe';

// ---- clean + scaffold ----
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(APP, 'node_modules', 'three', 'build'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'ws'), { recursive: true });

// ---- app files ----
for (const f of ['server.js', 'main.js', 'index.html', 'style.css', 'package.json', 'package-lock.json']) {
  copyFileSync(join(ROOT, f), join(APP, f));
}
// STEP converter (needs Docker + chair-cq:local image on the target machine)
const stepSrc = process.env.CQ_SCRIPT || 'C:\\Users\\chan_\\Projects\\chair-3d-web\\step2glb.py';
if (existsSync(stepSrc)) copyFileSync(stepSrc, join(APP, 'step2glb.py'));
// One-click Docker + OpenCascade installer, and the Dockerfile it builds from
const installBat = join(ROOT, 'install-docker-opencascade.bat');
if (existsSync(installBat)) copyFileSync(installBat, join(APP, 'install-docker-opencascade.bat'));
const dockerFile = join(ROOT, 'Dockerfile');
if (existsSync(dockerFile)) copyFileSync(dockerFile, join(APP, 'Dockerfile'));
// User manual (PDF + MD + screenshots referenced by the MD)
if (existsSync(join(ROOT, 'USER-MANUAL.pdf'))) copyFileSync(join(ROOT, 'USER-MANUAL.pdf'), join(APP, 'USER-MANUAL.pdf'));
if (existsSync(join(ROOT, 'USER-MANUAL.md'))) copyFileSync(join(ROOT, 'USER-MANUAL.md'), join(APP, 'USER-MANUAL.md'));
if (existsSync(join(ROOT, 'manual-shots'))) {
  cpSync(join(ROOT, 'manual-shots'), join(APP, 'manual-shots'), { recursive: true });
}

// ---- slim three (only what main.js imports) ----
const T = join(ROOT, 'node_modules', 'three');
copyFileSync(join(T, 'package.json'), join(APP, 'node_modules', 'three', 'package.json'));
copyFileSync(join(T, 'build', 'three.module.js'), join(APP, 'node_modules', 'three', 'build', 'three.module.js'));
// three.module.js re-exports from three.core.js — required, or the import fails.
copyFileSync(join(T, 'build', 'three.core.js'), join(APP, 'node_modules', 'three', 'build', 'three.core.js'));
copyFileSync(join(T, 'examples', 'jsm', 'controls', 'OrbitControls.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js'));
copyFileSync(join(T, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'));
copyFileSync(join(T, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'));
copyFileSync(join(T, 'examples', 'jsm', 'utils', 'SkeletonUtils.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'SkeletonUtils.js'));

// ---- ws (no deps) ----
const W = join(ROOT, 'node_modules', 'ws');
for (const f of ['package.json', 'index.js', 'wrapper.mjs']) {
  if (existsSync(join(W, f))) copyFileSync(join(W, f), join(APP, 'node_modules', 'ws', f));
}
cpSync(join(W, 'lib'), join(APP, 'node_modules', 'ws', 'lib'), { recursive: true });
// ws optionally uses these if present in node_modules
for (const extra of ['bufferutil', 'utf-8-validate']) {
  if (existsSync(join(ROOT, 'node_modules', extra))) {
    cpSync(join(ROOT, 'node_modules', extra), join(APP, 'node_modules', extra), { recursive: true });
  }
}

// ---- bundled node.exe (portable runtime) ----
copyFileSync(NODE_EXE, join(APP, 'node.exe'));

// ---- launchers ----
// Port precedence: command-line arg -> port.txt file -> default 4322.
writeFileSync(join(APP, 'start.bat'), [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  '',
  'set "PORT=4322"',
  'if not "%~1"=="" set "PORT=%~1"',
  'if exist "port.txt" set /p PORT=<port.txt',
  '',
  'echo Starting CAD Viewer on port %PORT% ...',
  'start "" http://localhost:%PORT%/',
  'set PORT=%PORT%',
  'node.exe server.js',
  'pause',
  '',
].join('\r\n'));

writeFileSync(join(APP, 'start.sh'), [
  '#!/bin/sh',
  'cd "$(dirname "$0")"',
  'PORT="${1:-4322}"',
  '[ -f port.txt ] && PORT=$(head -1 port.txt)',
  'echo "Starting CAD Viewer on port $PORT ..."',
  '(xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 || open "http://localhost:$PORT/" >/dev/null 2>&1) &',
  'exec env PORT="$PORT" node server.js',
  '',
].join('\n'));

// Also allow a port override for the source checkout: server.js already reads
// process.env.PORT, and a local port.txt is honoured there too (see server.js).

// ---- README ----
writeFileSync(join(APP, 'README.txt'), [
  'CAD Viewer — portable edition',
  '==============================',
  '',
  'Run it:',
  '  Windows: double-click start.bat  (or: start.bat)',
  '  macOS/Linux with node: ./start.sh',
  '',
  'Then open http://localhost:4322/  (the launcher opens it for you).',
  '',
  'The zip bundles node.exe, so NO installs are needed on Windows.',
  '',
  'User manual:',
  '  Open USER-MANUAL.pdf (or USER-MANUAL.md) for full instructions with',
  '  screenshots — starting the app, opening models, sessions, part visibility.',
  '',
  'Sharing:',
  '  Host clicks "Create session", then shares a model. Other users on the same',
  '  LAN open the join link shown in the sidebar (http://<ip>:4322/?s=CODE) or',
  '  type the code into "Join". Camera + part show/hide stay in sync.',
  '',
  'STEP files:',
  '  NOTE: STEP conversion requires TWO external pieces that are NOT bundled:',
  '  1. Docker Desktop (or another Docker runtime) installed on this PC, and',
  '  2. the OpenCascade CAD converter image "chair-cq:local" (built from the',
  '     chair-3d-web repo, or provided as a separate image).',
  '  The server shell out to Docker and runs the converter inside it (step2glb.py).',
  '  Without Docker, GLB/GLTF files still work; STEP shows a conversion error.',
  '',
  'Port: 4322. Override with env PORT.',
  '',
].join('\r\n'));

// ---- zip ----
console.log('assembled', APP);
const zipOut = join(DIST, 'cad-viewer-portable.zip');
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${APP}' -DestinationPath '${zipOut}' -CompressionLevel Optimal -Force`],
    { stdio: 'inherit' });
  console.log('zipped ->', zipOut);
} catch (e) {
  console.error('zip failed:', e.message);
  process.exit(1);
}
