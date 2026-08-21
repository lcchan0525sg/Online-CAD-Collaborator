// CAD Viewer — orthogonal Section View + cut-plane overlay.
//
// Clips the model with a THREE.Plane (existing behaviour) and, while the section
// is enabled, renders two derived visuals at the cut plane:
//   1. a transparent reference plane (always visible, soft blue), and
//   2. thick orange contour lines where the plane intersects each visible mesh's
//      surface ("interaction lines with the part surfaces").
// Both are recomputed per viewer from the synced section state, so no new wire
// format is needed. Contour geometry is recomputed on a throttled live schedule
// while the offset slider is dragged, and immediately on release / axis change.
import * as THREE from 'three';
import { ctx } from './context.js';
import { broadcastSection, broadcastSectionPresets } from './session.js';

const PLANE_COLOR = 0x5aa0ff;        // soft blue reference plane
const PLANE_OPACITY = 0.15;
const CONTOUR_COLOR = 0xffa726;      // bright orange intersection lines
const PLANE_MARGIN = 1.15;           // plane extends 15% past the model's in-plane extent
const EPS = 1e-7;                    // plane-coplanarity tolerance
const CONTOUR_THROTTLE_MS = 50;      // live-recompute coalescing window
const DEFAULT_SECTION_REVERSED = true;

let planeSize = 0;                   // cached in-plane side length (world units)

function axisVector(axis, reversed) {
  const v = axis === 'y' ? new THREE.Vector3(0, 1, 0) : axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  return reversed ? v.negate() : v;
}

// Format an offset (already in mm) per the active display unit.
function fmtOffset(mm) {
  if (ctx.units === 'in') {
    const inch = mm / 25.4;
    return (inch >= 10 ? inch.toFixed(1) : inch.toFixed(2)) + ' in';
  }
  return mm + ' mm';
}

// Re-render just the offset readout (used when the display unit changes).
export function refreshSectionDisplay() {
  if (ctx.sectionOffsetValEl) ctx.sectionOffsetValEl.textContent = fmtOffset(ctx.sectionOffset);
}

function applyModelClipping() {
  ctx.renderer.clippingPlanes = [];
  ctx.renderer.localClippingEnabled = true;
  if (!ctx.model) return;
  ctx.model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) mat.clippingPlanes = ctx.sectionOn ? [ctx.sectionPlane] : [];
  });
}

// ---- Visual overlay construction ----

