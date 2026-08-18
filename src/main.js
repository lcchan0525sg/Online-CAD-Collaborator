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

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
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
const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x20242c, 0.9);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(1.6, 2.6, 1.4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0002;
scene.add(key);
const fill = new THREE.DirectionalLight(0x8fb2ff, 0.6);
fill.position.set(-1.8, 1.2, -1.2);
scene.add(fill);
const front = new THREE.DirectionalLight(0xffffff, 0.0);
front.position.set(0.0, 0.8, 2.2);   // straight in front of the model
scene.add(front);

// named refs for the lighting controls in the UI
const LIGHTS = {
  ambient: { label: 'Ambient', obj: hemi,  def: 0.9 },
  key:     { label: 'Key',     obj: key,   def: 2.4 },
  fill:    { label: 'Fill',    obj: fill,  def: 0.6 },
  front:   { label: 'Front',   obj: front, def: 0.0 },
};

// Optional extra: a spotlight/presets later; for now sliders + reset.

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
let modelGen = 0;      // monotonic load token: a stale async load can't clobber a newer one

// Every model load bumps this. The completion callback checks the captured
// token against the current one and drops itself if a newer load superseded it.
// This is what stops the boot-time chair (loaded at page open) from landing
// AFTER a guest's shared model and overwriting it — a real race when a guest
// joins via the button rather than a ?s= deep-link.
function nextLoadGen() { return ++modelGen; }
function isCurrentGen(gen) { return gen === modelGen; }

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
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  clearPartsTree();
  clearPartSelection();
}

/* ---- Assembly tree: list parts (from GLB node hierarchy) with visibility
 * toggles. Works for real assemblies (assy -> p1, p2) and flat multi-part
 * GLBs (each named node becomes a row). Toggling a group hides its subtree,
 * which three.js handles natively.
 *
 * Part identifiers are PATHs (child indices from the scene root), not names —
 * names can be empty/duplicated, but the path is stable across every client
 * that loads the same GLB, so show/hide state syncs reliably. ---- */
const partsEl = document.getElementById('parts');
const partRows = new Map();   // pathKey -> { cb, row }
const allPartRows = [];       // every built row: { key, row, toggle, hasKids }

function clearPartsTree() {
  if (!partsEl) return;
  partsEl.innerHTML = '<span class="hint">—</span>';
  partRows.clear();
  allPartRows.length = 0;
}

function nodeAtPath(root, path) {
  let o = root;
  for (const i of path) {
    if (!o?.children?.[i]) return null;
    o = o.children[i];
  }
  return o;
}

// Collapsed parents: keys whose descendant rows are hidden. Default is all
// collapsed so only the first level shows; expanding a row reveals its children.
let collapsedPaths = new Set();

function buildPartsTree(root) {
  if (!partsEl || !root) return;
  partsEl.innerHTML = '';
  partRows.clear();
  allPartRows.length = 0;
  let count = 0;
  // Three.js GLTFLoader makes ONE Mesh per glTF PRIMITIVE, and RWGltf_CafWriter
  // emits one primitive per triangle/face — so a single part can spawn hundreds
  // of child Mesh objects (auto-named "Part2_1", "Part2_2", ...). A part row
  // must therefore be any NAMED node that is NOT one of those primitive Mesh
  // leaves — i.e. a named assembly (Object3D/Group) or a lone top-level Mesh
  // directly under the scene root (flat single-part GLB). The primitive Meshes
  // nested under a part are geometry, not separate parts.
  const isPartNode = (child, obj) =>
    !!child.name && (obj === root || !child.isMesh);
  const walk = (obj, depth, path) => {
    obj.children.forEach((child, i) => {
      const p = [...path, i];
      const isPart = isPartNode(child, obj);
      if (isPart) {
        count++;
        const key = p.join('.');
        const row = document.createElement('label');
        row.className = 'partrow' + (child.visible ? '' : ' off');
        row.style.paddingLeft = `${8 + depth * 14}px`;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'parttoggle';
        toggle.textContent = '–';
        toggle.style.visibility = 'hidden';   // hidden until we know it has kids
        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (collapsedPaths.has(key)) collapsedPaths.delete(key);
          else collapsedPaths.add(key);
          renderCollapseState();
          if (!applyingRemoteTree) broadcastTree(key, collapsedPaths.has(key));
        });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = child.visible;
        cb.addEventListener('change', () => {
          // Cascading toggle: turning a (sub-)assembly on/off applies to its
          // whole subtree. three.js only respects a node's OWN visible flag —
          // a child that stayed off while the parent was off would stay blank
          // after the parent comes back on.
          const ops = [];
          for (const r of allPartRows) {
            if (r.key === key || r.key.startsWith(key + '.')) {
              const node = nodeAtPath(root, r.key.split('.').map(Number));
              if (!node) continue;
              node.visible = cb.checked;
              const entry = partRows.get(r.key);
              if (entry) {
                entry.cb.checked = cb.checked;
                entry.row.classList.toggle('off', !cb.checked);
              }
              ops.push({ path: r.key.split('.').map(Number), visible: cb.checked });
            }
          }
          broadcastParts(ops);
        });
        const span = document.createElement('span');
        span.className = 'partname';
        span.textContent = child.name || `Part ${count}`;
        span.title = child.name || `Part ${count}`;
        // Clicking the part name SELECTS it and highlights it in the viewport.
        // preventDefault stops the <label> from toggling the visibility checkbox.
        span.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectPart(key);
        });
        row.append(toggle, cb, span);
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPartMenu(e.clientX, e.clientY, key);
        });
        partsEl.appendChild(row);
        partRows.set(key, { cb, row });
        allPartRows.push({ key, row, toggle, depth });
      }
      if (child.children?.length) walk(child, depth + (isPart ? 1 : 0), p);
    });
  };
  walk(root, 0, []);
  // A row "has kids" if any other row's path starts with its path + a separator.
  for (const r of allPartRows) {
    r.hasKids = allPartRows.some((o) => o.key.startsWith(r.key + '.'));
    if (r.hasKids) r.toggle.style.visibility = 'visible';
  }
  // Default: collapse parents at depth >= 1, so the tree initially shows two
  // levels (top assembly + its direct children); deeper levels start collapsed.
  collapsedPaths = new Set(allPartRows.filter((r) => r.hasKids && r.depth >= 1).map((r) => r.key));
  renderCollapseState();
  if (!count) partsEl.innerHTML = '<span class="hint">—</span>';
}

// Show a row only when none of its ancestor rows is collapsed.
function renderCollapseState() {
  for (const r of allPartRows) {
    const segs = r.key.split('.');
    let visible = true;
    for (let i = 1; i < segs.length; i++) {
      if (collapsedPaths.has(segs.slice(0, i).join('.'))) { visible = false; break; }
    }
    r.row.style.display = visible ? '' : 'none';
    if (r.hasKids) r.toggle.textContent = collapsedPaths.has(r.key) ? '+' : '–';
  }
}

