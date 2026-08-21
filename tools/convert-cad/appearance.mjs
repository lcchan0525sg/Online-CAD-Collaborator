// appearance.mjs — GLB appearance optimization helpers.
// Colors-only removes texture payloads and UV attributes while preserving
// basic material colours, hierarchy, transforms, and geometry.

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function align4(n) { return (n + 3) & ~3; }

function parseGlb(glb) {
  if (glb.length < 20 || glb.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('colors-only appearance requires a valid GLB');
  }
  const jsonLen = glb.readUInt32LE(12);
  const jsonType = glb.readUInt32LE(16);
  if (jsonType !== JSON_CHUNK) throw new Error('GLB has no JSON chunk');
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8').trim());
  const binHeader = 20 + jsonLen;
  if (binHeader + 8 > glb.length || glb.readUInt32LE(binHeader + 4) !== BIN_CHUNK) {
    throw new Error('GLB has no BIN chunk');
  }
  const binLen = glb.readUInt32LE(binHeader);
  const bin = glb.subarray(binHeader + 8, binHeader + 8 + binLen);
  return { json, bin };
}

function stripTextureInfo(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (/Texture$/i.test(key) || key === 'texCoord') delete value[key];
    else if (value[key] && typeof value[key] === 'object') stripTextureInfo(value[key]);
  }
}

function removeUnusedUvAttributes(gltf) {
  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      for (const key of Object.keys(primitive.attributes || {})) {
        if (/^TEXCOORD_\d+$/.test(key)) delete primitive.attributes[key];
      }
    }
  }
}

function simplifyMaterials(gltf) {
  for (const material of gltf.materials || []) {
    const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {});
    stripTextureInfo(material);
    if (!Array.isArray(pbr.baseColorFactor)) pbr.baseColorFactor = [0.62, 0.66, 0.72, 1];
    delete material.emissiveTexture;
    delete material.normalTexture;
    delete material.occlusionTexture;
    if (material.extensions) {
      for (const key of Object.keys(material.extensions)) {
        if (/texture|material/i.test(key)) delete material.extensions[key];
      }
      if (!Object.keys(material.extensions).length) delete material.extensions;
    }
  }
  removeUnusedUvAttributes(gltf);
  delete gltf.images;
  delete gltf.textures;
  delete gltf.samplers;
  if (Array.isArray(gltf.extensionsUsed)) {
    gltf.extensionsUsed = gltf.extensionsUsed.filter(name => !/texture|material/i.test(name));
    if (!gltf.extensionsUsed.length) delete gltf.extensionsUsed;
  }
  if (Array.isArray(gltf.extensionsRequired)) {
    gltf.extensionsRequired = gltf.extensionsRequired.filter(name => !/texture|material/i.test(name));
    if (!gltf.extensionsRequired.length) delete gltf.extensionsRequired;
  }
}

function rebuildGlb(gltf, bin) {
  const oldViews = gltf.bufferViews || [];
  const kept = new Set();
  for (const accessor of gltf.accessors || []) {
    if (accessor.bufferView !== undefined) kept.add(accessor.bufferView);
  }

  const remap = new Map();
  const newViews = [];
  const parts = [];
  let offset = 0;
  for (let i = 0; i < oldViews.length; i++) {
    if (!kept.has(i)) continue;
    const view = oldViews[i];
    offset = align4(offset);
    const start = view.byteOffset || 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    remap.set(i, newViews.length);
    newViews.push({ buffer: 0, byteOffset: offset, byteLength: view.byteLength, ...(view.target ? { target: view.target } : {}) });
    parts.push({ offset, bytes });
    offset += bytes.length;
  }

  for (const accessor of gltf.accessors || []) {
    if (accessor.bufferView !== undefined) {
      const next = remap.get(accessor.bufferView);
      if (next === undefined) throw new Error('colors-only rewrite lost an accessor bufferView');
      accessor.bufferView = next;
    }
  }

  const finalBin = Buffer.alloc(align4(offset));
  for (const part of parts) part.bytes.copy(finalBin, part.offset);
  gltf.bufferViews = newViews;
  if (gltf.buffers?.[0]) gltf.buffers[0].byteLength = finalBin.length;

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binPadded = Buffer.concat([finalBin, Buffer.alloc((4 - (finalBin.length % 4)) % 4)]);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonPadded.copy(out, 20);
  const binHeader = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binHeader);
  out.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  binPadded.copy(out, binHeader + 8);
  return out;
}

export function colorsOnlyGlb(glb) {
  const { json, bin } = parseGlb(glb);
  simplifyMaterials(json);
  return rebuildGlb(json, bin);
}
