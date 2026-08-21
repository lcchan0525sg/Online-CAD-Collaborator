// CAD Viewer — scene module (extracted from main.js).

import * as THREE from 'three';
import { GridHelper } from 'three';
import { ctx } from './context.js';

import { buildPartsTree, captureMeshBases, clearPartSelection, clearPartsTree, clearTransparency, flushPendingParts, flushPendingTrans } from './parts.js';
import { flushPendingMeasures, measureClear } from './measure.js';
import { applyExplodeGap, computeExplodeDirs, renderExplodeScope, resetExplode } from './explode.js';
import { buildRotateArc, makeArrow, saveOriginalPositions, saveOriginalRotations, setMoveAxis, setRotateMode, updateUndoState } from './move.js';
import { applyRemoteAnim, broadcastAnim, broadcastLight, esc, setHealth, shareBuffer, streamBytes, xferBegin, xferDone, xferError, xferProgress } from './session.js';
import { applyModelCorrections } from './model.js';

ctx.scene.background = new THREE.Color(0x141822);

ctx.camera.position.set(1.2, 1.0, 1.6);

ctx.renderer.shadowMap.enabled = true;

ctx.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping;

ctx.renderer.toneMappingExposure = 1.05;

ctx.renderer.outputColorSpace = THREE.SRGBColorSpace;

ctx.stage.appendChild(ctx.renderer.domElement);

ctx.controls.enableDamping = true;

ctx.controls.dampingFactor = 0.08;

ctx.controls.maxPolarAngle = Math.PI * 0.495;

ctx.scene.add(ctx.hemi);

ctx.key.position.set(1.6, 2.6, 1.4);

ctx.key.castShadow = true;

ctx.key.shadow.mapSize.set(2048, 2048);

ctx.key.shadow.bias = -0.0002;

ctx.scene.add(ctx.key);

ctx.fill.position.set(-1.8, 1.2, -1.2);

ctx.scene.add(ctx.fill);

ctx.front.position.set(0.0, 0.8, 2.2);

ctx.scene.add(ctx.front);

export function makeGrid(size) {
  if (ctx.grid) { ctx.scene.remove(ctx.grid); ctx.grid.geometry.dispose(); }
  ctx.grid = new GridHelper(size, size, 0x3a4356, 0x232b3a);
  ctx.scene.add(ctx.grid);
}

export function nextLoadGen() { return ++ctx.modelGen; }

export function isCurrentGen(gen) { return gen === ctx.modelGen; }

export function orientModel(root) {
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

export function clearModel() {
  if (!ctx.model) return;
  if (typeof clearTransparency === 'function') clearTransparency();
  if (typeof measureClear === 'function') measureClear();
  if (typeof resetExplode === 'function') resetExplode();
  if (typeof setMoveAxis === 'function') setMoveAxis(null);
  if (typeof setRotateMode === 'function') setRotateMode(false);
  if (typeof ctx.originalPositions !== 'undefined') ctx.originalPositions.clear();
  if (typeof ctx.originalRotations !== 'undefined') ctx.originalRotations.clear();
  ctx.transformHistory.length = 0;
  ctx.transformRedo.length = 0;
  ctx.pivotByPath.clear();
  if (ctx.rotateArc) { ctx.rotateArc.visible = false; ctx.rotateArcArrow.visible = false; }
  if (typeof ctx.moveGizmo !== 'undefined' && ctx.moveGizmo) ctx.moveGizmo.visible = false;
  ctx.scene.remove(ctx.model);
  ctx.model.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    }
  });
  ctx.model = null;
  if (ctx.mixer) { ctx.mixer.stopAllAction(); ctx.mixer = null; }
  clearPartsTree();
  clearPartSelection();
  window.dispatchEvent(new Event('viewer-model-cleared'));
}

// Common framing math: returns { center, maxDim, dist } for the current model.
function framing() {
  const box = new THREE.Box3().setFromObject(ctx.model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = (maxDim / 2) / Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)) * 1.6;
  return { center, maxDim, dist };
}