/* ---- Right-click context menu: "Show me only" ---- */
const partMenuEl = document.getElementById('part-menu');
const partMenuOnlyEl = document.getElementById('part-menu-only');
let partMenuKey = null;
let partMenuHideTimer = null;
function showPartMenu(x, y, key) {
  if (!partMenuEl) return;
  partMenuKey = key;
  partMenuEl.style.left = `${x}px`;
  partMenuEl.style.top = `${y}px`;
  partMenuEl.hidden = false;
  if (partMenuHideTimer) { clearTimeout(partMenuHideTimer); partMenuHideTimer = null; }
}
function hidePartMenu() {
  if (partMenuEl) partMenuEl.hidden = true;
  partMenuKey = null;
}

// Hide every part that is NOT the selected part (or one of its children).
// The selected part + its whole subtree stay visible; everything else turns off.
// Ancestors of the selected part must ALSO stay visible: in three.js a parent
// with visible=false hides its whole subtree, so an off parent would blank the
// part you asked to isolate.
function showOnlyPart(key) {
  if (!model || !key) return;
  const ops = [];
  const root = model.children[0];
  for (const r of allPartRows) {
    const keep = r.key === key
      || r.key.startsWith(key + '.')     // the part itself + its children
      || key.startsWith(r.key + '.');    // ancestors (must stay on to render)
    const node = nodeAtPath(root, r.key.split('.').map(Number));
    if (!node) continue;
    node.visible = keep;
    const entry = partRows.get(r.key);
    if (entry) {
      entry.cb.checked = keep;
      entry.row.classList.toggle('off', !keep);
    }
    ops.push({ path: r.key.split('.').map(Number), visible: keep });
  }
  broadcastParts(ops);
}

partMenuOnlyEl?.addEventListener('click', () => {
  const key = partMenuKey;   // capture BEFORE hidePartMenu() nulls it
  hidePartMenu();
  if (key) showOnlyPart(key);
});

/* ---- Part selection highlight ---- */
// Clicking a part name highlights that part (and its children) in the viewport
// via emissive on per-mesh material CLONES — GLB parts often share materials,
// so mutating the shared material would tint every part that uses it.
let selectedPartKey = null;
let selectedMaterialCopies = [];   // [{ mesh, original }]

function clearPartSelection(silent) {
  for (const { mesh, original } of selectedMaterialCopies) {
    mesh.material = original;
  }
  selectedMaterialCopies = [];
  if (selectedPartKey) {
    const prev = partRows.get(selectedPartKey);
    if (prev) prev.row.classList.remove('sel');
    selectedPartKey = null;
    if (!silent) broadcastSel(null);
  }
}

function selectPart(key, force) {
  if (!model || !key) return;
  if (key === selectedPartKey) {   // click again -> toggle off
    clearPartSelection();
    return;
  }
  clearPartSelection(true);
  const node = nodeAtPath(model.children[0], key.split('.').map(Number));
  if (!node) return;
  selectedPartKey = key;
  const row = partRows.get(key);
  if (row) row.row.classList.add('sel');
  // Highlight every mesh in this part's subtree.
  node.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const clones = mats.map((m) => {
      const c = m.clone();
      c.emissive = (c.emissive ? c.emissive.clone() : new THREE.Color()).set(0x2f7dff);
      c.emissiveIntensity = 0.55;
      return c;
    });
    selectedMaterialCopies.push({ mesh: o, original: o.material });
    o.material = Array.isArray(o.material) ? clones : clones[0];
  });
  if (!force) broadcastSel(key);
}
// Clicking elsewhere / scrolling dismisses the menu.
document.addEventListener('click', () => { partMenuHideTimer = setTimeout(hidePartMenu, 0); });
document.addEventListener('contextmenu', () => { partMenuHideTimer = setTimeout(hidePartMenu, 0); });
document.addEventListener('scroll', hidePartMenu, true);

function setAllParts(visible) {
  if (!model) return;
  const ops = [];
  for (const [key, { cb, row }] of partRows) {
    const node = nodeAtPath(model.children[0], key.split('.').map(Number));
    if (!node) continue;
    node.visible = visible;
    cb.checked = visible;
    row.classList.toggle('off', !visible);
    ops.push({ path: key.split('.').map(Number), visible });
  }
  broadcastParts(ops);
}

/* ---- Part visibility sync over the session ---- */
let applyingRemoteParts = false;
let pendingRemoteParts = [];   // ops that arrived before the model was loaded
function broadcastParts(ops) {
  if (!session?.connected || !ops?.length) return;
  try { session.ws.send(JSON.stringify({ t: 'parts', ops })); } catch {}
}

/* ---- Tree expand/collapse sync over the session ---- */
let applyingRemoteTree = false;
function broadcastTree(pathKey, collapsed) {
  if (!session?.connected) return;
  try { session.ws.send(JSON.stringify({ t: 'tree', key: pathKey, collapsed })); } catch {}
}
function applyRemoteTree(msg) {
  if (!msg || !msg.key) return;
  applyingRemoteTree = true;
  try {
    if (msg.collapsed) collapsedPaths.add(msg.key);
    else collapsedPaths.delete(msg.key);
    renderCollapseState();
  } finally { applyingRemoteTree = false; }
}

