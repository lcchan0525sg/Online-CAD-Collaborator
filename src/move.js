// CAD Viewer — move module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';

import { hidePartHover, hidePartMenu, highlightHoverRow, hoverPickKey, nodeAtPath, partNameForKey, showPartHoverTip, showPartMenu } from './parts.js';
import { resetExplode } from './explode.js';
import { xferToast } from './session.js';

let transformGroupSeq = 0;

function clonePivot(pivot) { return pivot ? pivot.clone() : null; }

export function captureTransform(node, path = movePathFor(node)) {
  return {
    path: [...path],
    pos: node.position.clone(),
    quat: node.quaternion.clone(),
    pivot: clonePivot(ctx.customPivot),
  };
}

function sameTransform(a, b) {
  return a && b && a.pos.equals(b.pos) && a.quat.equals(b.quat)
    && ((!a.pivot && !b.pivot) || (a.pivot && b.pivot && a.pivot.equals(b.pivot)));
}

function currentMatches(node, snapshot, key) {
  if (!node || !snapshot || !node.position.equals(snapshot.pos) || !node.quaternion.equals(snapshot.quat)) return false;
  const pivot = ctx.pivotByPath.get(key) || null;
  return (!snapshot.pivot && !pivot) || (snapshot.pivot && pivot && snapshot.pivot.equals(pivot));
}

export function recordTransform(before, after, label, groupId = null) {
  if (!before || !after || sameTransform(before, after)) return;
  ctx.transformHistory.push({ path: [...after.path], before, after, label, groupId });
  const key = pivotPathKey(after.path);
  if (after.pivot) ctx.pivotByPath.set(key, after.pivot.clone());
  else ctx.pivotByPath.delete(key);
  if (ctx.transformHistory.length > ctx.TRANSFORM_HISTORY_MAX) ctx.transformHistory.shift();
  ctx.transformRedo.length = 0;
  updateUndoState();
}

function applyTransformSnapshot(entry, snapshot) {
  const key = pivotPathKey(snapshot.path);
  const node = nodeAtPath(ctx.model?.children[0], snapshot.path);
  if (!node || !currentMatches(node, entry.expected, key)) return false;
  node.position.copy(snapshot.pos);
  node.quaternion.copy(snapshot.quat);
  if (snapshot.pivot) ctx.pivotByPath.set(key, snapshot.pivot.clone());
  else ctx.pivotByPath.delete(key);
  if (ctx.selectedPartKey === key) {
    ctx.customPivot = clonePivot(snapshot.pivot);
    updateMoveGizmo();
  }
  node.updateMatrixWorld(true);
  broadcastTransform(snapshot.path, node);
  return true;
}

function takeGrouped(stack) {
  const last = stack[stack.length - 1];
  if (!last?.groupId) return [last];
  const out = [];
  for (let i = stack.length - 1; i >= 0 && stack[i].groupId === last.groupId; i--) out.unshift(stack[i]);
  return out;
}

export function undoTransform() {
  if (!ctx.model || !ctx.transformHistory.length) return false;
  const entries = takeGrouped(ctx.transformHistory);
  for (const entry of entries) entry.expected = entry.after;
  for (const entry of entries) {
    if (!applyTransformSnapshot(entry, entry.before)) {
      const actor = ctx.partLastActor.get(entry.key);
      xferToast(actor ? `Cannot undo: ${actor} changed this part` : 'Cannot undo: part changed remotely');
      return false;
    }
  }
  ctx.transformHistory.splice(ctx.transformHistory.length - entries.length, entries.length);
  ctx.transformRedo.push(...entries);
  updateUndoState();
  xferToast(`Undid ${entries.length > 1 ? `${entries.length} part transforms` : entries[0].label}`);
  return true;
}

