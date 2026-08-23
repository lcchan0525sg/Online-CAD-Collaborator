// CAD Viewer — session module (extracted from main.js).

import * as THREE from 'three';
import { ctx } from './context.js';
import { onLanguageChange, t as translate } from './ui-i18n.js';

import { clearModel, isCurrentGen, loadFromGltf, nextLoadGen, refreshAnimUI } from './scene.js';
import { applyRemoteParts, applyRemoteSel, applyRemoteTransSync, applyRemoteTransparent, applyRemoteTree, broadcastParts, broadcastTransparent, clearPartSelection, clearPartsTree, nodeAtPath } from './parts.js';
import { applyRemoteMeasureAdd, applyRemoteMeasureClear, applyRemoteMeasureDel, applyRemoteMeasureSync, applyRemoteMeasureUpdate, broadcastMeasureAdd } from './measure.js';
import { applySectionState, applyRemoteSectionPresets, sectionPresetsState, sectionState } from './section.js';
import { applyRemoteExplode, broadcastExplode } from './explode.js';
import { applyRemoteMove, applyRemoteRot, applyRemoteTransform, broadcastTransform } from './move.js';
import { applyRemoteCorrections, correctionsState } from './model.js';

let reconnectCode = null;
let reconnectCreate = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let backendDetails = null;

export function requestSessionResync() {
  if (!ctx.session?.connected) { xferToast(translate('ui.join.a.session.to.resync')); return false; }
  try { ctx.session.ws.send(JSON.stringify({ t: 'resync-request' })); setSessionStatus(translate('ui.resync.requested.ellipsis')); return true; } catch { return false; }
}

export function broadcastSection(s = sectionState()) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'section', s })); } catch {}
}

export function broadcastSectionPresets(presets = sectionPresetsState()) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'section-preset', presets })); } catch {}
}

export function broadcastCorrections(s = correctionsState()) {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'corr', s })); } catch {}
}

export function onModelAck(from) {
  ctx.ackedSend.add(from);
  if (!ctx.pendingSend.has(from)) return;
  ctx.pendingSend.delete(from);
  if (!ctx.pendingSend.size) {
    if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
    setSessionStatus(translate('ui.connected.host.model.sent.to.all'));
    xferDone(translate('ui.model.sent.to.guest.s'), translate('ui.control.restored'));
  }
}

export function onPeerGone(id) {
  ctx.pendingSend.delete(id);
  ctx.ackedSend.delete(id);
  if (!ctx.pendingSend.size) {
    if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
    setSessionStatus(translate('ui.connected.host'));
    xferDone();
  }
}

export function sendModelAck(note) {
  if (ctx.session?.ws?.readyState === 1) { try { ctx.session.ws.send(JSON.stringify({ t: 'model-ack', note })); } catch {} }
}

export function setReconnectVisible(show) {
  const button = document.getElementById('btn-reconnect-session');
  if (button) button.hidden = !show;
}

export function setSessionStatus(text) {
  if (!ctx.sessionStatusEl) return;
  ctx.sessionStatusEl.textContent = text;
  const state = /^connected/.test(text) ? 'connected'
    : /^connecting/.test(text) ? 'connecting'
      : /disconnected|could not|removed|left/.test(text) ? 'bad' : '';
  if (state) ctx.sessionStatusEl.dataset.state = state;
  else delete ctx.sessionStatusEl.dataset.state;
}

export function setHealth(state) {
  if (!ctx.healthDot) return;
  ctx.healthDot.className = 'health-dot ' + state;
  ctx.healthDot.title = state === 'ok' ? translate('ui.server.connected')
    : state === 'bad' ? translate('ui.server.unreachable')
    : translate('ui.checking.server.ellipsis');
}

function updateBackendStatus(details) {
  backendDetails = details;
  const backend = details?.backend || (details?.docker ? 'docker' : '');
  if (!ctx.backendStatusEl || !backend) return;
  const native = backend === 'native';
  const label = translate(native
    ? 'ui.backend.native'
    : details.fallback
      ? 'ui.backend.docker.fallback'
      : 'ui.backend.docker');
  ctx.backendStatusEl.textContent = translate('ui.conversion.status', { label });
  ctx.backendStatusEl.dataset.backendLabel = label;
  ctx.backendStatusEl.dataset.backend = backend;
  ctx.backendStatusEl.title = native
    ? `Native CAD backend: ${details.nativePython || 'configured Python'}`
    : details.fallback || 'Docker CAD backend: chair-cq:local';
}

export async function pollHealth() {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    const details = await r.json().catch(() => null);
    if (r.ok) { ctx.healthFailures = 0; updateBackendStatus(details); setHealth('ok'); }
    else { ctx.healthFailures++; setHealth(ctx.healthFailures >= 2 ? 'bad' : 'unknown'); }
  } catch {
    ctx.healthFailures++;
    setHealth(ctx.healthFailures >= 2 ? 'bad' : 'unknown');
  }
}