/* ---- Part selection highlight sync ---- */
let applyingRemoteSel = false;
function broadcastSel(key) {   // key = pathKey or null (deselect)
  if (!session?.connected) return;
  try { session.ws.send(JSON.stringify({ t: 'sel', key })); } catch {}
}
function applyRemoteSel(msg) {
  applyingRemoteSel = true;
  try {
    if (msg.key) selectPart(msg.key, true);
    else clearPartSelection(true);
  } finally { applyingRemoteSel = false; }
}
// Apply a remote parts message: set visibility + refresh the matching row.
function applyRemoteParts(ops) {
  if (!Array.isArray(ops) || !ops.length) return;
  if (!model) {                        // model not loaded yet — replay later
    pendingRemoteParts.push(...ops);
    return;
  }
  applyingRemoteParts = true;
  try {
    for (const op of ops) {
      if (!Array.isArray(op.path) || typeof op.visible !== 'boolean') continue;
      const key = op.path.join('.');
      const node = nodeAtPath(model.children[0], op.path);
      if (node) node.visible = op.visible;
      const entry = partRows.get(key);
      if (entry) {
        entry.cb.checked = op.visible;
        entry.row.classList.toggle('off', !op.visible);
      }
    }
  } finally { applyingRemoteParts = false; }
}
// Called from loadFromGltf once the scene is in: replay any parts state that
// arrived while the model was still loading (e.g. a late joiner's snapshot).
function flushPendingParts() {
  if (!pendingRemoteParts.length || !model) return;
  const ops = pendingRemoteParts;
  pendingRemoteParts = [];
  applyRemoteParts(ops);
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
  let tris = 0, verts = 0, parts = 0;
  root.traverse((o) => {
    // Count part nodes the same way buildPartsTree does (three.js makes one
    // Mesh per glTF primitive, so counting isMesh would report every triangle):
    // any named non-primitive node (assembly/part), plus a lone top-level mesh.
    if (o.isMesh) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      verts += g.attributes.position.count;
      if (o.name && o.parent === root) parts++;   // flat single-part GLB
    } else if (o.name && !o.isPrimitive) {
      parts++;
    }
  });
  const units = modelScale !== 1
    ? (fileMaxDim > 10 ? ` (file units mm → m ×${modelScale})` : ` (normalized ×${modelScale.toFixed(3)})`)
    : '';
  infoEl.textContent = [
    `generator: ${gltf.parser.json.asset?.generator ?? '?'}`,
    `glTF version: ${gltf.parser.json.asset?.version ?? '?'}`,
    `meshes: ${parts}`,
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
      <span class="matname">${esc(m.name ?? 'material ' + i)}</span><span class="val">${hex}</span>`;
    matsEl.appendChild(row);
  });
}

function loadFromGltf(gltf) {
  clearModel();
  lastGltf = gltf;
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
  setupAnimation(gltf, root);
  // In a session, push the current animation + lighting state so every viewer
  // (including ones that joined mid-load) converges on the same settings.
  if (session?.connected) { broadcastAnim(); broadcastLight(); }
  frameModel();
  showInfo(gltf, model, maxDim);
  buildPartsTree(root);
  flushPendingParts();
  document.getElementById('hud').querySelector('h1').textContent = 'CAD Viewer';
}

/* ============================ Loading ============================ */

// Set up GLB animation playback (three.js AnimationMixer) for clips carried
// by the loaded model. CAD-converted GLBs have none; animated GLBs from other
// tools do, and we play them back here.
function setupAnimation(gltf, root) {
  const clips = (gltf && (gltf.animations || [])) || [];
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  if (!clips.length) { animState.clip = -1; refreshAnimUI(); return; }
  // Start PAUSED at frame 0. If we auto-played here, each viewer (host and
  // every guest) would start from its own load instant and drift out of
  // frame-sync; pausing lets everyone start at the same state and the host
  // controls play via the synced Animation controls.
  animState.clip = 0;
  animState.playing = false;
  mixer = new THREE.AnimationMixer(root);
  applyClip(0);
  refreshAnimUI();
  // A remote anim state may have arrived before this model loaded — apply it now.
  if (pendingRemoteAnim) { const s = pendingRemoteAnim; pendingRemoteAnim = null; applyRemoteAnim(s); }
}

function applyClip(i) {
  if (!mixer) return;
  const clips = (lastGltf && lastGltf.animations) || [];
  if (i < 0 || i >= clips.length) return;
  mixer.stopAllAction();
  const action = mixer.clipAction(clips[i]);
  action.setLoop(animState.loop ? THREE.LoopRepeat : THREE.LoopOnce);
  action.clampWhenFinished = !animState.loop;
  if (animState.playing) action.play();
}

function refreshAnimUI() {
  const animSection = document.getElementById('anim-section');
  const clipSel = document.getElementById('anim-clip');
  if (!animSection) return;
  const clips = (lastGltf && lastGltf.animations) || [];
  const has = clips.length > 0;
  animSection.style.display = has ? '' : 'none';
  if (!has) return;
  if (clipSel) {
    clipSel.innerHTML = '';
    clips.forEach((c, idx) => {
      const op = document.createElement('option');
      op.value = idx;
      op.textContent = c.name || `Clip ${idx + 1}`;
      clipSel.appendChild(op);
    });
    clipSel.value = animState.clip;
  }
  const playBtn = document.getElementById('anim-play');
  if (playBtn) playBtn.textContent = animState.playing ? '⏸ Pause' : '▶ Play';
  document.getElementById('anim-loop').checked = animState.loop;
  document.getElementById('anim-speed').value = animState.speed;
  document.getElementById('anim-speed-val').textContent = `${animState.speed.toFixed(1)}×`;
}

let lastGltf = null;
const loader = new GLTFLoader();
function loadUrl(url) {
  const gen = nextLoadGen();
  loader.load(url, (gltf) => { if (isCurrentGen(gen)) loadFromGltf(gltf); },
    (ev) => { if (ev.total) console.log('progress', (ev.loaded / ev.total * 100).toFixed(0) + '%'); },
    (err) => {
      console.error(err);
      document.getElementById('info').textContent = 'load failed: ' + (err.message ?? err);
    });
}

// Load a File into the scene. Returns a Promise that resolves once the model
// has parsed and rendered. If `afterLoad` is given it runs after the load lands
// (used to hand off to the "sending to guests" step in a session). The opened
// model is remembered in `lastLocalModel` so it can be offered to a session
// even when it was opened before the session existed.
function loadFile(file, afterLoad) {
  const reader = new FileReader();
  const gen = nextLoadGen();
  const p = new Promise((resolve) => {
    reader.onload = () => {
      const buf = reader.result;
      const finish = (ok, err) => {
        if (ok) {
          lastLocalModel = { buf, filename: file.name, kind: 'glb' };
          if (afterLoad) afterLoad(buf);
        }
        resolve(ok ? true : (err || false));
      };
      if (file.name.toLowerCase().endsWith('.glb')) {
        loader.parse(buf, '', (gltf) => { if (isCurrentGen(gen)) { loadFromGltf(gltf); finish(true); } else resolve(false); }, (e) => {
          document.getElementById('info').textContent = 'parse failed: ' + e.message;
          finish(false, e.message);
        });
      } else {
        // .gltf (JSON) — parse directly; external resources must be embedded
        try {
          const json = JSON.parse(new TextDecoder().decode(buf));
          loader.parse(json, '', (gltf) => { if (isCurrentGen(gen)) { loadFromGltf(gltf); finish(true); } else resolve(false); }, (e) => {
            document.getElementById('info').textContent = 'parse failed: ' + e.message;
            finish(false, e.message);
          });
        } catch (e) {
          document.getElementById('info').textContent = 'invalid GLTF: ' + e.message;
          finish(false, e.message);
        }
      }
    };
  });
  reader.readAsArrayBuffer(file);
  return p;
}

// STEP / AP214 / IGES / OBJ import: the browser can't parse these B-rep/mesh
// sources, so we POST the file to the server, which converts it to GLB via the
// OpenCascade kernel in Docker (see /convert/step), then load the returned
// GLB. The whole thing is behind the blocking overlay — the opening user
// cannot operate until the conversion AND load have both completed. The
// x-filename header lets the server keep the real extension so its dispatcher
// routes to the right per-format converter. For OBJ, the user may also select
// the companion .mtl — it is staged first (x-mtl) so part colours survive.
async function importStep(file, mtlFile) {
  const infoEl = document.getElementById('info');
  const gen = nextLoadGen();
  const inSession = !!(session && session.connected);
  xferBegin('Converting CAD file…', `OpenCascade kernel · Docker — ${file.name}`);
  infoEl.textContent = `converting ${file.name} to GLB…\n(OpenCascade kernel · Docker — allow a few seconds)`;
  const t0 = performance.now();
  try {
    // OBJ: stage the companion .mtl (if picked) so the converter can apply
    // its material colours.
    let mtlId = '';
    if (mtlFile) {
      try {
        const mres = await fetch('/convert/mtl', { method: 'POST', body: mtlFile });
        if (mres.ok) mtlId = ((await mres.json()) || {}).id || '';
      } catch { mtlId = ''; }
      if (!mtlId) infoEl.textContent = `${file.name}: .mtl staging failed — colours may be lost\n` + infoEl.textContent;
    }
    const headers = {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': file.name,
    };
    if (mtlId) headers['x-mtl'] = mtlId;
    const res = await fetch('/convert/step', {
      method: 'POST',
      body: file,
      headers,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}\n${errText.slice(-400)}`);
    }
    // Conversion done — stream the GLB back with byte-level progress, then load.
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    xferBegin('Transferring model…', `receiving ${file.name}`, total);
    xferProgress(0, total);
    const buf = await streamBytes(res, (r, t) => xferProgress(r, t || total));

    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    loader.parse(buf.buffer, '', (gltf) => {
      if (!isCurrentGen(gen)) return;
      // loadFromGltf builds the parts tree, info and frames the camera. If it
      // throws (e.g. a very large OBJ with thousands of primitive meshes), we
      // must still clear the blocking overlay — otherwise it hangs forever.
      try {
        loadFromGltf(gltf);
      } catch (err) {
        if (!isCurrentGen(gen)) return;
        infoEl.textContent = 'model load error: ' + (err?.message ?? err);
        xferError('model load error: ' + (err?.message ?? err));
        return;
      }
      let srcLine = `source: ${file.name} (converted to GLB in ${dt}s)`;
      // OBJ colours live in a sibling .mtl; if it wasn't selected, say so
      // clearly so a grey result isn't mistaken for a converter bug.
      if (file.name.toLowerCase().endsWith('.obj') && !mtlFile) {
        srcLine += '  ⚠ NO .MTL SELECTED — parts are grey. Re-open and select the .obj together with its .mtl.';
      } else if (file.name.toLowerCase().endsWith('.obj') && mtlFile && !mtlId) {
        srcLine += '  ⚠ .MTL STAGING FAILED — parts may be grey.';
      }
      infoEl.textContent = srcLine + '\n' + infoEl.textContent;
      lastLocalModel = { buf, filename: file.name, kind: 'glb' };
      // In a session the model is also pushed to the guests once the local
      // parse has landed — share the converted GLB and hold the overlay until
      // every guest ACKs it. (buf is already GLB here, so kind is 'glb'.)
      if (inSession && session) {
        shareBuffer(buf, file.name, 'glb');
      } else {
        xferDone();
      }
    }, (e) => {
      if (!isCurrentGen(gen)) return;
      infoEl.textContent = 'converted GLB parse failed: ' + e.message;
      xferError(e.message);
    });
  } catch (e) {
    if (!isCurrentGen(gen)) return;
    infoEl.textContent = 'CAD conversion failed:\n' + (e.message ?? e);
    xferError(e.message);
  }
}

