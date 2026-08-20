// CAD Viewer — move module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';

import { hidePartHover, hidePartMenu, highlightHoverRow, hoverPickKey, nodeAtPath, partNameForKey, showPartHoverTip, showPartMenu } from './parts.js';
import { resetExplode } from './explode.js';
import { xferToast } from './session.js';

export function movableNode() {
  if (!ctx.model || !ctx.selectedPartKey) return null;
  const root = ctx.model.children[0];
  // Move the highlighted node itself (not its whole assembly ancestor).
  return nodeAtPath(root, ctx.selectedPartKey.split('.').map(Number));
}

export function setMoveAxis(a) {
  ctx.moveAxis = a;
  if (!ctx.moveAxisEl) return;
  ctx.moveAxisEl.textContent = a ? a.toUpperCase() : 'off';
  ctx.moveAxisEl.classList.toggle('armed', !!a);
  ctx.moveAxisEl.classList.toggle('x', a === 'x');
  ctx.moveAxisEl.classList.toggle('y', a === 'y');
  ctx.moveAxisEl.classList.toggle('z', a === 'z');
}

export function movePathFor(node) {
  const root = ctx.model.children[0];
  const path = [];
  let o = node;
  while (o && o !== root) { const p = o.parent; if (!p) break; path.unshift(p.children.indexOf(o)); o = p; }
  return path;
}

export function broadcastMove(path, pos) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'move', path, pos: [pos.x, pos.y, pos.z] })); } catch {}
}

export function applyRemoteMove(msg) {
  if (!ctx.model || !Array.isArray(msg.path) || !Array.isArray(msg.pos)) return;
  const node = nodeAtPath(ctx.model.children[0], msg.path);
  if (!node) return;
  node.position.set(msg.pos[0], msg.pos[1], msg.pos[2]);
  node.updateMatrixWorld(true);
}

export function resetPartPositions() {
  if (!ctx.model) return;
  // Collapse the exploded view first so parts return to their resting positions
  // before the baseline positions are restored.
  if (typeof resetExplode === 'function') resetExplode();
  const root = ctx.model.children[0];
  const visited = new Set();
  for (const [path, orig] of ctx.originalPositions) {
    const node = nodeAtPath(root, path.split('.').map(Number));
    if (!node || visited.has(node.uuid)) continue;
    visited.add(node.uuid);
    node.position.copy(orig);
    node.updateMatrixWorld(true);
    broadcastMove(path.split('.').map(Number), orig);
  }
  // Reset also clears the undo history — the positions are back to the baseline.
  ctx.moveHistory.length = 0;
  updateUndoState();
  xferToast('Part positions reset');
}

export function saveOriginalPositions() {
  ctx.originalPositions.clear();
  if (!ctx.model) return;
  const root = ctx.model.children[0];
  // Save the position of every named part/assembly node keyed by its path, so
  // Reset can restore any part that was moved (including nested sub-parts).
  const walk = (obj, path) => {
    (obj.children || []).forEach((c, i) => {
      const p = [...path, i];
      if (c.isObject3D || c.isMesh) ctx.originalPositions.set(p.join('.'), c.position.clone());
      walk(c, p);
    });
  };
  walk(root, []);
}

export function moveRayToPlane(e, out) {
  const r = ctx.renderer.domElement.getBoundingClientRect();
  ctx._mv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5);
  ctx.moveRay.setFromCamera(ctx._mv, ctx.camera);
  return ctx.moveRay.ray.intersectPlane(ctx.movePlane, out || ctx._planePt);
}

ctx.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !ctx.moveAxis || !ctx.moveOnChk.checked) return;
  const node = movableNode();
  if (!node) return;
  ctx.moveDragging = true;
  ctx.moveStartWorld.copy(node.getWorldPosition(ctx._mv2));
  ctx.moveStartNodePos.copy(node.position);
  ctx.controls.enabled = false;   // move instead of orbit while dragging
  // plane through the part, facing the camera, for stable axis-constrained drag
  ctx.movePlane.setFromNormalAndCoplanarPoint(
    ctx.camera.getWorldDirection(new THREE.Vector3()).clone().negate(), ctx.moveStartWorld);
  moveRayToPlane(e, ctx.moveStartPlanePt);
});

ctx.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!ctx.moveDragging || !ctx.moveAxis) return;
  const pt = moveRayToPlane(e);
  if (!pt) return;
  const node = movableNode();
  if (!node) return;
  const axis = ctx.moveAxis === 'x' ? new THREE.Vector3(1, 0, 0)
    : ctx.moveAxis === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  const worldPos = ctx.moveStartWorld.clone();
  const delta = pt.sub(ctx.moveStartPlanePt).dot(axis);
  worldPos.addScaledVector(axis, delta);
  // convert world → node-local (handles model scale)
  node.parent.worldToLocal(worldPos);
  node.position.copy(worldPos);
  node.updateMatrixWorld(true);
  broadcastMove(movePathFor(node), node.position);
});

export function endMoveDrag() {
  if (!ctx.moveDragging) return;
  ctx.moveDragging = false;
  ctx.controls.enabled = true;
  // Record this drag gesture as one movement (from the drag-start position).
  const node = movableNode();
  if (node && ctx.moveHistory) {
    const path = movePathFor(node);
    const to = node.position.clone();
    if (!to.equals(ctx.moveStartNodePos)) {
      ctx.moveHistory.push({ path, from: ctx.moveStartNodePos.clone(), to });
      if (ctx.moveHistory.length > ctx.MOVE_HISTORY_MAX) ctx.moveHistory.shift();
      updateUndoState();
    }
  }
}

export function updateUndoState() {
  const btn = document.getElementById('btn-move-undo');
  if (btn) btn.disabled = !(ctx.moveHistory && ctx.moveHistory.length);
}

