// Build a portable zip of the CAD viewer: bundled node.exe + slimmed node_modules
// (only the three.js files the app imports) + server + client + STEP converter +
// start.bat / start.sh + README + manual + licenses.
//
// Usage:
//   node build-portable.mjs                 build from the current working tree
//   node build-portable.mjs v0.21           build that tag/commit via git worktree
//   node build-portable.mjs v0.21 v0.2      ...and keep older zips (no dist wipe)
//
// Output: dist/cad-viewer-portable.zip, or dist/cad-viewer-portable-<version>.zip
// when a version is given. A versioned build NEVER touches the working tree.
import { mkdirSync, copyFileSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const APP = join(DIST, 'cad-viewer-portable');
const NODE_EXE = process.env.NODE_EXE || 'C:\\Users\\chan_\\AppData\\Local\\hermes\\node\\node.exe';
// Converter source: CQ_DIR env (a folder of per-format modules) -> legacy
// CQ_SCRIPT env (single step2glb.py) -> dev-machine default folder. The
// server resolves the same layout at runtime, so a folder and a legacy file
// both work end to end.
const convDirDefault = 'C:\\Users\\chan_\\Projects\\chair-3d-web\\converters';
const convFileDefault = 'C:\\Users\\chan_\\Projects\\chair-3d-web\\step2glb.py';
function resolveConvSrc() {
  if (process.env.CQ_DIR) return process.env.CQ_DIR;
  if (process.env.CQ_SCRIPT) return process.env.CQ_SCRIPT;
  return existsSync(convDirDefault) ? convDirDefault : convFileDefault;
}
const convSrc = resolveConvSrc();

const versionArg = process.argv[2] || '';
const keepOlder = process.argv.includes('--keep') || process.argv[3] === '--keep';

// resolve the version label: explicit arg, else nearest tag, else 'dev'
function resolveVersion() {
  if (versionArg) return versionArg.replace(/^v/i, '');   // normalize "V0.2" -> "0.2"
  try {
    const desc = execFileSync('git', ['describe', '--tags', '--always'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return desc.replace(/^v/i, '');
  } catch { return 'dev'; }
}

// ---- build from a given source root into dist/ ----
// Source layout: the web app lives in <src>/src (server.js, main.js, index.html,
// style.css); the portable zip is FLAT — app files are copied to the zip root
// alongside a generated start.bat/start.sh that runs node server.js there.
function buildFrom(src, version, zipName) {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(join(APP, 'node_modules', 'three', 'build'), { recursive: true });
  mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls'), { recursive: true });
  mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders'), { recursive: true });
  mkdirSync(join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils'), { recursive: true });
  mkdirSync(join(APP, 'node_modules', 'ws'), { recursive: true });

  // ---- app files (into the zip root) ----
  // Newer source trees keep the app in src/; older tags are flat. Handle both.
  const SRC = existsSync(join(src, 'src', 'server.js')) ? join(src, 'src') : src;
  for (const f of ['server.js', 'main.js', 'index.html', 'style.css']) {
    copyFileSync(join(SRC, f), join(APP, f));
  }
  // package files sit at the source root (node resolution for ws/three imports)
  for (const f of ['package.json', 'package-lock.json']) {
    copyFileSync(join(src, f), join(APP, f));
  }
  // Stamp the version into the About section of the copied index.html
  if (existsSync(join(APP, 'index.html'))) {
    const html = readFileSync(join(APP, 'index.html'), 'utf8')
      .replace(/<strong>CAD Viewer<\/strong>\s*v[0-9][^<\s-]*/, `<strong>CAD Viewer</strong> v${version}`);
    writeFileSync(join(APP, 'index.html'), html);
  }
  // CAD converter (needs Docker + chair-cq:local image on the target machine).
  // Prefer the per-format folder (converters/); fall back to a legacy single
  // step2glb.py. Either layout works at runtime (server resolves both).
  if (convSrc.toLowerCase().endsWith('.py')) {
    if (existsSync(convSrc)) copyFileSync(convSrc, join(APP, 'step2glb.py'));
  } else if (existsSync(join(convSrc, 'step2glb.py'))) {
    cpSync(convSrc, join(APP, 'converters'), { recursive: true });
  } else {
    console.warn('WARNING: no converter found at', convSrc, '- zip will not convert STEP/IGES/OBJ');
  }
  // One-click Docker + OpenCascade installer, and the Dockerfile it builds from
  const installBat = join(src, 'install-docker-opencascade.bat');
  if (existsSync(installBat)) copyFileSync(installBat, join(APP, 'install-docker-opencascade.bat'));
  const dockerFile = join(src, 'Dockerfile');
  if (existsSync(dockerFile)) copyFileSync(dockerFile, join(APP, 'Dockerfile'));
  // User manual (doc/: HTML + PDF + MD + screenshots). Served at /doc/ by
  // the server (repo root in dev, zip root here), so copy the whole folder.
  if (existsSync(join(src, 'doc'))) {
    cpSync(join(src, 'doc'), join(APP, 'doc'), { recursive: true });
  }
  // Third-party license notices (OCCT/OCP/CadQuery/three.js/ws licensing)
  if (existsSync(join(src, 'THIRD-PARTY-NOTICES.txt'))) {
    copyFileSync(join(src, 'THIRD-PARTY-NOTICES.txt'), join(APP, 'THIRD-PARTY-NOTICES.txt'));
  }
  // Full license texts (LGPL-2.1/3.0, Apache-2.0) — required by the LGPL
  if (existsSync(join(src, 'licenses'))) {
    cpSync(join(src, 'licenses'), join(APP, 'licenses'), { recursive: true });
  }

  // ---- slim three (only what main.js imports) — from the source root's node_modules ----
  const T = join(src, 'node_modules', 'three');
  copyFileSync(join(T, 'package.json'), join(APP, 'node_modules', 'three', 'package.json'));
  copyFileSync(join(T, 'build', 'three.module.js'), join(APP, 'node_modules', 'three', 'build', 'three.module.js'));
  // three.module.js re-exports from three.core.js — required, or the import fails.
  copyFileSync(join(T, 'build', 'three.core.js'), join(APP, 'node_modules', 'three', 'build', 'three.core.js'));
  copyFileSync(join(T, 'examples', 'jsm', 'controls', 'OrbitControls.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js'));
  copyFileSync(join(T, 'examples', 'jsm', 'loaders', 'GLTFLoader.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'));
  // Draco loader + decoder (for KHR_draco_mesh_compression GLBs) — DRACOLoader.js
  // plus the wasm/js decoder it fetches at runtime from the libs/draco/ dir.
  copyFileSync(join(T, 'examples', 'jsm', 'loaders', 'DRACOLoader.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'DRACOLoader.js'));
  const dracoSrc = join(T, 'examples', 'jsm', 'libs', 'draco');
  const dracoDst = join(APP, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco');
  mkdirSync(dracoDst, { recursive: true });
  for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) {
    copyFileSync(join(dracoSrc, f), join(dracoDst, f));
  }
  copyFileSync(join(T, 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'));
  copyFileSync(join(T, 'examples', 'jsm', 'utils', 'SkeletonUtils.js'), join(APP, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'SkeletonUtils.js'));

  // ---- ws (no deps) ----
  const W = join(src, 'node_modules', 'ws');
  for (const f of ['package.json', 'index.js', 'wrapper.mjs']) {
    if (existsSync(join(W, f))) copyFileSync(join(W, f), join(APP, 'node_modules', 'ws', f));
  }
  cpSync(join(W, 'lib'), join(APP, 'node_modules', 'ws', 'lib'), { recursive: true });
  // ws optionally uses these if present in node_modules
  for (const extra of ['bufferutil', 'utf-8-validate']) {
    if (existsSync(join(src, 'node_modules', extra))) {
      cpSync(join(src, 'node_modules', extra), join(APP, 'node_modules', extra), { recursive: true });
    }
  }

  // ---- bundled node.exe (portable runtime) ----
  if (existsSync(NODE_EXE)) copyFileSync(NODE_EXE, join(APP, 'node.exe'));
  else console.warn('WARNING: node.exe not found at', NODE_EXE, '- zip will not be self-contained');

  // ---- launchers ----
  // Port precedence: command-line arg -> port.txt file -> default 8088.
  writeFileSync(join(APP, 'start.bat'), [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    '',
    'set "PORT=8088"',
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
    'PORT="${1:-8088}"',
    '[ -f port.txt ] && PORT=$(head -1 port.txt)',
    'echo "Starting CAD Viewer on port $PORT ..."',
    '(xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 || open "http://localhost:$PORT/" >/dev/null 2>&1) &',
    'exec env PORT="$PORT" node server.js',
    '',
  ].join('\n'));

  // ---- README ----
  writeFileSync(join(APP, 'README.txt'), [
    'CAD Viewer — portable edition',
    '==============================',
    `Version: v${version}`,
    '',
    'Run it:',
    '  Windows: double-click start.bat  (or: start.bat)',
    '  macOS/Linux with node: ./start.sh',
    '',
    'Then open http://localhost:8088/  (the launcher opens it for you).',
    '',
    'The zip bundles node.exe, so NO installs are needed on Windows.',
    '',
    'User manual:',
    '  Open doc/USER-MANUAL.html (or doc/USER-MANUAL.pdf) for full',
    '  instructions with screenshots — starting the app, opening models,',
    '  sessions, part visibility and selection.',
    '',
    'Licensing:',
    '  THIRD-PARTY-NOTICES.txt lists the components and their licences',
    '  (OCCT/OCP/CadQuery are free for commercial use under the LGPL).',
    '',
    'Sharing:',
    '  Host clicks "Create session", then shares a model. Other users on the same',
    '  LAN open the join link shown in the sidebar (http://<ip>:8088/?s=CODE) or',
    '  type the code into "Join". Camera + part show/hide stay in sync.',
    '',
    'STEP files:',
    '  NOTE: STEP conversion requires TWO external pieces that are NOT bundled:',
    '  1. Docker Desktop (or another Docker runtime) installed on this PC, and',
    '  2. the OpenCascade CAD converter image "chair-cq:local" (built from the',
    '     chair-3d-web repo, or provided as a separate image).',
    '  The server shells out to Docker and runs the converter inside it',
    '  (the converters/ folder, or a legacy step2glb.py in older zips).',
    '  Without Docker, GLB/GLTF files still work; STEP shows a conversion error.',
    '',
    'Port: 8088. Override with env PORT.',
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
}

// ---- main ----
const version = resolveVersion();
const zipName = versionArg
  ? `cad-viewer-portable-v${version}.zip`
  : 'cad-viewer-portable.zip';

if (versionArg) {
  // ---- versioned build: hermetic git worktree, working tree untouched ----
  const tmp = join(os.tmpdir(), `cadv-wt-${Date.now()}`);
  const cleanup = () => {
    try { execFileSync('git', ['worktree', 'remove', '--force', tmp], { cwd: ROOT, stdio: 'ignore' }); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  };
  try {
    console.log(`[build] checking out v${version} into a temporary worktree...`);
    execFileSync('git', ['worktree', 'add', '--detach', tmp, `v${version}`], { cwd: ROOT, stdio: 'inherit' });
    // reuse the installed node_modules so the build needs no network/install
    if (existsSync(join(ROOT, 'node_modules'))) {
      cpSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'), { recursive: true });
    }
    if (!keepOlder) rmSync(DIST, { recursive: true, force: true });
    mkdirSync(DIST, { recursive: true });
    buildFrom(tmp, version, zipName);
  } catch (e) {
    console.error('versioned build failed:', e.message);
    process.exit(1);
  } finally {
    cleanup();
    console.log(`[build] worktree cleaned up; working tree untouched.`);
  }
} else {
  // ---- current-tree build (original behaviour) ----
  if (!keepOlder) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  buildFrom(ROOT, version, zipName);
}
