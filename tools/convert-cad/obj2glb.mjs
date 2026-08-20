#!/usr/bin/env node
// obj2glb.mjs — pure-JS OBJ (+ .mtl + textures) -> GLB converter (no Docker).
//
// Parses an OBJ (vertices, UVs, normals, faces/polygons, groups, usemtl) and
// its companion Wavefront .mtl (Kd diffuse, d/Tr transparency, map_Kd texture).
//
// PART NAMES + ASSEMBLY STRUCTURE: OBJ group names (`g` / `o`) may encode the
// assembly path as space-separated segments, e.g. `g top GearBox_asm_1 Part_par_1`
// (how Siemens/Solid-Edge exporters write a hierarchy). We split the group name
// on spaces and build a NESTED node tree top -> GearBox_asm_1 -> Part, so the
// resulting GLB carries the same assembly structure and part names as the source.
// A leaf part that uses several usemtl materials becomes ONE mesh with multiple
// primitives (one per material). map_Kd textures are embedded as baseColorTexture.
//
// OCCT's convert_obj.py only supports flat Kd colours (no textures) and emits one
// glTF primitive per triangle; this JS writer is host-side, smaller, and keeps
// the assembly structure.
//
// Usage:  node obj2glb.mjs <in.obj> <out.glb> [--mtl <file.mtl>] [--stem NAME]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error(...a);
const die = (m, c = 1) => { console.error(m); process.exit(c); };
const clamp = (n, a, b) => (n == null || isNaN(n) ? a : Math.min(b, Math.max(a, n)));

// ---- MTL parsing -----------------------------------------------------------
function parseMtl(src) {
  const mtls = new Map();
  let cur = null;
  for (let line of src.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    const k = t[0], val = t.slice(1).join(' ');
    if (k === 'newmtl') { mtls.set(val, { kd: [0.7, 0.7, 0.7], d: 1, mapKd: null }); cur = mtls.get(val); }
    else if (!cur) continue;
    else if (k === 'Kd') cur.kd = t.slice(1, 4).map(Number);
    else if (k === 'd') cur.d = clamp(Number(t[1]), 0, 1);
    // CAD exporters (Kaydara FBX, Solid Edge, ...) write `Tr 1.0` to mean OPAQUE,
    // so read Tr as opacity, not 1-opacity. (The only divergence from the Wavefront
    // spec is Tr=1.0: spec says fully transparent, but that is never intended —
    // treating it as opaque is what makes real CAD .mtl files render.)
    else if (k === 'Tr') cur.d = clamp(Number(t[1]), 0, 1);
    else if (k === 'map_Kd') cur.mapKd = val;
  }
  return mtls;
}

// ---- OBJ parsing -----------------------------------------------------------
// Returns { V, VT, VN, parts: [{ path:[segs], material, faces }], mtllibs }
function parseObj(src) {
  const V = [], VT = [], VN = [];
  const parts = [];
  const mtllibs = [];
  let path = ['Part'], mtl = 'default';
  let cur = { path, material: mtl, faces: [] };
  const pathKey = () => cur.path.join('/');
  const flush = () => { if (cur.faces.length) parts.push(cur); };
  for (let line of src.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    const k = t[0];
    if (k === 'v') V.push(t.slice(1, 4).map(Number));
    else if (k === 'vt') VT.push(t.slice(1, 3).map(Number));
    else if (k === 'vn') VN.push(t.slice(1, 4).map(Number));
    else if (k === 'mtllib') mtllibs.push(t.slice(1).join(' '));
    else if (k === 'o' || k === 'g') {
      // Group name may be a space-separated assembly path: `g top Asm Part`.
      const segs = t.slice(1).map((s) => s.trim()).filter(Boolean);
      if (segs.length && segs.join('/') !== pathKey()) {
        flush(); path = segs; cur = { path, material: mtl, faces: [] };
      }
    } else if (k === 'usemtl') {
      if (t[1] && t[1] !== mtl) { flush(); mtl = t[1]; cur = { path, material: mtl, faces: [] }; }
    } else if (k === 'f') {
      const idx = t.slice(1).map((s) => s.split('/').map((x) => (x === '' ? 0 : parseInt(x, 10))));
      for (let i = 1; i + 1 < idx.length; i++) {   // fan triangulate polygon
        const [a, b, c] = [idx[0], idx[i], idx[i + 1]];
        cur.faces.push([
          [a[0] > 0 ? a[0] - 1 : a[0] < 0 ? V.length + a[0] : 0, a[1] > 0 ? a[1] - 1 : a[1] < 0 ? VT.length + a[1] : -1, a[2] > 0 ? a[2] - 1 : a[2] < 0 ? VN.length + a[2] : -1],
          [b[0] > 0 ? b[0] - 1 : b[0] < 0 ? V.length + b[0] : 0, b[1] > 0 ? b[1] - 1 : b[1] < 0 ? VT.length + b[1] : -1, b[2] > 0 ? b[2] - 1 : b[2] < 0 ? VN.length + b[2] : -1],
          [c[0] > 0 ? c[0] - 1 : c[0] < 0 ? V.length + c[0] : 0, c[1] > 0 ? c[1] - 1 : c[1] < 0 ? VT.length + c[1] : -1, c[2] > 0 ? c[2] - 1 : c[2] < 0 ? VN.length + c[2] : -1],
        ]);
      }
    }
  }
  flush();
  return { V, VT, VN, parts, mtllibs };
}

