import http from 'node:http';
import { readFile, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join, normalize, dirname } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Count triangles in a GLB buffer by walking its JSON chunk. Returns 0 if the
 * GLB has no indexed position primitives (i.e. it would render nothing).
 */
function countGlbTriangles(buf) {
  try {
    let off = 12;
    let json = {};
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      if (type === 0x4e4f534a /* 'JSON' */) {
        json = JSON.parse(buf.subarray(off + 8, off + 8 + len));
      }
      off += 8 + len + (len % 4);
    }
    let tris = 0;
    for (const m of json.meshes ?? []) {
      for (const p of m.primitives ?? []) {
        if (p.indices == null) continue;
        const idx = json.accessors?.[p.indices];
        if (idx) tris += Math.floor(idx.count / 3);
      }
    }
    return tris;
  } catch {
    return 0;
  }
}

const ROOT = fileURLToPath(new URL('.', import.meta.url));
// Port: env PORT wins; else a port.txt next to server.js (portable zip);
// else the default 8088.
let PORT = parseInt(process.env.PORT || '', 10) || 0;
if (!PORT) {
  try {
    const txt = await readFile(join(ROOT, 'port.txt'), 'utf8');
    PORT = parseInt(txt.trim(), 10) || 0;
  } catch {}
}
if (!PORT) PORT = 8088;

// STEP import runs the OpenCascade kernel (no Windows wheel) in Docker.
// CQ_SCRIPT: env override -> step2glb.py next to server.js (portable zip) ->
// dev-machine default.
import { existsSync } from 'node:fs';
const CQ_CONTAINER = process.env.CQ_CONTAINER || 'chair-cq:local';
const CQ_SCRIPT = process.env.CQ_SCRIPT ||
  (existsSync(join(ROOT, 'step2glb.py')) ? join(ROOT, 'step2glb.py')
    : 'C:\\Users\\chan_\\Projects\\chair-3d-web\\step2glb.py');

// HTTP header values must be ISO-8859-1 (latin-1). Non-ASCII in a filename or
// note (e.g. the "→" in "STEP → GLB") makes writeHead throw ERR_INVALID_CHAR,
// which would otherwise kill the whole server. Strip to safe printable ASCII.
function latin1(v) {
  return String(v).replace(/[^\x20-\x7e]/g, '');
}

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

const httpServer = http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // ---- API: LAN addresses (for sharing the join link) ----
    if (req.method === 'GET' && url.pathname === '/ip') {
      const addrs = [];
      for (const infos of Object.values(networkInterfaces())) {
        for (const a of infos || []) {
          if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
        }
      }
      // Prefer a private-LAN address over virtual adapters (VMware/WSL/Hyper-V
      // bridges like 172.x / 169.254.x) so the join link points at the network
      // other users are actually on.
      const lan = addrs.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ips: addrs, lan: lan || addrs[0] || null, port: PORT }));
      return;
    }
    // ---- API: STEP conversion (standalone) ----
    if (req.method === 'POST' && url.pathname === '/convert/step') {
      return handleStepUpload(req, res);
    }
    // ---- API: shared-session model (GET = fetch current, POST = upload) ----
    const m = url.pathname.match(/^\/sessions\/([A-Z0-9]{4,12})\/model$/);
    if (m) {
      const session = sessions.get(m[1]);
      if (!session) { res.writeHead(404).end('unknown session'); return; }
      if (req.method === 'GET') {
        if (!session.model) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no model yet'); return; }
        res.writeHead(200, {
          'content-type': 'model/gltf-binary',
          'content-length': session.model.buf.length,
          'x-model-filename': latin1(session.model.filename),
          'x-model-note': latin1(session.model.note),
        });
        res.end(session.model.buf);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }
      return handleSessionModelUpload(req, res, session);
    }
    // ---- Static files ----
    let urlPath = decodeURIComponent(url.pathname);
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
  });
// Safety net: an unexpected throw inside an async request handler (e.g. a bad
// header value) surfaces as an unhandled rejection / uncaught exception and
// would otherwise kill the whole server, dropping every connected session.
// For a shared-viewing tool, log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});

httpServer.listen(PORT, () => console.log(`cad-viewer on http://localhost:${PORT}`));