/* ============================ Session (shared viewing) ============================
 * Host creates a session + shares a model; guests join by code. Model is stored
 * on the server and re-sent to every member. Camera (orbit/zoom/pan) is synced
 * both ways: each client broadcasts its camera and applies the others' camera,
 * so everyone sees the same viewpoint.
 */
let session = null;          // { code, ws, id, isHost, connected }
let roster = [];             // [{id, name, isHost}]
let applyingRemote = false;  // suppress broadcast while applying a remote camera
let lastCamSent = 0;
const CAM_INTERVAL = 40;     // ms between camera broadcasts
let pendingSend = new Set(); // guest ids still to ACK the current shared model (host)
let currentModel = null;     // { buf, filename, kind, note } — host's last shared model
// The model currently in the scene that was opened LOCALLY (file picker /
// STEP). If the host opens a model before (or while) connecting to a session,
// it must still reach the guests — so we remember it here and offer it the
// moment 'joined' arrives.
let lastLocalModel = null;   // { buf, filename, kind }

// A guest finished loading the shared model (relayed from the server). Clear it
// from the pending set; once none remain, drop the "Sending model" overlay.
// ACKs are tracked in ackedSend even if they arrive BEFORE sendModelToPeers
// populated pendingSend (a race: the server broadcasts to the guest during the
// upload POST, so a fast guest can ACK before the host's POST returns). Without
// this, an early ACK is dropped and the host waits the full sendGuard timeout.
let ackedSend = new Set();   // guest ids that ACKed the current shared model
function onModelAck(from) {
  ackedSend.add(from);
  if (!pendingSend.has(from)) return;
  pendingSend.delete(from);
  if (!pendingSend.size) {
    if (sendGuard) clearTimeout(sendGuard);
    setSessionStatus(`connected · host · model sent to all`);
    xferDone('Model sent to guest(s)', 'control restored');
  }
}
function onPeerGone(id) {
  pendingSend.delete(id);
  ackedSend.delete(id);
  if (!pendingSend.size) {
    if (sendGuard) clearTimeout(sendGuard);
    setSessionStatus('connected · host');
    xferDone();
  }
}
function sendModelAck(note) {
  if (session?.ws?.readyState === 1) { try { session.ws.send(JSON.stringify({ t: 'model-ack', note })); } catch {} }
}

const sessionStatusEl = document.getElementById('session-status');
const sessionCodeEl = document.getElementById('session-code');
const rosterEl = document.getElementById('roster');
const sessionControlsEl = document.getElementById('session-controls');
const sessionActiveEl = document.getElementById('session-active');
const joinCodeInput = document.getElementById('join-code');

function setSessionStatus(text) { if (sessionStatusEl) sessionStatusEl.textContent = text; }