pollHealth();

setInterval(pollHealth, 4000);

export function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function renderRoster() {
  if (!ctx.rosterEl) return;
  ctx.rosterEl.innerHTML = '';
  if (!ctx.roster.length) { ctx.rosterEl.innerHTML = '<span class="hint">—</span>'; return; }
  ctx.roster.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'matrow';
    const isSelf = ctx.session && r.id === ctx.session.id;
    const label = esc(r.name) + (r.isHost ? ` ${translate('ui.host')}` : '') + (isSelf ? ` (${translate('ui.you')})` : '');
    // The host can kick any non-host viewer.
    const kick = ctx.session?.isHost && !r.isHost
      ? `<button class="kick-btn" data-kick="${r.id}" title="Remove ${esc(r.name)}">kick</button>`
      : '';
    row.innerHTML = `<span class="swatch" style="background:${r.isHost ? '#6ea8fe' : '#3a4356'}"></span>
      <span class="matname">${label}</span>${kick}`;
    const kb = row.querySelector('.kick-btn');
    if (kb) kb.addEventListener('click', () => {
      try { ctx.session.ws.send(JSON.stringify({ t: 'kick', target: r.id })); } catch {}
    });
    ctx.rosterEl.appendChild(row);
  });
}

onLanguageChange(() => {
  renderRoster();
  if (ctx.healthDot) setHealth(ctx.healthDot.classList.contains('ok') ? 'ok' : ctx.healthDot.classList.contains('bad') ? 'bad' : 'unknown');
  if (backendDetails) updateBackendStatus(backendDetails);
});

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function appendChatMsg(msg) {
  ctx.chatHistory.push(msg);
  if (ctx.chatHistory.length > ctx.CHAT_HISTORY_MAX) ctx.chatHistory.shift();
  if (!ctx.chatMessagesEl) return;
  const row = document.createElement('div');
  if (msg.system) {
    row.className = 'chat-sys';
    row.textContent = msg.text;
  } else {
    row.className = 'chat-msg' + (msg.self ? ' own' : '');
    row.innerHTML = `<span class="cm-name">${esc(msg.name)}:</span> <span class="cm-text">${esc(msg.text)}</span><span class="cm-time">${fmtTime(msg.ts)}</span>`;
  }
  ctx.chatMessagesEl.appendChild(row);
  ctx.chatMessagesEl.scrollTop = ctx.chatMessagesEl.scrollHeight;
}

export function sendChatText(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (!ctx.session?.connected) { appendChatMsg({ id: 'sys', system: true, text: translate('ui.not.connected.to.a.session') }); return; }
  // Show your own message locally (the server relays only to the other members).
  appendChatMsg({ id: 'self:' + (++ctx.chatSeq), name: ctx.userName, text: t, ts: Date.now(), self: true });
  try { ctx.session.ws.send(JSON.stringify({ t: 'chat', text: t })); } catch {}
}

export function sendChat() {
  const text = (ctx.chatInputEl.value || '').trim();
  if (!text) return;
  ctx.chatInputEl.value = '';
  sendChatText(text);
}

// Send a part comment into the session chat, prefixed with the part name.
export function sendPartComment(key, comment) {
  const t = (comment || '').trim();
  if (!t) return false;
  if (!ctx.session?.connected) { xferToast(translate('ui.join.a.session.to.comment.on.a.part')); return false; }
  const root = ctx.model?.children[0];
  const node = key && root ? nodeAtPath(root, key.split('.').map(Number)) : null;
  const name = (node && node.name) || `Part ${key}`;
  sendChatText(`[${name}] ${t}`);
  return true;
}

ctx.btnChatEl?.addEventListener('click', () => {
  if (ctx.chatWindowEl) ctx.chatWindowEl.hidden = false;
  if (ctx.chatInputEl) ctx.chatInputEl.focus();
});

ctx.btnChatCloseEl?.addEventListener('click', () => { if (ctx.chatWindowEl) ctx.chatWindowEl.hidden = true; });

ctx.chatFormEl?.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });

export function downloadChat() {
  if (!ctx.chatHistory.length) { xferToast(translate('ui.no.chat.messages.to.download')); return; }
  const head = `CAD Viewer session chat transcript\nGenerated ${new Date().toLocaleString()}\n${'='.repeat(48)}\n\n`;
  const body = ctx.chatHistory
    .map((m) => (m.system ? `[system] ${m.text}` : `${fmtTime(m.ts)}  ${m.name}: ${m.text}`))
    .join('\n');
  const blob = new Blob([head + body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const code = (ctx.session && ctx.session.code) ? ctx.session.code : 'chat';
  a.href = url;
  a.download = `chat-${code}-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  xferToast(`Chat transcript saved (${ctx.chatHistory.length} messages)`);
}

ctx.btnChatDownloadEl?.addEventListener('click', downloadChat);

export function applyRemoteChat(msg) {
  appendChatMsg({ id: msg.id, name: msg.name, text: msg.text, ts: msg.ts, self: false });
}

export function applyRemoteChatSync(history) {
  if (!Array.isArray(history)) return;
  ctx.chatHistory = history.map((m) => ({ id: m.id, name: m.name, text: m.text, ts: m.ts, self: false }));
  if (ctx.chatMessagesEl) {
    ctx.chatMessagesEl.innerHTML = '';
    for (const m of ctx.chatHistory) {
      const row = document.createElement('div');
      row.className = 'chat-msg';
      row.innerHTML = `<span class="cm-name">${esc(m.name)}:</span> <span class="cm-text">${esc(m.text)}</span><span class="cm-time">${fmtTime(m.ts)}</span>`;
      ctx.chatMessagesEl.appendChild(row);
    }
    ctx.chatMessagesEl.scrollTop = ctx.chatMessagesEl.scrollHeight;
  }
}

export function resetChat() {
  ctx.chatHistory = [];
  if (ctx.chatMessagesEl) ctx.chatMessagesEl.innerHTML = '';
}

export function showSessionUI(active, code) {
  if (!ctx.sessionControlsEl || !ctx.sessionActiveEl) return;
  ctx.sessionControlsEl.hidden = active;
  ctx.sessionActiveEl.hidden = !active;
  const roleEl = document.getElementById('session-role');
  if (roleEl && !active) { roleEl.hidden = true; roleEl.textContent = ''; }
  // The chat window opens by default when entering a session (create or join),
  // so members can talk immediately. It can be closed and reopened via the Chat
  // button / ✕.
  if (active && ctx.chatWindowEl) ctx.chatWindowEl.hidden = false;
  if (active) {
    ctx.sessionCodeEl.textContent = code;
    ctx.sessionCodeEl.title = translate('ui.click.to.copy');
    ctx.sessionCodeEl.style.cursor = 'pointer';
    // Join link: http://<lan-ip>:<port>/?s=CODE — shown so the host can hand
    // the address to other users on the same network.
    refreshJoinLink(code);
    // auto-rotate would fight camera sync, so disable it while in a session
    document.getElementById('chk-rotate').checked = false;
    document.getElementById('chk-rotate').disabled = true;
    ctx.controls.autoRotate = false;
  } else {
    document.getElementById('chk-rotate').disabled = false;
  }
}

export async function refreshJoinLink(code) {
  const linkEl = document.getElementById('session-link');
  if (!linkEl) return;
  const port = location.port ? `:${location.port}` : '';
  let base = location.hostname;                 // e.g. 192.168.x.x or localhost
  try {
    const res = await fetch('/ip');
    if (res.ok) {
      const j = await res.json();
      if (j.lan) base = j.lan;                      // preferred LAN address
      else if (j.ips?.length) base = j.ips[0];
    }
  } catch {}
  const url = `${location.protocol}//${base}${port}/?s=${code}`;
  linkEl.href = url;
  linkEl.textContent = url;
  linkEl.title = translate('ui.open.on.another.machine.or.copy');
}

export function endSessionForGuest({ status = translate('ui.not.in.a.session'), info = '', toast = '' } = {}) {
  if (ctx.session) { try { ctx.session.ws.close(); } catch {} }
  ctx.session = null;
  setReconnectVisible(false);
  ctx.roster = []; renderRoster();
  setSessionStatus(status);
  showSessionUI(false);
  const chk = document.getElementById('chk-rotate');
  if (chk) chk.disabled = false;
  // A transfer can't finish without a session — clear it and restore control.
  ctx.pendingSend.clear();
  ctx.currentModel = null;
  if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
  xferAbort();
  nextLoadGen();
  ctx.pendingRemoteSectionPresets = null;
  clearModel();
  if (typeof resetChat === 'function') { resetChat(); if (ctx.chatWindowEl) ctx.chatWindowEl.hidden = true; }
  if (info) { const infoEl = document.getElementById('info'); if (infoEl) infoEl.textContent = info; }
  if (toast) xferToast(toast);
}

function scheduleGuestReconnect() {
  if (!reconnectCode || reconnectCreate || reconnectAttempts >= 3 || reconnectTimer) return;
  const delay = [1000, 2000, 5000][reconnectAttempts];
  reconnectAttempts++;
  setSessionStatus(translate('ui.reconnecting.attempt', { attempt: reconnectAttempts }));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTo(reconnectCode, { create: false, reconnect: true });
  }, delay);
}