export function redoTransform() {
  if (!ctx.model || !ctx.transformRedo.length) return false;
  const entries = takeGrouped(ctx.transformRedo);
  for (const entry of entries) entry.expected = entry.before;
  for (const entry of entries) {
    if (!applyTransformSnapshot(entry, entry.after)) {
      const actor = ctx.partLastActor.get(entry.key);
      xferToast(actor ? `Cannot redo: ${actor} changed this part` : 'Cannot redo: part changed remotely');
      return false;
    }
  }
  ctx.transformRedo.splice(ctx.transformRedo.length - entries.length, entries.length);
  ctx.transformHistory.push(...entries);
  updateUndoState();
  xferToast(`Redid ${entries.length > 1 ? `${entries.length} part transforms` : entries[0].label}`);
  return true;
}

export function updateUndoState() {
  const undo = document.getElementById('btn-move-undo');
  const redo = document.getElementById('btn-move-redo');
  if (undo) undo.disabled = !(ctx.transformHistory && ctx.transformHistory.length);
  if (redo) redo.disabled = !(ctx.transformRedo && ctx.transformRedo.length);
}

export function undoLastMove() { return undoTransform(); }

export function redoLastMove() { return redoTransform(); }

export function movableNode() {
  if (!ctx.model || !ctx.selectedPartKey) return null;
  const root = ctx.model.children[0];
  // Move the highlighted node itself (not its whole assembly ancestor).
  return nodeAtPath(root, ctx.selectedPartKey.split('.').map(Number));
}

export function selectedMovableNodes() {
  if (!ctx.model) return [];
  const root = ctx.model.children[0];
  const keys = ctx.selectedPartKeys.length ? ctx.selectedPartKeys : (ctx.selectedPartKey ? [ctx.selectedPartKey] : []);
  return keys.map((key) => ({ key, node: nodeAtPath(root, key.split('.').map(Number)) })).filter((x) => x.node);
}

export function pivotWorld(node = movableNode()) {
  if (ctx.customPivot) return ctx.customPivot.clone();
  return node ? node.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
}

export function buildPivotHandle() {
  if (ctx.pivotHandle) return ctx.pivotHandle;
  const handle = new THREE.Group();
  handle.userData.kind = 'pivotHandle';
  handle.renderOrder = 20;
  const makeLine = (axis, color) => {
    const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0)
      : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const geometry = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-0.14), dir.clone().multiplyScalar(0.14),
    ]);
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.62, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.userData.pivotVisual = true;
    line.renderOrder = 21;
    handle.add(line);
  };
  makeLine('x', 0xff7b72);
  makeLine('y', 0x7ee2a8);
  makeLine('z', 0x7cc4ff);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, depthTest: false }));
  dot.userData.pivotVisual = true;
  dot.renderOrder = 22;
  handle.add(dot);
  handle.visible = false;
  ctx.moveGizmo.add(handle);
  ctx.pivotHandle = handle;
  return handle;
}

export function setPivotMode(on) {
  ctx.pivotMode = !!on;
  if (!ctx.pivotMode) ctx.pivotDragging = false;
  if (ctx.pivotHandle) {
    ctx.pivotHandle.traverse((child) => {
      if (child.material) child.material.opacity = ctx.pivotMode ? 0.9 : 0.35;
    });
  }
}

export function pivotPathKey(path = null) {
  if (path) return Array.isArray(path) ? path.join('.') : path;
  return ctx.selectedPartKey;
}

export function rememberActivePivot(path = ctx.selectedPartKey) {
  if (!path) return;
  if (ctx.customPivot) ctx.pivotByPath.set(pivotPathKey(path), ctx.customPivot.clone());
  else ctx.pivotByPath.delete(pivotPathKey(path));
}

export function activatePivotForPart(key) {
  ctx.customPivot = key && ctx.pivotByPath.has(key) ? ctx.pivotByPath.get(key).clone() : null;
  setPivotMode(false);
  updateMoveGizmo();
}

export function clearActivePivot() {
  ctx.customPivot = null;
  setPivotMode(false);
  updateMoveGizmo();
  window.dispatchEvent(new CustomEvent('viewer-pivot', { detail: { pivot: null } }));
}

export function resetPivot() {
  if (ctx.selectedPartKey) ctx.pivotByPath.delete(ctx.selectedPartKey);
  clearActivePivot();
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

export function broadcastRot(path, quat) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'rot', path, quat: [quat.x, quat.y, quat.z, quat.w] })); } catch {}
}

