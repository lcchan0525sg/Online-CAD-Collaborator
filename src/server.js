import http from 'node:http';
import { readFile, writeFile, copyFile, unlink, rmdir, mkdir } from 'node:fs/promises';
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

const ROOT = fileURLToPath(new URL('../', import.meta.url));  // repo / zip root
const WEB = fileURLToPath(new URL('.', import.meta.url));    // src/ — served web files
// Port: env PORT wins; else a port.txt next to the launcher (repo/zip root);
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
// The converter is a FOLDER of per-format modules (converters/step2glb.py
// dispatcher + convert_step.py / convert_iges.py / convert_obj.py +
// common.py), so a new format never touches a finished one.
//
// Host path resolution: CQ_DIR env -> converters/ next to server.js
// (portable zip: src/converters) -> legacy single step2glb.py next to
// server.js (old zips) -> dev-machine default. The container path is always
// /converters/step2glb.py: a folder mounts to /converters, a legacy single
// .py mounts to /converters/step2glb.py (docker creates the parent dir), so
// the docker command is identical for both layouts.
import { existsSync } from 'node:fs';
const CQ_CONTAINER = process.env.CQ_CONTAINER || 'chair-cq:local';
function resolveConverter() {
  const candidates = process.env.CQ_DIR
    ? [process.env.CQ_DIR]
    : [join(WEB, 'converters'), join(WEB, 'step2glb.py'),
       'C:\\Users\\chan_\\Projects\\chair-3d-web\\converters',
       'C:\\Users\\chan_\\Projects\\chair-3d-web\\step2glb.py'];
  for (const c of candidates) {
    if (existsSync(c)) {
      const isFile = c.toLowerCase().endsWith('.py');
      return { host: c, inContainer: isFile ? '/converters/step2glb.py' : '/converters' };
    }
  }
  return { host: candidates[candidates.length - 1], inContainer: '/converters' };
}
const CQ = resolveConverter();