// Reorient triangles so every face in a connected component has CONSISTENT
// winding (no adjacent faces wound oppositely). CAD OBJ tessellation is usually
// consistently wound for the exterior but can flip faces around holes/pockets —
// those flipped faces get inverted normals and render dark/absent (a "broken"
// surface). Flood-fill over shared edges, flipping each neighbor to oppose its
// parent, then rebuild indices with the corrected winding.
function orientConsistently(idx, pos) {
  const triCount = idx.length / 3;
  const edgeMap = new Map();   // "u-v" (u<v) -> [{ t, sign }]
  for (let t = 0; t < triCount; t++) {
    const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
    for (const [u, v] of [[a,b],[b,c],[c,a]]) {
      const key = u < v ? u + '-' + v : v + '-' + u;
      const sign = u < v ? 1 : -1;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ t, sign });
    }
  }
  const orient = new Int8Array(triCount).fill(0);   // 0=unset, +1 keep, -1 flip
  const compOf = new Int32Array(triCount);          // component id per triangle
  const compBoundary = [];                          // boundary-edge count per component
  let compCount = 0;
  for (let seed = 0; seed < triCount; seed++) {
    if (orient[seed] !== 0) continue;
    const cid = compCount++;
    compOf[seed] = cid; orient[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const t = stack.pop();
      const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
      for (const [u, v] of [[a,b],[b,c],[c,a]]) {
        const key = u < v ? u + '-' + v : v + '-' + u;
        const tSign = u < v ? 1 : -1;
        for (const nb of edgeMap.get(key) || []) {
          if (nb.t === t || orient[nb.t] !== 0) continue;
          orient[nb.t] = -orient[t] * tSign * nb.sign;
          compOf[nb.t] = cid;
          stack.push(nb.t);
        }
      }
    }
  }
  // An edge with a single owner is a boundary edge (open mesh).
  for (const list of edgeMap.values())
    if (list.length === 1) compBoundary[compOf[list[0].t]] = (compBoundary[compOf[list[0].t]] || 0) + 1;
  for (let t = 0; t < triCount; t++) {
    if (orient[t] === -1) {
      const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
      idx[t*3] = a; idx[t*3+1] = c; idx[t*3+2] = b;   // reverse winding
      orient[t] = 1;
    }
  }
  // Fix inversion (trimesh `fix_inversion`): for every WATERTIGHT component the
  // signed volume (divergence theorem) is well defined; a negative volume means
  // the whole body is consistently inside-out, so flip it to point outward.
  // Open components are skipped — their "volume" is boundary-dependent and a
  // flip could make them worse (doubleSided rendering covers those).
  let flippedBodies = 0;
  const volByComp = new Float64Array(compCount);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
    const pa = pos[a], pb = pos[b], pc = pos[c];
    volByComp[compOf[t]] += pa[0] * (pb[1] * pc[2] - pb[2] * pc[1])
      - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0])
      + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0]);
  }
  const flipComp = new Uint8Array(compCount);
  for (let cid = 0; cid < compCount; cid++) {
    if (!compBoundary[cid] && volByComp[cid] < 0) flipComp[cid] = 1, flippedBodies++;
  }
  if (flippedBodies) {
    for (let t = 0; t < triCount; t++) if (flipComp[compOf[t]]) {
      const a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
      idx[t*3] = a; idx[t*3+1] = c; idx[t*3+2] = b;
    }
  }
  return { flippedBodies };
}

