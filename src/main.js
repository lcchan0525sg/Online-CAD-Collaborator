// CAD Viewer — app entry. Imports every feature module (so their top-level
// listeners run), then the render loop, boot, and the debug hooks.
import * as THREE from 'three';
import { ctx } from './context.js';
import './scene.js'; import './parts.js'; import './measure.js'; import './explode.js'; import './move.js'; import './session.js';
import './interaction.js'; import './section.js'; import './theme.js';
import { importStep, loadFile, loadUrl } from './scene.js';
import { clearPartSelection, nodeAtPath, partIsSelected, partIsTransparent, partTransparent, selectPart, setPartTransparent, setPartVisible, showPartMenu } from './parts.js';
import { commitMeasurement, measureClear, measureEnsureVisuals, pickNearestCorner, updateMeasureStatus } from './measure.js';
import { explodeScopeNode, explodeSet } from './explode.js';
import { updateMoveGizmo } from './move.js';
import { applyRemoteCamera, askName, broadcastCorrections, connectTo, downloadChat, ensureName, fmtTime, loadSharedModel, newSessionCode, sendChat, sendPartComment, shareBuffer, xferDone, xferLogReset } from './session.js';
import { setPresetView } from './scene.js';
import { setPivotMode, setRotateMode, undoTransform, redoTransform, rememberActivePivot, broadcastTransform } from './move.js';
import { addSectionPreset, applySectionState, exportSectionPng, exportSectionSvg, removeSectionPreset, resetSection, sectionPresetsState, sectionState } from './section.js';
import { applyModelCorrections, resetModelCorrections, applyUnits } from './model.js';
import { formatMm } from './measure.js';

ctx.renderer.setAnimationLoop(() => {
  const dt = Math.min(ctx.animClock.getDelta(), 0.1);
  if (ctx.mixer) ctx.mixer.update(dt * ctx.animState.speed);
  ctx.controls.update();
  if (typeof updateMoveGizmo === 'function') updateMoveGizmo();
  ctx.renderer.render(ctx.scene, ctx.camera);
});

const bootSession = new URLSearchParams(location.search).get('s')?.toUpperCase();

if (bootSession) {
  ensureName();   // deep-link join at boot: no prompt, use stored name
  connectTo(bootSession);   // 'joined' (with model info) triggers loadSharedModel
}

