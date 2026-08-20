#!/usr/bin/env node
// stl2glb.mjs — pure-JS STL -> GLB converter (no Docker, no OCCT).
//
// STL is a pure triangle mesh, so routing it through OpenCascade's B-rep path
// is both slow (Docker) and catastrophic for file size: OCCT emits one glTF
// primitive per disconnected STL facet, so a 280k-facet STL becomes a GLB whose
// JSON alone is ~4 MB (measured ~10x blowup; Draco can't fix structural bloat).
//
// This writer instead parses the STL and emits a SINGLE glTF primitive with
// welded vertices + per-facet FLAT normals + a fallback colour — typically
// smaller than the source STL. Kept dependency-free (Node stdlib only).
//
// Usage:  node stl2glb.mjs <in.stl> <out.glb> [--stem NAME]
// Exit:   0 success (prints RESULT_OK)  1 failure  2 usage

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import process from 'node:process';

const GEN = 'stl2glb (pure JS)';

function die(msg, code = 1) { process.stderr.write('ERROR: ' + msg + '\n'); process.exit(code); }
function log(msg) { process.stderr.write(msg + '\n'); }

// ---- STL parsing -----------------------------------------------------------

// Detect ASCII vs binary. Binary header is 80 bytes then a uint32 count that
// must match the file length; ASCII begins with "solid".
function isBinary(buf) {
  const head = buf.subarray(0, 5).toString('ascii').toLowerCase();
  if (head !== 'solid') return true;
  // A binary file can also start with "solid" (a few encoders do). Confirm by
  // the trailing-length rule: 84 + 50*count == length.
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  return buf.length === 84 + 50 * n;
}

// Returns { positions:Float32Array, normals:Float32Array, indices:Uint16|Uint32 }
function parseStl(buf) {
  const bin = isBinary(buf);
  const faces = []; // each: [ [x,y,z]*3 ]
  if (bin) {
    const n = buf.readUInt32LE(80);
    let o = 84;
    for (let i = 0; i < n && o + 50 <= buf.length; i++) {
      const p = [
        [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)],
        [buf.readFloatLE(o + 24), buf.readFloatLE(o + 28), buf.readFloatLE(o + 32)],
        [buf.readFloatLE(o + 36), buf.readFloatLE(o + 40), buf.readFloatLE(o + 44)],
      ];
      faces.push(p);
      o += 50;
    }
  } else {
    // ASCII: gather "vertex x y z" triples per facet.
    const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    let m, cur = [], order = [];
    const s = buf.toString('ascii');
    while ((m = re.exec(s)) !== null) {
      cur.push([+m[1], +m[2], +m[3]]);
      if (cur.length === 3) { order.push(cur); cur = []; }
    }
    for (const f of order) faces.push(f);   // (avoid `...` spread: arg-limit / stack blow on big meshes)
  }
  if (!faces.length) throw new Error('no facets found');
  return weld(faces);
}