export function fitModelPreserveView() {
  if (!ctx.model) return;
  const { center, dist } = framing();
  const direction = ctx.camera.position.clone().sub(ctx.controls.target);
  if (direction.lengthSq() < 1e-8) direction.set(0.7, 0.55, 0.85);
  direction.normalize();
  ctx.controls.target.copy(center);
  ctx.camera.position.copy(center).addScaledVector(direction, dist);
  ctx.camera.near = dist / 1000;
  ctx.camera.far = dist * 1000;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
  setActivePreset(null);
}

export function frameModel() {
  if (!ctx.model) return;
  const { center, maxDim, dist } = framing();
  ctx.controls.target.copy(center);
  ctx.camera.up.set(0, 1, 0);
  ctx.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.85);
  ctx.camera.near = dist / 1000;
  ctx.camera.far = dist * 1000;
  ctx.camera.updateProjectionMatrix();
  ctx.controls.update();
  setActivePreset(null);

  // grid + shadow light sized to the model
  const g = maxDim * 3;
  if (document.getElementById('chk-grid').checked) makeGrid(g);
  ctx.key.position.set(center.x + g * 0.4, center.y + g * 0.6, center.z + g * 0.35);
  ctx.key.shadow.camera.left = -g; ctx.key.shadow.camera.right = g;
  ctx.key.shadow.camera.top = g; ctx.key.shadow.camera.bottom = -g;
  ctx.key.shadow.camera.far = g * 6;
  ctx.key.shadow.camera.updateProjectionMatrix();
}

let presetApplying = false;
const presetButtons = [...document.querySelectorAll('#view-presets .vp-btn')];