export function broadcastTransform(path, node, pivotOverride = ctx.customPivot) {
  if (!ctx.session?.connected || !node) return;
  const pivot = pivotOverride ? [pivotOverride.x, pivotOverride.y, pivotOverride.z] : null;
  try {
    ctx.session.ws.send(JSON.stringify({
      t: 'transform', path,
      pos: [node.position.x, node.position.y, node.position.z],
      quat: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      pivot,
    }));
  } catch {}
}

export function applyRemoteTransform(msg) {
  if (!Array.isArray(msg.path) || !Array.isArray(msg.pos) || !Array.isArray(msg.quat)) return;
  if (!ctx.model) { ctx.pendingRemoteTransforms.push(msg); return; }
  const node = nodeAtPath(ctx.model.children[0], msg.path);
  if (!node) return;
  node.position.set(msg.pos[0], msg.pos[1], msg.pos[2]);
  node.quaternion.set(msg.quat[0], msg.quat[1], msg.quat[2], msg.quat[3]);
  node.updateMatrixWorld(true);
  const key = msg.path.join('.');
  if (Array.isArray(msg.pivot) && msg.pivot.length === 3) {
    ctx.pivotByPath.set(key, new THREE.Vector3(...msg.pivot));
    if (ctx.selectedPartKey === key) ctx.customPivot = ctx.pivotByPath.get(key).clone();
  } else {
    ctx.pivotByPath.delete(key);
    if (ctx.selectedPartKey === key) ctx.customPivot = null;
  }
  if (ctx.selectedPartKey === key) updateMoveGizmo();
  // Actor-aware conflict surfacing: remember who last changed this part, and if
  // the user is currently working on it, tell them who edited it.
  if (msg.name) {
    ctx.partLastActor.set(key, msg.name);
    if (ctx.selectedPartKey === key) xferToast(`${msg.name} changed ${node.name || 'this part'}`);
  }
}

export function flushPendingRemoteTransforms() {
  if (!ctx.model || !ctx.pendingRemoteTransforms.length) return;
  const pending = ctx.pendingRemoteTransforms;
  ctx.pendingRemoteTransforms = [];
  for (const msg of pending) applyRemoteTransform(msg);
}

export function applyRemoteRot(msg) {
  if (!ctx.model || !Array.isArray(msg.path) || !Array.isArray(msg.quat)) return;
  const node = nodeAtPath(ctx.model.children[0], msg.path);
  if (!node) return;
  node.quaternion.set(msg.quat[0], msg.quat[1], msg.quat[2], msg.quat[3]);
  node.updateMatrixWorld(true);
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
  ctx.pivotByPath.clear();
  clearActivePivot();
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
  // Also restore rotations (move + rotate share the Reset button).
  const rv = new Set();
  for (const [path, orig] of ctx.originalRotations) {
    const node = nodeAtPath(root, path.split('.').map(Number));
    if (!node || rv.has(node.uuid)) continue;
    rv.add(node.uuid);
    node.quaternion.copy(orig);
    node.updateMatrixWorld(true);
    broadcastRot(path.split('.').map(Number), orig);
  }
  // Reset also clears the unified transform history.
  ctx.transformHistory.length = 0;
  ctx.transformRedo.length = 0;
  setRotateMode(false);
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

export function saveOriginalRotations() {
  ctx.originalRotations.clear();
  if (!ctx.model) return;
  const root = ctx.model.children[0];
  const walk = (obj, path) => {
    (obj.children || []).forEach((c, i) => {
      const p = [...path, i];
      if (c.isObject3D || c.isMesh) ctx.originalRotations.set(p.join('.'), c.quaternion.clone());
      walk(c, p);
    });
  };
  walk(root, []);
}

export function setRotateMode(on) {
  ctx.rotateMode = !!on;
  if (ctx.rotateMode) setPivotMode(false);
  if (ctx.rotateArc) ctx.rotateArc.material.opacity = ctx.rotateMode ? 1 : 0.4;
  if (ctx.rotateArcArrow) ctx.rotateArcArrow.material.opacity = ctx.rotateMode ? 1 : 0.4;
}

export function buildRotateArc() {
  if (ctx.rotateArc) return ctx.rotateArc;
  const R = 0.5, SEG = 48, pts = [];
  for (let i = 0; i <= SEG; i++) {
    const a = Math.PI * i / SEG;
    pts.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));   // XY-plane semi-circle
  }
  const arc = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.4, depthTest: false }));
  arc.userData.kind = 'rotateArc';
  arc.visible = false;
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.14, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.4, depthTest: false }));
  arrow.position.set(R, 0, 0);                 // at the arc's 0° end
  arrow.rotation.z = Math.PI / 2;              // point tangentially along the arc
  arrow.userData.kind = 'rotateArrow';
  arrow.visible = false;
  ctx.moveGizmo.add(arc);
  ctx.moveGizmo.add(arrow);
  ctx.rotateArc = arc;
  ctx.rotateArcArrow = arrow;
  return arc;
}

