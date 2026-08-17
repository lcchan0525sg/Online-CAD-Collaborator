// CAD Viewer — loads real kernel geometry (GLB/GLTF) into a WebGL scene.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GridHelper } from 'three';

/* ============================ Scene ============================ */
const stage = document.getElementById('stage');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141822);

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100000);
camera.position.set(1.2, 1.0, 1.6);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;

/* ---- Lighting ---- */
scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x20242c, 0.9));

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(1.6, 2.6, 1.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0002;
scene.add(key);
scene.add(new THREE.DirectionalLight(0x8fb2ff, 0.6).translateX(-1.8).translateY(1.2).translateZ(-1.2));

/* ---- Grid (sized to fit the loaded model) ---- */
let grid = null;
function makeGrid(size) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); }
  grid = new GridHelper(size, size, 0x3a4356, 0x232b3a);
  scene.add(grid);
}

/* ============================ Model state ============================ */
let model = null;      // the loaded (scaled) group
let modelScale = 1;

// GLTF is Y-up; OpenCascade writes Z-up. Bounding-box sizes are ambiguous
// (same numbers, different axis labels), but the BASE PLANE is not: CAD models
// sit on a plane at 0 extending in +up (chair: z from 0 to 0.979, y centered).
// Find the axis where min ≈ 0 and max ≈ size — that is the model's "up".
// If it's Z, rotate -90° about X to bring it Y-up.
function orientModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  // base-ness score per axis: min near 0 AND max near +size
  const score = (mn, sz, mx) => (sz < 1e-6 ? 0 : (Math.abs(mn) / sz < 0.05 && Math.abs(mx - sz) / sz < 0.05 ? 1 : 0));
  const sz = [size.x, size.y, size.z];
  const mn = [box.min.x, box.min.y, box.min.z];
  const mx = [box.max.x, box.max.y, box.max.z];
  const s = sz.map((d, i) => score(mn[i], d, mx[i]));
  if (s[2] === 1 && s[2] > s[1]) {
    root.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld(true);
  }
}

function clearModel() {
  if (!model) return;
  scene.remove(model);
  model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
  model = null;
}

function frameModel() {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  controls.target.copy(center);
  const dist = (maxDim / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.6;
  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.85);
  camera.near = dist / 1000;
  camera.far = dist * 1000;
  camera.updateProjectionMatrix();
  controls.update();

  // grid + shadow light sized to the model
  const g = maxDim * 3;
  if (document.getElementById('chk-grid').checked) makeGrid(g);
  key.position.set(center.x + g * 0.4, center.y + g * 0.6, center.z + g * 0.35);
  key.shadow.camera.left = -g; key.shadow.camera.right = g;
  key.shadow.camera.top = g; key.shadow.camera.bottom = -g;
  key.shadow.camera.far = g * 6;
  key.shadow.camera.updateProjectionMatrix();
}

function showInfo(gltf, root, fileMaxDim) {
  const infoEl = document.getElementById('info');
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const meshes = [];
  let tris = 0, verts = 0;
  root.traverse((o) => {
    if (o.isMesh) {
      meshes.push(o);
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      verts += g.attributes.position.count;
    }
  });
  const units = modelScale !== 1
    ? (fileMaxDim > 10 ? ` (file units mm → m ×${modelScale})` : ` (normalized ×${modelScale.toFixed(3)})`)
    : '';
  infoEl.textContent = [
    `generator: ${gltf.parser.json.asset?.generator ?? '?'}`,
    `glTF version: ${gltf.parser.json.asset?.version ?? '?'}`,
    `meshes: ${meshes.length}`,
    `triangles: ${Math.round(tris).toLocaleString()}`,
    `vertices: ${verts.toLocaleString()}`,
    `materials: ${gltf.parser.json.materials?.length ?? 0}`,
    `size (m): ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}${units}`,
  ].join('\n');

  // material swatches
  const matsEl = document.getElementById('mats');
  matsEl.innerHTML = '';
  const materials = gltf.parser.json.materials ?? [];
  if (!materials.length) {
    matsEl.innerHTML = '<span class="hint">—</span>';
    return;
  }
  materials.forEach((m, i) => {
    const bc = m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    // GLTF baseColorFactor is LINEAR; convert to sRGB for display.
    const lin2s = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    const hex = '#' + bc.slice(0, 3).map((v) =>
      Math.round(THREE.MathUtils.clamp(lin2s(v), 0, 1) * 255).toString(16).padStart(2, '0')).join('');
    const row = document.createElement('div');
    row.className = 'matrow';
    row.innerHTML = `<span class="swatch" style="background:${hex}"></span>
      <span class="matname">${m.name ?? 'material ' + i}</span><span class="val">${hex}</span>`;
    matsEl.appendChild(row);
  });
}