export function connectTo(code, { create = false, reconnect = false } = {}) {
  reconnectCode = code;
  reconnectCreate = create;
  if (!reconnect) reconnectAttempts = 0;
  setReconnectVisible(false);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ session: code, name: ctx.userName });
  if (create) q.set('create', '1');
  const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ctx.session = { code, ws, id: null, isHost: false, connected: false, name: ctx.userName, reconnect };
  setSessionStatus(translate('ui.connecting.ellipsis'));
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onSessionMsg(m); };
  ws.onclose = (ev) => {
    // A later connectTo() may have replaced this connection — if so, this
    // stale close handler must not clobber the new session's state.
    if (!ctx.session || ctx.session.ws !== ws) return;
    const wasIn = ctx.session?.connected;
    const wasHost = ctx.session?.isHost;
    ctx.session = null;
    if (ev.code === 4001) {
      setSessionStatus(translate('ui.removed.by.host'));
      showSessionUI(false);
      ctx.roster = []; renderRoster();
      // The viewer was removed — clear the model from their screen.
      clearModel();
      clearPartsTree();
      clearPartSelection();
      const infoEl = document.getElementById('info');
      if (infoEl) infoEl.textContent = translate('ui.you.were.removed.from.the.session.by.the.host');
      xferToast(translate('ui.you.were.removed.from.the.session.by.the.host'));
    } else if (ev.code === 4002) {
      // Fallback: the server told us the host left, but the 'host-left' message
      // was never delivered before the socket closed. End the session the same way.
      endSessionForGuest({ status: translate('ui.host.left.session.ended'), info: translate('ui.the.host.left.the.session'), toast: translate('ui.host.left.session.ended.2') });
    } else if (wasIn && !wasHost) {
      setSessionStatus(translate('ui.disconnected.reconnecting'));
      showSessionUI(true);
      setReconnectVisible(true);
      scheduleGuestReconnect();
    } else if (wasIn) {
      setSessionStatus(translate('ui.disconnected'));
      showSessionUI(false);
      setReconnectVisible(false);
    } else if (ctx.sessionStatusEl && ctx.sessionStatusEl.textContent === translate('ui.connecting.ellipsis')) {
      setSessionStatus(translate('ui.could.not.connect'));
    }
    // A transfer can't finish without a session — clear it and restore control.
    ctx.pendingSend.clear();
    ctx.currentModel = null;
    if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
    xferAbort();
  };
  ws.onerror = () => {}; // onclose handles cleanup
}