// Weld vertices on a (position, facet-normal) key so each triangle gets FLAT
// (faceted) shading: vertices shared only by coplanar triangles merge, while
// vertices on a hard edge are split so every face carries its own normal.
// Facet normals are oriented outward from the model centre (robust to inverted
// STL winding on shell-like models).
function weld(faces) {
  const pos = [];
  const norm = [];
  const indexOf = new Map();
  const Q = 1e-6, NQ = 1e-5;
  const key = (x, y, z, nx, ny, nz) =>
    Math.round(x / Q) + ',' + Math.round(y / Q) + ',' + Math.round(z / Q) + '|' +
    Math.round(nx / NQ) + ',' + Math.round(ny / NQ) + ',' + Math.round(nz / NQ);

  // Bounding-box centre used to orient normals outward.
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const f of faces) for (const [x, y, z] of f) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;

  const indices = [];
  for (const f of faces) {
    const [a, b, c] = f;
    const ax = a[0], ay = a[1], az = a[2];
    const ux = b[0] - ax, uy = b[1] - ay, uz = b[2] - az;
    const vx = c[0] - ax, vy = c[1] - ay, vz = c[2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const d = Math.hypot(nx, ny, nz);
    if (d === 0) continue;                       // degenerate triangle
    nx /= d; ny /= d; nz /= d;
    // Orient the normal away from the model centre (robust to winding).
    const fcx = (ax + b[0] + c[0]) / 3 - cx, fcy = (ay + b[1] + c[1]) / 3 - cy, fcz = (az + b[2] + c[2]) / 3 - cz;
    if (nx * fcx + ny * fcy + nz * fcz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const tri = [];
    for (const [x, y, z] of f) {
      const k = key(x, y, z, nx, ny, nz);
      let idx = indexOf.get(k);
      if (idx === undefined) { idx = pos.length; indexOf.set(k, idx); pos.push([x, y, z]); norm.push(nx, ny, nz); }
      tri.push(idx);
    }
    // A degenerate (zero-area) triangle can collapse to <3 unique verts; skip.
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    indices.push(tri[0], tri[1], tri[2]);
  }
  if (!indices.length) throw new Error('no non-degenerate triangles');

  const positions = new Float32Array(pos.length * 3);
  for (let i = 0; i < pos.length; i++) {
    positions[i * 3] = pos[i][0]; positions[i * 3 + 1] = pos[i][1]; positions[i * 3 + 2] = pos[i][2];
  }
  return {
    positions,
    normals: Float32Array.from(norm),
    indices: pos.length <= 0xFFFF ? Uint16Array.from(indices) : Uint32Array.from(indices),
  };
}

// ---- GLB writing -----------------------------------------------------------

const GLB_JSON = 0x4E4F534A, GLB_BIN = 0x004E4942;
function pad4(n) { return (4 - (n % 4)) % 4; }

function buildGlb(mesh, stem) {
  const { positions, normals, indices } = mesh;
  const ibuf = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  const compType = indices instanceof Uint16Array ? 5123 : 5125;

  // Offsets within the BIN chunk (all bufferViews 4-byte aligned).
  const posLen = positions.byteLength, normLen = normals.byteLength;
  const idxLen = ibuf.byteLength;
  const posOff = 0;
  const normOff = posOff + posLen + pad4(posLen);
  const idxOff = normOff + normLen + pad4(normLen);
  const binLen = idxOff + idxLen;
  const bin = Buffer.alloc(binLen + pad4(binLen));
  Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength).copy(bin, posOff);
  Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength).copy(bin, normOff);
  ibuf.copy(bin, idxOff);

  const json = {
    asset: { version: '2.0', generator: GEN },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: stem, mesh: 0 }],
    meshes: [{
      name: stem,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
    }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.62, 0.66, 0.72, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: posLen, target: 34962 },
      { buffer: 0, byteOffset: normOff, byteLength: normLen, target: 34962 },
      { buffer: 0, byteOffset: idxOff, byteLength: idxLen, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: min3(positions), max: max3(positions) },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: compType, count: indices.length, type: 'SCALAR' },
    ],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  // glTF requires the JSON chunk padded with SPACES (0x20), not nulls.
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length), 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii'); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12); out.writeUInt32LE(GLB_JSON, 16); jsonPadded.copy(out, 20);
  const o = 20 + jsonPadded.length;
  out.writeUInt32LE(bin.length, o); out.writeUInt32LE(GLB_BIN, o + 4); bin.copy(out, o + 8);
  return { out, tris: indices.length / 3, verts: positions.length / 3 };
}

function min3(a) { let m = [Infinity, Infinity, Infinity]; for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) m[k] = Math.min(m[k], a[i + k]); return m; }
function max3(a) { let m = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) m[k] = Math.max(m[k], a[i + k]); return m; }

// ---- CLI -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const pos = []; let stem = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stem') { stem = argv[++i]; }
    else if (a.startsWith('--stem=')) { stem = a.slice(7); }
    else if (!a.startsWith('--')) { pos.push(a); }
  }
  if (pos.length !== 2) { die('usage: stl2glb.mjs <in.stl> <out.glb> [--stem NAME]', 2); }
  const [src, out] = pos;
  if (extname(out).toLowerCase() !== '.glb') die('stl2glb only writes .glb output', 2);
  if (!stem) stem = basename(src).replace(/\.[^.]+$/, '');

  try {
    const buf = readFileSync(src);
    const mesh = parseStl(buf);
    const { out: glb, tris, verts } = buildGlb(mesh, stem);
    writeFileSync(out, glb);
    log(`STL -> GLB: ${tris.toLocaleString()} triangles, ${verts.toLocaleString()} vertices`);
    log(`bytes: ${glb.length}`);
    log('RESULT_OK');
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }
}

main();