// ---- Server health indicator: polls /health so "nothing happens on open" is
// diagnosable at a glance (grey = unknown, green = server up, red = down).
const healthDot = document.getElementById('health-dot');
function setHealth(state) {
  if (!healthDot) return;
  healthDot.className = 'health-dot ' + state;
  healthDot.title = state === 'ok' ? 'server connected'
    : state === 'bad' ? 'server unreachable - open will not work'
    : 'checking server...';
}
let healthFailures = 0;
async function pollHealth() {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    if (r.ok) { healthFailures = 0; setHealth('ok'); }
    else { healthFailures++; setHealth(healthFailures >= 2 ? 'bad' : 'unknown'); }
  } catch {
    healthFailures++;
    setHealth(healthFailures >= 2 ? 'bad' : 'unknown');
  }
}
setHealth('unknown');
pollHealth();
setInterval(pollHealth, 4000);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderRoster() {
  if (!rosterEl) return;
  rosterEl.innerHTML = '';
  if (!roster.length) { rosterEl.innerHTML = '<span class="hint">—</span>'; return; }
  roster.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'matrow';
    const isSelf = session && r.id === session.id;
    const label = esc(r.name) + (r.isHost ? ' · host' : '') + (isSelf ? ' (you)' : '');
    // The host can kick any non-host viewer.
    const kick = session?.isHost && !r.isHost
      ? `<button class="kick-btn" data-kick="${r.id}" title="Remove ${esc(r.name)}">kick</button>`
      : '';
    row.innerHTML = `<span class="swatch" style="background:${r.isHost ? '#6ea8fe' : '#3a4356'}"></span>
      <span class="matname">${label}</span>${kick}`;
    const kb = row.querySelector('.kick-btn');
    if (kb) kb.addEventListener('click', () => {
      try { session.ws.send(JSON.stringify({ t: 'kick', target: r.id })); } catch {}
    });
    rosterEl.appendChild(row);
  });
}

function showSessionUI(active, code) {
  if (!sessionControlsEl || !sessionActiveEl) return;
  sessionControlsEl.hidden = active;
  sessionActiveEl.hidden = !active;
  if (active) {
    sessionCodeEl.textContent = code;
    sessionCodeEl.title = 'click to copy';
    sessionCodeEl.style.cursor = 'pointer';
    // Join link: http://<lan-ip>:<port>/?s=CODE — shown so the host can hand
    // the address to other users on the same network.
    refreshJoinLink(code);
    // auto-rotate would fight camera sync, so disable it while in a session
    document.getElementById('chk-rotate').checked = false;
    document.getElementById('chk-rotate').disabled = true;
    controls.autoRotate = false;
  } else {
    document.getElementById('chk-rotate').disabled = false;
  }
}

// Fetch the host's LAN addresses and render the join link (clickable/copyable).
// Falls back to the current origin if /ip is unavailable.
async function refreshJoinLink(code) {
  const linkEl = document.getElementById('session-link');
  if (!linkEl) return;
  const port = location.port ? `:${location.port}` : '';
  let base = location.hostname;                 // e.g. 192.168.x.x or localhost
  try {
    const res = await fetch('/ip');
    if (res.ok) {
      const j = await res.json();
      if (j.lan) base = j.lan;                      // preferred LAN address
      else if (j.ips?.length) base = j.ips[0];
    }
  } catch {}
  const url = `${location.protocol}//${base}${port}/?s=${code}`;
  linkEl.href = url;
  linkEl.textContent = url;
  linkEl.title = 'open on another machine, or copy';
}

function connectTo(code, { create = false } = {}) {
  if (session) { try { session.ws.close(); } catch {} session = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ session: code, name: userName });
  if (create) q.set('create', '1');
  const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  session = { code, ws, id: null, isHost: false, connected: false, name: userName };
  setSessionStatus('connecting…');
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onSessionMsg(m); };
  ws.onclose = (ev) => {
    // A later connectTo() may have replaced this connection — if so, this
    // stale close handler must not clobber the new session's state.
    if (!session || session.ws !== ws) return;
    const wasIn = session?.connected;
    session = null;
    if (ev.code === 4001) {
      setSessionStatus('removed by host');
      showSessionUI(false);
      roster = []; renderRoster();
      // The viewer was removed — clear the model from their screen.
      clearModel();
      clearPartsTree();
      clearPartSelection();
      const infoEl = document.getElementById('info');
      if (infoEl) infoEl.textContent = 'You were removed from the session by the host.';
      xferToast('You were removed from the session by the host.');
    } else if (wasIn) {
      setSessionStatus('disconnected');
      showSessionUI(false);
      roster = []; renderRoster();
    } else if (sessionStatusEl && sessionStatusEl.textContent === 'connecting…') {
      setSessionStatus('could not connect');
    }
    // A transfer can't finish without a session — clear it and restore control.
    pendingSend.clear();
    currentModel = null;
    if (sendGuard) clearTimeout(sendGuard);
    xferAbort();
  };
  ws.onerror = () => {}; // onclose handles cleanup
}

function onSessionMsg(msg) {
  switch (msg.t) {
    case 'joined':
      session.id = msg.id;
      session.isHost = msg.isHost;
      session.connected = true;
      roster = msg.roster;
      setSessionStatus(`connected${msg.isHost ? ' · host' : ''}`);
      showSessionUI(true, msg.session);
      renderRoster();
      // Host opened a model BEFORE the session existed (or while connecting):
      // upload + offer it now so guests get it, without re-opening the file.
      if (msg.isHost && lastLocalModel && !currentModel) {
        shareBuffer(lastLocalModel.buf, lastLocalModel.filename, lastLocalModel.kind);
      }
      // Guest deep-link: the server tells us the session already has a model —
      // fetch + load it (blocking overlay until it lands).
      if (msg.model) loadSharedModel(msg.model);
      break;
    case 'roster':
      roster = msg.roster; renderRoster();
      break;
    case 'peer-join':
      // The roster just refreshed; a new member is in. If we're the host and
      // already hold a model, offer it to the newcomer. The guest's 'joined'
      // already carried the model, so we only block here if we have something
      // to hand over.
      roster = roster.filter((r) => r.id !== msg.id);
      roster.push({ id: msg.id, name: msg.name, isHost: msg.isHost });
      renderRoster();
      if (session?.isHost && currentModel) sendModelToPeers(currentModel, [msg.id]);
      break;
    case 'peer-gone':
      roster = roster.filter((r) => r.id !== msg.id);
      renderRoster();
      onPeerGone(msg.id);
      break;
    case 'model':
      loadSharedModel(msg);
      break;
    case 'model-ack':
      // Any sharer — host OR guest — must process ACKs to drain its own
      // pendingSend/ackedSend. The old `if (session?.isHost)` gate meant a
      // guest that shared a model received the ACKs but ignored them, hanging
      // its "Sending model to guest(s)…" overlay for the full 30s.
      onModelAck(msg.from);
      break;
    case 'parts':
      applyRemoteParts(msg.ops);
      break;
    case 'tree':
      applyRemoteTree(msg);
      break;
    case 'sel':
      applyRemoteSel(msg);
      break;
    case 'cam':
      applyRemoteCamera(msg.pos, msg.target);
      break;
    case 'anim':
      applyRemoteAnim(msg.s);
      break;
    case 'light':
      applyRemoteLight(msg.s);
      break;
  }
}

/* ============================ Model-transfer overlay ============================
 * One overlay, one job: tell the user a model is moving and BLOCK the viewport
 * until it lands. Both directions use it:
 *   host  -> "Sending model to guest(s)…"  (blocks until every guest ACKs)
 *   guest -> "Receiving model…"            (blocks until the GLB is parsed+loaded)
 *   any   -> "Converting STEP…" / "Loading model…" (local open, blocks too)
 *
 * xferBegin() starts a blocking op (show overlay, lock controls);
 * xferDone()/xferError() restore control and clear the overlay.
 * The MutationObserver below logs every state change so headless verification
 * can assert the block/restore sequence deterministically (a fast localhost
 * transfer can't slip between polls).
 */