export async function onSessionMsg(msg) {
  switch (msg.t) {
    case 'joined':
      ctx.session.id = msg.id;
      ctx.session.isHost = msg.isHost;
      ctx.session.connected = true;
      reconnectAttempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      setReconnectVisible(false);
      ctx.roster = msg.roster;
      setSessionStatus(msg.isHost ? translate('ui.connected.host') : translate('ui.connected'));
      const roleEl = document.getElementById('session-role');
      if (roleEl) { roleEl.textContent = msg.isHost ? 'HOST' : 'GUEST'; roleEl.hidden = false; }
      showSessionUI(true, msg.session);
      renderRoster();
      // Host opened a model BEFORE the session existed (or while connecting):
      // upload + offer it now so guests get it, without re-opening the file.
      if (msg.isHost && ctx.lastLocalModel) {
        // The upload resets model-specific server state when it completes. Wait
        // for that reset before publishing transforms/visibility/transparency,
        // otherwise those messages can arrive first and be erased by the upload.
        await shareBuffer(ctx.lastLocalModel.buf, ctx.lastLocalModel.filename, ctx.lastLocalModel.kind);
        const sent = new Set();
        for (const entry of ctx.transformHistory) {
          const key = entry.path.join('.');
          if (sent.has(key)) continue;
          sent.add(key);
          const node = ctx.model && nodeAtPath(ctx.model.children[0], entry.path);
          if (node) broadcastTransform(entry.path, node, ctx.pivotByPath.get(key) || null);
        }
        // Publish pre-created part visibility (hidden / isolated parts) too. Without
        // this a guest that joins sees every part visible until the 1.2s auto-resync
        // (or never, if that is skipped). Only non-default (hidden) parts are sent,
        // mirroring how the server stores visibility as a delta from all-visible.
        if (ctx.model) {
          const hiddenOps = [];
          const root = ctx.model.children[0];
          for (const r of ctx.allPartRows) {
            const node = nodeAtPath(root, r.key.split('.').map(Number));
            if (node && !node.visible) hiddenOps.push({ path: r.key.split('.').map(Number), visible: false });
          }
          if (hiddenOps.length) broadcastParts(hiddenOps);
        }
        // Publish pre-created part transparency (transparent parts) the same way.
        if (ctx.transparentParts.size) {
          for (const key of ctx.transparentParts) broadcastTransparent(key, true);
        }
        for (const measurement of ctx.measureList) broadcastMeasureAdd(measurement);
        // Publish a pre-created section state (plane/axis/offset/reverse) the same
        // way transforms + measurements are, so a guest that joins later receives
        // it and the server stores it for resync / late-joiner replay.
        if (ctx.sectionOn) broadcastSection(sectionState());
        // Publish pre-created model corrections (units/scale/flip/rotate) too.
        broadcastCorrections();
        // Publish any saved section presets.
        if (ctx.sectionPresets.length) broadcastSectionPresets(sectionPresetsState());
        // Publish the host's current lighting + animation + explode (the "module
        // status") the same way. Without these the guest only ever got its own
        // defaults, and its load-time broadcast relayed those defaults back and
        // clobbered the host. The server stores each value so resync /
        // late-joiner replay can hand it to later members too.
        broadcastLight();
        broadcastAnim();
        if (ctx.explodeGap) broadcastExplode();
        // Publish the host's current camera (view angle + zoom) too, so a guest
        // joining a session whose model was opened BEFORE the session existed
        // adopts the host's view. Without this, session.camera is null for a
        // pre-session model and the guest would snap to its own default framing
        // — which gets relayed back and resets the host's view angle + zoom.
        broadcastCamera();
      }
      // Guest deep-link: the server tells us the session already has a model —
      // fetch + load it (blocking overlay until it lands).
      if (msg.model && (!ctx.session.reconnect || !ctx.model)) loadSharedModel(msg.model);
      if (!msg.isHost) setTimeout(() => requestSessionResync(), 1200);
      break;
    case 'roster':
      ctx.roster = msg.roster; renderRoster();
      break;
    case 'peer-join':
      // The roster just refreshed; a new member is in. If we're the host and
      // already hold a model, offer it to the newcomer. The guest's 'joined'
      // already carried the model, so we only block here if we have something
      // to hand over.
      ctx.roster = ctx.roster.filter((r) => r.id !== msg.id);
      ctx.roster.push({ id: msg.id, name: msg.name, isHost: msg.isHost });
      renderRoster();
      if (ctx.session?.isHost && ctx.currentModel) sendModelToPeers(ctx.currentModel, [msg.id]);
      break;
    case 'peer-gone':
      ctx.roster = ctx.roster.filter((r) => r.id !== msg.id);
      renderRoster();
      onPeerGone(msg.id);
      break;
    case 'host-left':
      // The host left or closed the session. The shared model belonged to the
      // host, so clear it from our view and end the session for this guest.
      endSessionForGuest({ status: translate('ui.host.left.session.ended'), info: translate('ui.the.host.left.the.session'), toast: translate('ui.host.left.session.ended.2') });
      break;
    case 'model':
      loadSharedModel(msg);
      break;
    case 'model-ack':
      // Any sharer — host OR guest — must process ACKs to drain its own
      // pendingSend/ackedSend. The old `if (session?.isHost)` gate meant a
      // guest that shared a model received the ACKs but ignored them, hanging
      // its "Sending model to guest(s)…" overlay for the full 30s.
      onModelAck(msg.from);
      break;
    case 'parts':
      applyRemoteParts(msg.ops);
      break;
    case 'tree':
      applyRemoteTree(msg);
      break;
    case 'sel':
      applyRemoteSel(msg);
      break;
    case 'cam':
      applyRemoteCamera(msg.pos, msg.target);
      break;
    case 'move':
      applyRemoteMove(msg);
      break;
    case 'transform':
      applyRemoteTransform(msg);
      break;
    case 'section':
      ctx.applyingRemoteSection = true;
      try { applySectionState(msg.s || msg, false); } finally { ctx.applyingRemoteSection = false; }
      break;
    case 'section-preset':
      applyRemoteSectionPresets(msg.presets);
      break;
    case 'corr':
      applyRemoteCorrections(msg.s);
      break;
    case 'rot':
      applyRemoteRot(msg);
      break;
    case 'trans':
      applyRemoteTransparent(msg.key, msg.transparent);
      break;
    case 'trans-sync':
      applyRemoteTransSync(msg.keys);
      break;
    case 'resync-done':
      setSessionStatus(ctx.session?.isHost ? translate('ui.connected.host') : translate('ui.connected'));
      xferToast(translate('ui.session.state.synchronized'));
      break;
    case 'chat':
      applyRemoteChat(msg);
      break;
    case 'chat-sync':
      applyRemoteChatSync(msg.history);
      break;
    case 'measure-add':
      applyRemoteMeasureAdd(msg);
      break;
    case 'measure-update':
      applyRemoteMeasureUpdate(msg);
      break;
    case 'measure-del':
      applyRemoteMeasureDel(msg);
      break;
    case 'measure-clear':
      applyRemoteMeasureClear();
      break;
    case 'measure-sync':
      applyRemoteMeasureSync(msg.measures);
      break;
    case 'explode':
      applyRemoteExplode(msg);
      break;
    case 'anim':
      applyRemoteAnim(msg.s);
      break;
    case 'light':
      applyRemoteLight(msg.s);
      break;
  }
}