function setActivePreset(view) {
  for (const button of presetButtons) {
    const active = !!view && button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

ctx.controls.addEventListener('change', () => {
  if (!presetApplying) setActivePreset(null);
});

// Standard preset views (front/back/left/right/top/bottom/iso) around the model.
export function setPresetView(view) {
  if (!ctx.model) return;
  const { center, dist } = framing();
  ctx.controls.target.copy(center);
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  switch (view) {
    case 'front':  pos.set(center.x, center.y, center.z + dist); break;
    case 'back':   pos.set(center.x, center.y, center.z - dist); break;
    case 'left':   pos.set(center.x - dist, center.y, center.z); break;
    case 'right':  pos.set(center.x + dist, center.y, center.z); break;
    case 'top':    pos.set(center.x, center.y + dist, center.z); up.set(0, 0, -1); break;
    case 'bottom': pos.set(center.x, center.y - dist, center.z); up.set(0, 0, 1); break;
    case 'iso':
    default:       pos.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.85); break;
  }
  ctx.camera.up.copy(up);
  ctx.camera.position.copy(pos);
  presetApplying = true;
  ctx.controls.update();
  presetApplying = false;
  setActivePreset(view);
}

document.getElementById('vp-fit')?.addEventListener('click', fitModelPreserveView);
document.querySelectorAll('#view-presets .vp-btn[data-view]').forEach((b) => {
  b.addEventListener('click', () => setPresetView(b.dataset.view));
});


export function showInfo(gltf, root, fileMaxDim) {
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
  const units = ctx.modelScale !== 1
    ? (fileMaxDim > 10 ? ` (file units mm → m ×${ctx.modelScale})` : ` (normalized ×${ctx.modelScale.toFixed(3)})`)
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

export function loadFromGltf(gltf) {
  clearModel();
  ctx.lastGltf = gltf;
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
  ctx.modelScale = maxDim > 10 ? 1 / 1000 : 1.0 / maxDim;

  ctx.model = new THREE.Group();
  ctx.model.scale.setScalar(ctx.modelScale);
  ctx.model.add(root);
  ctx.model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  orientModel(ctx.model);
  ctx.modelBaseRot.setFromEuler(ctx.model.rotation);   // preserve the auto-orientation
  // rebase onto the ground plane (grid sits at y=0)
  const box2 = new THREE.Box3().setFromObject(ctx.model);
  ctx.model.position.y -= box2.min.y;
  ctx.scene.add(ctx.model);
  applyModelCorrections();   // apply per-viewer scale / flip / rotate corrections
  setupAnimation(gltf, root);
  // In a session, push the current animation + lighting state so every viewer
  // (including ones that joined mid-load) converges on the same settings.
  if (ctx.session?.connected) { broadcastAnim(); broadcastLight(); }
  frameModel();
  showInfo(gltf, ctx.model, maxDim);
  buildPartsTree(root);
  if (typeof captureMeshBases === 'function') captureMeshBases(root);
  if (typeof saveOriginalPositions === 'function') saveOriginalPositions();
  if (typeof saveOriginalRotations === 'function') saveOriginalRotations();
  flushPendingParts();
  if (typeof flushPendingMeasures === 'function') flushPendingMeasures();
  if (typeof flushPendingTrans === 'function') flushPendingTrans();
  if (typeof computeExplodeDirs === 'function') computeExplodeDirs();
  // Re-apply any stored explode state on the fresh model (move from rest by the
  // full gap, not a zero delta).
  if (typeof ctx.explodeGap !== 'undefined' && ctx.explodeGap) {
    const g = ctx.explodeGap; ctx.explodeGap = 0; applyExplodeGap(g);
  } else if (typeof renderExplodeScope === 'function') {
    renderExplodeScope();
  }
  document.getElementById('hud').querySelector('h1').textContent = 'CAD Viewer';
  window.dispatchEvent(new Event('viewer-model-loaded'));
}

export function setupAnimation(gltf, root) {
  const clips = (gltf && (gltf.animations || [])) || [];
  if (ctx.mixer) { ctx.mixer.stopAllAction(); ctx.mixer = null; }
  if (!clips.length) { ctx.animState.clip = -1; refreshAnimUI(); return; }
  // Start PAUSED at frame 0. If we auto-played here, each viewer (host and
  // every guest) would start from its own load instant and drift out of
  // frame-sync; pausing lets everyone start at the same state and the host
  // controls play via the synced Animation controls.
  ctx.animState.clip = 0;
  ctx.animState.playing = false;
  ctx.mixer = new THREE.AnimationMixer(root);
  applyClip(0);
  refreshAnimUI();
  // A remote anim state may have arrived before this model loaded — apply it now.
  if (ctx.pendingRemoteAnim) { const s = ctx.pendingRemoteAnim; ctx.pendingRemoteAnim = null; applyRemoteAnim(s); }
}

export function applyClip(i) {
  if (!ctx.mixer) return;
  const clips = (ctx.lastGltf && ctx.lastGltf.animations) || [];
  if (i < 0 || i >= clips.length) return;
  ctx.mixer.stopAllAction();
  const action = ctx.mixer.clipAction(clips[i]);
  action.setLoop(ctx.animState.loop ? THREE.LoopRepeat : THREE.LoopOnce);
  action.clampWhenFinished = !ctx.animState.loop;
  if (ctx.animState.playing) action.play();
}

export function refreshAnimUI() {
  const animSection = document.getElementById('anim-section');
  const clipSel = document.getElementById('anim-clip');
  if (!animSection) return;
  const clips = (ctx.lastGltf && ctx.lastGltf.animations) || [];
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
    clipSel.value = ctx.animState.clip;
  }
  const playBtn = document.getElementById('anim-play');
  if (playBtn) playBtn.textContent = ctx.animState.playing ? '⏸ Pause' : '▶ Play';
  document.getElementById('anim-loop').checked = ctx.animState.loop;
  document.getElementById('anim-speed').value = ctx.animState.speed;
  document.getElementById('anim-speed-val').textContent = `${ctx.animState.speed.toFixed(1)}×`;
}

ctx.dracoLoader.setDecoderPath('./node_modules/three/examples/jsm/libs/draco/');

ctx.loader.setDRACOLoader(ctx.dracoLoader);

export function loadUrl(url) {
  const gen = nextLoadGen();
  ctx.loader.load(url, (gltf) => { if (isCurrentGen(gen)) loadFromGltf(gltf); },
    (ev) => { if (ev.total) console.log('progress', (ev.loaded / ev.total * 100).toFixed(0) + '%'); },
    (err) => {
      console.error(err);
      document.getElementById('info').textContent = 'load failed: ' + (err.message ?? err);
    });
}

export function loadFile(file, afterLoad) {
  const reader = new FileReader();
  const gen = nextLoadGen();
  const p = new Promise((resolve) => {
    reader.onload = () => {
      const buf = reader.result;
      const finish = (ok, err) => {
        if (ok) {
          ctx.lastLocalModel = { buf, filename: file.name, kind: 'glb' };
          if (afterLoad) afterLoad(buf);
        }
        resolve(ok ? true : (err || false));
      };
      if (file.name.toLowerCase().endsWith('.glb')) {
        ctx.loader.parse(buf, '', (gltf) => { if (isCurrentGen(gen)) { loadFromGltf(gltf); finish(true); } else resolve(false); }, (e) => {
          document.getElementById('info').textContent = 'parse failed: ' + e.message;
          finish(false, e.message);
        });
      } else {
        // .gltf (JSON) — parse directly; external resources must be embedded
        try {
          const json = JSON.parse(new TextDecoder().decode(buf));
          ctx.loader.parse(json, '', (gltf) => { if (isCurrentGen(gen)) { loadFromGltf(gltf); finish(true); } else resolve(false); }, (e) => {
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

export async function importStep(file) {
  const infoEl = document.getElementById('info');
  const gen = nextLoadGen();
  const inSession = !!(ctx.session && ctx.session.connected);
  const isStl = /\.stl$/i.test(file.name);
  xferBegin('Converting CAD file…', isStl ? `Host-side STL → GLB — ${file.name}` : `OpenCascade kernel · Docker — ${file.name}`);
  infoEl.textContent = isStl
    ? `converting ${file.name} to GLB…\n(pure JS, host-side — instant)`
    : `converting ${file.name} to GLB…\n(OpenCascade kernel · Docker — allow a few seconds)`;
  const t0 = performance.now();
  try {
    const headers = {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': file.name,
    };
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
    ctx.loader.parse(buf.buffer, '', (gltf) => {
      if (!isCurrentGen(gen)) return;
      // loadFromGltf builds the parts tree, info and frames the camera. If it
      // throws (e.g. a very large conversion with thousands of primitive
      // meshes), we must still clear the blocking overlay — otherwise it hangs
      // forever.
      try {
        loadFromGltf(gltf);
      } catch (err) {
        if (!isCurrentGen(gen)) return;
        infoEl.textContent = 'model load error: ' + (err?.message ?? err);
        xferError('model load error: ' + (err?.message ?? err));
        return;
      }
      let srcLine = `source: ${file.name} (converted to GLB in ${dt}s)`;
      infoEl.textContent = srcLine + '\n' + infoEl.textContent;
      ctx.lastLocalModel = { buf, filename: file.name, kind: 'glb' };
      // In a session the model is also pushed to the guests once the local
      // parse has landed — share the converted GLB and hold the overlay until
      // every guest ACKs it. (buf is already GLB here, so kind is 'glb'.)
      if (inSession && ctx.session) {
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

setHealth('unknown');

document.querySelectorAll('.collapse-toggle').forEach((btn) => {
  const body = btn.closest('section')?.querySelector('.collapse-body');
  if (!body) return;
  btn.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
});

new MutationObserver(() => {
  ctx.xferLog.push({
    hidden: ctx.xferOverlayEl.hidden,
    title: ctx.xferTitleEl.textContent,
    fill: ctx.xferFillEl.style.width,
    blocking: ctx.xferBlocking,
  });
  if (ctx.xferLog.length > 400) ctx.xferLog.shift();
}).observe(ctx.xferOverlayEl, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });

document.getElementById('file').addEventListener('change', (e) => {
  // Multi-select: pick the CAD file.
  const files = [...(e.target.files || [])];
  const f = files[0];
  if (f) {
    const ext = f.name.toLowerCase();
    if (ext.endsWith('.step') || ext.endsWith('.stp') ||
        ext.endsWith('.igs') || ext.endsWith('.iges') ||
        ext.endsWith('.stl')) {
      // importStep converts locally (so the opener sees it too) and, when in a
      // session, hands the resulting GLB to shareBuffer for the guests.
      // (Named "Step" from the first format; it covers every kernel-convertible
      // format — the server routes by the real file extension.)
      importStep(f);
    } else {
      // Load locally, then hand off to the "sending model to guest(s)" step
      // IF a session is live by the time the model lands. Opening a model
      // before (or while) connecting must still reach the guests — lastLocalModel
      // covers the pre-session case, and this callback covers the mid-load case.
      loadFile(f, (buf) => {
        if (ctx.session?.connected) shareBuffer(buf, f.name, 'glb');
      });
    }
  }
  e.target.value = '';
});



export function bindLightSlider(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    ctx.LIGHTS[key].obj.intensity = parseFloat(el.value);
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
  Object.entries(ctx.LIGHTS).forEach(([k, cfg]) => {
    cfg.obj.intensity = cfg.def;
    const el = document.getElementById('light-' + k);
    if (el) el.value = cfg.def;
    const v = document.getElementById('light-' + k + '-val');
    if (v) v.textContent = cfg.def.toFixed(1);
  });
  broadcastLight();
});

document.getElementById('anim-play')?.addEventListener('click', () => {
  ctx.animState.playing = !ctx.animState.playing;
  const playBtn = document.getElementById('anim-play');
  if (ctx.animState.playing) {
    const clips = (ctx.lastGltf && ctx.lastGltf.animations) || [];
    if (ctx.mixer && ctx.animState.clip >= 0 && ctx.animState.clip < clips.length) {
      const action = ctx.mixer.clipAction(clips[ctx.animState.clip]);
      action.setLoop(ctx.animState.loop ? THREE.LoopRepeat : THREE.LoopOnce);
      action.clampWhenFinished = !ctx.animState.loop;
      action.play();
    }
    playBtn.textContent = '⏸ Pause';
  } else {
    if (ctx.mixer) ctx.mixer.stopAllAction();
    playBtn.textContent = '▶ Play';
  }
  broadcastAnim();
});

document.getElementById('anim-loop')?.addEventListener('change', (e) => {
  ctx.animState.loop = e.target.checked;
  if (ctx.animState.clip >= 0) applyClip(ctx.animState.clip);
  broadcastAnim();
});

document.getElementById('anim-clip')?.addEventListener('change', (e) => {
  ctx.animState.clip = parseInt(e.target.value, 10);
  applyClip(ctx.animState.clip);
  broadcastAnim();
});

document.getElementById('anim-speed')?.addEventListener('input', (e) => {
  ctx.animState.speed = parseFloat(e.target.value);
  const v = document.getElementById('anim-speed-val');
  if (v) v.textContent = `${ctx.animState.speed.toFixed(1)}×`;
  broadcastAnim();
});

refreshAnimUI();

ctx.wire.addEventListener('change', () => {
  if (!ctx.model) return;
  ctx.model.traverse((o) => {
    if (o.isMesh && o.material && o.material.wireframe !== undefined) {
      o.material.wireframe = ctx.wire.checked;
    }
  });
});

ctx.gridChk.addEventListener('change', () => {
  if (ctx.gridChk.checked) makeGrid(Math.max(2, (new THREE.Box3().setFromObject(ctx.model ?? new THREE.Object3D()).getSize(new THREE.Vector3()).x) * 3));
  else if (ctx.grid) { ctx.scene.remove(ctx.grid); ctx.grid.geometry.dispose(); ctx.grid = null; }
});

ctx.rotateChk.addEventListener('change', () => { ctx.controls.autoRotate = ctx.rotateChk.checked; ctx.controls.autoRotateSpeed = 1.2; });

ctx.controls.autoRotate = ctx.rotateChk.checked;

document.addEventListener('keyup', (e) => { /* keep axis until re-pressed/off */ });

updateUndoState();

ctx.scene.add(ctx.moveGizmo);

['x', 'y', 'z'].forEach((a) => { ctx.moveGizmoArrows[a] = makeArrow(a); });
buildRotateArc();

export function resize() {
  const w = ctx.stage.clientWidth, h = ctx.stage.clientHeight;
  if (!w || !h) return;
  ctx.renderer.setSize(w, h, false);
  ctx.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(ctx.stage);

resize();

;
