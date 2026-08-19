// draco-compress.mjs — self-contained Draco GLB compressor using `draco3d`.
// Encodes each triangle mesh primitive's geometry with the
// KHR_draco_mesh_compression extension. No cesium dependency (~1MB total).

const ATTR_MAP = { POSITION:'POSITION', NORMAL:'NORMAL', TEXCOORD_0:'TEX_COORD', COLOR_0:'COLOR' };
const COMP_SIZE = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const TYPED = {5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array};
const TYPE_N = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4};

export async function compressGlb(glb, opts = {}) {
  const t0 = Date.now();
  const draco3d = await import('draco3d');
  const M = await draco3d.createEncoderModule({});
  const level = opts.level ?? 7, posBits = opts.posBits ?? 14,
        normalBits = opts.normalBits ?? 10, uvBits = opts.uvBits ?? 12, colorBits = opts.colorBits ?? 8;

  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  let binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = new Uint8Array(glb.buffer, glb.byteOffset + binStart + 8, binLen);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glb.buffer, glb.byteOffset + 20, jsonLen)));
  const accessors = gltf.accessors || [];

  function read(acc) {
    const bv = gltf.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const n = acc.count * TYPE_N[acc.type];
    const cs = COMP_SIZE[acc.componentType];
    // Copy the exact bytes into a fresh 4-aligned ArrayBuffer so typed-array
    // views (Float32/Int16/...) never hit misaligned-offset errors.
    const bytes = new Uint8Array(n * cs);
    bytes.set(bin.subarray(off, off + n * cs));
    const T = TYPED[acc.componentType];
    const arr = new T(bytes.buffer, 0, n);
    return { arr, count: acc.count, stride: TYPE_N[acc.type] };
  }

  const meshCount = (gltf.meshes || []).length;
  const dracoPayloads = [];     // per (mi,pi) encoded Uint8Array or null
  const dracoAttrsList = [];    // per (mi,pi) { attributes: {gltfAttr:dracoId} } or null
  let any = false;

  for (let mi = 0; mi < meshCount; mi++) {
    const mesh = gltf.meshes[mi];
    for (let pi = 0; pi < (mesh.primitives || []).length; pi++) {
      const prim = mesh.primitives[pi];
      const rec = { payload: null, attrs: null };
      dracoPayloads.push(rec); dracoAttrsList.push(rec);
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      if (!prim.attributes || prim.attributes.POSITION === undefined) continue;
      if (prim.extensions && prim.extensions.KHR_draco_mesh_compression) continue;

      const enc = new M.Encoder();
      const mb = new M.MeshBuilder();
      const dm = new M.Mesh();

      let idx = null;
      if (prim.indices !== undefined) { const a = read(gltf.accessors[prim.indices]); idx = a.arr; }
      const nf = idx ? idx.length / 3 : 0;
      if (nf > 0) { const i32 = idx instanceof Uint32Array ? idx : Uint32Array.from(idx); mb.AddFacesToMesh(dm, nf, i32); }

      const attrIds = {};
      let dracoId = 0;
      for (const [ga, dn] of Object.entries(ATTR_MAP)) {
        if (prim.attributes[ga] === undefined) continue;
        const d = read(gltf.accessors[prim.attributes[ga]]);
        mb.AddFloatAttributeToMesh(dm, M[dn], d.count, d.stride, d.arr);
        attrIds[ga] = dracoId++;
      }

      try {
        enc.SetSpeedOptions(0, 0);
        if (posBits) enc.SetAttributeQuantization(M.POSITION, posBits);
        if (normalBits) enc.SetAttributeQuantization(M.NORMAL, normalBits);
        if (uvBits) enc.SetAttributeQuantization(M.TEX_COORD, uvBits);
        if (colorBits) enc.SetAttributeQuantization(M.COLOR, colorBits);
        enc.SetEncodingMethod(M.MESH_EDGEBREAKER_ENCODING);
      } catch { /* best-effort setters */ }

      const data = new M.DracoInt8Array();
      const len = enc.EncodeMeshToDracoBuffer(dm, data);
      const payload = new Uint8Array(len);
      for (let i = 0; i < len; i++) payload[i] = data.GetValue(i);

      M.destroy(dm); M.destroy(enc); M.destroy(mb);
      rec.payload = payload; rec.attrs = attrIds;
      any = true;
    }
  }

  if (!any) { M.destroy(M); return { buf: glb, ms: Date.now() - t0, inBytes: glb.byteLength, outBytes: glb.byteLength, compressed: false }; }

  // ---- rebuild GLB ----
  // 1) Apply the Draco extension to every compressed primitive and strip the
  //    bufferView from its geometry accessors (per the KHR_draco spec, the
  //    accessors keep count/min/max but drop bufferView/byteOffset).
  // 2) Determine which original bufferViews are STILL referenced by any
  //    remaining accessor (non-compressed geometry, animation/skin/morph data).
  // 3) Keep only those bytes + append the Draco payloads, remap indices.

  // Step 1: strip compressed prims' accessors + attach extension.
  {
    let pi2 = 0;
    for (let mi = 0; mi < meshCount; mi++) {
      const mesh = gltf.meshes[mi];
      for (let pi = 0; pi < (mesh.primitives || []).length; pi++) {
        const prim = mesh.primitives[pi];
        const rec = dracoPayloads[pi2++];
        if (!rec || !rec.payload) continue;
        prim.extensions = prim.extensions || {};
        prim.extensions.KHR_draco_mesh_compression = { bufferView: rec.bvIndex, attributes: rec.attrs };
        if (prim.indices !== undefined) { const a = accessors[prim.indices]; delete a.bufferView; delete a.byteOffset; }
        for (const ga of Object.keys(ATTR_MAP)) {
          if (prim.attributes[ga] === undefined) continue;
          const a = accessors[prim.attributes[ga]];
          delete a.bufferView; delete a.byteOffset;
        }
      }
    }
  }

  // Step 2: which original bufferViews are still referenced? An accessor scan
  // alone misses bufferViews referenced directly (not via accessors) — most
  // importantly `image.bufferView` for textures, plus any other object that
  // points at a bufferView by index. Collect those too.
  const keptBv = new Set();
  for (const acc of accessors) {
    if (acc.bufferView !== undefined) keptBv.add(acc.bufferView);
  }
  for (const img of (gltf.images || [])) {
    if (img && img.bufferView !== undefined) keptBv.add(img.bufferView);
  }

  // Step 3: build kept bytes + new bufferViews. Old index -> new index.
  const remap = new Map();
  const newBufferViews = [];
  const binParts = [];
  let binOff = 0;
  for (let i = 0; i < gltf.bufferViews.length; i++) {
    if (!keptBv.has(i)) continue;
    const bv = gltf.bufferViews[i];
    remap.set(i, newBufferViews.length);
    newBufferViews.push({ buffer: 0, byteOffset: binOff, byteLength: bv.byteLength });
    binParts.push(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    binOff += bv.byteLength;
  }
  // Append Draco payloads as new bufferViews (index = newBufferViews.length).
  {
    let pi2 = 0;
    for (let mi = 0; mi < meshCount; mi++) {
      const mesh = gltf.meshes[mi];
      for (let pi = 0; pi < (mesh.primitives || []).length; pi++) {
        const rec = dracoPayloads[pi2++];
        if (!rec || !rec.payload) continue;
        const bvIndex = newBufferViews.length;
        newBufferViews.push({ buffer: 0, byteOffset: binOff, byteLength: rec.payload.length });
        binParts.push(rec.payload);
        binOff += rec.payload.length;
        // update the extension's bufferView reference to the final index
        mesh.primitives[pi].extensions.KHR_draco_mesh_compression.bufferView = bvIndex;
      }
    }
  }
  // Remap the kept accessors' bufferView to the new indices.
  for (const acc of accessors) {
    if (acc.bufferView !== undefined) {
      const ni = remap.get(acc.bufferView);
      if (ni !== undefined) acc.bufferView = ni;
    }
  }
  // Remap images' bufferView too (textures reference the BIN via image.bufferView,
  // which is NOT an accessor — without this they point at stale indices).
  for (const img of (gltf.images || [])) {
    if (img && img.bufferView !== undefined) {
      const ni = remap.get(img.bufferView);
      if (ni !== undefined) img.bufferView = ni;
    }
  }

  // Assemble final BIN.
  const finalBin = new Uint8Array(binOff);
  let o = 0;
  for (const part of binParts) { finalBin.set(part, o); o += part.length; }
  gltf.bufferViews = newBufferViews;
  if (!gltf.extensionsUsed) gltf.extensionsUsed = [];
  if (!gltf.extensionsUsed.includes('KHR_draco_mesh_compression')) gltf.extensionsUsed.push('KHR_draco_mesh_compression');
  if (gltf.buffers && gltf.buffers[0]) gltf.buffers[0].byteLength = finalBin.length;

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const jp = pad4(jsonBytes.length), bp = pad4(finalBin.length);
  const total = 12 + 8 + jsonBytes.length + jp + 8 + finalBin.length + bp;
  const out = new Uint8Array(total);
  const w = new DataView(out.buffer);
  out[0]=0x67; out[1]=0x6c; out[2]=0x54; out[3]=0x46;
  w.setUint32(4, 2, true); w.setUint32(8, total, true);
  w.setUint32(12, jsonBytes.length + jp, true);
  out[16]=0x4a; out[17]=0x53; out[18]=0x4f; out[19]=0x4e;
  out.set(jsonBytes, 20);
  if (jp) out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jp);   // JSON padded with spaces
  const binChunkStart = 20 + jsonBytes.length + jp;
  w.setUint32(binChunkStart, finalBin.length + bp, true);
  out[binChunkStart+4]=0x42; out[binChunkStart+5]=0x49; out[binChunkStart+6]=0x4e; out[binChunkStart+7]=0x00;
  out.set(finalBin, binChunkStart + 8);

  return { buf: Buffer.from(out.buffer), ms: Date.now() - t0, inBytes: glb.byteLength, outBytes: out.length, compressed: true };
}