export function xferLogReset() { ctx.xferLog = []; }

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function xferBegin(title, sub, totalBytes) {
  ctx.xferSeq++;
  ctx.xferTitleEl.textContent = title;
  ctx.xferSubEl.textContent = sub || '';
  ctx.xferFillEl.style.width = '0%';
  if (totalBytes && totalBytes > 0) ctx.xferBarEl.classList.remove('indeterminate');
  else ctx.xferBarEl.classList.add('indeterminate');
  ctx.xferOverlayEl.hidden = false;
  ctx.xferBlocking = true;
  ctx.controls.enabled = false;
}

export function xferProgress(loaded, total) {
  if (total && total > 0) {
    ctx.xferBarEl.classList.remove('indeterminate');
    ctx.xferFillEl.style.width = Math.min(100, (loaded / total) * 100).toFixed(1) + '%';
    ctx.xferSubEl.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
  } else {
    ctx.xferSubEl.textContent = fmtBytes(loaded) + ' received';
  }
}

export function xferDone(title, sub) {
  ctx.xferBlocking = false;
  if (ctx.xferOverlayEl.hidden) return;
  ctx.xferBarEl.classList.remove('indeterminate');
  ctx.xferFillEl.style.width = '100%';
  ctx.xferTitleEl.textContent = title || 'Model loaded';
  ctx.xferSubEl.textContent = sub || 'you can now rotate, zoom and pan';
  ctx.controls.enabled = true;
  const seq = ctx.xferSeq;
  setTimeout(() => {
    if (seq !== ctx.xferSeq) return;          // a newer transfer started — don't clobber it
    ctx.xferOverlayEl.hidden = true;
    xferToast(translate('ui.model.ready.full.control.restored'));
  }, 950);
}

export function xferError(msg) {
  ctx.xferBlocking = false;
  ctx.xferSeq++;
  if (!ctx.xferOverlayEl.hidden) ctx.xferOverlayEl.hidden = true;
  ctx.controls.enabled = true;
  xferToast(translate('ui.model.transfer.failed') + ' ' + (msg || translate('ui.unknown.error')));
}

export function xferAbort() {
  ctx.xferBlocking = false;
  ctx.xferSeq++;
  if (!ctx.xferOverlayEl.hidden) ctx.xferOverlayEl.hidden = true;
  ctx.controls.enabled = true;
}

export async function streamBytes(res, onProgress) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, received);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  const b = new Uint8Array(await res.arrayBuffer());
  onProgress?.(b.length, b.length);
  return b;
}

export function xferToast(msg) {
  if (!ctx.xferToastEl) return;
  ctx.xferToastEl.textContent = msg;
  ctx.xferToastEl.hidden = false;
  ctx.xferToastEl.classList.remove('is-out');
  if (ctx.xferToastTimer) clearTimeout(ctx.xferToastTimer);
  ctx.xferToastTimer = setTimeout(() => {
    ctx.xferToastEl.classList.add('is-out');
    setTimeout(() => { ctx.xferToastEl.hidden = true; ctx.xferToastEl.classList.remove('is-out'); }, 450);
  }, 3200);
}