const xferOverlayEl = document.getElementById('xfer-overlay');
const xferTitleEl = document.getElementById('xfer-title');
const xferSubEl = document.getElementById('xfer-sub');
const xferBarEl = document.querySelector('#xfer-overlay .xfer-bar');
const xferFillEl = document.getElementById('xfer-fill');
const xferToastEl = document.getElementById('xfer-toast');
let xferToastTimer = null;
// Authoritative blocking flag — true while a transfer is in flight (overlay
// shown + controls locked). Set synchronously before any DOM write so the log
// records the true state, not a microtask-late read of controls.enabled.
let xferBlocking = false;
let xferLog = [];
function xferLogReset() { xferLog = []; }

new MutationObserver(() => {
  xferLog.push({
    hidden: xferOverlayEl.hidden,
    title: xferTitleEl.textContent,
    fill: xferFillEl.style.width,
    blocking: xferBlocking,
  });
  if (xferLog.length > 400) xferLog.shift();
}).observe(xferOverlayEl, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// Start a blocking transfer op: show the overlay, lock the controls.
let xferSeq = 0;             // bumped on begin/done/error so a stale "ready" timeout can't hide a new transfer
function xferBegin(title, sub, totalBytes) {
  xferSeq++;
  xferTitleEl.textContent = title;
  xferSubEl.textContent = sub || '';
  xferFillEl.style.width = '0%';
  if (totalBytes && totalBytes > 0) xferBarEl.classList.remove('indeterminate');
  else xferBarEl.classList.add('indeterminate');
  xferOverlayEl.hidden = false;
  xferBlocking = true;
  controls.enabled = false;
}

// Update byte progress on the bar (deterministic when a byte total is known).
function xferProgress(loaded, total) {
  if (total && total > 0) {
    xferBarEl.classList.remove('indeterminate');
    xferFillEl.style.width = Math.min(100, (loaded / total) * 100).toFixed(1) + '%';
    xferSubEl.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
  } else {
    xferSubEl.textContent = fmtBytes(loaded) + ' received';
  }
}

// Finish a blocking op: flash the completion state, hand control back to the
// user, then clear the overlay a beat later.
function xferDone(title, sub) {
  xferBlocking = false;
  if (xferOverlayEl.hidden) return;
  xferBarEl.classList.remove('indeterminate');
  xferFillEl.style.width = '100%';
  xferTitleEl.textContent = title || 'Model loaded';
  xferSubEl.textContent = sub || 'you can now rotate, zoom and pan';
  controls.enabled = true;
  const seq = xferSeq;
  setTimeout(() => {
    if (seq !== xferSeq) return;          // a newer transfer started — don't clobber it
    xferOverlayEl.hidden = true;
    xferToast('Model ready — full control restored.');
  }, 950);
}

function xferError(msg) {
  xferBlocking = false;
  xferSeq++;
  if (!xferOverlayEl.hidden) xferOverlayEl.hidden = true;
  controls.enabled = true;
  xferToast('Model transfer failed: ' + (msg || 'unknown error'));
}

// Force-clear the overlay + restore control (used on disconnect / leave).
function xferAbort() {
  xferBlocking = false;
  xferSeq++;
  if (!xferOverlayEl.hidden) xferOverlayEl.hidden = true;
  controls.enabled = true;
}

// Read a fetch Response body into a Uint8Array, reporting byte progress.
// Prefers streaming reads (real progress) and falls back to arrayBuffer.
async function streamBytes(res, onProgress) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, received);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  const b = new Uint8Array(await res.arrayBuffer());
  onProgress?.(b.length, b.length);
  return b;
}

function xferToast(msg) {
  if (!xferToastEl) return;
  xferToastEl.textContent = msg;
  xferToastEl.hidden = false;
  xferToastEl.classList.remove('is-out');
  if (xferToastTimer) clearTimeout(xferToastTimer);
  xferToastTimer = setTimeout(() => {
    xferToastEl.classList.add('is-out');
    setTimeout(() => { xferToastEl.hidden = true; xferToastEl.classList.remove('is-out'); }, 450);
  }, 3200);
}

// Guest side: fetch the session's current model GLB and load it into the scene.
// Streams the body for real byte-level progress and BLOCKS the viewport until
// the model is parsed and rendered — then it ACKs back to the host (via the
// server) so the host can drop its "Sending model to guest(s)…" overlay.
async function loadSharedModel(m) {
  if (!session) return;
  const gen = nextLoadGen();   // shared model supersedes any in-flight local load
  const infoEl = document.getElementById('info');
  const label = m.note || m.filename || 'model';
  xferBegin('Receiving model…', label);
  try {
    const res = await fetch(`/sessions/${session.code}/model?ts=${Date.now()}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    xferProgress(0, total);
    const buf = await streamBytes(res, (r, t) => xferProgress(r, t || total));
    // ACK the host as soon as the model BYTES arrive, not after the heavy
    // parse/load below. The host's overlay only waits on transfer; the local
    // load continues independently. Sending the ACK here removes the timing
    // dependency on model size / client speed, so a large model can't make the
    // host's 30s sendGuard fire early.
    sendModelAck(label);

    loader.parse(buf.buffer, '', (gltf) => {
      if (!isCurrentGen(gen)) return;   // superseded — the newer load owns the UI
      try {
        loadFromGltf(gltf);
        infoEl.textContent = `shared: ${label}\n` + infoEl.textContent;
        xferDone('Model received', 'you can now rotate, zoom and pan');
      } catch (err) {
        if (!isCurrentGen(gen)) return;
        infoEl.textContent = 'shared model load error: ' + (err?.message ?? err);
        xferError('shared model load error: ' + (err?.message ?? err));
      }
    }, (e) => {
      if (!isCurrentGen(gen)) return;
      infoEl.textContent = 'shared model load failed: ' + e.message;
      xferError(e.message);
    });
  } catch (e) {
    if (!isCurrentGen(gen)) return;
    infoEl.textContent = 'failed to load shared model: ' + e.message;
    xferError(e.message);
    // No ACK here: if the fetch/stream failed the model never arrived, so the
    // host should legitimately wait for its sendGuard rather than think we got
    // a model we didn't receive.
  }
}

// Host side: the model already exists on the server (we just uploaded it, or a
// guest is joining and will fetch it). Block with "Sending model to guest(s)…"
// until every other viewer ACKs that they loaded it.
let sendGuard = null;        // safety timer so a stalled guest can't block the host
function sendModelToPeers(m, ids) {
  if (!session || !session.connected) return;
  currentModel = m;
  const guests = ids && ids.length
    ? ids.filter((id) => roster.some((r) => r.id === id))
    // Wait on every member EXCEPT this client (the uploader). Using !isHost
    // assumed the host is always the sharer — when a guest shares, that wrongly
    // dropped the host from the wait-list and added the sharer to its own
    // pendingSend (which never ACKs), hanging the overlay for 30s.
    : roster.filter((r) => r.id !== session.id).map((r) => r.id);
  // Only wait on guests that haven't already ACKed this model (a fast guest may
  // have ACKed before this function ran — see onModelAck/ackedSend).
  const waiting = guests.filter((id) => !ackedSend.has(id));
  pendingSend = new Set(waiting);
  if (!waiting.length) {
    // Everyone already ACKed (or no guests) — nothing to wait for.
    xferDone('Model ready to share', 'all viewers confirmed');
    return;
  }
  xferBegin('Sending model to guest(s)…', `${waiting.length} waiting to load…`);
  if (sendGuard) clearTimeout(sendGuard);
  sendGuard = setTimeout(() => {
    if (!pendingSend.size) return;
    setSessionStatus('connected · host · send timed out');
    xferDone('Model sent', 'no ACK within 30s — continuing');
  }, 30000);
}

// POST a model buffer into the current session. Server converts STEP if needed
// and broadcasts {t:'model'} to the other members (not the uploader, who
// already has it). Once the upload lands, block until the guests ACK.
async function shareBuffer(buf, filename, kind) {
  if (!session || !session.connected) return;
  // New model share: reset the ACK tracking. ACKs that arrive during the upload
  // POST below (a fast guest can ACK before the host's POST returns) are
  // captured in ackedSend and honored by sendModelToPeers.
  ackedSend = new Set();
  pendingSend = new Set();
  const infoEl = document.getElementById('info');
  const verb = kind === 'glb' ? 'sharing' : 'converting + sharing';
  infoEl.textContent = `${verb} ${filename} to the session…`;
  try {
    const res = await fetch(`/sessions/${session.code}/model`, {
      method: 'POST',
      body: buf,
      headers: { 'x-filename': filename, 'x-kind': kind, 'x-uploader-id': session.id || '' },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}\n${errText.slice(-400)}`);
    }
    const j = await res.json().catch(() => ({}));
    const note = j.note || filename;
    infoEl.textContent = `shared ${note} · ${roster.length} viewer(s)\n` + infoEl.textContent;
    sendModelToPeers({ buf, filename, kind, note });
    return j;
  } catch (e) {
    console.error(e);
    infoEl.textContent = 'share failed:\n' + (e.message ?? e);
    xferError(e.message);
    return null;
  }
}

