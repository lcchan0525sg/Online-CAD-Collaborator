// CAD Viewer — explode module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';

import { frameModel } from './scene.js';
import { nodeAtPath } from './parts.js';

export function explodeScopeNode() {
  if (!ctx.model) return null;
  const root = ctx.model.children[0];
  // A selected assembly (a row with kids) becomes the scope.
  if (ctx.selectedPartKey) {
    const n = nodeAtPath(root, ctx.selectedPartKey.split('.').map(Number));
    const rowInfo = n && ctx.allPartRows.find((r) => r.key === ctx.selectedPartKey);
    if (n && rowInfo && rowInfo.hasKids) return n;
    // Leaf part selected -> fall through to a stored remote scope, else top level.
  }
  // Remote scope: a collaborator drilled into a sub-assembly and broadcast its
  // scopeKey. Honor it when there's no overriding local assembly selection, so
  // the guest's explode targets match the host's.
  if (ctx.explodeScopeKey && ctx.explodeScopeKey !== '') {
    const n = nodeAtPath(root, ctx.explodeScopeKey.split('.').map(Number));
    const namedKids = (o) => (o.children || []).filter((c) => c.name && nodeHasMeshes(c));
    if (n && n !== root && namedKids(n).length > 1) return n;
  }
  // Default top level: descend past single-child "pure wrapper" nodes (which may
  // be unnamed, e.g. a GLTF root) to the highest assembly with more than one
  // named child.
  const namedKids = (o) => (o.children || []).filter((c) => c.name && nodeHasMeshes(c));
  // A "pure wrapper" to descend through: a non-light child that itself has
  // children AND meshes in its subtree (i.e. leads to real geometry).
  const wrappers = (o) => (o.children || []).filter((c) => !c.isLight && nodeHasMeshes(c) && c.children && c.children.length);
  let node = root;
  while (node) {
    const kids = namedKids(node);
    if (kids.length > 1) return node;            // this is the assembly to explode
    // No named children: descend into the single pure wrapper, if any. This
    // handles unnamed GLTF roots that wrap the real sub-assemblies.
    const w = wrappers(node);
    if (w.length === 1) { node = w[0]; continue; }
    return null;   // single leaf / empty -> nothing to explode
  }
  return null;
}

export function nodeHasMeshes(node) {
  let found = false;
  node.traverse((o) => { if (o.isMesh) found = true; });
  return found;
}

export function explodeScopeInfo() {
  const scope = explodeScopeNode();
  if (!scope) { ctx.explodeScopeKey = null; ctx.explodeScopeName = '—'; ctx.explodeNothing = true; return []; }
  const kids = (scope.children || []).filter((c) => c.name && nodeHasMeshes(c));
  ctx.explodeScopeKey = scope === ctx.model.children[0] && !ctx.partRows.has('') ? null : scopeKeyOf(scope);
  ctx.explodeScopeName = scope.name || 'Assembly';
  ctx.explodeNothing = kids.length <= 1;
  return kids;
}

export function scopeKeyOf(node) {
  const root = ctx.model.children[0];
  const path = [];
  let c = node;
  while (c && c !== root) { path.unshift(c.parent.children.indexOf(c)); c = c.parent; }
  return path.join('.');
}

export function computeExplodeDirs() {
  ctx.explodeTargets = [];
  if (!ctx.model) { renderExplodeScope(); return; }
  const kids = explodeScopeInfo();
  if (!kids.length || ctx.explodeNothing) { renderExplodeScope(); return; }
  // Skip hidden parts in the layout — no phantom gap around hidden geometry.
  const visible = kids.filter((n) => n.visible !== false);
  if (!visible.length) { renderExplodeScope(); return; }
  const axisWorld = axisVector();
  const _c = new THREE.Vector3();
  for (const node of visible) {
    const parent = node.parent || ctx.model.children[0];
    // Cache the RESTING box along the current axis so slider drags are smooth:
    // the layout reuses these cached scalars instead of re-reading geometry.
    const box = new THREE.Box3().setFromObject(node);
    const center = box.getCenter(_c).clone();
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.abs(size.dot(axisWorld));
    const half = extent / 2;
    // Prefer the recorded ORIGINAL resting position (from an earlier scope) so
    // re-exploring an assembly uses the true assembled baseline, not the current
    // displaced position. Fall back to the node's current position on first pass.
    const rec = ctx.explodeDisplaced.get(node.uuid);
    ctx.explodeTargets.push({
      node, parent, resting: (rec ? rec.resting : node.position).clone(),
      axisPos: center.dot(axisWorld),
      axisMin: center.dot(axisWorld) - half,
      extent,
    });
  }
  renderExplodeScope();
}