export async function loadSharedModel(m) {
  if (!ctx.session) return;
  const gen = nextLoadGen();   // shared model supersedes any in-flight local load
  const infoEl = document.getElementById('info');
  const label = m.note || m.filename || 'model';
  xferBegin(translate('ui.receiving.model.ellipsis'), label);
  try {
    const res = await fetch(`/sessions/${ctx.session.code}/model?ts=${Date.now()}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    xferProgress(0, total);
    const buf = await streamBytes(res, (r, t) => xferProgress(r, t || total));
    // ACK the host as soon as the model BYTES arrive, not after the heavy
    // parse/load below. The host's overlay only waits on transfer; the local
    // load continues independently. Sending the ACK here removes the timing
    // dependency on model size / client speed, so a large model can't make the
    // host's 30s sendGuard fire early.
    sendModelAck(label);

    ctx.loader.parse(buf.buffer, '', (gltf) => {
      if (!isCurrentGen(gen)) return;   // superseded — the newer load owns the UI
      try {
        loadFromGltf(gltf);
        infoEl.textContent = `shared: ${label}\n` + infoEl.textContent;
        xferDone(translate('ui.model.received'), translate('ui.you.can.now.rotate.zoom.and.pan'));
      } catch (err) {
        if (!isCurrentGen(gen)) return;
        infoEl.textContent = translate('ui.shared.model.load.error') + ' ' + (err?.message ?? err);
        xferError(translate('ui.shared.model.load.error') + ' ' + (err?.message ?? err));
      }
    }, (e) => {
      if (!isCurrentGen(gen)) return;
      infoEl.textContent = translate('ui.shared.model.load.failed') + ' ' + e.message;
      xferError(e.message);
    });
  } catch (e) {
    if (!isCurrentGen(gen)) return;
    infoEl.textContent = translate('ui.failed.to.load.shared.model') + ' ' + e.message;
    xferError(e.message);
    // No ACK here: if the fetch/stream failed the model never arrived, so the
    // host should legitimately wait for its sendGuard rather than think we got
    // a model we didn't receive.
  }
}

export function sendModelToPeers(m, ids) {
  if (!ctx.session || !ctx.session.connected) return;
  ctx.currentModel = m;
  const guests = ids && ids.length
    ? ids.filter((id) => ctx.roster.some((r) => r.id === id))
    // Wait on every member EXCEPT this client (the uploader). Using !isHost
    // assumed the host is always the sharer — when a guest shares, that wrongly
    // dropped the host from the wait-list and added the sharer to its own
    // pendingSend (which never ACKs), hanging the overlay for 30s.
    : ctx.roster.filter((r) => r.id !== ctx.session.id).map((r) => r.id);
  // Only wait on guests that haven't already ACKed this model (a fast guest may
  // have ACKed before this function ran — see onModelAck/ackedSend).
  const waiting = guests.filter((id) => !ctx.ackedSend.has(id));
  ctx.pendingSend = new Set(waiting);
  if (!waiting.length) {
    // Everyone already ACKed (or no guests) — nothing to wait for.
    xferDone(translate('ui.model.ready.to.share'), translate('ui.all.viewers.confirmed'));
    return;
  }
  xferBegin(translate('ui.sending.model.to.guest.s.ellipsis'), `${waiting.length} waiting to load…`);
  if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
  ctx.sendGuard = setTimeout(() => {
    if (!ctx.pendingSend.size) return;
    setSessionStatus(translate('ui.connected.host.send.timed.out'));
    xferDone(translate('ui.model.sent'), translate('ui.no.ack.within.30s.continuing'));
  }, 30000);
}

export async function shareBuffer(buf, filename, kind) {
  if (!ctx.session || !ctx.session.connected) return;
  // New model share: reset the ACK tracking. ACKs that arrive during the upload
  // POST below (a fast guest can ACK before the host's POST returns) are
  // captured in ackedSend and honored by sendModelToPeers.
  ctx.ackedSend = new Set();
  ctx.pendingSend = new Set();
  const infoEl = document.getElementById('info');
  const verb = kind === 'glb' ? 'sharing' : 'converting + sharing';
  infoEl.textContent = `${verb} ${filename} to the session…`;
  try {
    const res = await fetch(`/sessions/${ctx.session.code}/model`, {
      method: 'POST',
      body: buf,
      headers: { 'x-filename': filename, 'x-kind': kind, 'x-uploader-id': ctx.session.id || '' },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}\n${errText.slice(-400)}`);
    }
    const j = await res.json().catch(() => ({}));
    const note = j.note || filename;
    infoEl.textContent = `shared ${note} · ${ctx.roster.length} viewer(s)\n` + infoEl.textContent;
    sendModelToPeers({ buf, filename, kind, note });
    return j;
  } catch (e) {
    console.error(e);
    infoEl.textContent = translate('ui.share.failed') + '\n' + (e.message ?? e);
    xferError(e.message);
    return null;
  }
}

ctx.controls.addEventListener('change', () => {
  if (!ctx.session?.connected || ctx.applyingRemote) return;
  const now = performance.now();
  if (now - ctx.lastCamSent < ctx.CAM_INTERVAL) return;
  ctx.lastCamSent = now;
  try {
    ctx.session.ws.send(JSON.stringify({
      t: 'cam',
      pos: [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
      target: [ctx.controls.target.x, ctx.controls.target.y, ctx.controls.target.z],
    }));
  } catch {}
});

export function broadcastCamera() {
  if (!ctx.session?.connected) return;
  try {
    ctx.session.ws.send(JSON.stringify({
      t: 'cam',
      pos: [ctx.camera.position.x, ctx.camera.position.y, ctx.camera.position.z],
      target: [ctx.controls.target.x, ctx.controls.target.y, ctx.controls.target.z],
    }));
  } catch {}
}

export function applyRemoteCamera(pos, target) {
  if (!pos || !target || pos.length !== 3 || target.length !== 3) return;
  ctx.applyingRemote = true;
  ctx.camera.position.set(pos[0], pos[1], pos[2]);
  ctx.controls.target.set(target[0], target[1], target[2]);
  ctx.controls.update();
  ctx.applyingRemote = false;
  ctx.remoteCamValid = true;   // a peer/host camera is now in force (guest load adopts it)
}

export function currentAnimState() {
  return { clip: ctx.animState.clip, playing: ctx.animState.playing, loop: ctx.animState.loop, speed: ctx.animState.speed };
}

export function broadcastAnim() {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'anim', s: currentAnimState() })); } catch {}
}