// Upload extensions the kernel can convert (mirrors the converters/step2glb.py
// FORMATS map). The server stores the upload under its REAL extension so the
// dispatcher inside the container routes it to the right per-format module —
// storing everything as model.step would force every upload through the STEP
// reader (IGES/OBJ would fail with IFSelect_RetFail).
const CONVERT_EXT = {
  '.step': 'step',
  '.stp': 'step',
  '.igs': 'iges',
  '.iges': 'iges',
  '.obj': 'obj',
};
function kindFromExt(name) { return CONVERT_EXT[(String(name).toLowerCase().match(/\.\w+$/) || [''])[0]]; }
// Human label for a converted source, e.g. "STEP → GLB".
function labelFromKind(kind) { return kind.toUpperCase() + ' → GLB'; }
// Canonical extension per kind, used when the filename carries no convertible
// extension (e.g. a client that sends x-kind but a bare filename).
const KIND_EXT = { step: '.step', iges: '.igs', obj: '.obj' };
// Extension to store the upload under: the file's REAL extension when it's
// convertible (that's what the container's dispatcher routes on), else the
// canonical extension for the declared kind.
function storeExt(filename, kind) {
  const fileExt = extname(filename).toLowerCase();
  return CONVERT_EXT[fileExt] ? fileExt : KIND_EXT[kind] || '.step';
}
// Bare filename without its extension (used as the GLB root node name).
function stemOf(filename) {
  return String(filename).replace(/\.[^.]+$/, '').slice(0, 80) || 'model';
}

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
    // ---- API: STEP/IGES/OBJ conversion (standalone) ----
    if (req.method === 'POST' && url.pathname === '/convert/step') {
      return handleStepUpload(req, res);
    }
    // ---- API: OBJ companion .mtl staging (uploaded with the .obj) ----
    if (req.method === 'POST' && url.pathname === '/convert/mtl') {
      return handleMtlUpload(req, res);
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
    // ---- Static files (served from src/) ----
    let urlPath = decodeURIComponent(url.pathname);
    if (urlPath === '/') urlPath = '/index.html';
    // node_modules lives at the repo/zip root (ROOT), not inside src/ (WEB),
    // so requests like ./node_modules/three/... must resolve from ROOT.
    const base = urlPath.startsWith('/node_modules/') ? ROOT : WEB;
    const filePath = normalize(join(base, urlPath));
    if (!filePath.startsWith(normalize(base))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await readFile(filePath);
      // Never let the browser cache HTML/JS/CSS: the app is updated in place
      // between builds, and a stale cached main.js has caused repeated
      // 'nothing happens on open' bugs. Force revalidation every request.
      const cache = filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')
        ? { 'cache-control': 'no-cache, no-store, must-revalidate' }
        : {};
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', ...cache });
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
    session = { code: raw, model: null, members: new Map(), light: null, anim: null };
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
  // Late joiner: replay lighting + animation state too.
  if (session.light) send(ws, { t: 'light', s: session.light });
  if (session.anim) send(ws, { t: 'anim', s: session.anim });
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
    } else if (msg.t === 'light' && msg.s && typeof msg.s === 'object') {
      // Lighting sync: store (for late joiners) and relay to the others.
      session.light = {
        ambient: Number(msg.s.ambient), key: Number(msg.s.key), fill: Number(msg.s.fill),
        front: Number(msg.s.front ?? 0),
      };
      broadcast(session, { t: 'light', s: session.light }, id);
    } else if (msg.t === 'anim' && msg.s && typeof msg.s === 'object') {
      // Animation sync: store (for late joiners) and relay to the others.
      session.anim = {
        clip: Number(msg.s.clip), playing: !!msg.s.playing,
        loop: !!msg.s.loop, speed: Number(msg.s.speed),
      };
      broadcast(session, { t: 'anim', s: session.anim }, id);
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
 * or a STEP/IGES/OBJ body which is converted to GLB first). Stores the GLB in
 * the session and tells all members to load it.
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
    // The client knows what it's sending (it may have already converted a
    // STEP/IGES/OBJ to GLB locally and kept the original filename) — trust
    // x-kind over a filename-extension guess.
    const declared = (req.headers['x-kind'] || '').toString().toLowerCase();
    let kind = declared === 'glb' ? 'glb'
      : declared === 'step' || declared === 'iges' || declared === 'obj' ? declared
      : 'glb';
    // A filename with a convertible extension also implies its kind (tolerant
    // fallback for clients that omit x-kind).
    if (kind === 'glb') {
      const ek = kindFromExt(filename);
      if (ek) kind = ek;
    }
    let glb = buf;

    if (kind !== 'glb') {
      // Reuse the kernel conversion in Docker. The upload keeps its real
      // extension so the /converters/step2glb.py dispatcher picks the matching
      // convert_<kind>.py module (everything-as-model.step would force every
      // format through the STEP reader).
      const ext = storeExt(filename, kind);
      const tmp = join(tmpdir(), 'cadv-sess-' + randomUUID());
      const inPath = join(tmp, 'model' + ext);
      const outPath = join(tmp, 'model.glb');
      await mkdir(tmp, { recursive: true });
      await writeFile(inPath, buf);
      // OBJ colours come from a companion .mtl (staged via /convert/mtl).
      if (kind === 'obj' && (req.headers['x-mtl'] || '').toString()) {
        const mtlId = (req.headers['x-mtl'] || '').toString().replace(/[^a-zA-Z0-9-]/g, '');
        try {
          await copyFile(join(tmpdir(), 'cadv-mtl-' + mtlId + '.mtl'), join(tmp, 'model.mtl'));
          await unlink(join(tmpdir(), 'cadv-mtl-' + mtlId + '.mtl')).catch(() => {});
          console.log(`[session ${session.code}] attached companion .mtl`);
        } catch (e) {
          console.warn('[session] mtl attach failed: ' + e.message);
        }
      }
      const args = [
        'run', '--rm',
        '--env', `CQ_STEM=${stemOf(filename) || 'model'}`,
        '-v', `${tmp}:/w`,
        '-v', `${CQ.host}:${CQ.inContainer}:ro`,
        '-w', '/w',
        CQ_CONTAINER,
        'python', '/converters/step2glb.py', `/w/model${ext}`, '/w/model.glb',
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
        res.end(labelFromKind(kind) + ' conversion failed:\n' + stderr.slice(-1500));
        return;
      }
      glb = await readFile(outPath);
      if (!countGlbTriangles(glb)) {
        await Promise.allSettled([unlink(inPath), unlink(outPath), rmdir(tmp).catch(() => {})]);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(labelFromKind(kind) + ' conversion produced no visible geometry (0 triangles). See server log.');
        return;
      }
      await Promise.allSettled([unlink(inPath), unlink(outPath), rmdir(tmp).catch(() => {})]);
    }

    const note = kind === 'glb' ? filename : `${filename} (${labelFromKind(kind)})`;
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
 * POST /convert/mtl — stage an OBJ companion .mtl (raw body). Returns a short
 * id that the following /convert/step request passes in an x-mtl header; the
 * file is then copied next to the .obj so convert_obj.py can read the material
 * colours. Staged files are deleted after use and swept after 30 minutes.
 */
const MTL_TTL_MS = 30 * 60 * 1000;
async function handleMtlUpload(req, res) {
  let chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { res.writeHead(413).end('mtl too large (10 MB max)'); return; }
      chunks.push(chunk);
    }
    if (!chunks.length) { res.writeHead(400).end('empty mtl'); return; }
    const id = randomUUID();
    await writeFile(join(tmpdir(), 'cadv-mtl-' + id + '.mtl'), Buffer.concat(chunks));
    // Opportunistic sweep of stale stages (crash orphans).
    try {
      const { readdir, stat } = await import('node:fs/promises');
      const now = Date.now();
      for (const f of await readdir(tmpdir())) {
        if (!f.startsWith('cadv-mtl-')) continue;
        const p = join(tmpdir(), f);
        try {
          if (now - (await stat(p)).mtimeMs > MTL_TTL_MS) await unlink(p).catch(() => {});
        } catch {}
      }
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('mtl stage failed: ' + e.message);
  }
}