/* ============================ Sessions (shared viewing) ============================
 * In-memory shared sessions: one model + a roster of connected viewers whose
 * cameras are kept in sync over WebSocket. Host uploads; guests join by code.
 *
 * WS protocol (JSON):
 *   client -> server
 *     { t:'cam', pos:[x,y,z], target:[x,y,z] }      (someone moved their camera)
 *     { t:'model-ack', note }                        (finished loading a shared model)
 *     { t:'parts', ops:[{path:[i,j,...], visible:bool}] }  (part show/hide changes)
 *     { t:'tree', key:'i.j', collapsed:bool }        (assembly-tree expand/collapse)
 *     { t:'sel',  key:'i.j'|null }                   (part selection highlight)
 *   server -> client
 *     { t:'joined', id, session, isHost, roster:[{id,name,isHost}], model|null }
 *     { t:'roster', roster }                          (membership changed)
 *     { t:'peer-join', id, name, isHost }             (someone joined — host offers model)
 *     { t:'peer-gone', id }                           (someone left)
 *     { t:'model',  filename, kind:'glb'|'step', note }   (host shared a model)
 *     { t:'model-ack', from, note }                   (a guest finished loading)
 *     { t:'parts', ops:[{path, visible}] }            (part visibility sync)
 *     { t:'tree', key, collapsed }                    (assembly-tree sync)
 *     { t:'sel', key|null }                           (part selection sync)
 *     { t:'cam',    from, pos:[x,y,z], target:[x,y,z] }    (someone moved camera)
 */
const sessions = new Map();   // code -> { model: {buf, filename, kind, note, ts} | null, members: Map<id, {ws, name, isHost}> }
const wss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades: /ws?session=CODE
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, url);
  });
});

function newCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    const b = randomBytes(5);
    for (let i = 0; i < 5; i++) code += alphabet[b[i] % alphabet.length];
    if (!sessions.has(code)) return code;
  }
  return randomBytes(4).toString('hex').toUpperCase();
}

function roster(session) {
  return [...session.members.values()].map((v) => ({ id: v.id, name: v.name, isHost: v.isHost }));
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(session, obj, exceptId) {
  for (const [id, v] of session.members) if (id !== exceptId) send(v.ws, obj);
}

wss.on('connection', (ws, req, url) => {
  const raw = (url.searchParams.get('session') || '').toUpperCase();
  // A brand-new 5-char code the host just minted -> create the session.
  // Anything else must already exist (guest joining).
  const isNewHost = /^[A-Z0-9]{4,12}$/.test(raw) && url.searchParams.get('create') === '1';
  let session = sessions.get(raw);
  if (!session) {
    if (!isNewHost) { ws.close(4000, 'unknown session'); return; }
    session = { code: raw, model: null, members: new Map() };
    sessions.set(raw, session);
    console.log(`[session ${raw}] created`);
  }
  const id = randomUUID().slice(0, 8);
  const name = (url.searchParams.get('name') || '').trim().slice(0, 24) || 'viewer';
  const isHost = !session.members.size;   // first member becomes host
  session.members.set(id, { ws, name, isHost, id });

  send(ws, {
    t: 'joined', id, session: session.code, isHost, roster: roster(session),
    model: session.model ? { filename: session.model.filename, kind: session.model.kind, note: session.model.note } : null,
  });
  // Late joiner: replay the current part-visibility state so they start in sync.
  if (session.partsState && Object.keys(session.partsState).length) {
    send(ws, {
      t: 'parts', ops: Object.entries(session.partsState)
        .map(([p, visible]) => ({ path: p.split('.').map(Number), visible })),
    });
  }
  // Let everyone else know a new member arrived (host uses this to offer its
  // current model to the newcomer — see the 'peer-join' handler client-side).
  broadcast(session, { t: 'peer-join', id, name, isHost }, id);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === 'cam' && Array.isArray(msg.pos) && Array.isArray(msg.target)) {
      // Relay camera motion to every other member (not back to sender).
      broadcast(session, { t: 'cam', from: id, pos: msg.pos, target: msg.target }, id);
    } else if (msg.t === 'model-ack') {
      // A guest finished loading a shared model. Relay the confirmation to the
      // host so it can drop its "Sending model to guest(s)…" overlay.
      const host = [...session.members.values()].find((v) => v.isHost);
      if (host) send(host.ws, { t: 'model-ack', from: id, note: msg.note });
    } else if (msg.t === 'parts' && Array.isArray(msg.ops)) {
      // Part visibility sync: merge into the session state (so late joiners
      // get it) and relay to every other member.
      session.partsState = session.partsState || {};
      for (const op of msg.ops) {
        if (Array.isArray(op.path) && typeof op.visible === 'boolean') {
          session.partsState[op.path.join('.')] = op.visible;
        }
      }
      broadcast(session, { t: 'parts', ops: msg.ops }, id);
    } else if (msg.t === 'tree' && typeof msg.key === 'string') {
      // Assembly-tree expand/collapse: relay to the other members.
      broadcast(session, { t: 'tree', key: msg.key, collapsed: !!msg.collapsed }, id);
    } else if (msg.t === 'sel') {
      // Part selection highlight: relay to the other members.
      broadcast(session, { t: 'sel', key: msg.key || null }, id);
    }
  });

  const onGone = () => {
    session.members.delete(id);
    // If the host leaves, promote the next member so the session keeps working.
    const remaining = [...session.members.values()];
    if (isHost && remaining.length) {
      remaining[0].isHost = true;
      broadcast(session, { t: 'roster', roster: roster(session) });
    } else if (!isHost) {
      broadcast(session, { t: 'roster', roster: roster(session) });
    }
    // Tell the rest the member left (so a host waiting on this guest's
    // model-ack can stop waiting).
    broadcast(session, { t: 'peer-gone', id });
  };
  ws.on('close', onGone);
  ws.on('error', onGone);
});