function ensureVisuals() {
  if (ctx.sectionPlaneMesh) return;

  const planeGeo = new THREE.PlaneGeometry(1, 1); // normal +Z; spans X/Y in local frame
  const planeMat = new THREE.MeshBasicMaterial({
    color: PLANE_COLOR, transparent: true, opacity: PLANE_OPACITY,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
  const planeMesh = new THREE.Mesh(planeGeo, planeMat);
  planeMesh.renderOrder = 999;
  planeMesh.frustumCulled = false;
  ctx.sectionPlaneMesh = planeMesh;
  ctx.sectionVisuals.add(planeMesh);

  const lineMat = new THREE.LineBasicMaterial({
    color: CONTOUR_COLOR, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
  });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  lines.renderOrder = 1000;
  lines.frustumCulled = false;
  // Contour vertex positions are computed in WORLD space, so this layer must
  // live directly in the scene (NOT under sectionVisuals, which is rotated and
  // translated to align the local-space plane quad).
  ctx.sectionContours = lines;
  ctx.scene.add(lines);
}

// Size + orient + place the plane quad. The quad is a square sized to the
// model's max in-plane bounding-box extent, centered on the model's in-plane
// bounding-box center (not the world origin) so it hugs the model evenly and
// doesn't overhang lopsidedly when the model isn't centered on the cut axis.
function updatePlaneTransform() {
  const box = new THREE.Box3().setFromObject(ctx.model);
  if (box.isEmpty()) { planeSize = 0; return; }
  const size = box.getSize(new THREE.Vector3());
  const idx = ctx.sectionAxis === 'x' ? 0 : ctx.sectionAxis === 'y' ? 1 : 2;
  const side = Math.max(
    idx === 0 ? size.y : size.x,
    idx === 2 ? size.y : size.z
  );
  planeSize = (Number.isFinite(side) && side > 0 ? side : 1) * PLANE_MARGIN;

  // Use the SAME (possibly reversed) normal as the clip plane so the transparent
  // quad always coincides with the actual cutting plane — otherwise Reverse makes
  // the two sweep in opposite directions.
  const n = axisVector(ctx.sectionAxis, ctx.sectionReversed).normalize();
  ctx.sectionVisuals.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const center = box.getCenter(new THREE.Vector3());
  // Place the quad at the cut (offset along the axis) but shifted so its
  // in-plane center coincides with the model's in-plane bbox center.
  ctx.sectionVisuals.position
    .copy(n).multiplyScalar(ctx.sectionOffset / 1000 - center.dot(n)).add(center);
  ctx.sectionPlaneMesh.scale.set(planeSize || 1, planeSize || 1, 1);
}

// Cheap per-change refresh: show/hide, orient, place, size the plane quad.
function updatePlaneVisual() {
  const show = ctx.sectionOn && !!ctx.model;
  ctx.sectionVisuals.visible = show;
  if (ctx.sectionContours) ctx.sectionContours.visible = show;
  if (!show) return;
  updatePlaneTransform();
}

// ---- Contour (plane/mesh intersection) computation ----

// Push the intersection point between a plane and edge (a,b) into `out`, if any.
function edgeCross(plane, a, b, da, db, out) {
  const sa = da > EPS ? 1 : da < -EPS ? -1 : 0;
  const sb = db > EPS ? 1 : db < -EPS ? -1 : 0;
  if (sa === 0) { out.push(a.clone()); return; }
  if (sb === 0) { out.push(b.clone()); return; }
  if (sa === sb) return;
  out.push(a.clone().lerp(b, da / (da - db)));
}

// Recursively visit visible nodes; skip hidden subtrees.
function walkVisible(obj, fn) {
  if (!obj.visible) return;
  fn(obj);
  for (const c of obj.children) walkVisible(c, fn);
}

// Compute the section-plane / visible-mesh intersection segments, returned as
// world-space point pairs ([a,b,a,b,...]). Shared by the viewport overlay and
// the 2D drawing export.
function collectContourSegments() {
  const worldPts = [];
  if (!ctx.model || !ctx.sectionOn) return worldPts;
  const world = new THREE.Matrix4();
  const worldInv = new THREE.Matrix4();
  const planeLocal = new THREE.Plane();
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const d = [0, 0, 0];
  const pts = [];
  const tmpV = new THREE.Vector3();

  walkVisible(ctx.model, (obj) => {
    if (!obj.isMesh) return;
    const geom = obj.geometry;
    const attr = geom && geom.getAttribute('position');
    if (!attr || attr.count < 3) return;
    world.copy(obj.matrixWorld);
    worldInv.copy(world).invert();
    planeLocal.copy(ctx.sectionPlane).applyMatrix4(worldInv);
    const index = geom.index;
    const triCount = index ? (index.count / 3) | 0 : (attr.count / 3) | 0;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      tri[0].fromBufferAttribute(attr, i0);
      tri[1].fromBufferAttribute(attr, i1);
      tri[2].fromBufferAttribute(attr, i2);
      d[0] = planeLocal.distanceToPoint(tri[0]);
      d[1] = planeLocal.distanceToPoint(tri[1]);
      d[2] = planeLocal.distanceToPoint(tri[2]);

      pts.length = 0;
      edgeCross(planeLocal, tri[0], tri[1], d[0], d[1], pts);
      edgeCross(planeLocal, tri[1], tri[2], d[1], d[2], pts);
      edgeCross(planeLocal, tri[2], tri[0], d[2], d[0], pts);
      if (pts.length >= 2) {
        let a = pts[0], b = null;
        for (const p of pts) {
          if (p.distanceTo(a) > 1e-9) { b = p; break; }
        }
        if (!b) continue; // zero-length segment (triangle coplanar with plane)
        worldPts.push(tmpV.copy(a).applyMatrix4(world).clone());
        worldPts.push(tmpV.copy(b).applyMatrix4(world).clone());
      }
    }
  });
  return worldPts;
}

function rebuildContours() {
  const lines = ctx.sectionContours;
  if (!lines) return;
  if (!ctx.model || !ctx.sectionOn) {
    setContourGeometry(lines, []);
    return;
  }
  setContourGeometry(lines, collectContourSegments());
}

function setContourGeometry(lines, worldPts) {
  const geo = new THREE.BufferGeometry();
  if (worldPts.length) {
    const arr = new Float32Array(worldPts.length * 3);
    for (let i = 0; i < worldPts.length; i++) {
      arr[i * 3] = worldPts[i].x;
      arr[i * 3 + 1] = worldPts[i].y;
      arr[i * 3 + 2] = worldPts[i].z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  }
  const old = lines.geometry;
  lines.geometry = geo;
  if (old) old.dispose();
}

function scheduleContours(immediate = false) {
  if (immediate) {
    if (ctx.sectionContourTimer) { clearTimeout(ctx.sectionContourTimer); ctx.sectionContourTimer = null; }
    rebuildContours();
    return;
  }
  if (ctx.sectionContourTimer) return;
  ctx.sectionContourTimer = setTimeout(() => {
    ctx.sectionContourTimer = null;
    rebuildContours();
  }, CONTOUR_THROTTLE_MS);
}

// ---- Public API ----

export function applySectionState(state, sync = true) {
  if (state) {
    ctx.sectionOn = !!state.enabled;
    ctx.sectionAxis = ['x', 'y', 'z'].includes(state.axis) ? state.axis : 'x';
    ctx.sectionOffset = Number.isFinite(state.offset) ? state.offset : 0;
    ctx.sectionReversed = !!state.reversed;
  }
  if (ctx.sectionOnChk) ctx.sectionOnChk.checked = ctx.sectionOn;
  if (ctx.sectionAxisEl) ctx.sectionAxisEl.value = ctx.sectionAxis;
  if (ctx.sectionOffsetEl) ctx.sectionOffsetEl.value = String(ctx.sectionOffset);
  if (ctx.sectionOffsetValEl) ctx.sectionOffsetValEl.textContent = fmtOffset(ctx.sectionOffset);
  if (ctx.sectionReverseBtn) {
    ctx.sectionReverseBtn.classList.toggle('active', ctx.sectionReversed);
    ctx.sectionReverseBtn.setAttribute('aria-pressed', String(ctx.sectionReversed));
  }
  const n = axisVector(ctx.sectionAxis, ctx.sectionReversed);
  ctx.sectionPlane.set(n, -(ctx.sectionOffset / 1000));
  applyModelClipping();
  ensureVisuals();
  updatePlaneVisual();
  scheduleContours();   // throttled live; crisp enough for axis/toggle/slider drags
  renderSectionPresets();   // refresh the active-preset highlight
  if (sync && !ctx.applyingRemoteSection) broadcastSection(sectionState());
}

export function sectionState() {
  return { enabled: !!ctx.sectionOn, axis: ctx.sectionAxis, offset: ctx.sectionOffset, reversed: !!ctx.sectionReversed };
}

export function resetSection(sync = true) {
  applySectionState({ enabled: false, axis: 'x', offset: 0, reversed: DEFAULT_SECTION_REVERSED }, sync);
}

ctx.sectionOnChk?.addEventListener('change', () => {
  ctx.sectionOn = ctx.sectionOnChk.checked;
  applySectionState(null);
  scheduleContours(true);   // immediate on toggle
});
ctx.sectionAxisEl?.addEventListener('change', () => {
  ctx.sectionAxis = ctx.sectionAxisEl.value;
  applySectionState(null);
  scheduleContours(true);   // immediate on axis change
});
ctx.sectionOffsetEl?.addEventListener('input', () => {
  ctx.sectionOffset = Number(ctx.sectionOffsetEl.value) || 0;
  applySectionState(null);  // plane follows live; contours throttled
});
ctx.sectionOffsetEl?.addEventListener('change', () => {
  scheduleContours(true);   // immediate on slider release
});
ctx.sectionReverseBtn?.addEventListener('click', () => {
  ctx.sectionReversed = !ctx.sectionReversed;
  applySectionState(null);
  scheduleContours(true);
});
ctx.sectionResetBtn?.addEventListener('click', () => resetSection());

window.addEventListener('viewer-model-loaded', () => {
  ensureVisuals();
  applySectionState(null, false);
  scheduleContours(true);
  clearSectionPresets(false);
});
window.addEventListener('viewer-model-cleared', () => {
  ctx.sectionVisuals.visible = false;
  if (ctx.sectionContours) { ctx.sectionContours.visible = false; setContourGeometry(ctx.sectionContours, []); }
  clearSectionPresets(false);
});

// ---- Section presets (named cuts) ----

export function sectionPresetsState() {
  return ctx.sectionPresets.map((p) => ({ id: p.id, name: p.name, axis: p.axis, offset: p.offset, reversed: p.reversed }));
}

function isActivePreset(p) {
  return ctx.sectionOn && ctx.sectionAxis === p.axis && ctx.sectionOffset === p.offset && ctx.sectionReversed === p.reversed;
}

function renderSectionPresets() {
  if (!ctx.sectionPresetListEl) return;
  ctx.sectionPresetListEl.innerHTML = '';
  if (!ctx.sectionPresets.length) { ctx.sectionPresetListEl.hidden = true; return; }
  ctx.sectionPresetListEl.hidden = false;
  ctx.sectionPresets.forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'section-preset-chip' + (isActivePreset(p) ? ' active' : '');
    chip.title = `${p.axis.toUpperCase()} · offset ${p.offset}${ctx.units === 'in' ? ' in' : ' mm'}${p.reversed ? ' (reversed)' : ''}`;
    const name = document.createElement('span');
    name.className = 'sp-name';
    name.textContent = p.name;
    const del = document.createElement('button');
    del.className = 'sp-del';
    del.textContent = '✕';
    del.title = 'Delete preset';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeSectionPreset(p.id); });
    chip.append(name, del);
    chip.addEventListener('click', () => applySectionState({ enabled: true, axis: p.axis, offset: p.offset, reversed: p.reversed }));
    ctx.sectionPresetListEl.appendChild(chip);
  });
}