/**
 * POST /convert/step — accepts a raw .step/.stp/.igs/.iges/.obj body (the
 * client sends its filename via x-filename), converts it to GLB via the
 * OpenCascade kernel in Docker, and responds with the GLB bytes. The name is
 * legacy: it is the generic "convert CAD → GLB" endpoint.
 */
async function handleStepUpload(req, res) {
  const tmp = join(tmpdir(), 'cadv-step-' + randomUUID());
  // The upload keeps its real extension so the /converters/step2glb.py
  // dispatcher selects the matching convert_<kind>.py module. (The old
  // everything-as-model.step forced every format through the STEP reader.)
  const filename = (req.headers['x-filename'] || 'model.step').toString().slice(0, 120);
  const kind = kindFromExt(filename) || 'step';
  const ext = storeExt(filename, kind);
  const inPath = join(tmp, 'model' + ext);
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

    // OBJ colours come from a companion .mtl: if the client staged one via
    // /convert/mtl (x-mtl = stage id), copy it next to the model under the
    // expected name so convert_obj.py's sibling lookup finds it.
    if (kind === 'obj' && (req.headers['x-mtl'] || '').toString()) {
      const mtlId = (req.headers['x-mtl'] || '').toString().replace(/[^a-zA-Z0-9-]/g, '');
      try {
        const staged = join(tmpdir(), 'cadv-mtl-' + mtlId + '.mtl');
        await copyFile(staged, join(tmp, 'model.mtl'));
        await unlink(staged).catch(() => {});
        console.log('[convert] attached companion .mtl');
      } catch (e) {
        console.warn('[convert] mtl attach failed: ' + e.message);
      }
    }

    // Mount the temp dir (read/write) and the converter script, run the kernel.
    // Docker Desktop on Windows accepts native C:\... paths in -v.
    const args = [
      'run', '--rm',
      '--env', `CQ_STEM=${stemOf(filename) || 'model'}`,
      '-v', `${tmp}:/w`,
      '-v', `${CQ.host}:${CQ.inContainer}:ro`,
      '-w', '/w',
      CQ_CONTAINER,
      'python', '/converters/step2glb.py', `/w/model${ext}`, '/w/model.glb',
    ];
    console.log(`[convert] ${kind.toUpperCase()} ${(size / 1024).toFixed(1)} KB ...`);
    const t0 = Date.now();
    const { code, stderr } = await new Promise((resolve) => {
      execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, _so, se) => {
        const out = String(se || '');
        resolve({ code: err ? (err.code ?? 1) : 0, stderr: out });
      });
    });
    if (code !== 0) {
      console.log('[convert] conversion failed:\n' + stderr.slice(-2000));
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(labelFromKind(kind) + ' conversion failed:\n' + stderr.slice(-2000));
      return;
    }
    console.log(`[convert] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const glb = await readFile(outPath);
    const tris = countGlbTriangles(glb);
    if (!tris) {
      const tail = stderr.slice(-600).trim();
      console.log('[convert] produced GLB has 0 triangles');
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        labelFromKind(kind) + ' conversion produced no visible geometry (0 triangles).\n' +
        'The kernel could not tessellate any meshable geometry from this file.\n' +
        'It may be a surface/wire-only file, use an unsupported schema, or be a ' +
        'reference-based assembly the reader couldn\'t fully transfer.\n' +
        'Converter log tail:\n' + tail
      );
      return;
    }
    console.log(`[convert] GLB has ${tris} triangles`);
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
