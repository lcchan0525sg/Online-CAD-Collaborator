// CAD Viewer — parts module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';

import { refreshExplodeForVisibility, renderExplodeScope, rescopeExplode } from './explode.js';
import { isPickVisible, pickPartKey, clearActivePivot, activatePivotForPart, setMoveAxis } from './move.js';
import { xferToast, sendPartComment } from './session.js';

export function clearPartsTree() {
  if (!ctx.partsEl) return;
  ctx.partsEl.innerHTML = '<span class="hint">—</span>';
  ctx.partRows.clear();
  ctx.allPartRows.length = 0;
  setFloatingPartsVisible(false);
}

export function nodeAtPath(root, path) {
  let o = root;
  for (const i of path) {
    if (!o?.children?.[i]) return null;
    o = o.children[i];
  }
  return o;
}

export function buildPartsTree(root) {
  if (!ctx.partsEl || !root) return;
  ctx.partsEl.innerHTML = '';
  ctx.partRows.clear();
  ctx.allPartRows.length = 0;
  treeFilter = '';
  if (fpFilterEl) fpFilterEl.value = '';
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
          if (ctx.collapsedPaths.has(key)) ctx.collapsedPaths.delete(key);
          else ctx.collapsedPaths.add(key);
          renderCollapseState();
          if (!ctx.applyingRemoteTree) broadcastTree(key, ctx.collapsedPaths.has(key));
        });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = child.visible;
        cb.addEventListener('change', () => setPartVisible(key, cb.checked));
        const span = document.createElement('span');
        span.className = 'partname';
        span.textContent = child.name || `Part ${count}`;
        span.title = child.name || `Part ${count}`;
        // Clicking the part name SELECTS it and highlights it in the viewport.
        // preventDefault stops the <label> from toggling the visibility checkbox.
        span.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectPart(key, false, e.ctrlKey || e.metaKey);
        });
        row.append(toggle, cb, span);
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showPartMenu(e.clientX, e.clientY, key);
        });
        ctx.partsEl.appendChild(row);
        ctx.partRows.set(key, { cb, row });
        ctx.allPartRows.push({ key, row, toggle, depth });
      }
      if (child.children?.length) walk(child, depth + (isPart ? 1 : 0), p);
    });
  };
  walk(root, 0, []);
  // A row "has kids" if any other row's path starts with its path + a separator.
  for (const r of ctx.allPartRows) {
    r.hasKids = ctx.allPartRows.some((o) => o.key.startsWith(r.key + '.'));
    if (r.hasKids) r.toggle.style.visibility = 'visible';
  }
  // Default: collapse parents at depth >= 1, so the tree initially shows two
  // levels (top assembly + its direct children); deeper levels start collapsed.
  ctx.collapsedPaths = new Set(ctx.allPartRows.filter((r) => r.hasKids && r.depth >= 1).map((r) => r.key));
  renderCollapseState();
  if (!count) ctx.partsEl.innerHTML = '<span class="hint">—</span>';
  setFloatingPartsVisible(count > 0);
}

export function renderCollapseState() {
  for (const r of ctx.allPartRows) {
    const segs = r.key.split('.');
    let visible = true;
    for (let i = 1; i < segs.length; i++) {
      if (ctx.collapsedPaths.has(segs.slice(0, i).join('.'))) { visible = false; break; }
    }
    r.row.style.display = visible ? '' : 'none';
    if (r.hasKids) r.toggle.textContent = ctx.collapsedPaths.has(r.key) ? '+' : '–';
  }
  applyTreeFilter();   // a name filter overrides collapse visibility
}

// ---- Floating Assembly-tree name filter (local, per-viewer, no sync) ----
let treeFilter = '';
const fpFilterEl = document.getElementById('fp-filter');

export function applyTreeFilter() {
  const q = treeFilter.trim().toLowerCase();
  if (!q) return;   // no filter: collapse state (set above) already rules
  const matched = new Set();
  for (const r of ctx.allPartRows) {
    if ((r.row.querySelector('.partname')?.textContent || '').toLowerCase().includes(q)) {
      matched.add(r.key);
      const segs = r.key.split('.');
      for (let i = 1; i < segs.length; i++) matched.add(segs.slice(0, i).join('.'));   // keep ancestors visible
    }
  }
  for (const r of ctx.allPartRows) r.row.style.display = matched.has(r.key) ? '' : 'none';
}

