#!/usr/bin/env node
// verify-orientation.mjs — regression check for obj2glb winding/outward passes.
//
// 1. Converts the sample OBJs (cad-samples/) to scratch GLBs.
// 2. Re-parses each GLB and checks every WATERTIGHT mesh has POSITIVE signed
//    volume (outward normals). Open meshes (boundary edges) are reported but
//    not failed — they can't be oriented without a B-rep (doubleSided covers
//    them in the viewer).
// 3. Negative test: converts a fully inside-out copy of cube.obj and asserts
//    the fix_inversion pass flips it back outward.
//
// Usage: node tools/convert-cad/verify-orientation.mjs
// Exit code 0 = all watertight meshes outward + negative test passed.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const samples = resolve(root, 'cad-samples');
const scratch = resolve(__dirname, '.verify-scratch');
const CONVERTER = resolve(__dirname, 'obj2glb.mjs');

function glbMeshes(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binOff = 20 + jsonLen + 8;
  const bin = (bv) => buf.subarray(binOff + bv.byteOffset, binOff + bv.byteOffset + bv.byteLength);
  const attr = (acc, n) => { const bv = bin(json.bufferViews[json.accessors[acc].bufferView]); return new Float32Array(bv.buffer, bv.byteOffset, n); };
  return json.meshes.map((m) => {
    const p = attr(m.primitives[0].attributes.POSITION, json.accessors[m.primitives[0].attributes.POSITION].count * 3);
    const ia = json.accessors[m.primitives[0].indices];
    const bv = bin(json.bufferViews[ia.bufferView]);
    const idx = ia.componentType === 5123 ? new Uint16Array(bv.buffer, bv.byteOffset, ia.count) : new Uint32Array(bv.buffer, bv.byteOffset, ia.count);
    let vol = 0;
    const edgeCount = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
      for (const [u, v] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const k = u < v ? `${u}-${v}` : `${v}-${u}`;
        edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      }
    }
    const boundary = [...edgeCount.values()].filter((n) => n === 1).length;
    return { name: m.name, tris: idx.length / 3, vol: vol / 6, boundary };
  });
}

let failures = 0;
if (!existsSync(samples)) { console.error(`samples dir not found: ${samples}`); process.exit(2); }
if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch);

const samples_ = ['top', 'Asm1', 'cube'];
for (const f of samples_) {
  const out = resolve(scratch, `${f}.glb`);
  execSync(`node "${CONVERTER}" "${resolve(samples, f + '.obj')}" "${out}" --stem ${f}`, { stdio: 'inherit' });
  const meshes = glbMeshes(readFileSync(out));
  let ok = true, neg = 0;
  for (const m of meshes) if (m.tris > 1 && m.vol < 0) {
    if (m.boundary) console.log(`  ${f}/${m.name}: vol=${m.vol.toFixed(2)} boundaryEdges=${m.boundary} (open -> skipped by design)`);
    else { neg++; ok = false; console.error(`  FAIL ${f}/${m.name}: WATERTIGHT but vol=${m.vol.toFixed(2)} (inside-out)`); }
  }
  console.log(`${f}: ${meshes.length} meshes, watertight-inside-out: ${neg} -> ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures++;
}

// Negative test: reverse every face winding in cube.obj -> inside-out cube.
const src = readFileSync(resolve(samples, 'cube.obj'), 'utf8');
const flipped = src.replace(/^f\s+(.*)$/gm, (line, rest) => `f ${rest.trim().split(/\s+/).reverse().join(' ')}`);
const flippedIn = resolve(scratch, 'cube-flipped.obj');
const flippedOut = resolve(scratch, 'cube-fixed.glb');
writeFileSync(flippedIn, flipped);
execSync(`node "${CONVERTER}" "${flippedIn}" "${flippedOut}" --stem cube`, { stdio: 'inherit' });
const fixed = glbMeshes(readFileSync(flippedOut));
const v = fixed[0].vol;
if (v > 0) console.log(`inside-out cube: volume ${v.toFixed(4)} -> REORIENTED OUTWARD OK`);
else { console.error(`inside-out cube: volume ${v.toFixed(4)} -> STILL INSIDE-OUT FAIL`); failures++; }

// Hole-fill test: drop one face of cube.obj -> open cube. The fill pass must
// close the loop (no boundary edges left) while staying outward.
const holeSrc = src.split('\n').filter((l) => !/^f\s/.test(l)).join('\n') + '\n'
  + src.split('\n').filter((l) => /^f\s/.test(l)).slice(0, -1).join('\n') + '\n';
const holeIn = resolve(scratch, 'cube-hole.obj');
const holeOut = resolve(scratch, 'cube-hole.glb');
writeFileSync(holeIn, holeSrc);
execSync(`node "${CONVERTER}" "${holeIn}" "${holeOut}" --stem cube-hole --hole-size 2`, { stdio: 'inherit' });
const hole = glbMeshes(readFileSync(holeOut))[0];
if (hole.boundary === 0 && hole.vol > 0) console.log(`hole cube: volume ${hole.vol.toFixed(4)}, boundaryEdges 0 -> CLOSED + OUTWARD OK`);
else { console.error(`hole cube: volume ${hole.vol.toFixed(4)}, boundaryEdges ${hole.boundary} -> NOT CLOSED FAIL`); failures++; }

rmSync(scratch, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