// Is the pointer near the rotate semi-circle on screen?
export function pickRotateArc(e) {
  if (!ctx.rotateArc?.visible || !ctx.moveOnChk?.checked) return false;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  ctx.rotateArc.updateMatrixWorld(true);
  const pos = ctx.rotateArc.geometry.attributes.position;
  let best = 1e9;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    ctx.rotateArc.localToWorld(v);
    const p = v.clone().project(ctx.camera);
    const sx = (p.x * 0.5 + 0.5) * r.width, sy = (-p.y * 0.5 + 0.5) * r.height;
    const d = Math.hypot(px - sx, py - sy);
    if (d < best) best = d;
  }
  return best < 18;
}

// Pointer angle (radians) around ctx.rotAxisVec, relative to ctx.rotCenter.
function pointerAngle(e) {
  const r = ctx.renderer.domElement.getBoundingClientRect();
  ctx._mv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ctx._mv, ctx.camera);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(ctx.rotAxisVec, ctx.rotCenter);
  const pt = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, pt)) return null;
  const d = pt.sub(ctx.rotCenter);
  const u = new THREE.Vector3();
  if (Math.abs(ctx.rotAxisVec.y) < 0.9) u.crossVectors(ctx.rotAxisVec, new THREE.Vector3(0, 1, 0)).normalize();
  else u.crossVectors(ctx.rotAxisVec, new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(ctx.rotAxisVec, u).normalize();
  return Math.atan2(d.dot(v), d.dot(u));
}

export function pickPivotHandle(e) {
  if (!ctx.pivotMode || !ctx.pivotHandle?.visible) return false;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  const p = ctx.pivotHandle.getWorldPosition(new THREE.Vector3()).project(ctx.camera);
  const sx = (p.x * 0.5 + 0.5) * r.width;
  const sy = (-p.y * 0.5 + 0.5) * r.height;
  return Math.hypot(e.clientX - r.left - sx, e.clientY - r.top - sy) < 22;
}

ctx.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !ctx.pivotMode || !pickPivotHandle(e)) return;
  const node = movableNode();
  if (!node) return;
  ctx.pivotDragging = true;
  ctx.pivotStartTransform = captureTransform(node);
  ctx.controls.enabled = false;
  ctx.pivotHandle.traverse((child) => { if (child.material) child.material.opacity = 1; });
  ctx.pivotStartWorld.copy(pivotWorld(node));
  ctx.movePlane.setFromNormalAndCoplanarPoint(
    ctx.camera.getWorldDirection(new THREE.Vector3()).clone().negate(), ctx.pivotStartWorld);
  moveRayToPlane(e, ctx.pivotStartPoint);
});

ctx.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!ctx.pivotDragging) return;
  const node = movableNode();
  const pt = moveRayToPlane(e);
  if (!node || !pt) return;
  const delta = pt.clone().sub(ctx.pivotStartPoint);
  if (ctx.moveAxis) {
    const axis = ctx.moveAxis === 'x' ? new THREE.Vector3(1, 0, 0)
      : ctx.moveAxis === 'y' ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    delta.copy(axis.multiplyScalar(delta.dot(axis)));
  }
  ctx.customPivot = ctx.pivotStartWorld.clone().add(delta);
  updateMoveGizmo();
  broadcastTransform(movePathFor(node), node);
});