fpFilterEl?.addEventListener('input', () => {
  treeFilter = fpFilterEl.value;
  if (!treeFilter.trim()) { for (const r of ctx.allPartRows) r.row.style.display = ''; renderCollapseState(); }
  else applyTreeFilter();
});

export function showPartMenu(x, y, key) {
  if (!ctx.partMenuEl) return;
  ctx.partMenuKey = key;
  // Reflect the part's current transparency in the menu item label.
  const transEl = document.getElementById('part-menu-trans');
  if (transEl) transEl.textContent = partTransparent(key) ? 'Make opaque' : 'Make transparent';
  ctx.partMenuEl.style.left = `${x}px`;
  ctx.partMenuEl.style.top = `${y}px`;
  ctx.partMenuEl.hidden = false;
  if (ctx.partMenuHideTimer) { clearTimeout(ctx.partMenuHideTimer); ctx.partMenuHideTimer = null; }
}

export function hidePartMenu() {
  if (ctx.partMenuEl) ctx.partMenuEl.hidden = true;
  const cb = document.getElementById('part-comment-box');
  if (cb) cb.hidden = true;
  ctx.partMenuKey = null;
}

export function setPartVisible(key, visible) {
  if (!ctx.model || !key) return;
  const root = ctx.model.children[0];
  const ops = [];
  for (const r of ctx.allPartRows) {
    if (r.key === key || r.key.startsWith(key + '.')) {
      const node = nodeAtPath(root, r.key.split('.').map(Number));
      if (!node) continue;
      node.visible = visible;
      const entry = ctx.partRows.get(r.key);
      if (entry) {
        entry.cb.checked = visible;
        entry.row.classList.toggle('off', !visible);
      }
      ops.push({ path: r.key.split('.').map(Number), visible });
    }
  }
  broadcastParts(ops);
  refreshExplodeForVisibility();
}

export function showOnlyPart(key) {
  if (!ctx.model || !key) return;
  const ops = [];
  const root = ctx.model.children[0];
  for (const r of ctx.allPartRows) {
    const keep = r.key === key
      || r.key.startsWith(key + '.')     // the part itself + its children
      || key.startsWith(r.key + '.');    // ancestors (must stay on to render)
    const node = nodeAtPath(root, r.key.split('.').map(Number));
    if (!node) continue;
    node.visible = keep;
    const entry = ctx.partRows.get(r.key);
    if (entry) {
      entry.cb.checked = keep;
      entry.row.classList.toggle('off', !keep);
    }
    ops.push({ path: r.key.split('.').map(Number), visible: keep });
  }
  broadcastParts(ops);
  refreshExplodeForVisibility();
}

ctx.partMenuOnlyEl?.addEventListener('click', () => {
  const key = ctx.partMenuKey;   // capture BEFORE hidePartMenu() nulls it
  hidePartMenu();
  if (key) showOnlyPart(key);
});

ctx.partMenuHideEl?.addEventListener('click', () => {
  const key = ctx.partMenuKey;
  hidePartMenu();
  if (key) setPartVisible(key, false);
});

ctx.partMenuMoveEl?.addEventListener('click', () => {
  const key = ctx.partMenuKey;
  hidePartMenu();
  if (!key) return;
  if (ctx.selectedPartKey !== key) selectPart(key, true);
  ctx.moveOnChk.checked = true;
  setMoveAxis(null);        // no axis chosen yet — wait for a gizmo-arrow click
  xferToast('Click an axis arrow to set the move direction');
});

// ---- Part comment -> session chat ----
const partCommentBox = () => document.getElementById('part-comment-box');
const partCommentInput = () => document.getElementById('part-comment-input');

document.getElementById('part-menu-comment')?.addEventListener('click', (e) => {
  e.stopPropagation();   // keep the menu open so the text box stays visible
  const box = partCommentBox(), inp = partCommentInput();
  if (!box || !inp) return;
  box.hidden = false;
  inp.value = '';
  inp.focus();
});

function submitPartComment() {
  const key = ctx.partMenuKey;
  const inp = partCommentInput();
  const text = inp ? inp.value : '';
  if (sendPartComment(key, text)) {
    const box = partCommentBox();
    if (box) box.hidden = true;
    hidePartMenu();
  }
}