// ---- weld + build one indexed mesh ------------------------------------------
function buildMesh(faces, V, VT, VN) {
  const pos = [], uv = [], nrm = [];
  const map = new Map();
  // Weld tolerance must exceed the OBJ exporter's float precision, not be a
  // nanometer. CAD OBJs (mm units) duplicate each vertex per triangle with
  // float32 values that differ by ~1e-5 mm; a Q of 1e-6 fails to merge them,
  // leaving OPEN edges (gaps/broken surface) around holes. 1e-4 mm (0.1 micron)
  // comfortably exceeds float32 noise yet is far smaller than any real feature.
  const Q = 1e-4, UQ = 1e-5, NQ = 1e-5;
  const key = (p, t, n) =>
    `${Math.round(p[0] / Q)},${Math.round(p[1] / Q)},${Math.round(p[2] / Q)}|` +
    `${Math.round((t ? t[0] : 0) / UQ)},${Math.round((t ? t[1] : 0) / UQ)}|` +
    `${Math.round((n ? n[0] : 0) / NQ)},${Math.round((n ? n[1] : 0) / NQ)},${Math.round((n ? n[2] : 0) / NQ)}`;
  const indices = [];
  for (const f of faces) {
    const tri = [];
    for (const [vi, ti, ni] of f) {
      const p = V[vi] || [0, 0, 0];
      const t = ti >= 0 && ti < VT.length ? VT[ti] : null;
      const n = ni >= 0 && ni < VN.length ? VN[ni] : null;
      const k = key(p, t, n);
      let idx = map.get(k);
      if (idx === undefined) {
        idx = pos.length; map.set(k, idx);
        pos.push(p);
        uv.push(t ? [t[0], 1 - t[1]] : [0, 0]);   // OBJ vt is bottom-up -> flip V for glTF
        nrm.push(n ? n.slice() : null);
      }
      tri.push(idx);
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    indices.push(tri[0], tri[1], tri[2]);
  }
  if (!indices.length) return null;
  const { flippedBodies } = orientConsistently(indices, pos);   // consistent winding + outward orientation
  for (let i = 0; i < nrm.length; i++) if (!nrm[i]) {
    const acc = [0, 0, 0];
    for (let j = 0; j < indices.length; j += 3) {
      const a = indices[j], b = indices[j + 1], c = indices[j + 2];
      if (a !== i && b !== i && c !== i) continue;
      const pa = pos[a], pb = pos[b], pc = pos[c];
      const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      acc[0] += uy * vz - uz * vy; acc[1] += uz * vx - ux * vz; acc[2] += ux * vy - uy * vx;
    }
    const d = Math.hypot(...acc) || 1; nrm[i] = acc.map((x) => x / d);
  }
  const positions = new Float32Array(pos.length * 3);
  const normals = new Float32Array(pos.length * 3);
  const uvs = new Float32Array(pos.length * 2);
  for (let i = 0; i < pos.length; i++) {
    positions[i * 3] = pos[i][0]; positions[i * 3 + 1] = pos[i][1]; positions[i * 3 + 2] = pos[i][2];
    normals[i * 3] = nrm[i][0]; normals[i * 3 + 1] = nrm[i][1]; normals[i * 3 + 2] = nrm[i][2];
    uvs[i * 2] = uv[i][0]; uvs[i * 2 + 1] = uv[i][1];
  }
  return {
    positions, normals, uvs,
    indices: pos.length <= 0xFFFF ? Uint16Array.from(indices) : Uint32Array.from(indices),
    flippedBodies,
  };
}

// ---- GLB writer (nested assembly tree + multi-primitive leaves) --------------
const pad4 = (n) => (4 - (n % 4)) % 4;

function buildGlb(parts, textures, stem) {
  const nodes = [{ name: stem, children: [] }];
  const nodeByPath = new Map([['', 0]]);
  // get-or-create a node for a '/' separated path, linking it under its parent.
  const getNode = (key) => {
    if (nodeByPath.has(key)) return nodeByPath.get(key);
    const name = key.slice(key.lastIndexOf('/') + 1);
    const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    const parentIdx = getNode(parentKey);
    const idx = nodes.length;
    nodes.push({ name, children: [] });
    nodeByPath.set(key, idx);
    nodes[parentIdx].children.push(idx);
    return idx;
  };
  const meshes = [];
  const materials = [];
  const matIndex = new Map();
  const images = textures.map((t) => ({ mimeType: t.mime }));
  const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const gltfTextures = textures.map((t) => ({ sampler: 0, source: t.imageIndex }));

  const bins = [], bufferViews = [], accessors = [];
  let binOffset = 0;
  const pushBin = (buf, target) => {
    const pad = pad4(binOffset); if (pad) { bins.push(Buffer.alloc(pad)); binOffset += pad; }
    const view = { buffer: 0, byteOffset: binOffset, byteLength: buf.length };
    if (target) view.target = target;
    bufferViews.push(view); bins.push(buf); binOffset += buf.length;
    return bufferViews.length - 1;
  };
  textures.forEach((t, i) => { t.imageView = pushBin(t.data, null); images[i].bufferView = t.imageView; });

  for (const part of parts) {
    const prims = [];
    for (const sub of part.subMeshes) {
      const m = sub.mesh;
      const nVerts = m.positions.length / 3;
      let pMin = [Infinity, Infinity, Infinity], pMax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < nVerts; i++) {
        const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
        if (x < pMin[0]) pMin[0] = x; if (x > pMax[0]) pMax[0] = x;
        if (y < pMin[1]) pMin[1] = y; if (y > pMax[1]) pMax[1] = y;
        if (z < pMin[2]) pMin[2] = z; if (z > pMax[2]) pMax[2] = z;
      }
      const posView = pushBin(Buffer.from(m.positions.buffer), 34962);
      const nrmView = pushBin(Buffer.from(m.normals.buffer), 34962);
      const uvView = sub.textured ? pushBin(Buffer.from(m.uvs.buffer), 34962) : -1;
      const idxView = pushBin(Buffer.from(m.indices.buffer), 34963);
      const posAcc = accessors.length; accessors.push({ bufferView: posView, componentType: 5126, count: nVerts, type: 'VEC3', min: pMin, max: pMax });
      const nrmAcc = accessors.length; accessors.push({ bufferView: nrmView, componentType: 5126, count: nVerts, type: 'VEC3' });
      const uvAcc = uvView >= 0 ? accessors.length : -1; if (uvAcc >= 0) accessors.push({ bufferView: uvView, componentType: 5126, count: nVerts, type: 'VEC2' });
      const idxAcc = accessors.length; accessors.push({ bufferView: idxView, componentType: m.indices instanceof Uint16Array ? 5123 : 5125, count: m.indices.length, type: 'SCALAR' });
      if (!matIndex.has(sub.material)) { matIndex.set(sub.material, materials.length); materials.push(buildMaterial(sub.mtl, sub.textured, textures)); }
      const attrs = { POSITION: posAcc, NORMAL: nrmAcc };
      if (uvAcc >= 0) attrs.TEXCOORD_0 = uvAcc;
      prims.push({ attributes: attrs, indices: idxAcc, material: matIndex.get(sub.material) });
    }
    if (!prims.length) continue;
    const meshIdx = meshes.length;
    meshes.push({ name: part.name, primitives: prims });
    // The part is a NAMED Group; the geometry sits in an UNNAMED child Mesh node.
    // This matches the glTF assembly convention the main viewer's parts tree
    // expects (a part = named non-mesh node), so all parts show up by name.
    const partNodeIdx = getNode(part.path.join('/'));
    const meshNodeIdx = nodes.length;
    nodes.push({ mesh: meshIdx });
    nodes[partNodeIdx].children.push(meshNodeIdx);
  }

  const json = {
    asset: { version: '2.0', generator: 'obj2glb (pure JS)' },
    scene: 0, scenes: [{ nodes: [0] }], nodes, meshes, materials,
    textures: gltfTextures, images, samplers,
    accessors, bufferViews,
    buffers: [{ byteLength: binOffset }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length), 0x20)]);
  const bin = Buffer.concat(bins);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii'); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12); out.write('JSON', 16, 'ascii');
  jsonPadded.copy(out, 20);
  let o = 20 + jsonPadded.length;
  out.writeUInt32LE(bin.length, o); out.write('BIN', o + 4, 'ascii');
  bin.copy(out, o + 8);
  return out;
}
function buildMaterial(mtl, textured, textures) {
  const m = { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } };
  if (textured && textures[0]) {
    m.pbrMetallicRoughness.baseColorTexture = { index: 0 };
    m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  } else {
    const c = mtl.kd || [0.7, 0.7, 0.7];
    m.pbrMetallicRoughness.baseColorFactor = [c[0], c[1], c[2], mtl.d ?? 1];
  }
  // CAD OBJ exports can have inconsistent winding (flipped faces around holes,
  // pockets, thin walls), which flips the computed normals and makes those
  // faces get backface-culled. Render both sides so the surface is never missing.
  m.doubleSided = true;
  if ((mtl.d ?? 1) < 1) { m.alphaMode = 'BLEND'; }
  return m;
}