export function axisVector() {
  return ctx.explodeDir === 'y' ? new THREE.Vector3(0, 1, 0)
    : ctx.explodeDir === 'z' ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(1, 0, 0);
}

export function applyExplodeGap(newGap) {
  const gap = Math.max(0, Number(newGap) || 0);
  if (!ctx.model || !ctx.explodeTargets.length || ctx.explodeNothing) { setExplodeUi(gap); return; }
  const axisWorld = axisVector();
  // gap=0 means "assembled": restore every box to its resting position.
  if (gap <= 0) {
    const seen = new Set();
    for (const t of ctx.explodeTargets) {
      if (seen.has(t.node.uuid)) continue;
      seen.add(t.node.uuid);
      if (!ctx.explodeDisplaced.has(t.node.uuid)) ctx.explodeDisplaced.set(t.node.uuid, { node: t.node, resting: t.resting.clone() });
      t.node.position.copy(t.resting);
      t.node.updateMatrixWorld(true);
    }
    setExplodeUi(0);
    broadcastExplode();
    return;
  }
  const gapWorld = gap / 1000;   // scene is mm -> m
  // Use the cached resting boxes (axisPos / axisMin / extent) captured at
  // computeExplodeDirs — no per-tick geometry read, so the slider is smooth.
  const items = ctx.explodeTargets.map((t) => ({ t, axisPos: t.axisPos, min: t.axisMin, extent: t.extent, offset: 0 }));
  items.sort((a, b) => a.axisPos - b.axisPos);
  // Push each box forward only as far as needed to maintain `gap` after the
  // previous box. Cursor tracks the new trailing edge of the last box.
  let cursor = -Infinity;
  for (const it of items) {
    const requiredMin = cursor === -Infinity ? it.min : cursor + gapWorld;
    const offset = Math.max(0, requiredMin - it.min);
    it.offset = offset;
    cursor = it.min + offset + it.extent;
  }
  // Apply offsets (absolute from resting) in each target's parent frame.
  const seen = new Set();
  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  for (const it of items) {
    if (seen.has(it.t.node.uuid)) continue;
    seen.add(it.t.node.uuid);
    const p = it.t.parent || ctx.model.children[0];
    // NB: worldToLocal returns its argument, so `a` and `b` MUST be distinct
    // vectors — otherwise b.sub(a) always yields (0,0,0) and nothing moves.
    const a = p.worldToLocal(_o.set(0, 0, 0));
    const b = p.worldToLocal(_d.copy(axisWorld).multiplyScalar(it.offset));
    const localDelta = b.sub(a);
    if (!ctx.explodeDisplaced.has(it.t.node.uuid)) ctx.explodeDisplaced.set(it.t.node.uuid, { node: it.t.node, resting: it.t.resting.clone() });
    it.t.node.position.copy(it.t.resting).add(localDelta);
    it.t.node.updateMatrixWorld(true);
  }
  setExplodeUi(gap);
  broadcastExplode();
}

export function setExplodeUi(gap) {
  ctx.explodeGap = Math.max(0, Number(gap) || 0);
  if (ctx.explodeSliderEl) ctx.explodeSliderEl.value = ctx.explodeGap;
  if (ctx.explodeValEl) ctx.explodeValEl.textContent = Math.round(ctx.explodeGap) + ' mm';
  renderExplodeScope();
}

export function renderExplodeScope() {
  if (!ctx.explodeScopeEl) return;
  if (ctx.explodeNothing || !ctx.explodeScopeName || ctx.explodeScopeName === '—') {
    ctx.explodeScopeEl.textContent = 'Scope: nothing to spread · select an assembly';
    return;
  }
  const n = ctx.explodeTargets.length || (explodeScopeNode()?.children || []).filter((c) => c.name).length;
  ctx.explodeScopeEl.textContent = `Scope: ${ctx.explodeScopeName} · ${n} children · gap ${Math.round(ctx.explodeGap)} mm · dir ${ctx.explodeDir.toUpperCase()}`;
}