document.getElementById('part-comment-send')?.addEventListener('click', submitPartComment);
document.getElementById('part-comment-cancel')?.addEventListener('click', () => {
  const box = partCommentBox();
  if (box) box.hidden = true;
});
partCommentInput()?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPartComment(); } });

export function captureMeshBases(root) {
  ctx.meshBase.clear();
  ctx.meshPartKey.clear();
  const keyFor = (node) => {
    const path = [];
    let c = node;
    while (c && c !== root) { path.unshift(c.parent.children.indexOf(c)); c = c.parent; }
    return path.join('.');
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    ctx.meshBase.set(o, Array.isArray(o.material) ? o.material.slice() : [o.material]);
    // deepest named part ancestor (matches the tree's part rows) — check the
    // mesh itself first (flat single-part GLB: the mesh IS the row), then walk
    // up and take the FIRST (deepest) match.
    let partKey = '';
    if (ctx.partRows.has(keyFor(o))) partKey = keyFor(o);
    if (!partKey) {
      let n = o.parent;
      while (n && n !== root) {
        if (ctx.partRows.has(keyFor(n))) { partKey = keyFor(n); break; }
        n = n.parent;
      }
    }
    ctx.meshPartKey.set(o, partKey);
  });
}

export function partIsTransparent(key) {
  if (!key) return false;
  if (ctx.transparentParts.has(key)) return true;
  const seg = key.split('.');
  for (let i = seg.length - 1; i > 0; i--) {
    if (ctx.transparentParts.has(seg.slice(0, i).join('.'))) return true;
  }
  return false;
}

export function partIsSelected(key) {
  return ctx.selectedPartKeys.some((selected) => key === selected || key.startsWith(selected + '.'));
}

export function applyMeshMaterial(o) {
  const base = ctx.meshBase.get(o);
  if (!base) return;
  const key = ctx.meshPartKey.get(o) || '';
  const trans = partIsTransparent(key);
  const sel = partIsSelected(key);
  let mats = base.map((m) => m.clone());   // always clone from the pristine base
  if (trans) mats.forEach((m) => {
    m.transparent = true;
    m.opacity = ctx.TRANSPARENT_OPACITY;
    m.depthWrite = false;
    m.needsUpdate = true;
  });
  if (sel) mats.forEach((m) => {
    m.emissive = (m.emissive ? m.emissive.clone() : new THREE.Color()).set(ctx.HIGHLIGHT_COLOR);
    m.emissiveIntensity = ctx.HIGHLIGHT_INTENSITY;
  });
  o.material = mats.length === 1 ? mats[0] : mats;
}

export function applyAllMaterials() {
  if (!ctx.model) return;
  const root = ctx.model.children[0];
  root.traverse((o) => { if (o.isMesh) applyMeshMaterial(o); });
}

export function partTransparent(key) { return ctx.transparentParts.has(key); }

export function setPartTransparent(key, transparent) {
  if (!ctx.model || !key) return;
  if (transparent) ctx.transparentParts.add(key);
  else ctx.transparentParts.delete(key);
  applyAllMaterials();
  broadcastTransparent(key, transparent);
}

export function broadcastTransparent(key, transparent) {
  if (!ctx.session?.connected || ctx.applyingRemoteTrans) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'trans', key, transparent })); } catch {}
}

export function applyRemoteTransparent(key, transparent) {
  ctx.applyingRemoteTrans = true;
  try { setPartTransparent(key, transparent); } finally { ctx.applyingRemoteTrans = false; }
}

export function clearTransparency() {
  ctx.transparentParts.clear();
  if (ctx.model) applyAllMaterials();
}

export function applyRemoteTransSync(keys) {
  if (!Array.isArray(keys)) return;
  if (!ctx.model) { ctx.pendingRemoteTransKeys = keys; return; }
  ctx.applyingRemoteTrans = true;
  try {
    ctx.transparentParts.clear();
    for (const k of keys) ctx.transparentParts.add(k);
    applyAllMaterials();
  } finally { ctx.applyingRemoteTrans = false; }
}

export function flushPendingTrans() {
  if (!ctx.pendingRemoteTransKeys.length || !ctx.model) return;
  const keys = ctx.pendingRemoteTransKeys;
  ctx.pendingRemoteTransKeys = [];
  applyRemoteTransSync(keys);
}

