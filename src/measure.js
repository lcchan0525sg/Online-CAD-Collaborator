// CAD Viewer — measure module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';
import { t } from './ui-i18n.js';

import { clearPartSelection, selectPart, partNameForKey } from './parts.js';
import { isPickVisible, pickGizmoAxis, pickPartKey, setMoveAxis } from './move.js';
import { xferToast } from './session.js';

ctx.renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !ctx.pickDown) return;
  const moved = Math.hypot(e.clientX - ctx.pickDown.x, e.clientY - ctx.pickDown.y);
  ctx.pickDown = null;
  if (moved > 5) return;                 // orbit / move drag, not a click
  // In Measure mode a click snaps to a corner and commits the two-point measure.
  if (ctx.measureOn) {
    const c = pickNearestCorner(e.clientX, e.clientY);
    if (!c) { clearHoverGlow(); return; }
    ctx.measureGlow.position.copy(c);
    ctx.measureGlow.visible = true;
    if (!ctx.measureP1) {
      ctx.measureP1 = c.clone();
      ctx.measureP1Part = c.userData || null;
      if (ctx.measureP1Dot) { ctx.measureP1Dot.position.copy(c); ctx.measureP1Dot.visible = true; }
      updateMeasureStatus();
    } else {
      commitMeasurement(ctx.measureP1, c, ctx.measureP1Part, c.userData);
    }
    return;
  }
  // First, a click on a gizmo arrow sets the move axis (from "Move part" menu).
  const axis = pickGizmoAxis(e);
  if (axis) { setMoveAxis(axis); return; }
  const key = pickPartKey(e);
  if (key) selectPart(key, false, e.ctrlKey || e.metaKey);              // select or Ctrl-toggle
  else clearPartSelection();
});

ctx.scene.add(ctx.measureLayer);

export function setMeasureStatus(txt, active) {
  if (!ctx.measureStatusEl) return;
  ctx.measureStatusEl.textContent = txt;
  ctx.measureStatusEl.classList.toggle('active', !!active);
}

export function updateMeasureStatus() {
  if (!ctx.measureOn) setMeasureStatus(t('ui.off'), false);
  else if (ctx.measureP1) setMeasureStatus(t('ui.second.point'), true);
  else setMeasureStatus(t('ui.first.point'), true);
}

const MM_PER_IN = 25.4;

export function formatMm(v) {
  const mm = Math.abs(v) * 1000;            // scene is normalized mm->m, so 1 unit = 1000 mm
  if (ctx.units === 'in') {
    const inch = mm / MM_PER_IN;
    if (inch >= 100) return inch.toFixed(0) + ' in';
    if (inch >= 10) return inch.toFixed(1) + ' in';
    return inch.toFixed(2) + ' in';
  }
  if (mm >= 100) return mm.toFixed(0) + ' mm';
  if (mm >= 10) return mm.toFixed(1) + ' mm';
  return mm.toFixed(2) + ' mm';
}

export function measureDotSize() {
  if (!ctx.model) return 0.01;
  const s = new THREE.Sphere();
  new THREE.Box3().setFromObject(ctx.model).getBoundingSphere(s);
  return Math.max(0.002, s.radius * 0.015);
}

ctx.measureOnChk.addEventListener('change', () => {
  ctx.measureOn = ctx.measureOnChk.checked;
  if (ctx.measureOn && ctx.moveOnChk.checked) { ctx.moveOnChk.checked = false; setMoveAxis(null); }
  // Leaving the tool cancels only an unfinished two-point operation. Completed
  // measurements remain visible so switching to Select/Move does not destroy
  // useful inspection results.
  if (!ctx.measureOn) {
    ctx.measureP1 = null;
  ctx.measureP1Part = null;
    if (ctx.measureP1Dot) ctx.measureP1Dot.visible = false;
    clearHoverGlow();
  } else measureEnsureVisuals();
  updateMeasureStatus();
});

ctx.moveOnChk.addEventListener('change', () => {
  if (ctx.moveOnChk.checked && ctx.measureOnChk.checked) {
    ctx.measureOnChk.checked = false; ctx.measureOn = false;
    measureClear();
  }
});