// ---- main -------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const pos = []; let stem = null, mtlPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stem') stem = argv[++i];
    else if (a.startsWith('--stem=')) stem = a.slice(7);
    else if (a === '--mtl') mtlPath = argv[++i];
    else if (a.startsWith('--mtl=')) mtlPath = a.slice(6);
    else if (!a.startsWith('--')) pos.push(a);
  }
  if (pos.length !== 2) die('usage: obj2glb.mjs <in.obj> <out.glb> [--mtl <file.mtl>] [--stem NAME]', 2);
  const [src, out] = pos;
  if (!existsSync(src)) die('input not found: ' + src);
  if (extname(out).toLowerCase() !== '.glb') die('OBJ output must be .glb');

  const parsed = parseObj(readFileSync(src, 'utf8'));
  if (!parsed.parts.length) die('no faces found in OBJ');

  const base = src.slice(0, src.length - extname(src).length);
  const objDir = dirname(src);
  const fromMtlLib = parsed.mtllibs.map((m) => resolve(objDir, m)).find((p) => existsSync(p));
  const mtlFile = mtlPath && existsSync(mtlPath) ? mtlPath
    : fromMtlLib || (existsSync(base + '.mtl') ? base + '.mtl' : existsSync(base + '.MTL') ? base + '.MTL' : null);
  let mtls = new Map();
  if (mtlFile && existsSync(mtlFile)) mtls = parseMtl(readFileSync(mtlFile, 'utf8'));

  const mtlDir = mtlFile ? dirname(mtlFile) : dirname(src);
  const textures = []; const texByName = new Map();
  for (const [name, m] of mtls) {
    if (m.mapKd && !texByName.has(m.mapKd)) {
      const p = resolve(mtlDir, m.mapKd);
      if (existsSync(p)) {
        const ext = extname(p).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : null;
        if (mime) { texByName.set(m.mapKd, { path: p, data: readFileSync(p), mime }); }
        else log(`obj2glb: unsupported texture type '${ext}' for ${m.mapKd} (skipping)`);
      } else log(`obj2glb: texture not found: ${m.mapKd}`);
    }
  }
  const texOrder = [...texByName.values()].map((t) => ({ data: t.data, mime: t.mime, imageIndex: 0 }));
  texOrder.forEach((t, i) => { t.imageIndex = i; });

  // Group face-groups by assembly path; a leaf part may have several materials.
  const byPath = new Map();
  for (const fg of parsed.parts) {
    const key = fg.path.join('/');
    if (!byPath.has(key)) byPath.set(key, { path: fg.path, name: fg.path[fg.path.length - 1], subMeshes: [] });
    const part = byPath.get(key);
    const mtl = mtls.get(fg.material) || { kd: [0.7, 0.7, 0.7], d: 1, mapKd: null };
    const mesh = buildMesh(fg.faces, parsed.V, parsed.VT, parsed.VN);
    if (mesh) part.subMeshes.push({ mesh, material: fg.material, mtl, textured: !!(mtl.mapKd && texByName.has(mtl.mapKd)) });
  }
  const parts = [...byPath.values()];
  if (!parts.length) die('no renderable geometry (all faces degenerate)');

  const stemSafe = (stem || basename(src).replace(/\.[^.]+$/, '')).replace(/[^A-Za-z0-9_.-]/g, '_');
  // If the OBJ's top assembly segment is just the file's own name, collapse it
  // into the root so the tree reads cleanly (e.g. root "top" -> GearBox_asm_1,
  // not root "top" -> "top" -> GearBox_asm_1).
  for (const p of parts) if (p.path[0] === stemSafe) p.path = p.path.slice(1);
  const glb = buildGlb(parts, texOrder, stemSafe);
  writeFileSync(out, glb);

  const tris = parts.reduce((s, p) => s + p.subMeshes.reduce((x, m) => x + m.mesh.indices.length / 3, 0), 0);
  const verts = parts.reduce((s, p) => s + p.subMeshes.reduce((x, m) => x + m.mesh.positions.length / 3, 0), 0);
  const reoriented = parts.reduce((s, p) => s + p.subMeshes.reduce((x, m) => x + m.mesh.flippedBodies, 0), 0);
  log(`OBJ -> GLB: ${parts.length} part(s), ${tris.toLocaleString()} triangles, ${verts.toLocaleString()} vertices, ${texOrder.length} texture(s)${reoriented ? `, ${reoriented} inside-out body(ies) reoriented` : ''}`);
  log(`bytes: ${glb.length}`);
  console.log('RESULT_OK');
  process.exit(0);
}

main();