// ---- Camera sync: broadcast my camera, apply the others' camera ----
controls.addEventListener('change', () => {
  if (!session?.connected || applyingRemote) return;
  const now = performance.now();
  if (now - lastCamSent < CAM_INTERVAL) return;
  lastCamSent = now;
  try {
    session.ws.send(JSON.stringify({
      t: 'cam',
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    }));
  } catch {}
});

function applyRemoteCamera(pos, target) {
  if (!pos || !target || pos.length !== 3 || target.length !== 3) return;
  applyingRemote = true;
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.set(target[0], target[1], target[2]);
  controls.update();
  applyingRemote = false;
}

/* ============================ UI ============================ */
// Local loads: if we're in a session, also share the model with the other viewers.
document.getElementById('file').addEventListener('change', (e) => {
  // Multi-select: pick the CAD file (an .obj may be accompanied by its .mtl —
  // same stem, case-insensitive — which carries the part colours).
  const files = [...(e.target.files || [])];
  const isMtl = (n) => /\.mtl$/i.test(n || '');
  const f = files.find((x) => !isMtl(x.name)) || files[0];
  if (f) {
    const ext = f.name.toLowerCase();
    if (ext.endsWith('.step') || ext.endsWith('.stp') ||
        ext.endsWith('.igs') || ext.endsWith('.iges') || ext.endsWith('.obj')) {
      // importStep converts locally (so the opener sees it too) and, when in a
      // session, hands the resulting GLB to shareBuffer for the guests.
      // (Named "Step" from the first format; it covers every kernel-convertible
      // format — the server routes by the real file extension.)
      let mtlFile = null;
      if (ext.endsWith('.obj')) {
        const stem = f.name.replace(/\.[^.]+$/i, '').toLowerCase();
        mtlFile = files.find((x) => isMtl(x.name) && x.name.toLowerCase().startsWith(stem))
          || files.find((x) => isMtl(x.name)) || null;
      }
      importStep(f, mtlFile);
    } else {
      // Load locally, then hand off to the "sending model to guest(s)" step
      // IF a session is live by the time the model lands. Opening a model
      // before (or while) connecting must still reach the guests — lastLocalModel
      // covers the pre-session case, and this callback covers the mid-load case.
      loadFile(f, (buf) => {
        if (session?.connected) shareBuffer(buf, f.name, 'glb');
      });
    }
  }
  e.target.value = '';
});
document.getElementById('btn-frame').addEventListener('click', frameModel);
document.getElementById('btn-parts-all')?.addEventListener('click', () => setAllParts(true));
document.getElementById('btn-parts-none')?.addEventListener('click', () => setAllParts(false));

/* ---- Lighting controls ---- */
function bindLightSlider(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    LIGHTS[key].obj.intensity = parseFloat(el.value);
    const v = document.getElementById(id + '-val');
    if (v) v.textContent = `${parseFloat(el.value).toFixed(1)}`;
    broadcastLight();
  });
}
bindLightSlider('light-ambient', 'ambient');
bindLightSlider('light-key', 'key');
bindLightSlider('light-fill', 'fill');
bindLightSlider('light-front', 'front');
document.getElementById('light-reset')?.addEventListener('click', () => {
  Object.entries(LIGHTS).forEach(([k, cfg]) => {
    cfg.obj.intensity = cfg.def;
    const el = document.getElementById('light-' + k);
    if (el) el.value = cfg.def;
    const v = document.getElementById('light-' + k + '-val');
    if (v) v.textContent = cfg.def.toFixed(1);
  });
  broadcastLight();
});

/* ---- Animation controls ---- */
document.getElementById('anim-play')?.addEventListener('click', () => {
  animState.playing = !animState.playing;
  const playBtn = document.getElementById('anim-play');
  if (animState.playing) {
    const clips = (lastGltf && lastGltf.animations) || [];
    if (mixer && animState.clip >= 0 && animState.clip < clips.length) {
      const action = mixer.clipAction(clips[animState.clip]);
      action.setLoop(animState.loop ? THREE.LoopRepeat : THREE.LoopOnce);
      action.clampWhenFinished = !animState.loop;
      action.play();
    }
    playBtn.textContent = '⏸ Pause';
  } else {
    if (mixer) mixer.stopAllAction();
    playBtn.textContent = '▶ Play';
  }
  broadcastAnim();
});
document.getElementById('anim-loop')?.addEventListener('change', (e) => {
  animState.loop = e.target.checked;
  if (animState.clip >= 0) applyClip(animState.clip);
  broadcastAnim();
});
document.getElementById('anim-clip')?.addEventListener('change', (e) => {
  animState.clip = parseInt(e.target.value, 10);
  applyClip(animState.clip);
  broadcastAnim();
});
document.getElementById('anim-speed')?.addEventListener('input', (e) => {
  animState.speed = parseFloat(e.target.value);
  const v = document.getElementById('anim-speed-val');
  if (v) v.textContent = `${animState.speed.toFixed(1)}×`;
  broadcastAnim();
});
refreshAnimUI();