export function endPivotDrag() {
  if (!ctx.pivotDragging) return;
  ctx.pivotDragging = false;
  ctx.controls.enabled = true;
  const node = movableNode();
  if (node && ctx.pivotStartTransform) recordTransform(ctx.pivotStartTransform, captureTransform(node), 'pivot adjustment');
  ctx.pivotStartTransform = null;
  if (ctx.pivotHandle) ctx.pivotHandle.traverse((child) => { if (child.material) child.material.opacity = 0.9; });
}

ctx.renderer.domElement.addEventListener('pointerup', endPivotDrag);
ctx.renderer.domElement.addEventListener('pointercancel', endPivotDrag);

ctx.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !ctx.rotateArc?.visible || !ctx.rotateMode || !ctx.moveOnChk.checked) return;
  if (!pickRotateArc(e)) return;
  const group = selectedMovableNodes();
  const node = group[0]?.node;
  if (!node) return;
  ctx.rotating = true;
  ctx.controls.enabled = false;
  ctx.rotStartGroup = group.map(({ key, node: item }) => ({ key, node: item, worldMatrix: item.matrixWorld.clone(), before: captureTransform(item, key.split('.').map(Number)) }));
  ctx.rotStartTransform = ctx.rotStartGroup[0].before;
  const box = new THREE.Box3();
  for (const item of group) box.expandByObject(item.node);
  ctx.rotCenter.copy(box.getCenter(new THREE.Vector3()));
  ctx.rotStartWorldMatrix.copy(node.matrixWorld);

  if (ctx.moveAxis === 'x') ctx.rotAxisVec.set(1, 0, 0);
  else if (ctx.moveAxis === 'y') ctx.rotAxisVec.set(0, 1, 0);
  else ctx.rotAxisVec.set(0, 0, 1);
  const cL = node.parent.worldToLocal(ctx.rotCenter.clone());
  const aL = node.parent.worldToLocal(ctx.rotCenter.clone().add(ctx.rotAxisVec));
  ctx.rotLocalAxis.copy(aL.sub(cL)).normalize();
  ctx.rotStartQuat.copy(node.quaternion);
  ctx.rotStartAngle = pointerAngle(e) || 0;
});

ctx.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!ctx.rotating) return;
  const a = pointerAngle(e);
  if (a == null) return;
  const delta = a - ctx.rotStartAngle;
  const around = new THREE.Matrix4()
    .makeTranslation(ctx.rotCenter.x, ctx.rotCenter.y, ctx.rotCenter.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(ctx.rotAxisVec, delta))
    .multiply(new THREE.Matrix4().makeTranslation(-ctx.rotCenter.x, -ctx.rotCenter.y, -ctx.rotCenter.z));
  if (ctx.rotStartGroup?.length > 1) {
    for (const item of ctx.rotStartGroup) {
      const world = around.clone().multiply(item.worldMatrix);
      const local = item.node.parent.matrixWorld.clone().invert().multiply(world);
      local.decompose(item.node.position, item.node.quaternion, item.node.scale);
      item.node.updateMatrixWorld(true);
      broadcastTransform(movePathFor(item.node), item.node, item.before.pivot);
    }
  } else {
    const node = movableNode();
    if (!node) return;
    const world = around.multiply(ctx.rotStartWorldMatrix);
    const local = node.parent.matrixWorld.clone().invert().multiply(world);
    local.decompose(node.position, node.quaternion, node.scale);
    node.updateMatrixWorld(true);
    broadcastTransform(movePathFor(node), node);
  }
});