window.__viewer = {
  get model() { return ctx.model; },
  get scale() { return ctx.modelScale; },
  get THREE() { return THREE; },
  get session() { return ctx.session; },
  get userName() { return ctx.userName; },
  get roster() { return ctx.roster; },
  get controls() { return ctx.controls; },
  get xferLog() { return ctx.xferLog.slice(); },
  xferLogReset: () => xferLogReset(),
  get xferBlocking() { return ctx.xferBlocking; },
  cameraPos: () => [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
  cameraTarget: () => [ctx.controls.target.x, ctx.controls.target.y, ctx.controls.target.z],
  moveCamera: (pos, target) => { applyRemoteCamera(pos, target); return true; },
  // Source-side move: sets camera + target and calls controls.update() so a real
  // 'change' fires and the camera is broadcast to the session (for testing).
  pushCam: (pos, target) => {
    ctx.camera.position.set(pos[0], pos[1], pos[2]);
    ctx.controls.target.set(target[0], target[1], target[2]);
    ctx.controls.update();
    return true;
  },
  // Test helpers: drive the real create/share paths and report the result.
  createSession: () => { askName(); const c = newSessionCode(); connectTo(c, { create: true }); return c; },
  createSessionCode: (code) => { askName(); connectTo(code, { create: true }); return code; },
  joinSession: (code) => { askName(); connectTo(code); return code; },
  loadUrl: (url) => loadUrl(url),
  loadFile: (file) => loadFile(file),
  importStep: (file) => importStep(file),
  // Drive the REAL share path (with x-uploader-id) so the host's "sending model
  // to guest(s)" overlay and the server's "skip the uploader" broadcast are
  // exercised exactly as a user would trigger them.
  shareBuffer: (buf, filename, kind) => shareBuffer(buf, filename, kind),
  // Expose the model bytes the host currently holds (for assertions).
  get currentModelNote() { return ctx.currentModel ? ctx.currentModel.note : null; },
  // Force-clear the "sending" overlay for a test (bypasses the 30s guard).
  forceSendDone: () => { ctx.pendingSend.clear(); if (ctx.sendGuard) clearTimeout(ctx.sendGuard); xferDone('Model sent to guest(s)', 'control restored'); },
  // Debug: gizmo arrow world->screen positions (page coords; for headless tests).
  gizmoArrows: () => {
    const r = ctx.renderer.domElement.getBoundingClientRect();
    const to = (p) => ({ x: r.left + (p.x*0.5+0.5)*r.width, y: r.top + (-p.y*0.5+0.5)*r.height });
    const out = {};
    ['x','y','z'].forEach((ax) => {
      const a = ctx.moveGizmoArrows[ax];
      if (!a) return;
      // Cone sits at the arrow tip — project it (users click the arrowhead).
      const v = a.cone.getWorldPosition(new THREE.Vector3()).clone().project(ctx.camera);
      out[ax] = { ...to(v), visible: a.visible };
    });
    return out;
  },
  get moveAxis() { return ctx.moveAxis; },
  get gizmoVisible() { return ctx.moveGizmo.visible; },
  get rotateMode() { return ctx.rotateMode; },
  get pivotMode() { return ctx.pivotMode; },
  get pivot() { return ctx.customPivot ? [ctx.customPivot.x, ctx.customPivot.y, ctx.customPivot.z] : null; },
  get pivotKeys() { return [...ctx.pivotByPath.keys()]; },
  pivotFor: (key) => { const p = ctx.pivotByPath.get(key); return p ? [p.x, p.y, p.z] : null; },
  setPivot: (p) => { ctx.customPivot = p ? new THREE.Vector3(p[0], p[1], p[2]) : null; rememberActivePivot(); setPivotMode(!!p); updateMoveGizmo(); return window.__viewer.pivot; },
  setRotate: (on) => setRotateMode(!!on),
  sectionState: () => sectionState(),
  setSection: (state) => { applySectionState(state); return sectionState(); },
  resetSection: () => { resetSection(); return sectionState(); },
  sectionPresets: () => sectionPresetsState(),
  addSectionPreset: (name) => { addSectionPreset(name); return sectionPresetsState(); },
  removeSectionPreset: (id) => { removeSectionPreset(id); return sectionPresetsState(); },
  exportSectionSvg: () => exportSectionSvg(),
  exportSectionPng: () => exportSectionPng(),
  get sectionVisualsVisible() { return !!(ctx.sectionVisuals && ctx.sectionVisuals.visible); },
  get sectionContourCount() {
    const g = ctx.sectionContours && ctx.sectionContours.geometry;
    if (!g || !g.attributes || !g.attributes.position) return 0;
    return (g.attributes.position.count / 2) | 0; // segments = points / 2
  },
  sectionContourPoints: (max = 8) => {
    const g = ctx.sectionContours && ctx.sectionContours.geometry;
    const pos = g && g.attributes && g.attributes.position;
    if (!pos) return [];
    const out = [];
    for (let i = 0; i < pos.count && out.length < max * 2; i++) {
      out.push([+pos.getX(i).toFixed(3), +pos.getY(i).toFixed(3), +pos.getZ(i).toFixed(3)]);
    }
    return out;
  },
  get sectionPlaneColor() {
    return ctx.sectionPlaneMesh && ctx.sectionPlaneMesh.material
      ? '#' + ctx.sectionPlaneMesh.material.color.getHexString() : null;
  },
  sectionPlaneCenter: () => {
    const g = ctx.sectionVisuals;
    if (!g) return null;
    const p = g.getWorldPosition(new THREE.Vector3());
    return [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)];
  },
  lightIntensity: (k) => (ctx.LIGHTS[k] ? ctx.LIGHTS[k].obj.intensity : null),
  get units() { return ctx.units; },
  setUnits: (u) => { applyUnits(u); return ctx.units; },
  formatDist: (v) => formatMm(v),
  modelCorrections: () => ({ scale: ctx.modelScaleMult, flip: { ...ctx.modelFlip }, rot: { ...ctx.modelRot } }),
  setModelCorrections: (c) => {
    if (c && c.scale != null) ctx.modelScaleMult = c.scale;
    if (c && c.flip) ctx.modelFlip = { ...ctx.modelFlip, ...c.flip };
    if (c && c.rot) ctx.modelRot = { ...ctx.modelRot, ...c.rot };
    applyModelCorrections();
    broadcastCorrections();
    return { scale: ctx.modelScaleMult, flip: { ...ctx.modelFlip }, rot: { ...ctx.modelRot } };
  },
  resetModelCorrections: () => resetModelCorrections(),
  undoTransform: () => undoTransform(),
  redoTransform: () => redoTransform(),
  partActor: (key) => ctx.partLastActor.get(key) || null,
  broadcastMove: (key, pos, quat) => {
    const root = ctx.model && ctx.model.children[0];
    const node = root && nodeAtPath(root, key.split('.').map(Number));
    if (!node) return false;
    node.position.set(pos[0], pos[1], pos[2]);
    if (quat) node.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    node.updateMatrixWorld(true);
    broadcastTransform(key.split('.').map(Number), node);
    return true;
  },
  get transformHistoryLength() { return ctx.transformHistory.length; },
  get transformRedoLength() { return ctx.transformRedo.length; },
  get rotateArcVisible() { return !!(ctx.rotateArc && ctx.rotateArc.visible); },
  rotateArcPoints: () => {
    const a = ctx.rotateArc;
    if (!a || !a.geometry.attributes.position) return [];
    const r = ctx.renderer.domElement.getBoundingClientRect();
    a.updateMatrixWorld(true);
    const pos = a.geometry.attributes.position;
    const v = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < pos.count; i += 6) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      a.localToWorld(v);
      const p = v.clone().project(ctx.camera);
      out.push({ x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height });
    }
    return out;
  },
  presetView: (view) => setPresetView(view),
  partComment: (key, text) => sendPartComment(key, text),
  get measureOn() { return ctx.measureOn; },
  get measure() {
    return {
      on: ctx.measureOn,
      p1: ctx.measureP1 ? [ctx.measureP1.x, ctx.measureP1.y, ctx.measureP1.z] : null,
      glowVisible: !!(ctx.measureGlow && ctx.measureGlow.visible),
      glowPos: ctx.measureGlow && ctx.measureGlow.visible ? [ctx.measureGlow.position.x, ctx.measureGlow.position.y, ctx.measureGlow.position.z] : null,
      count: ctx.measureList.length,
      list: ctx.measureList.map((m) => ({ mm: m.mm, elevation: m.elevation, azimuth: m.azimuth, p1: m.p1, p2: m.p2 })),
      status: ctx.measureStatusEl ? ctx.measureStatusEl.textContent : '',
      labelVisible: !ctx.measureLabelEl.hidden,
      layerChildren: ctx.measureLayer ? ctx.measureLayer.children.length : 0,
    };
  },
  measureToggle: (on) => { ctx.measureOnChk.checked = !!on; ctx.measureOnChk.dispatchEvent(new Event('change')); return ctx.measureOn; },
  measureSnap: (clientX, clientY) => { const c = pickNearestCorner(clientX, clientY); return c ? [c.x, c.y, c.z] : null; },
  measureClick: (clientX, clientY) => {
    const c = pickNearestCorner(clientX, clientY);
    if (!c) return false;
    if (!ctx.measureP1) { ctx.measureP1 = c.clone(); if (ctx.measureP1Dot) { ctx.measureP1Dot.position.copy(c); ctx.measureP1Dot.visible = true; } updateMeasureStatus(); return 'p1'; }
    commitMeasurement(ctx.measureP1, c); return 'p2';
  },
  measureClear: () => { measureClear(); return true; },
  measureIds: () => ctx.measureList.map((m) => m.id),
  transSet: (key, on) => { setPartTransparent(key, !!on); return partTransparent(key); },
  transKeys: () => [...transparentParts],
  get transCount() { return ctx.transparentParts.size; },
  partMat: (key) => {
    const root = ctx.model.children[0];
    const node = nodeAtPath(root, key.split('.').map(Number));
    if (!node) return null;
    const res = [];
    node.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        res.push(mats.map((x) => ({ op: x.opacity, tr: x.transparent, em: x.emissiveIntensity })));
      }
    });
    return res;
  },
  openPartMenu: (key) => { showPartMenu(50, 50, key); return document.getElementById('part-menu-trans').textContent; },
  doSelect: (key) => { selectPart(key); return window.__selKey; },
  doDeselect: () => { clearPartSelection(); return window.__selKey; },
  get __selLen() { return ctx.selectedPartKey ? 1 : 0; },
  get meshDbg() { return { base: ctx.meshBase.size, part: ctx.meshPartKey.size }; },
  traceTrans: (key) => {
    const root = ctx.model.children[0];
    const node = nodeAtPath(root, key.split('.').map(Number));
    if (!node) return { err: 'no node' };
    let meshCount = 0, applied = 0, keys = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      meshCount++;
      keys.push(ctx.meshPartKey.get(o));
      const base = ctx.meshBase.get(o);
      const trans = partIsTransparent(ctx.meshPartKey.get(o) || '');
      const sel = partIsSelected(ctx.meshPartKey.get(o) || '');
      if (trans) applied++;
    });
    return { meshCount, applied, keys: [...new Set(keys)].slice(0, 5), transparentParts: [...transparentParts] };
  },
  partScreen: (key) => {
    const root = ctx.model.children[0];
    const n = nodeAtPath(root, key.split('.').map(Number));
    if (!n) return null;
    const b = new THREE.Box3().setFromObject(n);
    const c = b.getCenter(new THREE.Vector3()).clone().project(ctx.camera);
    const r = ctx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x * 0.5 + 0.5) * r.width, y: r.top + (-c.y * 0.5 + 0.5) * r.height };
  },
  sharedMats: (k1, k2) => {
    const root = ctx.model.children[0];
    const coll = (k) => { const s = new Set(); const n = nodeAtPath(root, k.split('.').map(Number)); if (n) n.traverse((o) => { if (o.isMesh && o.material) { const arr = Array.isArray(o.material) ? o.material : [o.material]; arr.forEach((m) => s.add(m.uuid)); } }); return s; };
    const a = coll(k1), b = coll(k2);
    return { p1: a.size, p2: b.size, shared: [...a].filter((u) => b.has(u)).length };
  },
  chatSend: (text) => { ctx.chatInputEl.value = text; sendChat(); return true; },
  chatDownload: () => downloadChat(),
  get userName() { return ctx.userName; },
  chatTranscript: () => {
    if (!ctx.chatHistory.length) return '';
    return ctx.chatHistory.map((m) => (m.system ? `[system] ${m.text}` : `${fmtTime(m.ts)}  ${m.name}: ${m.text}`)).join('\n');
  },
  get chatHistory() { return ctx.chatHistory.map((m) => ({ name: m.name, text: m.text, ts: m.ts, self: !!m.self, system: !!m.system })); },
  chatOpen: () => { if (ctx.chatWindowEl) ctx.chatWindowEl.hidden = false; return !ctx.chatWindowEl.hidden; },
  get explode() {
    return {
      gap: ctx.explodeGap, targets: ctx.explodeTargets.length, dir: ctx.explodeDir,
      scopeKey: ctx.explodeScopeKey, scopeName: ctx.explodeScopeName, nothing: ctx.explodeNothing,
    };
  },
  get explodeDiag() {
    const scope = explodeScopeNode();
    return {
      sel: ctx.selectedPartKey,
      scope: scope ? { name: scope.name, kids: (scope.children||[]).map(c => c.name), hasKids: (scope.children||[]).length } : null,
      targets: ctx.explodeTargets.map(t => ({ n: t.node.name, key: t.node.uuid })),
    };
  },
  get explodeTargets() { return ctx.explodeTargets.map((t) => ({ name: t.node.name, pos: t.axisPos, min: t.axisMin, ext: t.extent, rest: [t.resting.x, t.resting.y, t.resting.z] })); },
  get explodePos() {
    return ctx.explodeTargets.map((t) => {
      const p = t.node.position;
      return { n: t.node.name, x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) };
    });
  },
  partRowInfo: (key) => {
    const r = ctx.partRows.get(key);
    const all = ctx.allPartRows.filter((o) => o.key === key);
    return { hasRow: !!r, hasKids: all[0] ? all[0].hasKids : null, key };
  },
  explodeSet: (gap, dir) => explodeSet(gap, dir),
  explodeScope: () => explodeScopeNode()?.name || null,
  setPartVisible: (k, v) => { setPartVisible(k, v); return true; },
  projectWorld: (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(ctx.camera);
    const r = ctx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  },
  viewportRect: () => { const r = ctx.renderer.domElement.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; },
  get selectedPart() { return ctx.selectedPartKey; },
  partWorldPos: (key) => {
    const root = ctx.model && ctx.model.children[0];
    if (!root || !key) return null;
    const n = nodeAtPath(root, key.split('.').map(Number));
    if (!n) return null;
    const v = n.getWorldPosition(new THREE.Vector3()).clone().project(ctx.camera);
    const r = ctx.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x*0.5+0.5)*r.width, y: r.top + (-v.y*0.5+0.5)*r.height };
  },
  snapshotDataUrl: () => {
    ctx.renderer.render(ctx.scene, ctx.camera);
    return ctx.renderer.domElement.toDataURL('image/png');
  },
  addMeasure: (p1, p2, part1, part2) => {
    measureEnsureVisuals();
    commitMeasurement(new THREE.Vector3(...p1), new THREE.Vector3(...p2), part1 ? { partName: part1 } : null, part2 ? { partName: part2 } : null);
    return ctx.measureList.length;
  },
  dimensionLayer: () => {
    const el = ctx.measureAnnotationsEl;
    const svg = el && el.querySelector('svg');
    return {
      groups: svg ? svg.querySelectorAll('g').length : 0,
      arrowheads: svg ? svg.querySelectorAll('polygon').length : 0,
      texts: svg ? [...svg.querySelectorAll('text')].map((t) => t.textContent) : [],
    };
  },
}

// Viewport snapshot: capture the current view as a PNG and download it (local, no sync).
function snapshotView() {
  const data = ctx.renderer.domElement.toDataURL('image/png');
  if (!data || data === 'data:,') return;
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = data;
  a.download = `cad-view-${ts}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
document.getElementById('vp-snapshot')?.addEventListener('click', snapshotView);
