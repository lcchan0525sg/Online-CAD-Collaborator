// CAD Viewer — floating Model corrections: Units / Scale / Flip / Rotate.
// These are SESSION-SHARED state: any change is broadcast, stored by the server,
// and replayed on resync / late-joiner (like section / transforms / measures).
// Each viewer applies the shared corrections to its own loaded model.
import * as THREE from 'three';
import { ctx } from './context.js';
import { renderMeasureList } from './measure.js';
import { refreshSectionDisplay } from './section.js';
import { broadcastCorrections } from './session.js';

let rotAxis = 'x';   // selected rotate axis for the panel
const _corrQ = new THREE.Quaternion();
const _corrE = new THREE.Euler();

// Current corrections as a plain object (for the wire / server store).
export function correctionsState() {
  return {
    units: ctx.units,
    scale: ctx.modelScaleMult,
    flip: { ...ctx.modelFlip },
    rot: { ...ctx.modelRot },
  };
}

// Apply scale multiplier + flip + rotation to the loaded model root (R·S).
export function applyModelCorrections() {
  if (!ctx.model) return;
  const base = ctx.modelScale || 1;
  const s = ctx.modelScaleMult || 1;
  const f = ctx.modelFlip || { x: false, y: false, z: false };
  ctx.model.scale.set(
    base * s * (f.x ? -1 : 1),
    base * s * (f.y ? -1 : 1),
    base * s * (f.z ? -1 : 1)
  );
  const r = ctx.modelRot || { x: 0, y: 0, z: 0 };
  // Compose the correction rotation ON TOP of the base orientation (so we don't
  // clobber the Z-up->Y-up auto-orientation orientModel applied to the root).
  _corrE.set(r.x, r.y, r.z);
  _corrQ.setFromEuler(_corrE);
  ctx.model.quaternion.copy(ctx.modelBaseRot).multiply(_corrQ);
  // Negative-scale flips winding -> render surfaces double-sided while flipped
  // so reversed faces aren't culled. Remember the original side to restore.
  const anyFlip = f.x || f.y || f.z;
  ctx.model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat.userData._modelSide === undefined) mat.userData._modelSide = mat.side;
      mat.side = anyFlip ? THREE.DoubleSide : mat.userData._modelSide;
    }
  });
  ctx.model.updateMatrixWorld(true);
}

// Apply corrections received from a remote peer (no re-broadcast).
export function applyRemoteCorrections(s) {
  if (!s) return;
  if (s.units === 'in' || s.units === 'mm') ctx.units = s.units;
  if (Number.isFinite(s.scale)) ctx.modelScaleMult = s.scale;
  if (s.flip) ctx.modelFlip = { x: !!s.flip.x, y: !!s.flip.y, z: !!s.flip.z };
  if (s.rot) ctx.modelRot = { x: Number(s.rot.x) || 0, y: Number(s.rot.y) || 0, z: Number(s.rot.z) || 0 };
  refreshScaleUI();
  refreshFlipUI();
  refreshUnitUI();
  renderMeasureList();        // units may have changed
  refreshSectionDisplay();
  applyModelCorrections();
}

export function resetModelCorrections() {
  ctx.modelScaleMult = 1;
  ctx.modelFlip = { x: false, y: false, z: false };
  ctx.modelRot = { x: 0, y: 0, z: 0 };
  rotAxis = 'x';
  refreshScaleUI();
  refreshFlipUI();
  refreshRotAxisUI();
  applyModelCorrections();
  broadcastCorrections();
}

// ---- Units (mm / in) ----
export function applyUnits(u) {
  ctx.units = u === 'in' ? 'in' : 'mm';
  refreshUnitUI();
  renderMeasureList();
  refreshSectionDisplay();
  broadcastCorrections();
}

// ---- UI wiring ----
function refreshUnitUI() {
  ctx.unitSegEl?.querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.unit === ctx.units));
}
function refreshScaleUI() {
  if (ctx.modelScaleEl) ctx.modelScaleEl.value = String(ctx.modelScaleMult);
  if (ctx.modelScaleValEl) ctx.modelScaleValEl.textContent = ctx.modelScaleMult.toFixed(2) + '×';
}
function refreshFlipUI() {
  ctx.flipSegEl?.querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('active', !!ctx.modelFlip[b.dataset.flipAxis]));
}
function refreshRotAxisUI() {
  ctx.rotAxisSegEl?.querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.rotAxis === rotAxis));
}

ctx.unitSegEl?.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) applyUnits(b.dataset.unit);
});

ctx.modelScaleEl?.addEventListener('input', () => {
  ctx.modelScaleMult = Number(ctx.modelScaleEl.value) || 1;
  refreshScaleUI();
  applyModelCorrections();
  broadcastCorrections();
});
ctx.modelScaleResetEl?.addEventListener('click', () => {
  ctx.modelScaleMult = 1;
  refreshScaleUI();
  applyModelCorrections();
  broadcastCorrections();
});

ctx.flipSegEl?.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b || !(b.dataset.flipAxis in ctx.modelFlip)) return;
  ctx.modelFlip[b.dataset.flipAxis] = !ctx.modelFlip[b.dataset.flipAxis];
  refreshFlipUI();
  applyModelCorrections();
  broadcastCorrections();
});

ctx.rotAxisSegEl?.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) { rotAxis = b.dataset.rotAxis; refreshRotAxisUI(); }
});
ctx.modelRotAngleEl?.addEventListener('input', () => {
  if (ctx.modelRotAngleValEl) ctx.modelRotAngleValEl.textContent = (Number(ctx.modelRotAngleEl.value) || 0) + '°';
});
ctx.modelRotApplyEl?.addEventListener('click', () => {
  const deg = Number(ctx.modelRotAngleEl?.value) || 0;
  ctx.modelRot[rotAxis] = (ctx.modelRot[rotAxis] || 0) + THREE.MathUtils.degToRad(deg);
  applyModelCorrections();
  broadcastCorrections();
});

ctx.modelCorrectionsResetEl?.addEventListener('click', resetModelCorrections);

ctx.modelCollapseBtn?.addEventListener('click', () => {
  const open = ctx.modelBodyEl.hidden;
  ctx.modelBodyEl.hidden = !open;
  ctx.modelCollapseBtn.textContent = open ? '▾' : '▸';
  ctx.modelCollapseBtn.setAttribute('aria-expanded', String(open));
});

// Init UI (do NOT reset on model load — corrections are session-shared state;
// scene.js applies the current corrections after each model build).
refreshUnitUI();
refreshScaleUI();
refreshFlipUI();
refreshRotAxisUI();