export function computeMeshCorners(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return [];
  const index = geo.index ? geo.index.array : null;
  const nV = pos.count;
  const nTri = index ? index.length / 3 : nV / 3;
  const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3();
  const getV = (i, out) => out.fromBufferAttribute(pos, i);
  const triN = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const ia = index ? index[t * 3] : t * 3, ib = index ? index[t * 3 + 1] : t * 3 + 1, ic = index ? index[t * 3 + 2] : t * 3 + 2;
    getV(ia, _A); getV(ib, _B); getV(ic, _C);
    const n = new THREE.Vector3().subVectors(_B, _A).cross(new THREE.Vector3().subVectors(_C, _A)).normalize();
    triN[t * 3] = n.x; triN[t * 3 + 1] = n.y; triN[t * 3 + 2] = n.z;
  }
  const edgeKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  const edgeTris = new Map();
  for (let t = 0; t < nTri; t++) {
    const ia = index ? index[t * 3] : t * 3, ib = index ? index[t * 3 + 1] : t * 3 + 1, ic = index ? index[t * 3 + 2] : t * 3 + 2;
    for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const k = edgeKey(u, v);
      if (!edgeTris.has(k)) edgeTris.set(k, []);
      edgeTris.get(k).push(t);
    }
  }
  const COS_CREASE = Math.cos(THREE.MathUtils.degToRad(35));
  const vtxDirs = new Map();   // vertexIdx -> array of incident crease-edge unit dirs (local)
  const _p = new THREE.Vector3(), _q = new THREE.Vector3();
  for (const [k, tris] of edgeTris) {
    if (tris.length > 2) continue;                 // skip non-manifold
    const [a, b] = k.split(':').map(Number);
    let crease;
    if (tris.length === 1) crease = true;          // boundary edge
    else {
      const t0 = tris[0], t1 = tris[1];
      const n0 = new THREE.Vector3(triN[t0 * 3], triN[t0 * 3 + 1], triN[t0 * 3 + 2]);
      const n1 = new THREE.Vector3(triN[t1 * 3], triN[t1 * 3 + 1], triN[t1 * 3 + 2]);
      crease = Math.abs(n0.dot(n1)) < COS_CREASE;  // sharp dihedral
    }
    if (!crease) continue;
    getV(a, _p); getV(b, _q);
    const d = _q.clone().sub(_p).normalize();
    if (!vtxDirs.has(a)) vtxDirs.set(a, []);
    if (!vtxDirs.has(b)) vtxDirs.set(b, []);
    vtxDirs.get(a).push(d);
    vtxDirs.get(b).push(d.clone().negate());
  }
  const corners = [];
  for (const [vi, dirs] of vtxDirs) {
    const kept = [];
    let distinct = 0;
    for (const d of dirs) {
      let dup = false;
      for (const k of kept) { if (Math.abs(k.dot(d)) > 0.995) { dup = true; break; } }
      if (!dup) { kept.push(d.clone()); distinct++; }
    }
    if (distinct >= 2) { getV(vi, _p); corners.push(_p.clone()); }
  }
  return corners;
}

export function meshCorners(mesh) {
  if (ctx.measureCornerCache.has(mesh.uuid)) return ctx.measureCornerCache.get(mesh.uuid);
  const c = computeMeshCorners(mesh);
  ctx.measureCornerCache.set(mesh.uuid, c);
  return c;
}

export function pickNearestCorner(clientX, clientY) {
  if (!ctx.model) return null;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ctx.measureRay.setFromCamera(ndc, ctx.camera);
  const hits = ctx.measureRay.intersectObject(ctx.model, true);
  const hit = hits.find((h) => isPickVisible(h.object));
  if (!hit || !hit.object.isMesh) return null;
  const mesh = hit.object;
  const locals = meshCorners(mesh);
  if (!locals.length) return null;
  let best = null, bestD = ctx.MEASURE_TOL_PX;
  for (const lc of locals) {
    const wc = lc.clone().applyMatrix4(mesh.matrixWorld);
    const sp = wc.clone().project(ctx.camera);
    const sx = r.left + (sp.x * 0.5 + 0.5) * r.width;
    const sy = r.top + (-sp.y * 0.5 + 0.5) * r.height;
    const d = Math.hypot(clientX - sx, clientY - sy);
    if (d < bestD) { bestD = d; best = wc; }
  }
  if (best) {
    const key = ctx.meshPartKey.get(mesh) || '';
    best.userData = { partKey: key, partName: key ? partNameForKey(key) : mesh.name || t('ui.unknown.part') };
  }
  return best;
}

