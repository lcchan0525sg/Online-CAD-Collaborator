#!/usr/bin/env node
// convert-cad — host-side launcher for the standalone CAD -> GLB/GLTF tool.
//
// Stages the input into a temp dir, mounts it together with the converter
// into the `chair-cq:local` OpenCascade container, runs convert-cad.py inside,
// copies the output back to where you asked, and verifies it landed.
//
// Usage:
//   node convert-cad.mjs <input.(step|stp|igs|iges|stl)> [out.glb|out.gltf] [opts]
//
// Options:
//   -o, --out <path>      Output path (default: input dir / <stem>.<glb|gltf>)
//   --container <img>     Docker image (default: chair-cq:local)
//   --keep                Keep the temp work dir on failure (for debugging)
//
// Output format is chosen by the output extension: .glb -> binary, .gltf -> text + .bin.
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, copyFileSync,
         writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONVERTER = join(__dirname, 'convert-cad.py');

const SUPPORTED = { '.step': 'STEP', '.stp': 'STEP', '.igs': 'IGES', '.iges': 'IGES', '.stl': 'STL' };

// Host-side glTF geometry compression (Draco) via the self-contained draco3d
// compressor (draco-compress.mjs). Runs after the Docker conversion so the
// container image stays untouched.
async function compressGlb(glbPath, method, opts = {}) {
  const t0 = Date.now();
  const { compressGlb: doCompress } = await import('./draco-compress.mjs');
  const fs = await import('node:fs');
  const buf = fs.readFileSync(glbPath);
  const r = await doCompress(buf, { level: opts.level || 7 });
  if (r.compressed) fs.writeFileSync(glbPath, r.buf);
  return { method, ms: Date.now() - t0, inBytes: buf.length, outBytes: r.outBytes };
}

function usage() {
  console.log(
`convert-cad — standalone STEP/IGES/STL -> GLB/GLTF converter (Docker/OpenCascade)

Usage:
  node convert-cad.mjs <input> [out.glb|out.gltf] [opts]

Options:
  -o, --out <path>    Output path (default: <input dir>/<stem>.<glb|gltf>)
  --container <img>   Docker image (default: chair-cq:local)
  --compress <m>      Compress the GLB host-side: draco (or none). Default: none.
  --level <n>         Draco compression level 0-10 (default 7)
  --keep              Keep the temp work dir on failure (for debugging)

Examples:
  node convert-cad.mjs model.step out.glb
  node convert-cad.mjs asm.stp --out C:/out/asm.glb --compress draco`);
}