export function undoLastMove() {
  if (!ctx.model || !ctx.moveHistory || !ctx.moveHistory.length) return;
  const entry = ctx.moveHistory.pop();
  const node = nodeAtPath(ctx.model.children[0], entry.path);
  if (node) {
    node.position.copy(entry.from);
    node.updateMatrixWorld(true);
    broadcastMove(entry.path, node.position);
    xferToast('Undid part movement');
  }
  updateUndoState();
}

ctx.renderer.domElement.addEventListener('pointerup', endMoveDrag);

ctx.renderer.domElement.addEventListener('pointercancel', endMoveDrag);

ctx.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) ctx.pickDown = { x: e.clientX, y: e.clientY };
});

export function isPickVisible(o) {
  while (o && o !== ctx.scene) { if (!o.visible) return false; o = o.parent; }
  return true;
}

export function pickPartKey(e) {
  if (!ctx.model) return null;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  ctx.pickNdc.set(((e.clientX - r.left) / r.width) * 2 - 1,
              -((e.clientY - r.top) / r.height) * 2 + 1);
  ctx.pickRay.setFromCamera(ctx.pickNdc, ctx.camera);
  const hits = ctx.pickRay.intersectObject(ctx.model, true);
  const hit = hits.find((h) => isPickVisible(h.object));
  if (!hit) return null;
  const root = ctx.model.children[0];
  let n = hit.object;
  while (n && n !== ctx.model) {
    const parent = n.parent;
    if (n.name && (parent === root || !n.isMesh)) {
      const path = [];
      let c = n;
      while (c && c !== root) { path.unshift(c.parent.children.indexOf(c)); c = c.parent; }
      return path.join('.');
    }
    n = parent;
  }
  return null;
}

export function pickGizmoAxis(e) {
  if (!ctx.moveGizmo.visible || !ctx.moveOnChk?.checked) return null;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const toScreen = (v) => {
    const p = v.clone().project(ctx.camera);
    return { x: (p.x*0.5+0.5)*r.width, y: (-p.y*0.5+0.5)*r.height };
  };
  const origin = toScreen(ctx.moveGizmoArrows.x.getWorldPosition(new THREE.Vector3()));
  let best = null, bestD = 24;   // 24px pick tolerance
  ['x','y','z'].forEach((ax) => {
    const tip = toScreen(ctx.moveGizmoArrows[ax].cone.getWorldPosition(new THREE.Vector3()));
    // distance from click to segment origin->tip
    const dx = tip.x-origin.x, dy = tip.y-origin.y;
    const len2 = dx*dx+dy*dy;
    let t = len2 ? ((px-origin.x)*dx+(py-origin.y)*dy)/len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = origin.x+t*dx, cy = origin.y+t*dy;
    const d = Math.hypot(px-cx, py-cy);
    if (d < bestD) { bestD = d; best = ax; }
  });
  return best;
}

ctx.renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();                    // don't let the doc listener auto-hide
  const key = pickPartKey(e);
  if (key) showPartMenu(e.clientX, e.clientY, key);
  else hidePartMenu();
});

document.addEventListener('keydown', (e) => {
  if (!ctx.moveOnChk?.checked) return;
  const k = e.key.toLowerCase();
  if (k === 'x' || k === 'y' || k === 'z') setMoveAxis(k);
});

ctx.moveOnChk.addEventListener('change', () => { if (!ctx.moveOnChk.checked) setMoveAxis(null); });

document.getElementById('btn-reset-pos').addEventListener('click', resetPartPositions);

document.getElementById('btn-move-undo').addEventListener('click', undoLastMove);

export function makeArrow(axis) {
  const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0)
    : axis === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), 0.5, ctx.AXIS_COLORS[axis], 0.16, 0.1);
  a.line.material.depthTest = false;
  a.cone.material.depthTest = false;
  a.line.material.transparent = true;
  a.cone.material.transparent = true;
  a.userData = { axis };
  a.visible = false;
  ctx.moveGizmo.add(a);
  return a;
}

export function updateMoveGizmo() {
  const node = movableNode();
  const on = !!(ctx.moveOnChk?.checked && node);
  ctx.moveGizmo.visible = on;
  if (!on) return;
  const p = node.getWorldPosition(new THREE.Vector3());
  // Size the gizmo to ~1/8 of the viewport height at its depth, so it stays a
  // constant screen fraction: the bigger the zoom (closer camera), the smaller
  // the gizmo. World height visible at distance d = 2*d*tan(fov/2).
  const d = ctx.camera.position.distanceTo(p);
  const visH = 2 * d * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2));
  const base = visH / 8;   // 1/8 of screen height
  ['x', 'y', 'z'].forEach((axis) => {
    const arrow = ctx.moveGizmoArrows[axis];
    arrow.position.copy(p);
    arrow.scale.setScalar(base / 0.5);
    arrow.visible = true;
    arrow.line.material.opacity = (ctx.moveAxis === axis) ? 1 : 0.35;
    arrow.cone.material.opacity = (ctx.moveAxis === axis) ? 1 : 0.35;
  });
  ctx.moveGizmoActive = ctx.moveAxis;
}

ctx.renderer.domElement.addEventListener('pointermove', (e) => {
  const now = performance.now();
  if (now - ctx.lastHoverPick < ctx.HOVER_TICK_MS) return;   // throttle raycast
  ctx.lastHoverPick = now;
  const key = hoverPickKey(e.clientX, e.clientY);
  if (key === ctx.hoverKey) return;                       // no change — keep current
  ctx.hoverKey = key;
  if (key) {
    highlightHoverRow(key);
    ctx.partHoverTipEl.textContent = partNameForKey(key);
    showPartHoverTip(e.clientX, e.clientY);
  } else {
    hidePartHover();
  }
});