export function endRotateDrag() {
  if (!ctx.rotating) return;
  ctx.rotating = false;
  ctx.controls.enabled = true;
  window.dispatchEvent(new CustomEvent('viewer-transform', { detail: { kind: 'rotate', state: 'done' } }));
  const node = movableNode();
  if (ctx.rotStartGroup?.length) {
    const groupId = ctx.rotStartGroup.length > 1 ? ++transformGroupSeq : null;
    for (const item of ctx.rotStartGroup) recordTransform(item.before, captureTransform(item.node, item.key.split('.').map(Number)), 'part rotation', groupId);
  } else if (node && ctx.rotStartTransform) recordTransform(ctx.rotStartTransform, captureTransform(node), 'part rotation');
  ctx.rotStartGroup = null;
  ctx.rotStartTransform = null;
}

// Abort an in-progress rotation and restore its starting quaternion. The live
// drag broadcasts intermediate rotations, so the restored value is broadcast.
export function cancelRotateDrag() {
  if (!ctx.rotating) return;
  if (ctx.rotStartGroup?.length) {
    for (const item of ctx.rotStartGroup) {
      item.node.position.copy(item.before.pos);
      item.node.quaternion.copy(item.before.quat);
      item.node.updateMatrixWorld(true);
      broadcastTransform(item.key.split('.').map(Number), item.node, item.before.pivot);
    }
  } else {
    const node = movableNode();
    if (node) {
      node.quaternion.copy(ctx.rotStartQuat);
      node.updateMatrixWorld(true);
      broadcastRot(movePathFor(node), node.quaternion);
    }
  }
  ctx.rotating = false;
  ctx.controls.enabled = true;
  ctx.rotStartGroup = null;
  ctx.rotStartTransform = null;
  window.dispatchEvent(new CustomEvent('viewer-transform', { detail: { kind: 'rotate', state: 'cancelled' } }));
}

export function moveRayToPlane(e, out) {
  const r = ctx.renderer.domElement.getBoundingClientRect();
  ctx._mv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5);
  ctx.moveRay.setFromCamera(ctx._mv, ctx.camera);
  return ctx.moveRay.ray.intersectPlane(ctx.movePlane, out || ctx._planePt);
}

ctx.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || ctx.pivotMode || !ctx.moveAxis || !ctx.moveOnChk.checked) return;
  // If rotate is armed and the click landed on the rotate arc, that's a rotate
  // gesture, not a move — don't start a move drag.
  if (ctx.rotateMode && pickRotateArc(e)) return;
  const group = selectedMovableNodes();
  const node = group[0]?.node;
  if (!node) return;
  ctx.moveDragging = true;
  ctx.moveStartGroup = group.map(({ key, node: item }) => ({ key, node: item, world: item.getWorldPosition(new THREE.Vector3()), before: captureTransform(item) }));
  ctx.moveStartTransform = ctx.moveStartGroup[0].before;
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
  const group = ctx.moveStartGroup || [];
  if (!group.length) return;
  const axis = ctx.moveAxis === 'x' ? new THREE.Vector3(1, 0, 0)
    : ctx.moveAxis === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  const delta = pt.sub(ctx.moveStartPlanePt).dot(axis);
  for (const item of group) {
    const worldPos = item.world.clone().addScaledVector(axis, delta);
    item.node.parent.worldToLocal(worldPos);
    item.node.position.copy(worldPos);
    item.node.updateMatrixWorld(true);
    broadcastTransform(movePathFor(item.node), item.node);
  }
  window.dispatchEvent(new CustomEvent('viewer-transform', { detail: { kind: 'move', value: Math.abs(delta) } }));
});

export function endMoveDrag() {
  if (!ctx.moveDragging) return;
  ctx.moveDragging = false;
  ctx.controls.enabled = true;
  window.dispatchEvent(new CustomEvent('viewer-transform', { detail: { kind: 'move', state: 'done' } }));
  if (ctx.moveStartGroup?.length) {
    const groupId = ctx.moveStartGroup.length > 1 ? ++transformGroupSeq : null;
    for (const item of ctx.moveStartGroup) recordTransform(item.before, captureTransform(item.node, item.key.split('.').map(Number)), 'part movement', groupId);
  }
  ctx.moveStartGroup = null;
  ctx.moveStartTransform = null;
}