export function makeMeasureDot(color, size) {
  const dot = new THREE.Group();
  dot.userData.kind = 'measureMarker';
  dot.renderOrder = 10;
  const makeLine = (axis) => {
    const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0)
      : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const geometry = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-size), dir.clone().multiplyScalar(size),
    ]);
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.52, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 11;
    dot.add(line);
  };
  makeLine('x');
  makeLine('y');
  makeLine('z');
  const centre = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(size * 0.18, 0.004), 8, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, depthTest: false }));
  centre.renderOrder = 12;
  dot.add(centre);
  return dot;
}

export function measureEnsureVisuals() {
  const sz = measureDotSize();
  if (!ctx.measureGlow) {
    ctx.measureGlow = makeMeasureDot(0xffd166, sz * 1.4);
    ctx.measureGlow.visible = false;
    ctx.measureLayer.add(ctx.measureGlow);
  }
  if (!ctx.measureP1Dot) {
    ctx.measureP1Dot = makeMeasureDot(0x7cc4ff, sz * 1.1);
    ctx.measureP1Dot.visible = false;
    ctx.measureLayer.add(ctx.measureP1Dot);
  }
}

export function clearHoverGlow() { if (ctx.measureGlow) ctx.measureGlow.visible = false; ctx.measureLabelEl.hidden = true; }

export function broadcastMeasureAdd(entry) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'measure-add', id: entry.id, label: entry.label, part1: entry.part1, part2: entry.part2, p1: entry.p1, p2: entry.p2 })); } catch {}
}

export function broadcastMeasureDel(id) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'measure-del', id })); } catch {}
}

export function broadcastMeasureClear() {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'measure-clear' })); } catch {}
}

export function makeMeasureEntry(p1, p2, part1 = null, part2 = null) {
  const mm = p1.distanceTo(p2);
  const v = new THREE.Vector3().subVectors(p2, p1);
  const elevation = (mm > 1e-9) ? THREE.MathUtils.radToDeg(Math.asin(v.y / mm)) : 0;
  const azimuth = THREE.MathUtils.radToDeg(Math.atan2(v.z, v.x));
  return { id: 'm' + (++ctx.measureSeq), label: `M${ctx.measureSeq}`, part1: part1?.partName || t('ui.unknown.part'), part2: part2?.partName || t('ui.unknown.part'), p1: [p1.x, p1.y, p1.z], p2: [p2.x, p2.y, p2.z], mm, elevation, azimuth };
}

export function addMeasurement(entry, broadcast) {
  ctx.measureList.push(entry);
  renderMeasureList();
  rebuildDimensionLayer();
  if (broadcast) broadcastMeasureAdd(entry);
}

export function broadcastMeasureUpdate(id, label) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'measure-update', id, label })); } catch {}
}

export function updateMeasurementLabel(id, label, broadcast = true) {
  const m = ctx.measureList.find((entry) => entry.id === id);
  if (!m) return;
  m.label = (label || '').trim().slice(0, 80) || m.id.toUpperCase();
  renderMeasureList();
  if (broadcast && !ctx.applyingRemoteMeasure) broadcastMeasureUpdate(id, m.label);
}

export function removeMeasurement(id) {
  ctx.measureList = ctx.measureList.filter((m) => m.id !== id);
  rebuildMeasureLayer();
  renderMeasureList();
  rebuildDimensionLayer();
  if (!ctx.applyingRemoteMeasure) broadcastMeasureDel(id);
}

export function measureClear() {
  ctx.measureList = [];
  ctx.measureP1 = null;
  ctx.measureP1Part = null;
  clearHoverGlow();
  rebuildMeasureLayer();
  rebuildDimensionLayer();
  if (ctx.measureListEl) ctx.measureListEl.innerHTML = `<span class="hint">${t('ui.no.measurements')}</span>`;
  const panel = document.getElementById('floating-measurements');
  if (panel) panel.hidden = true;
  if (!ctx.applyingRemoteMeasure) broadcastMeasureClear();
}

