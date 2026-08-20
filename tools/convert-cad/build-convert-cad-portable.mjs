#!/usr/bin/env node
// build-convert-cad-portable.mjs — package the standalone convert-cad tool as a
// portable Windows zip: bundled node.exe + slim three.js (for the 3D preview) +
// the CLI launcher, the drag & drop web server + UI, the converter script, and
// start.bat / start.sh.
//
// This tool is INDEPENDENT of the CAD Viewer web app — it lives in tools/convert-cad/
// and this build never touches src/ or the cad-viewer portable build.
//
// Usage:
//   node build-convert-cad-portable.mjs             build dist/convert-cad-portable.zip
//   node build-convert-cad-portable.mjs 0.1         build dist/convert-cad-portable-v0.1.zip
//
// The zip needs Docker + the chair-cq:local image at RUNTIME (documented, not bundled).
import { mkdirSync, copyFileSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TOOL = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOL, '..', '..');                 // repo root (for node_modules)
const DIST = join(ROOT, 'dist');
const APP = join(DIST, 'convert-cad-portable');
const NODE_EXE = process.env.NODE_EXE || 'C:\\Users\\chan_\\AppData\\Local\\hermes\\node\\node.exe';

const versionArg = (process.argv[2] || '').replace(/^v/i, '') || '0.1';
const zipName = `convert-cad-portable-v${versionArg}.zip`;

rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, 'node_modules', 'three', 'build'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders'), { recursive: true });
mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils'), { recursive: true });

// ---- tool files (into the zip root) ----
for (const f of ['convert-cad.py', 'convert-cad.mjs', 'convert-cad.bat',
                 'convert-cad-server.mjs', 'convert-cad-web.bat', 'index.html',
                 'draco-compress.mjs', 'stl2glb.mjs', 'README.md']) {
  copyFileSync(join(TOOL, f), join(APP, f));
}
// The modular per-format converters package (step2glb.py dispatcher +
// convert_*.py + common.py) must ship alongside the wrapper.
cpSync(join(TOOL, 'converters'), join(APP, 'converters'), { recursive: true });
// Stamp the version into the copied index.html title
const html = readFileSync(join(APP, 'index.html'), 'utf8')
  .replace(/(convert-cad — drag & drop\s*<span class="ver">)v[0-9][^<]*/, `$1v${versionArg}`);
writeFileSync(join(APP, 'index.html'), html);

// Docker dependency: image-builder batch + Dockerfile for the target machine
const installBat = join(ROOT, 'install-docker-opencascade.bat');
if (existsSync(installBat)) copyFileSync(installBat, join(APP, 'install-docker-opencascade.bat'));
const dockerFile = join(ROOT, 'Dockerfile');
if (existsSync(dockerFile)) copyFileSync(dockerFile, join(APP, 'Dockerfile'));

// ---- slim three.js (only what the preview imports) ----
const T = join(ROOT, 'node_modules', 'three');
copyFileSync(join(T, 'package.json'), join(APP, 'node_modules', 'three', 'package.json'));
copyFileSync(join(T, 'build', 'three.module.js'), join(APP, 'node_modules', 'three', 'build', 'three.module.js'));
copyFileSync(join(T, 'build', 'three.core.js'),  join(APP, 'node_modules', 'three', 'build', 'three.core.js'));
copyFileSync(join(T, 'examples', 'jsm', 'controls', 'OrbitControls.js'),         join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js'));
copyFileSync(join(T, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),             join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'));
copyFileSync(join(T, 'examples', 'jsm', 'loaders', 'DRACOLoader.js'),            join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'DRACOLoader.js'));
copyFileSync(join(T, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'),      join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'));
copyFileSync(join(T, 'examples', 'jsm', 'utils', 'SkeletonUtils.js'),            join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'SkeletonUtils.js'));