export function addSectionPreset(name, broadcast = true) {
  const n = (name || '').trim().slice(0, 40) || `Cut ${ctx.sectionPresets.length + 1}`;
  ctx.sectionPresets.push({ id: 'sp' + (++ctx.sectionPresetSeq), name: n, axis: ctx.sectionAxis, offset: ctx.sectionOffset, reversed: ctx.sectionReversed });
  if (ctx.sectionPresetNameEl) ctx.sectionPresetNameEl.value = '';
  renderSectionPresets();
  if (broadcast && !ctx.applyingRemoteSectionPreset) broadcastSectionPresets(sectionPresetsState());
}

export function removeSectionPreset(id, broadcast = true) {
  ctx.sectionPresets = ctx.sectionPresets.filter((p) => p.id !== id);
  renderSectionPresets();
  if (broadcast && !ctx.applyingRemoteSectionPreset) broadcastSectionPresets(sectionPresetsState());
}

export function clearSectionPresets(broadcast = true) {
  if (!ctx.sectionPresets.length) { renderSectionPresets(); return; }
  ctx.sectionPresets = [];
  renderSectionPresets();
  if (broadcast && !ctx.applyingRemoteSectionPreset) broadcastSectionPresets(sectionPresetsState());
}

export function applyRemoteSectionPresets(presets) {
  if (!Array.isArray(presets)) return;
  ctx.applyingRemoteSectionPreset = true;
  try {
    ctx.sectionPresets = presets.map((p) => ({
      id: p.id || ('sp' + (++ctx.sectionPresetSeq)),
      name: (p.name || 'Cut').slice(0, 40),
      axis: ['x', 'y', 'z'].includes(p.axis) ? p.axis : 'x',
      offset: Number.isFinite(Number(p.offset)) ? Number(p.offset) : 0,
      reversed: !!p.reversed,
    }));
    renderSectionPresets();
  } finally { ctx.applyingRemoteSectionPreset = false; }
}