export function applyRemoteMeasureAdd(msg) {
  if (!Array.isArray(msg.p1) || !Array.isArray(msg.p2) || !msg.id) return;
  if (!ctx.model) { ctx.pendingRemoteMeasures.push({ t: 'add', ...msg }); return; }
  ctx.applyingRemoteMeasure = true;
  try {
    const p1 = new THREE.Vector3(...msg.p1), p2 = new THREE.Vector3(...msg.p2);
    const entry = makeMeasureEntry(p1, p2);
    entry.id = msg.id;   // keep the sender's id so del matches
    entry.label = msg.label || entry.id.toUpperCase();
    entry.part1 = msg.part1 || t('ui.unknown.part');
    entry.part2 = msg.part2 || entry.part1;
    addMeasurement(entry, false);
  } finally { ctx.applyingRemoteMeasure = false; }
}

export function applyRemoteMeasureUpdate(msg) {
  if (!msg?.id) return;
  ctx.applyingRemoteMeasure = true;
  try { updateMeasurementLabel(msg.id, msg.label, false); } finally { ctx.applyingRemoteMeasure = false; }
}

export function applyRemoteMeasureDel(msg) {
  if (!ctx.model) { ctx.pendingRemoteMeasures.push({ t: 'del', ...msg }); return; }
  ctx.applyingRemoteMeasure = true;
  try { removeMeasurement(msg.id); } finally { ctx.applyingRemoteMeasure = false; }
}

export function applyRemoteMeasureClear() {
  if (!ctx.model) { ctx.pendingRemoteMeasures.push({ t: 'clear' }); return; }
  ctx.applyingRemoteMeasure = true;
  try { measureClear(); } finally { ctx.applyingRemoteMeasure = false; }
}

export function applyRemoteMeasureSync(measures) {
  if (!Array.isArray(measures)) return;
  if (!ctx.model) { ctx.pendingRemoteMeasures.push({ t: 'sync', measures }); return; }
  ctx.applyingRemoteMeasure = true;
  try {
    ctx.measureList = measures.map((m) => ({
      id: m.id, label: m.label || m.id.toUpperCase(), part1: m.part1 || t('ui.unknown.part'), part2: m.part2 || m.part1 || t('ui.unknown.part'), p1: m.p1, p2: m.p2,
      mm: new THREE.Vector3(...m.p1).distanceTo(new THREE.Vector3(...m.p2)),
      elevation: m.elevation, azimuth: m.azimuth,
    }));
    rebuildMeasureLayer();
    renderMeasureList();
    rebuildDimensionLayer();
  } finally { ctx.applyingRemoteMeasure = false; }
}

export function flushPendingMeasures() {
  if (!ctx.pendingRemoteMeasures.length || !ctx.model) return;
  const ops = ctx.pendingRemoteMeasures;
  ctx.pendingRemoteMeasures = [];
  for (const op of ops) {
    if (op.t === 'add') applyRemoteMeasureAdd(op);
    else if (op.t === 'del') applyRemoteMeasureDel(op);
    else if (op.t === 'clear') applyRemoteMeasureClear();
    else if (op.t === 'sync') applyRemoteMeasureSync(op.measures);
  }
}

export function commitMeasurement(p1, p2, part1 = null, part2 = null) {
  const entry = makeMeasureEntry(p1, p2, part1, part2);
  const sz = measureDotSize();
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([p1.clone(), p2.clone()]),
    new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false }));
  line.renderOrder = 10;
  ctx.measureLayer.add(line);
  ctx.measureLayer.add(placeDot(p1, sz * 0.9));
  ctx.measureLayer.add(placeDot(p2, sz * 0.9));
  addMeasurement(entry, true);   // broadcast the committed measurement
  ctx.measureP1 = null;
  ctx.measureP1Part = null;
  ctx.measureP1Dot.visible = false;
  updateMeasureStatus();
  xferToast(t('ui.measured', { value: formatMm(entry.mm) }));
}

export function placeDot(world, size) {
  const d = makeMeasureDot(0xffd166, size);
  d.position.copy(world);
  return d;
}

export function fmtCoord(p) {   // show a point in mm
  return `(${fmtNum(p[0])}, ${fmtNum(p[1])}, ${fmtNum(p[2])})`;
}

export function fmtNum(v) {
  const mm = v * 1000;
  if (ctx.units === 'in') {
    const inch = mm / MM_PER_IN;
    return inch >= 100 ? inch.toFixed(0) : inch >= 10 ? inch.toFixed(1) : inch.toFixed(2);
  }
  return mm >= 100 ? mm.toFixed(0) : mm >= 10 ? mm.toFixed(1) : mm.toFixed(2);
}