/**
 * POST /sessions/:code/model — host uploads the shared model (raw GLB body,
 * or a STEP body which is converted to GLB first). Stores the GLB in the
 * session and tells all members to load it.
 */
async function handleSessionModelUpload(req, res, session) {
  let chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) { res.writeHead(413).end('file too large (200 MB max)'); return; }
      chunks.push(chunk);
    }
    if (!chunks.length) { res.writeHead(400).end('empty body'); return; }
    const buf = Buffer.concat(chunks);
    const filename = (req.headers['x-filename'] || 'model').toString().slice(0, 120);
    const lower = filename.toLowerCase();
    // The client knows what it's sending (it may have already converted a STEP
    // to GLB locally and kept the original .step filename) — trust x-kind over
    // a filename-extension guess.
    const declared = (req.headers['x-kind'] || '').toString().toLowerCase();
    let kind = declared === 'glb' ? 'glb' : declared === 'step' ? 'step' : 'glb';
    let glb = buf;

    if (kind === 'step' || ((lower.endsWith('.step') || lower.endsWith('.stp')) && declared !== 'glb')) {
      kind = 'step';
      // Reuse the kernel conversion in Docker.
      const tmp = join(tmpdir(), 'cadv-sess-' + randomUUID());
      const inPath = join(tmp, 'model.step');
      const outPath = join(tmp, 'model.glb');
      await mkdir(tmp, { recursive: true });
      await writeFile(inPath, buf);
      const args = [
        'run', '--rm',
        '-v', `${tmp}:/w`,
        '-v', `${CQ_SCRIPT}:/step2glb.py:ro`,
        '-w', '/w',
        CQ_CONTAINER,
        'python', '/step2glb.py', '/w/model.step', '/w/model.glb',
      ];
      console.log(`[session ${session.code}] converting ${filename} ...`);
      const { code, stderr } = await new Promise((resolve) => {
        execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, _so, se) => {
          resolve({ code: err ? (err.code ?? 1) : 0, stderr: String(se || '') });
        });
      });
      if (code !== 0) {
        await Promise.allSettled([unlink(inPath), unlink(outPath), rmdir(tmp).catch(() => {})]);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('STEP conversion failed:\n' + stderr.slice(-1500));
        return;
      }
      glb = await readFile(outPath);
      if (!countGlbTriangles(glb)) {
        await Promise.allSettled([unlink(inPath), unlink(outPath), rmdir(tmp).catch(() => {})]);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('STEP conversion produced no visible geometry (0 triangles). See server log.');
        return;
      }
      await Promise.allSettled([unlink(inPath), unlink(outPath), rmdir(tmp).catch(() => {})]);
    }

    const note = kind === 'step' ? `${filename} (STEP → GLB)` : filename;
    session.model = { buf: glb, filename, kind, note, ts: Date.now() };
    session.partsState = {};   // part paths are model-specific — reset on new model
    console.log(`[session ${session.code}] model set: ${note} (${glb.length} B GLB), members=${session.members.size}`);
    // Tell every OTHER member to load the shared model. The uploader already has
    // it (they just uploaded it / loaded it locally), so skip them — that keeps
    // the host from re-downloading their own model and from being briefly locked.
    const uploaderId = (req.headers['x-uploader-id'] || '').toString();
    broadcast(session, { t: 'model', filename, kind, note }, uploaderId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kind, filename, note, bytes: glb.length }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('server error: ' + e.message);
  }
}

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
    const tris = countGlbTriangles(glb);
    if (!tris) {
      const tail = stderr.slice(-600).trim();
      console.log('[step] produced GLB has 0 triangles');
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'STEP conversion produced no visible geometry (0 triangles).\n' +
        'This STEP file has no meshable B-rep solids the kernel could tessellate.\n' +
        'It may be a surface/wire-only file, use an unsupported schema, or be a ' +
        'reference-based assembly the reader couldn\'t fully transfer.\n' +
        'Converter log tail:\n' + tail
      );
      return;
    }
    console.log(`[step] GLB has ${tris} triangles`);
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
