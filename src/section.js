// CAD Viewer — orthogonal Section View.
import * as THREE from 'three';
import { ctx } from './context.js';
import { broadcastSection } from './session.js';

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

function axisVector(axis, reversed) {
  const v = axis === 'y' ? new THREE.Vector3(0, 1, 0) : axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  return reversed ? v.negate() : v;
}

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
  if (ctx.sectionOffsetValEl) ctx.sectionOffsetValEl.textContent = `${ctx.sectionOffset} mm`;
  if (ctx.sectionReverseBtn) {
    ctx.sectionReverseBtn.classList.toggle('active', ctx.sectionReversed);
    ctx.sectionReverseBtn.setAttribute('aria-pressed', String(ctx.sectionReversed));
  }
  const n = axisVector(ctx.sectionAxis, ctx.sectionReversed);
  ctx.sectionPlane.set(n, -(ctx.sectionOffset / 1000));
  applyModelClipping();
  if (sync && !ctx.applyingRemoteSection) broadcastSection(sectionState());
}

export function sectionState() {
  return { enabled: !!ctx.sectionOn, axis: ctx.sectionAxis, offset: ctx.sectionOffset, reversed: !!ctx.sectionReversed };
}

export function resetSection(sync = true) {
  applySectionState({ enabled: false, axis: 'x', offset: 0, reversed: false }, sync);
}

ctx.sectionOnChk?.addEventListener('change', () => { ctx.sectionOn = ctx.sectionOnChk.checked; applySectionState(null); });
ctx.sectionAxisEl?.addEventListener('change', () => { ctx.sectionAxis = ctx.sectionAxisEl.value; applySectionState(null); });
ctx.sectionOffsetEl?.addEventListener('input', () => { ctx.sectionOffset = Number(ctx.sectionOffsetEl.value) || 0; applySectionState(null); });
ctx.sectionReverseBtn?.addEventListener('click', () => { ctx.sectionReversed = !ctx.sectionReversed; applySectionState(null); });
ctx.sectionResetBtn?.addEventListener('click', () => resetSection());

window.addEventListener('viewer-model-loaded', () => applySectionState(null, false));
applySectionState(null, false);