export function fmtAngle(deg) {
  const d = ((deg % 360) + 360) % 360;
  return d.toFixed(1) + '°';
}

export function renderMeasureList() {
  const panel = document.getElementById('floating-measurements');
  const view = document.getElementById('view-presets');
  if (panel) {
    panel.hidden = !ctx.measureList.length;
    if (view && !view.hidden) panel.style.top = `${view.offsetTop + view.offsetHeight + 10}px`;
  }
  if (!ctx.measureListEl) return;
  ctx.measureListEl.innerHTML = '';
  ctx.measureList.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'ml-item';
    const head = document.createElement('div');
    head.className = 'ml-row';
    const label = document.createElement('input');
    label.className = 'ml-label';
    label.value = m.label || `M${i + 1}`;
    label.maxLength = 80;
    label.title = t('ui.measurement.label');
    label.addEventListener('change', () => updateMeasurementLabel(m.id, label.value));
    const info = document.createElement('span');
    info.className = 'ml-mm';
    info.textContent = `${formatMm(m.mm)} · el ${fmtAngle(m.elevation)} · az ${fmtAngle(m.azimuth)}`;
    const del = document.createElement('button');
    del.className = 'ml-del';
    del.textContent = '✕';
    del.title = t('ui.remove.measurement') + ' ' + (i + 1);
    del.addEventListener('click', () => removeMeasurement(m.id));
    head.append(label, info, del);
    const pts = document.createElement('div');
    pts.className = 'ml-pts';
    pts.innerHTML = `${m.part1 || t('ui.unknown.part')}${m.part2 && m.part2 !== m.part1 ? ` ↔ ${m.part2}` : ''}<br>P1 ${fmtCoord(m.p1)}<br>P2 ${fmtCoord(m.p2)}`;
    item.append(pts, head);
    ctx.measureListEl.appendChild(item);
  });
  if (!ctx.measureList.length) ctx.measureListEl.innerHTML = `<span class="hint">${t('ui.no.measurements')}</span>`;
}

// ---- Screen-space dimension annotations (crisp arrowheads + edge-snapped labels) ----
const _SVGNS = 'http://www.w3.org/2000/svg';
const _dimGroups = new Map();   // measurement id -> { g, line, a1, a2, label }

function projectToScreen(p) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(ctx.camera);
  const r = ctx.renderer.domElement.getBoundingClientRect();
  return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height, z: v.z };
}