/* ---- Animation + lighting sync over the session ---- */
function currentAnimState() {
  return { clip: animState.clip, playing: animState.playing, loop: animState.loop, speed: animState.speed };
}
function broadcastAnim() {
  if (!session?.connected) return;
  try { session.ws.send(JSON.stringify({ t: 'anim', s: currentAnimState() })); } catch {}
}
function applyRemoteAnim(s) {
  if (!s) return;
  const clips = (lastGltf && lastGltf.animations) || [];
  // If no animated model is loaded yet, buffer the state and apply it once a
  // model (with clips) arrives — mirrors how parts state is deferred.
  if (!clips.length) { pendingRemoteAnim = s; animState.playing = !!s.playing; animState.loop = !!s.loop; if (typeof s.speed === 'number') animState.speed = s.speed; return; }
  pendingRemoteAnim = null;
  if (typeof s.clip === 'number' && s.clip >= 0 && s.clip < clips.length) {
    animState.clip = s.clip;
    if (mixer) { mixer.stopAllAction(); const a = mixer.clipAction(clips[s.clip]); a.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce); a.clampWhenFinished = !s.loop; if (s.playing) a.play(); }
  }
  animState.playing = !!s.playing;
  animState.loop = !!s.loop;
  if (typeof s.speed === 'number') animState.speed = s.speed;
  refreshAnimUI();
}
function currentLightState() {
  return { ambient: hemi.intensity, key: key.intensity, fill: fill.intensity, front: front.intensity };
}
function broadcastLight() {
  if (!session?.connected) return;
  try { session.ws.send(JSON.stringify({ t: 'light', s: currentLightState() })); } catch {}
}
function applyRemoteLight(s) {
  if (!s) return;
  if (typeof s.ambient === 'number') hemi.intensity = s.ambient;
  if (typeof s.key === 'number') key.intensity = s.key;
  if (typeof s.fill === 'number') fill.intensity = s.fill;
  if (typeof s.front === 'number') front.intensity = s.front;
  const ids = { ambient: 'light-ambient', key: 'light-key', fill: 'light-fill', front: 'light-front' };
  Object.entries(ids).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.value = currentLightState()[k];
    const v = document.getElementById(id + '-val');
    if (v) v.textContent = currentLightState()[k].toFixed(1);
  });
}

/* ---- Session controls ---- */
function newSessionCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
document.getElementById('btn-create-session').addEventListener('click', () => {
  connectTo(newSessionCode(), { create: true });
});
document.getElementById('btn-join-session').addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) { setSessionStatus('enter a session code'); return; }
  connectTo(code);
});
joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-session').click();
});
document.getElementById('btn-leave-session').addEventListener('click', () => {
  if (session) { try { session.ws.close(); } catch {} session = null; }
  roster = []; renderRoster();
  setSessionStatus('not in a session');
  showSessionUI(false);
  document.getElementById('chk-rotate').disabled = false;
  // a transfer in flight no longer has a session to land in
  pendingSend.clear();
  currentModel = null;
  if (sendGuard) clearTimeout(sendGuard);
  xferAbort();
});
sessionCodeEl?.addEventListener('click', () => {
  navigator.clipboard?.writeText(sessionCodeEl.textContent).catch(() => {});
});

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

const animClock = new THREE.Clock();
let mixer = null;          // AnimationMixer for the loaded GLB's clips
let animState = { playing: true, loop: true, speed: 1, clip: -1 };
let pendingRemoteAnim = null;   // anim state received before a model loaded

renderer.setAnimationLoop(() => {
  const dt = Math.min(animClock.getDelta(), 0.1);
  if (mixer) mixer.update(dt * animState.speed);
  controls.update();
  renderer.render(scene, camera);
});

// ---- Viewer identity: ask for a name on launch and reuse it across sessions.
// Persisted so it isn't re-asked every reload, but the user can change it.
let userName = '';
function askName() {
  let name = '';
  try { name = (localStorage.getItem('cadv_name') || '').trim(); } catch {}
  const entered = (window.prompt('Enter your name (shown to other viewers):', name) || '').trim().slice(0, 24);
  if (entered) {
    userName = entered;
    try { localStorage.setItem('cadv_name', entered); } catch {}
  } else {
    userName = name || 'viewer';
  }
  return userName;
}
askName();

// Boot: if a ?s=CODE param is present, join that session (guest deep-link) and
// load whatever model it has. Otherwise start empty — the user opens a model.
const bootSession = new URLSearchParams(location.search).get('s')?.toUpperCase();
if (bootSession) {
  connectTo(bootSession);   // 'joined' (with model info) triggers loadSharedModel
}

// debug hook for headless verification
window.__viewer = {
  get model() { return model; },
  get scale() { return modelScale; },
  get THREE() { return THREE; },
  get session() { return session; },
  get roster() { return roster; },
  get controls() { return controls; },
  get xferLog() { return xferLog.slice(); },
  xferLogReset: () => xferLogReset(),
  get xferBlocking() { return xferBlocking; },
  cameraPos: () => [camera.position.x, camera.position.y, camera.position.z],
  cameraTarget: () => [controls.target.x, controls.target.y, controls.target.z],
  moveCamera: (pos, target) => { applyRemoteCamera(pos, target); return true; },
  // Source-side move: sets camera + target and calls controls.update() so a real
  // 'change' fires and the camera is broadcast to the session (for testing).
  pushCam: (pos, target) => {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
    return true;
  },
  // Test helpers: drive the real create/share paths and report the result.
  createSession: () => { const c = newSessionCode(); connectTo(c, { create: true }); return c; },
  joinSession: (code) => { connectTo(code); return code; },
  loadUrl: (url) => loadUrl(url),
  loadFile: (file) => loadFile(file),
  importStep: (file) => importStep(file),
  // Drive the REAL share path (with x-uploader-id) so the host's "sending model
  // to guest(s)" overlay and the server's "skip the uploader" broadcast are
  // exercised exactly as a user would trigger them.
  shareBuffer: (buf, filename, kind) => shareBuffer(buf, filename, kind),
  // Expose the model bytes the host currently holds (for assertions).
  get currentModelNote() { return currentModel ? currentModel.note : null; },
  // Force-clear the "sending" overlay for a test (bypasses the 30s guard).
  forceSendDone: () => { pendingSend.clear(); if (sendGuard) clearTimeout(sendGuard); xferDone('Model sent to guest(s)', 'control restored'); },
};