ctx.partMenuTransEl?.addEventListener('click', () => {
  const key = ctx.partMenuKey;
  hidePartMenu();
  if (!key) return;
  setPartTransparent(key, !partTransparent(key));
});

export function clearPartSelection(silent) {
  clearActivePivot();
  if (ctx.selectedPartKey) {
    for (const key of ctx.selectedPartKeys) {
      const prev = ctx.partRows.get(key);
      if (prev) prev.row.classList.remove('sel');
    }
    ctx.selectedPartKey = null;
    ctx.selectedPartKeys.length = 0;
    applyAllMaterials();
    if (typeof renderExplodeScope === 'function') renderExplodeScope();
    window.__selKey = null;   // dev/debug hook for headless inspection
    if (!silent) broadcastSel(null);
  }
}

export function selectPart(key, force, additive = false) {
  if (!ctx.model || !key) return;
  if (additive && !force) {
    const keys = [...ctx.selectedPartKeys];
    const at = keys.indexOf(key);
    if (at >= 0) keys.splice(at, 1);
    else keys.push(key);
    if (!keys.length) { clearPartSelection(); return; }
    clearActivePivot();
    ctx.selectedPartKeys = keys;
    ctx.selectedPartKey = keys[0];
    for (const [rowKey, entry] of ctx.partRows) entry.row.classList.toggle('sel', keys.includes(rowKey));
    applyAllMaterials();
    if (!force) broadcastSel(ctx.selectedPartKey, keys);
    return;
  }
  if (key === ctx.selectedPartKey) {
    if (!force) clearPartSelection();
    return;
  }
  clearPartSelection(true);
  const node = nodeAtPath(ctx.model.children[0], key.split('.').map(Number));
  if (!node) return;
  ctx.selectedPartKey = key;
  ctx.selectedPartKeys = [key];
  activatePivotForPart(key);
  window.__selKey = key;   // dev/debug hook for headless inspection
  const row = ctx.partRows.get(key);
  if (row) row.row.classList.add('sel');
  applyAllMaterials();
  // Selecting an assembly re-scopes the explode to its immediate children
  // WITHOUT collapsing — the previous scope stays exploded; value resets to 0.
  const rowInfo = ctx.allPartRows.find((r) => r.key === key);
  if (rowInfo && rowInfo.hasKids && typeof rescopeExplode === 'function') {
    rescopeExplode();
  } else if (typeof renderExplodeScope === 'function') {
    renderExplodeScope();
  }
  if (!force) broadcastSel(key);
}

document.addEventListener('click', () => { ctx.partMenuHideTimer = setTimeout(hidePartMenu, 0); });

document.addEventListener('contextmenu', () => { ctx.partMenuHideTimer = setTimeout(hidePartMenu, 0); });

document.addEventListener('scroll', hidePartMenu, true);

export function setAllParts(visible) {
  if (!ctx.model) return;
  const ops = [];
  for (const [key, { cb, row }] of ctx.partRows) {
    const node = nodeAtPath(ctx.model.children[0], key.split('.').map(Number));
    if (!node) continue;
    node.visible = visible;
    cb.checked = visible;
    row.classList.toggle('off', !visible);
    ops.push({ path: key.split('.').map(Number), visible });
  }
  broadcastParts(ops);
}

export function broadcastParts(ops) {
  if (!ctx.session?.connected || !ops?.length) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'parts', ops })); } catch {}
}

export function broadcastTree(pathKey, collapsed) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'tree', key: pathKey, collapsed })); } catch {}
}

export function applyRemoteTree(msg) {
  if (!msg || !msg.key) return;
  ctx.applyingRemoteTree = true;
  try {
    if (msg.collapsed) ctx.collapsedPaths.add(msg.key);
    else ctx.collapsedPaths.delete(msg.key);
    renderCollapseState();
  } finally { ctx.applyingRemoteTree = false; }
}

export function broadcastSel(key, keys = null) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'sel', key, keys: keys || (key ? [key] : []) })); } catch {}
}

export function applyRemoteSel(msg) {
  ctx.applyingRemoteSel = true;
  try {
    const keys = Array.isArray(msg.keys) && msg.keys.length ? msg.keys : (msg.key ? [msg.key] : []);
    if (!keys.length) clearPartSelection(true);
    else {
      selectPart(keys[0], true);
      ctx.selectedPartKeys = keys;
      for (const [rowKey, entry] of ctx.partRows) entry.row.classList.toggle('sel', keys.includes(rowKey));
      applyAllMaterials();
    }
  } finally { ctx.applyingRemoteSel = false; }
}