// Recreate the SVG + one group per measurement. Call when the measurement set or
// the unit changes. Positions are (re)applied by updateDimensionLayer().
export function rebuildDimensionLayer() {
  const el = ctx.measureAnnotationsEl;
  if (!el) return;
  for (const d of _dimGroups.values()) d.g.remove();
  _dimGroups.clear();
  el.innerHTML = '';
  if (!ctx.measureList.length) return;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const svg = document.createElementNS(_SVGNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.overflow = 'visible';
  ctx.measureList.forEach((m) => {
    const g = document.createElementNS(_SVGNS, 'g');
    const line = document.createElementNS(_SVGNS, 'line');
    line.setAttribute('stroke', '#ffd166'); line.setAttribute('stroke-width', '1.5');
    const a1 = document.createElementNS(_SVGNS, 'polygon'); a1.setAttribute('fill', '#ffd166');
    const a2 = document.createElementNS(_SVGNS, 'polygon'); a2.setAttribute('fill', '#ffd166');
    const label = document.createElementNS(_SVGNS, 'text');
    label.setAttribute('fill', '#ffd166');
    label.setAttribute('font-size', '11');
    label.setAttribute('font-family', 'ui-monospace,Consolas,monospace');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('paint-order', 'stroke');
    label.setAttribute('stroke', '#101418');
    label.setAttribute('stroke-width', '3');
    label.setAttribute('stroke-linejoin', 'round');
    label.textContent = formatMm(m.mm);
    g.append(line, a1, a2, label);
    svg.appendChild(g);
    _dimGroups.set(m.id, { g, line, a1, a2, label });
  });
  el.appendChild(svg);
  updateDimensionLayer();
}

// Re-project each measurement's screen position. Call on camera change / each frame.
export function updateDimensionLayer() {
  const el = ctx.measureAnnotationsEl;
  if (!el || !_dimGroups.size) return;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const vw = rect.width, vh = rect.height;
  for (const m of ctx.measureList) {
    const d = _dimGroups.get(m.id);
    if (!d) continue;
    const p1 = projectToScreen(m.p1), p2 = projectToScreen(m.p2);
    if (p1.z > 1 || p2.z > 1) { d.g.style.display = 'none'; continue; }
    d.g.style.display = '';
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const ang = Math.atan2(dy, dx);
    const len = Math.hypot(dx, dy);
    if (len < 2) { d.g.style.display = 'none'; continue; }
    d.line.setAttribute('x1', p1.x); d.line.setAttribute('y1', p1.y);
    d.line.setAttribute('x2', p2.x); d.line.setAttribute('y2', p2.y);
    // Arrowheads (chevron triangles) at both ends, pointing outward.
    const ah = 9, aw = 5;
    const mkArrow = (x, y, oAng) => {
      const bx = x + Math.cos(oAng) * ah, by = y + Math.sin(oAng) * ah;
      const px = -Math.sin(oAng) * aw, py = Math.cos(oAng) * aw;
      return `${x},${y} ${(bx + px).toFixed(1)},${(by + py).toFixed(1)} ${(bx - px).toFixed(1)},${(by - py).toFixed(1)}`;
    };
    d.a1.setAttribute('points', mkArrow(p1.x, p1.y, ang + Math.PI));
    d.a2.setAttribute('points', mkArrow(p2.x, p2.y, ang));
    // Edge-snapped label: offset perpendicular to the dimension line.
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const off = 15;
    const pxo = -Math.sin(ang) * off, pyo = Math.cos(ang) * off;
    d.label.setAttribute('x', (mx + pxo).toFixed(1));
    d.label.setAttribute('y', (my + pyo).toFixed(1));
  }
}

export function dimensionLayerCount() {
  return ctx.measureList.length;
}

ctx.controls.addEventListener('change', updateDimensionLayer);

export function rebuildMeasureLayer() {
  if (ctx.measureLayer) ctx.scene.remove(ctx.measureLayer);
  ctx.measureLayer = new THREE.Group();
  ctx.scene.add(ctx.measureLayer);
  ctx.measureGlow = null;
  ctx.measureP1Dot = null;
  measureEnsureVisuals();
  const sz = measureDotSize();
  ctx.measureList.forEach((m) => {
    const p1 = new THREE.Vector3(...m.p1), p2 = new THREE.Vector3(...m.p2);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([p1, p2]),
      new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false }));
    line.renderOrder = 10;
    ctx.measureLayer.add(line);
    ctx.measureLayer.add(placeDot(p1, sz * 0.9));
    ctx.measureLayer.add(placeDot(p2, sz * 0.9));
  });
  updateMeasureStatus();
}

document.getElementById('fm-clear')?.addEventListener('click', measureClear);
document.getElementById('fm-collapse')?.addEventListener('click', () => {
  const list = document.getElementById('floating-measure-list');
  const button = document.getElementById('fm-collapse');
  const collapsed = !list.hidden;
  list.hidden = collapsed;
  button.textContent = collapsed ? '▸' : '▾';
  button.setAttribute('aria-expanded', String(!collapsed));
});
ctx.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!ctx.measureOn) return;
  const c = pickNearestCorner(e.clientX, e.clientY);
  if (!c) { clearHoverGlow(); return; }
  ctx.measureGlow.position.copy(c);
  ctx.measureGlow.visible = true;
  if (ctx.measureP1) {
    const mm = formatMm(ctx.measureP1.distanceTo(c));
    ctx.measureLabelEl.textContent = t('ui.distance', { value: mm });
    const sp = c.clone().project(ctx.camera);
    const r = ctx.renderer.domElement.getBoundingClientRect();
    ctx.measureLabelEl.style.left = (r.left + (sp.x * 0.5 + 0.5) * r.width) + 'px';
    ctx.measureLabelEl.style.top = (r.top + (-sp.y * 0.5 + 0.5) * r.height) + 'px';
    ctx.measureLabelEl.hidden = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctx.measureOn && ctx.measureP1) {
    ctx.measureP1 = null;
  ctx.measureP1Part = null;
    if (ctx.measureP1Dot) ctx.measureP1Dot.visible = false;
    clearHoverGlow();
    updateMeasureStatus();
  }
});

ctx.measureClearBtn.addEventListener('click', measureClear);