// Abort an in-progress move and restore the drag-start position.
export function cancelMoveDrag() {
  if (!ctx.moveDragging) return;
  if (ctx.moveStartGroup?.length) {
    for (const item of ctx.moveStartGroup) {
      item.node.position.copy(item.before.pos);
      item.node.updateMatrixWorld(true);
      broadcastMove(movePathFor(item.node), item.node.position);
    }
  }
  ctx.moveStartGroup = null;
  ctx.moveDragging = false;
  ctx.controls.enabled = true;
  ctx.moveStartTransform = null;
  window.dispatchEvent(new CustomEvent('viewer-transform', { detail: { kind: 'move', state: 'cancelled' } }));
}

ctx.renderer.domElement.addEventListener('pointerup', endMoveDrag);
ctx.renderer.domElement.addEventListener('pointerup', endRotateDrag);

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

ctx.moveOnChk.addEventListener('change', () => {
  if (!ctx.moveOnChk.checked) { setMoveAxis(null); setRotateMode(false); }
});

document.getElementById('btn-reset-pos').addEventListener('click', resetPartPositions);

document.getElementById('btn-move-undo').addEventListener('click', undoTransform);
document.getElementById('btn-move-redo').addEventListener('click', redoTransform);

document.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undoTransform(); }
  else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redoTransform(); }
});

window.addEventListener('viewer-model-loaded', flushPendingRemoteTransforms);

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
  buildPivotHandle();
  const group = selectedMovableNodes();
  const node = group[0]?.node;
  const on = !!(ctx.moveOnChk?.checked && node);
  ctx.moveGizmo.visible = on;
  if (ctx.pivotHandle) ctx.pivotHandle.visible = on && ctx.pivotMode;
  if (!on) return;
  const p = node.getWorldPosition(new THREE.Vector3());
  const pivot = group.length > 1 ? group.reduce((box, item) => box.expandByObject(item.node), new THREE.Box3()).getCenter(new THREE.Vector3()) : pivotWorld(node);
  // Size the gizmo to ~1/8 of the viewport height at its depth, so it stays a
  // constant screen fraction: the bigger the zoom (closer camera), the smaller
  // the gizmo. World height visible at distance d = 2*d*tan(fov/2).
  const d = ctx.camera.position.distanceTo(pivot);
  const visH = 2 * d * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2));
  const base = visH / 8;   // 1/8 of screen height
  ['x', 'y', 'z'].forEach((axis) => {
    const arrow = ctx.moveGizmoArrows[axis];
    arrow.position.copy(pivot);
    arrow.scale.setScalar(base / 0.5);
    arrow.visible = true;
    arrow.line.material.opacity = (ctx.moveAxis === axis) ? 1 : 0.35;
    arrow.cone.material.opacity = (ctx.moveAxis === axis) ? 1 : 0.35;
  });
  // Rotate semi-circle: shown when an axis is armed, in the plane perpendicular
  // to that axis, so its normal aligns with the rotation axis.
  if (ctx.rotateArc && ctx.moveAxis) {
    const axisVec = ctx.moveAxis === 'x' ? new THREE.Vector3(1, 0, 0)
      : ctx.moveAxis === 'y' ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    ctx.rotateArc.visible = true;
    ctx.rotateArc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisVec);
    ctx.rotateArc.position.copy(pivot);
    ctx.rotateArc.scale.setScalar(base / 0.5);
    ctx.rotateArcArrow.visible = true;
    ctx.rotateArcArrow.position.copy(new THREE.Vector3(0.5, 0, 0).applyQuaternion(ctx.rotateArc.quaternion)).add(pivot);
    ctx.rotateArcArrow.quaternion.copy(ctx.rotateArc.quaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
    ctx.rotateArcArrow.scale.setScalar(base / 0.5);
  } else if (ctx.rotateArc) {
    ctx.rotateArc.visible = false;
    ctx.rotateArcArrow.visible = false;
  }
  ctx.pivotHandle.position.copy(pivot);
  ctx.pivotHandle.scale.setScalar(base / 0.5);
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