export function applyRemoteParts(ops) {
  if (!Array.isArray(ops) || !ops.length) return;
  if (!ctx.model) {                        // model not loaded yet — replay later
    ctx.pendingRemoteParts.push(...ops);
    return;
  }
  ctx.applyingRemoteParts = true;
  try {
    for (const op of ops) {
      if (!Array.isArray(op.path) || typeof op.visible !== 'boolean') continue;
      const key = op.path.join('.');
      const node = nodeAtPath(ctx.model.children[0], op.path);
      if (node) node.visible = op.visible;
      const entry = ctx.partRows.get(key);
      if (entry) {
        entry.cb.checked = op.visible;
        entry.row.classList.toggle('off', !op.visible);
      }
    }
    refreshExplodeForVisibility();
  } finally { ctx.applyingRemoteParts = false; }
}

export function flushPendingParts() {
  if (!ctx.pendingRemoteParts.length || !ctx.model) return;
  const ops = ctx.pendingRemoteParts;
  ctx.pendingRemoteParts = [];
  applyRemoteParts(ops);
}

document.getElementById('btn-parts-all')?.addEventListener('click', () => setAllParts(true));

document.getElementById('btn-parts-none')?.addEventListener('click', () => setAllParts(false));

export function partNameForKey(key) {
  if (!ctx.model || !key) return '';
  const node = nodeAtPath(ctx.model.children[0], key.split('.').map(Number));
  return (node && node.name) ? node.name : `Part ${key}`;
}

export function highlightHoverRow(key) {
  if (ctx.hoverRow) ctx.hoverRow.classList.remove('hov');
  ctx.hoverRow = null;
  if (key && ctx.partRows.has(key)) {
    ctx.hoverRow = ctx.partRows.get(key).row;
    ctx.hoverRow.classList.add('hov');
  }
}

export function showPartHoverTip(clientX, clientY) {
  const r = ctx.renderer.domElement.getBoundingClientRect();
  // Containing block is #viewport; the canvas fills it, so offset the tip from
  // the canvas origin (r.left/top) to land at the cursor.
  ctx.partHoverTipEl.style.left = (clientX - r.left) + 'px';
  ctx.partHoverTipEl.style.top = (clientY - r.top) + 'px';
  ctx.partHoverTipEl.hidden = false;
}

export function hidePartHover() {
  highlightHoverRow(null);
  ctx.hoverKey = null;
  ctx.partHoverTipEl.hidden = true;
}

export function hoverPickKey(clientX, clientY) {
  if (!ctx.model) return null;
  const r = ctx.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ctx.hoverRay.setFromCamera(ndc, ctx.camera);
  const hits = ctx.hoverRay.intersectObject(ctx.model, true);
  const hit = hits.find((h) => isPickVisible(h.object));
  if (!hit) return null;
  // Resolve the hit mesh up to its deepest named part ancestor (same rule as
  // pickPartKey, but we also need the ancestor's name for the tooltip).
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

ctx.renderer.domElement.addEventListener('pointerleave', hidePartHover);

/* ---- Floating Parts side-menu (viewport) ---- */
// The parts assembly tree now renders here (buildPartsTree targets
// #floating-parts-list). Just show/hide the panel as parts come and go.
export function setFloatingPartsVisible(show) {
  const p = document.getElementById('floating-parts');
  if (p) p.hidden = !show;
}

document.getElementById('fp-show-all')?.addEventListener('click', () => setAllParts(true));
document.getElementById('fp-hide-all')?.addEventListener('click', () => setAllParts(false));
const fpCollapse = document.getElementById('fp-collapse');
const fpList = document.getElementById('floating-parts-list');
fpCollapse?.addEventListener('click', () => {
  const collapsed = !fpList.hidden;
  fpList.hidden = collapsed;
  fpCollapse.textContent = collapsed ? '▸' : '▾';
  fpCollapse.setAttribute('aria-expanded', String(!collapsed));
  fpCollapse.title = collapsed ? 'Expand Assembly tree' : 'Collapse Assembly tree';
});