function die(msg) { console.error('convert-cad: ' + msg); process.exit(1); }

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, so, se) => {
      if (err && !opts.allowNonZero) return rej(new Error(String(se || err.message)));
      res({ code: err ? (err.code ?? 1) : 0, stdout: String(so || ''), stderr: String(se || '') });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) { usage(); process.exit(0); }

  const pos = [];
  let out = null, container = 'chair-cq:local', keep = false, compress = 'none', level = 7;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--container') container = argv[++i];
    else if (a === '--keep') keep = true;
    else if (a === '--compress') compress = (argv[++i] || 'none').toLowerCase();
    else if (a === '--level') level = parseInt(argv[++i], 10) || 7;
    else if (a.startsWith('--out=')) out = a.split('=')[1];
    else if (a.startsWith('--container=')) container = a.split('=')[1];
    else if (a.startsWith('--compress=')) compress = a.split('=')[1].toLowerCase();
    else if (a.startsWith('--level=')) level = parseInt(a.split('=')[1], 10) || 7;
    else pos.push(a);
  }
  if (pos.length < 1 || pos.length > 2) die('expected <input> and optional [out]');
  const input = resolve(pos[0]);
  if (!existsSync(input)) die('input not found: ' + input);
  if (pos[1]) out = pos[1];   // positional output (also settable via -o/--out)
  const ext = extname(input).toLowerCase();
  if (!(ext in SUPPORTED)) die(`unsupported extension '${ext}' (need .step/.stp/.igs/.iges/.stl)`);

  const stem = basename(input).replace(/\.[^.]+$/, '');
  // Output extension decides GLB vs GLTF.
  const outArg = out ? resolve(out) : join(dirname(input), stem + '.glb');
  const wantExt = extname(outArg).toLowerCase();
  if (wantExt !== '.glb' && wantExt !== '.gltf') die(`output must end in .glb or .gltf, got '${wantExt}'`);

  // Pre-flight: docker + image.
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
  } catch { die('docker is not running. Start Docker Desktop first.'); }
  let imgOk = false;
  try {
    execFileSync('docker', ['image', 'inspect', container], { stdio: 'ignore' });
    imgOk = true;
  } catch {
    console.error(`convert-cad: image '${container}' not found.`);
    console.error('  Build it from the cad-viewer-web Dockerfile:');
    console.error('    docker build -t chair-cq:local .   (or run install-docker-opencascade.bat)');
    process.exit(1);
  }
  void imgOk;

  // Stage a temp work dir: model.<ext> + the converter.
  const work = mkdtempSync(join(tmpdir(), 'convert-cad-'));
  const inName = 'model' + ext;
  const inPath = join(work, inName);
  copyFileSync(input, inPath);

  const stemSafe = stem.replace(/[^A-Za-z0-9_.-]/g, '_');
  const workOut = join(work, 'model' + wantExt);

  if (ext === '.stl') {
    // Pure mesh -> direct host-side writer (no Docker). The OCCT/B-rep path
    // explodes STL to ~10x (one glTF primitive per facet); stl2glb.mjs writes a
    // single welded primitive, typically smaller than the source.
    if (wantExt !== '.glb') die('STL converts to GLB only; use a .glb output');
    console.log(`convert-cad: converting STL -> ${basename(outArg)} (GLB, host-side)`);
    try {
      execFileSync(process.execPath, [join(__dirname, 'stl2glb.mjs'), inPath, workOut, '--stem', stemSafe],
        { stdio: 'inherit' });
    } catch {
      if (keep) console.error('convert-cad: temp work dir kept at ' + work);
      die('stl2glb conversion failed');
    }
  } else {
    const args = [
      'run', '--rm',
      '--env', `CQ_STEM=${stemSafe}`,
      '-v', `${work}:/w`,
      '-v', `${dirname(CONVERTER)}:/tool:ro`,
      '-w', '/w',
      container,
      'python', '/tool/convert-cad.py', `/w/${inName}`, `/w/${'model' + wantExt}`,
    ];
    console.log(`convert-cad: converting ${SUPPORTED[ext]} -> ${basename(outArg)} (${wantExt === '.glb' ? 'GLB' : 'GLTF'})`);
    console.log(`convert-cad: docker run ... ${container}`);
    try {
      const { code, stdout, stderr } = await run('docker', args);
      if (code !== 0) {
        if (keep) console.error('convert-cad: temp work dir kept at ' + work);
        die('conversion failed:\n' + stderr.slice(-2000));
      }
      if (stderr.trim()) process.stderr.write(stderr.replace(/^/gm, '  '));
    } catch (e) {
      if (keep) console.error('convert-cad: temp work dir kept at ' + work);
      die('docker error: ' + e.message);
    }
  }

  // Copy outputs back.
  const outGlb = join(work, 'model' + wantExt);
  if (!existsSync(outGlb)) { if (keep) console.error('kept work ' + work); die('output file not produced'); }
  copyFileSync(outGlb, outArg);
  if (wantExt === '.gltf') {
    const binIn = join(work, 'model.bin');
    const binOut = outArg.slice(0, -'.gltf'.length) + '.bin';
    if (existsSync(binIn)) copyFileSync(binIn, binOut);
    else if (keep) console.warn('note: no model.bin companion found');
  }

  // Optional host-side geometry compression (GLB only; GLTF uses a .bin
  // companion that would need a matching re-encode — left for later).
  let comp = null;
  if (compress !== 'none' && wantExt === '.glb') {
    if (compress !== 'draco') die(`unsupported --compress '${compress}' (only 'draco' is supported)`);
    console.log('convert-cad: compressing GLB with Draco...');
    comp = await compressGlb(outArg, 'draco', { level });
  } else if (compress !== 'none' && wantExt === '.gltf') {
    console.warn('convert-cad: --compress only applies to .glb output; skipping for .gltf');
  }

  if (!keep) rmSync(work, { recursive: true, force: true });

  const size = statSync(outArg).size;
  console.log(`convert-cad: done -> ${outArg} (${size} bytes)`);
  if (comp) console.log(`convert-cad: draco ${comp.inBytes} -> ${comp.outBytes} bytes in ${comp.ms} ms`);
  if (wantExt === '.gltf') {
    const binOut = outArg.slice(0, -'.gltf'.length) + '.bin';
    console.log(`convert-cad: companion .bin -> ${binOut} (${statSync(binOut).size} bytes)`);
  }
  console.log('convert-cad: RESULT_OK');
}

main().catch((e) => die(e.message));