export function applyRemoteAnim(s) {
  if (!s) return;
  const clips = (ctx.lastGltf && ctx.lastGltf.animations) || [];
  // If no animated model is loaded yet, buffer the state and apply it once a
  // model (with clips) arrives — mirrors how parts state is deferred.
  if (!clips.length) { ctx.pendingRemoteAnim = s; ctx.animState.playing = !!s.playing; ctx.animState.loop = !!s.loop; if (typeof s.speed === 'number') ctx.animState.speed = s.speed; return; }
  ctx.pendingRemoteAnim = null;
  if (typeof s.clip === 'number' && s.clip >= 0 && s.clip < clips.length) {
    ctx.animState.clip = s.clip;
    if (ctx.mixer) { ctx.mixer.stopAllAction(); const a = ctx.mixer.clipAction(clips[s.clip]); a.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce); a.clampWhenFinished = !s.loop; if (s.playing) a.play(); }
  }
  ctx.animState.playing = !!s.playing;
  ctx.animState.loop = !!s.loop;
  if (typeof s.speed === 'number') ctx.animState.speed = s.speed;
  refreshAnimUI();
}

export function currentLightState() {
  return { ambient: ctx.hemi.intensity, key: ctx.key.intensity, fill: ctx.fill.intensity, front: ctx.front.intensity };
}

export function broadcastLight() {
  if (!ctx.session?.connected) return;
  try { ctx.session.ws.send(JSON.stringify({ t: 'light', s: currentLightState() })); } catch {}
}

export function applyRemoteLight(s) {
  if (!s) return;
  if (typeof s.ambient === 'number') ctx.hemi.intensity = s.ambient;
  if (typeof s.key === 'number') ctx.key.intensity = s.key;
  if (typeof s.fill === 'number') ctx.fill.intensity = s.fill;
  if (typeof s.front === 'number') ctx.front.intensity = s.front;
  const ids = { ambient: 'light-ambient', key: 'light-key', fill: 'light-fill', front: 'light-front' };
  Object.entries(ids).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.value = currentLightState()[k];
    const v = document.getElementById(id + '-val');
    if (v) v.textContent = currentLightState()[k].toFixed(1);
  });
}

export function newSessionCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

document.getElementById('btn-create-session').addEventListener('click', () => {
  askName();
  connectTo(newSessionCode(), { create: true });
});

document.getElementById('btn-join-session').addEventListener('click', () => {
  const code = ctx.joinCodeInput.value.trim().toUpperCase();
  if (!code) { setSessionStatus('enter a session code'); return; }
  askName();
  connectTo(code);
});

ctx.joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-session').click();
});

document.getElementById('btn-resync-session')?.addEventListener('click', requestSessionResync);

document.getElementById('btn-reconnect-session')?.addEventListener('click', () => {
  if (!reconnectCode) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  connectTo(reconnectCode, { create: reconnectCreate, reconnect: true });
});

document.getElementById('btn-leave-session').addEventListener('click', () => {
  // A guest who leaves on their own has the shared model cleared from their
  // view (the host keeps the model they opened locally).
  const wasGuest = ctx.session && !ctx.session.isHost;
  if (ctx.session) { try { ctx.session.ws.close(); } catch {} ctx.session = null; }
  ctx.roster = []; renderRoster();
  setSessionStatus('not in a session');
  showSessionUI(false);
  document.getElementById('chk-rotate').disabled = false;
  // a transfer in flight no longer has a session to land in
  ctx.pendingSend.clear();
  ctx.currentModel = null;
  if (ctx.sendGuard) clearTimeout(ctx.sendGuard);
  xferAbort();
  if (wasGuest) {
    nextLoadGen();
    ctx.pendingRemoteSectionPresets = null;
    if (ctx.model) clearModel();
  }
  if (typeof resetChat === 'function') { resetChat(); if (ctx.chatWindowEl) ctx.chatWindowEl.hidden = true; }
});

ctx.sessionCodeEl?.addEventListener('click', () => {
  navigator.clipboard?.writeText(ctx.sessionCodeEl.textContent).catch(() => {});
});

export function storedName() {
  try { return (localStorage.getItem('cadv_name') || '').trim(); } catch { return ''; }
}

export function ensureName() {
  ctx.userName = storedName() || 'viewer';
  return ctx.userName;
}

export function askName() {
  ensureName();
  if (navigator.webdriver) return ctx.userName;
  const entered = (window.prompt('Enter your name (shown to other viewers):', ctx.userName) || '').trim().slice(0, 24);
  if (entered) {
    ctx.userName = entered;
    try { localStorage.setItem('cadv_name', entered); } catch {}
  }
  return ctx.userName;
}
