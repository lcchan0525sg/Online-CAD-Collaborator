import http from 'node:http';
import { readFile, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 4322;

// STEP import runs the OpenCascade kernel (no Windows wheel) in Docker.
const CQ_CONTAINER = process.env.CQ_CONTAINER || 'chair-cq:local';
const CQ_SCRIPT = process.env.CQ_SCRIPT ||
  'C:\\Users\\chan_\\Projects\\chair-3d-web\\step2glb.py';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/convert/step') {
      return handleStepUpload(req, res);
    }
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found: ' + urlPath);
    }
  })
  .listen(PORT, () => console.log(`cad-viewer on http://localhost:${PORT}`));

/**
 * POST /convert/step — accepts a raw .step/.stp body, converts it to GLB via
 * the OpenCascade kernel in Docker, and responds with the GLB bytes.
 */
async function handleStepUpload(req, res) {
  const tmp = join(tmpdir(), 'cadv-step-' + randomUUID());
  const inPath = join(tmp, 'model.step');
  const outPath = join(tmp, 'model.glb');
  let chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) {
        res.writeHead(413).end('file too large (200 MB max)');
        return;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) {
      res.writeHead(400).end('empty body');
      return;
    }
    await mkdir(tmp, { recursive: true });
    await writeFile(inPath, Buffer.concat(chunks));

    // Mount the temp dir (read/write) and the converter script, run the kernel.
    // Docker Desktop on Windows accepts native C:\... paths in -v.
    const args = [
      'run', '--rm',
      '-v', `${tmp}:/w`,
      '-v', `${CQ_SCRIPT}:/step2glb.py:ro`,
      '-w', '/w',
      CQ_CONTAINER,
      'python', '/step2glb.py', '/w/model.step', '/w/model.glb',
    ];
    console.log('[step] converting ' + (size / 1024).toFixed(1) + ' KB ...');
    const t0 = Date.now();
    const { code, stderr } = await new Promise((resolve) => {
      execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, _so, se) => {
        const out = String(se || '');
        resolve({ code: err ? (err.code ?? 1) : 0, stderr: out });
      });
    });
    if (code !== 0) {
      console.log('[step] conversion failed:\n' + stderr.slice(-2000));
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('STEP conversion failed:\n' + stderr.slice(-2000));
      return;
    }
    console.log(`[step] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const glb = await readFile(outPath);
    res.writeHead(200, {
      'content-type': 'model/gltf-binary',
      'content-length': glb.length,
    });
    res.end(glb);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('server error: ' + e.message);
  } finally {
    try {
      await Promise.allSettled([
        unlink(inPath),
        unlink(outPath),
        rmdir(tmp).catch(() => {}),
      ]);
    } catch {}
  }
}