function loadFromGltf(gltf) {
  clearModel();
  const root = gltf.scene ?? gltf.scenes[0];

  // Guard: if the GLB carries no mesh, don't leave a silent blank viewport.
  let meshCount = 0;
  root?.traverse?.((o) => { if (o.isMesh) meshCount++; });
  if (!meshCount) {
    const infoEl = document.getElementById('info');
    infoEl.textContent =
      'Loaded GLB contains no renderable meshes.\n' +
      'The source file may be surface/wire-only, an unsupported schema, or an ' +
      'assembly the converter couldn\'t fully expand.\nTry a different file or ' +
      'check the server console for the converter log.';
    return;
  }

  // Auto-scale: CAD files are usually in mm; if the model is > 10 units wide,
  // treat units as millimetres and shrink to metres. Otherwise, normalize the
  // max dimension to ~1 m so tiny sample models fill the viewport (the chair
  // is already ~0.98 m and stays essentially 1:1).
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  modelScale = maxDim > 10 ? 1 / 1000 : 1.0 / maxDim;

  model = new THREE.Group();
  model.scale.setScalar(modelScale);
  model.add(root);
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  orientModel(model);
  // rebase onto the ground plane (grid sits at y=0)
  const box2 = new THREE.Box3().setFromObject(model);
  model.position.y -= box2.min.y;
  scene.add(model);
  frameModel();
  showInfo(gltf, model, maxDim);
  document.getElementById('hud').querySelector('h1').textContent = 'CAD Viewer';
}

/* ============================ Loading ============================ */
const loader = new GLTFLoader();

function loadUrl(url) {
  loader.load(url, loadFromGltf,
    (ev) => { if (ev.total) console.log('progress', (ev.loaded / ev.total * 100).toFixed(0) + '%'); },
    (err) => {
      console.error(err);
      document.getElementById('info').textContent = 'load failed: ' + (err.message ?? err);
    });
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const buf = reader.result;
    if (file.name.toLowerCase().endsWith('.glb')) {
      loader.parse(buf, '', loadFromGltf, (e) => {
        document.getElementById('info').textContent = 'parse failed: ' + e.message;
      });
    } else {
      // .gltf (JSON) — parse directly; external resources must be embedded
      try {
        const json = JSON.parse(new TextDecoder().decode(buf));
        loader.parse(json, '', loadFromGltf, (e) => {
          document.getElementById('info').textContent = 'parse failed: ' + e.message;
        });
      } catch (e) {
        document.getElementById('info').textContent = 'invalid GLTF: ' + e.message;
      }
    }
  };
  reader.readAsArrayBuffer(file);
}

// STEP / AP214 import: the browser can't parse STEP B-reps, so we POST the
// file to the server, which converts it to GLB via the OpenCascade kernel in
// Docker (see /convert/step), then load the returned GLB.
async function importStep(file) {
  const infoEl = document.getElementById('info');
  const t0 = performance.now();
  infoEl.textContent = `converting ${file.name} to GLB…\n(OpenCascade kernel · Docker — allow a few seconds)`;
  try {
    const res = await fetch('/convert/step', {
      method: 'POST',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}\n${errText.slice(-400)}`);
    }
    const buf = await res.arrayBuffer();
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    loader.parse(buf, '', (gltf) => {
      loadFromGltf(gltf);
      // note the source + conversion time at the top of the info block
      infoEl.textContent = `source: ${file.name} (STEP→GLB in ${dt}s)\n` + infoEl.textContent;
    }, (e) => {
      infoEl.textContent = 'STEP GLB parse failed: ' + e.message;
    });
  } catch (e) {
    console.error(e);
    infoEl.textContent = 'STEP conversion failed:\n' + (e.message ?? e);
  }
}

/* ============================ UI ============================ */
document.getElementById('btn-load-chair').addEventListener('click', () => loadUrl('/chair.glb'));
document.querySelectorAll('[data-sample]').forEach((b) =>
  b.addEventListener('click', () => loadUrl(b.dataset.sample)));
// Built-in STEP sample: fetch it and run through the same server-side conversion.
document.getElementById('btn-sample-step').addEventListener('click', async () => {
  const infoEl = document.getElementById('info');
  infoEl.textContent = 'loading sample-chair.step…';
  try {
    const res = await fetch('/sample-chair.step');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const file = new File([buf], 'chair.step', { type: 'application/octet-stream' });
    importStep(file);
  } catch (e) {
    infoEl.textContent = 'failed to load sample STEP: ' + e.message;
  }
});
document.getElementById('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) {
    const ext = f.name.toLowerCase();
    if (ext.endsWith('.step') || ext.endsWith('.stp')) importStep(f);
    else loadFile(f);
  }
  e.target.value = '';
});
document.getElementById('btn-frame').addEventListener('click', frameModel);

const wire = document.getElementById('chk-wire');
wire.addEventListener('change', () => {
  if (!model) return;
  model.traverse((o) => {
    if (o.isMesh && o.material && o.material.wireframe !== undefined) {
      o.material.wireframe = wire.checked;
    }
  });
});
const gridChk = document.getElementById('chk-grid');
gridChk.addEventListener('change', () => {
  if (gridChk.checked) makeGrid(Math.max(2, (new THREE.Box3().setFromObject(model ?? new THREE.Object3D()).getSize(new THREE.Vector3()).x) * 3));
  else if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
});
const rotateChk = document.getElementById('chk-rotate');
rotateChk.addEventListener('change', () => { controls.autoRotate = rotateChk.checked; controls.autoRotateSpeed = 1.2; });
controls.autoRotate = rotateChk.checked;

/* ============================ Resize + loop ============================ */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// auto-load the shipped chair on start
loadUrl('/chair.glb');

// debug hook for headless verification
window.__viewer = { get model() { return model; }, get scale() { return modelScale; }, get THREE() { return THREE; } };