export function resetExplode() {
  // Full collapse: restore EVERY node the explode has ever displaced (across all
  // scopes), then re-scope so the slider/readout match the current selection.
  if (ctx.model) {
    const seen = new Set();
    for (const { node, resting } of ctx.explodeDisplaced.values()) {
      if (seen.has(node.uuid)) continue;
      seen.add(node.uuid);
      node.position.copy(resting);
      node.updateMatrixWorld(true);
    }
  }
  ctx.explodeDisplaced.clear();
  ctx.explodeScopeKey = null;   // reset returns to top-level scope (or current selection)
  computeExplodeDirs();
  applyExplodeGap(0);
}

export function rescopeExplode() {
  computeExplodeDirs();   // capture new scope's children as the active targets
  applyExplodeGap(0);     // value -> 0; previous scope parts are untouched
}

ctx.explodeSliderEl.addEventListener('input', () => {
  applyExplodeGap(Number(ctx.explodeSliderEl.value) || 0);
});

ctx.explodeDirEl.addEventListener('change', () => {
  ctx.explodeDir = ctx.explodeDirEl.value;
  recomputeExplodeGap();
});

if (ctx.explodeResetEl) {
  ctx.explodeResetEl.addEventListener('click', () => {
    resetExplode();      // gap -> 0, restore all parts
  });
}



export function recomputeExplodeGap() {
  resetExplodeToResting();
  const gap = ctx.explodeGap;
  ctx.explodeGap = 0;
  computeExplodeDirs();
  applyExplodeGap(gap);
  broadcastExplode();
}

export function refreshExplodeForVisibility() {
  if (!ctx.model || typeof recomputeExplodeGap !== 'function') return;
  recomputeExplodeGap();
}

export function resetExplodeToResting() {
  if (!ctx.model) return;
  const seen = new Set();
  for (const t of ctx.explodeTargets) {
    if (seen.has(t.node.uuid)) continue;
    seen.add(t.node.uuid);
    t.node.position.copy(t.resting);
    t.node.updateMatrixWorld(true);
  }
}

export function broadcastExplode() {
  if (!ctx.session?.connected || ctx.applyingRemoteExplode) return;
  try {
    ctx.session.ws.send(JSON.stringify({
      t: 'explode', gap: ctx.explodeGap, dir: ctx.explodeDir, scopeKey: ctx.explodeScopeKey,
    }));
  } catch {}
}

export function applyRemoteExplode(msg) {
  ctx.applyingRemoteExplode = true;
  try {
    const dirChanged = typeof msg.dir === 'string' && msg.dir !== ctx.explodeDir;
    if (dirChanged) { ctx.explodeDir = msg.dir; if (ctx.explodeDirEl) ctx.explodeDirEl.value = msg.dir; }
    const scopeChanged = (msg.scopeKey ?? null) !== (ctx.explodeScopeKey ?? null);
    if (scopeChanged) ctx.explodeScopeKey = msg.scopeKey ?? null;
    const gap = Math.max(0, Number(msg.gap) || 0);
    // Pure gap change -> apply directly (smooth, no collapse). Only re-scope
    // (without collapsing the previous scope) when the direction or scope
    // changed, since those change the layout geometry. Mirrors the local
    // behavior where drilling into a sub-assembly keeps prior scopes exploded.
    if (dirChanged || scopeChanged) rescopeExplode();
    else applyExplodeGap(gap);
    setExplodeUi(gap);
  } finally { ctx.applyingRemoteExplode = false; }
}

export function explodeSet(gap, dir) {
  if (typeof dir === 'string' && dir !== ctx.explodeDir) { ctx.explodeDir = dir; if (ctx.explodeDirEl) ctx.explodeDirEl.value = dir; }
  ctx.explodeGap = Math.max(0, Number(gap) || 0);
  recomputeExplodeGap();
  return ctx.explodeGap;
}