// ---- draco3d (host-side compressor) + Draco decoder libs (for the preview) ----
const D3 = join(ROOT, 'node_modules', 'draco3d');
if (existsSync(D3)) {
  cpSync(D3, join(APP, 'node_modules', 'draco3d'), { recursive: true });
}
const DRACO_LIBS = join(T, 'examples', 'jsm', 'libs', 'draco');
if (existsSync(DRACO_LIBS)) {
  cpSync(DRACO_LIBS, join(APP, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco'), { recursive: true });
}

// ---- bundled node.exe (portable runtime) ----
if (existsSync(NODE_EXE)) copyFileSync(NODE_EXE, join(APP, 'node.exe'));
else console.warn('WARNING: node.exe not found at', NODE_EXE, '- zip will not be self-contained');

// ---- launchers (web UI is the primary surface) ----
writeFileSync(join(APP, 'start.bat'), [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  '',
  'set "PORT=8787"',
  'if not "%~1"=="" set "PORT=%~1"',
  'if exist "port.txt" set /p PORT=<port.txt',
  '',
  'echo Starting convert-cad web UI on port %PORT% ...',
  'start "" http://localhost:%PORT%/',
  'set PORT=%PORT%',
  'node.exe convert-cad-server.mjs --port %PORT%',
  'pause',
  '',
].join('\r\n'));

writeFileSync(join(APP, 'start.sh'), [
  '#!/bin/sh',
  'cd "$(dirname "$0")"',
  'PORT="${1:-8787}"',
  '[ -f port.txt ] && PORT=$(head -1 port.txt)',
  'echo "Starting convert-cad web UI on port $PORT ..."',
  '(xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 || open "http://localhost:$PORT/" >/dev/null 2>&1) &',
  'exec env PORT="$PORT" node convert-cad-server.mjs --port "$PORT"',
  '',
].join('\n'));

// ---- README.txt ----
writeFileSync(join(APP, 'README.txt'), [
  'convert-cad — portable edition',
  '================================',
  `Version: v${versionArg}`,
  '',
  'A standalone tool that converts STEP / IGES / STL CAD files into GLB or GLTF',
  '(glTF) assets, with a drag & drop web UI and a live 3D preview.',
  '',
  'Run it:',
  '  Windows: double-click start.bat  (or: start.bat [port])',
  '  macOS/Linux with node: ./start.sh [port]',
  '',
  'Then open http://localhost:8787/  (the launcher opens it for you).',
  'Drop a .step/.stp/.igs/.iges/.stl file,',
  'pick GLB or GLTF, hit Convert, then Download. After converting you get a live',
  '3D preview — drag to rotate, scroll to zoom, right-drag / two-finger to pan.',
  'Set Compress = Draco to shrink the GLB geometry (browser decodes it on load);',
  'it applies to converted GLB output and to passthrough .glb files.',
  '',
  'The zip bundles node.exe, so NO installs are needed on Windows.',
  '',
  'Command line (same conversion engine):',
  '  convert-cad.bat <input.(step|stp|igs|iges|stl)> [out.glb|out.gltf] [opts]',
  '  --compress draco   compress the GLB geometry (host-side, self-contained)',
  '  See README.md for full options.',
  '',
  'NOTE: conversion requires TWO external pieces that are NOT bundled:',
  '  1. Docker Desktop (or another Docker runtime) installed on this PC, and',
  '  2. the OpenCascade CAD converter image "chair-cq:local".',
  '  Build the image once with install-docker-opencascade.bat (or:',
  '  docker build -t chair-cq:local .  using the bundled Dockerfile).',
  '  Without Docker, the UI loads but conversions show an error.',
  '',
  'Port: 8787. Override with start.bat <port> or a port.txt file.',
  '',
  'This tool is independent of the CAD Viewer web app.',
  '',
].join('\r\n'));

// ---- zip ----
console.log('assembled', APP);
const zipOut = join(DIST, zipName);
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${APP}' -DestinationPath '${zipOut}' -CompressionLevel Optimal -Force`],
    { stdio: 'inherit' });
  console.log('zipped ->', zipOut);
} catch (e) {
  console.error('zip failed:', e.message);
  process.exit(1);
}