ctx.sectionPresetSaveBtn?.addEventListener('click', () => addSectionPreset(ctx.sectionPresetNameEl?.value));
ctx.sectionPresetNameEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSectionPreset(ctx.sectionPresetNameEl.value); }
});

// ---- Section 2D drawing export (SVG / PNG) ----

const _n = new THREE.Vector3();
const _up = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();

// Project the current contour segments onto the section plane's 2D frame, scaled
// to the current display unit. Returns { segs:[x,y pairs], unit, label }.
function projectSectionDrawing() {
  const worldPts = collectContourSegments();
  _n.copy(axisVector(ctx.sectionAxis, false)).normalize();
  _up.set(Math.abs(_n.y) < 0.9 ? 0 : 1, Math.abs(_n.y) < 0.9 ? 1 : 0, 0);
  _u.crossVectors(_n, _up).normalize();
  _v.crossVectors(_n, _u).normalize();
  const toUnit = ctx.units === 'in' ? 1000 / 25.4 : 1000;   // world (1 = 1000 mm) -> display unit
  const segs = [];
  for (let i = 0; i + 2 <= worldPts.length; i += 2) {
    segs.push([worldPts[i].dot(_u) * toUnit, worldPts[i].dot(_v) * toUnit]);
    segs.push([worldPts[i + 1].dot(_u) * toUnit, worldPts[i + 1].dot(_v) * toUnit]);
  }
  return { segs, unit: ctx.units === 'in' ? 'in' : 'mm', label: `Section ${ctx.sectionAxis.toUpperCase()} · ${fmtOffset(ctx.sectionOffset)}` };
}

function drawingBounds(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of segs) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const spanX = (maxX - minX) || 1, spanY = (maxY - minY) || 1;
  const margin = Math.max(spanX, spanY) * 0.06;
  return { minX, minY, maxX, maxY, spanX, spanY, margin };
}

export function exportSectionSvg() {
  if (!ctx.sectionOn || !ctx.model) { xferToast('Enable Section view to export a cut'); return null; }
  const { segs, unit, label } = projectSectionDrawing();
  if (!segs.length) { xferToast('No geometry intersects this section'); return null; }
  const { minX, minY, maxX, maxY, spanX, spanY, margin } = drawingBounds(segs);
  const w = spanX + 2 * margin, h = spanY + 2 * margin;
  let d = '';
  for (let i = 0; i + 2 <= segs.length; i += 2) {
    const a = segs[i], b = segs[i + 1];
    d += `M${(a[0] - minX + margin).toFixed(3)} ${(maxY - a[1] + margin).toFixed(3)}L${(b[0] - minX + margin).toFixed(3)} ${(maxY - b[1] + margin).toFixed(3)}`;
  }
  const fs = (Math.max(spanX, spanY) * 0.03) || 8;
  const sw = (Math.max(spanX, spanY) * 0.002) || 0.5;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">`
    + `<rect width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#ffffff"/>`
    + `<g fill="none" stroke="#111111" stroke-width="${sw.toFixed(4)}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>`
    + `<text x="${margin.toFixed(2)}" y="${(h - margin * 0.4).toFixed(2)}" font-family="sans-serif" font-size="${fs.toFixed(2)}" fill="#555555">${label} · units ${unit}</text>`
    + `</svg>`;
  const a = document.createElement('a');
  a.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  a.download = `section-${ctx.sectionAxis}-${Date.now()}.svg`;
  document.body.appendChild(a); a.click(); a.remove();
  return svg;
}

export function exportSectionPng() {
  if (!ctx.sectionOn || !ctx.model) { xferToast('Enable Section view to export a cut'); return null; }
  const { segs, unit, label } = projectSectionDrawing();
  if (!segs.length) { xferToast('No geometry intersects this section'); return null; }
  const { minX, maxY, spanX, spanY, margin } = drawingBounds(segs);
  const scale = 8;   // pixels per display unit
  const W = Math.ceil((spanX + 2 * margin) * scale);
  const H = Math.ceil((spanY + 2 * margin) * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#111111'; g.lineWidth = Math.max(1, scale * 0.5); g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i + 2 <= segs.length; i += 2) {
    const a = segs[i], b = segs[i + 1];
    g.moveTo((a[0] - minX + margin) * scale, (maxY - a[1] + margin) * scale);
    g.lineTo((b[0] - minX + margin) * scale, (maxY - b[1] + margin) * scale);
  }
  g.stroke();
  g.fillStyle = '#555555';
  g.font = `${Math.max(10, Math.round(scale * Math.max(spanX, spanY) * 0.03))}px sans-serif`;
  g.fillText(`${label} · units ${unit}`, margin * scale * 0.5, H - margin * scale * 0.4);
  const data = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = data; a.download = `section-${ctx.sectionAxis}-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  return data;
}

document.getElementById('section-export-svg')?.addEventListener('click', exportSectionSvg);
document.getElementById('section-export-png')?.addEventListener('click', exportSectionPng);

applySectionState(null, false);
