// Session Record — per-viewer session diary: viewport screenshots, section-cut
// history, measurement history, plus the shared chat transcript, combined into
// one downloadable self-contained HTML report ("Create Session Report").
//
// Storage is client-side only: entries live in memory and are mirrored to
// localStorage keyed by the session code ('local' when not in a session), so a
// page reload keeps the record. Nothing is broadcast on the wire and nothing is
// stored on the server.
//
// Hooks (called from other modules):
//   section.js  -> logSection(sectionState())   on every applied section state
//   measure.js  -> logMeasure(entry)            on addMeasurement()
import { ctx } from './context.js';
import { t } from './ui-i18n.js';
import { xferToast } from './session.js';

const LS_PREFIX = 'cadv_record_';
const MAX_SCREENSHOTS = 30;          // oldest dropped first when over budget
const MAX_IMAGE_CHARS = 400_000;     // ~300KB JPEG; larger captures get recompressed
const SECTION_MIN_GAP_MS = 1200;     // collapse slider-drag spam

let cacheKey = null;
let record = emptyRecord();
let lastSectionLog = { state: null, ts: 0 };
let seq = 0;

function emptyRecord() {
  return { screenshots: [], sections: [], measures: [], meta: {} };
}

function lsKey() {
  return LS_PREFIX + ((ctx.session && ctx.session.code) ? ctx.session.code : 'local');
}

function ensureLoaded() {
  const key = lsKey();
  if (key === cacheKey) return;
  cacheKey = key;
  record = emptyRecord();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      record.screenshots = Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
      record.sections = Array.isArray(parsed.sections) ? parsed.sections : [];
      record.measures = Array.isArray(parsed.measures) ? parsed.measures : [];
      record.meta = (parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)) ? parsed.meta : {};
    }
  } catch { /* corrupted record: start clean */ }
}

function save() {
  const key = lsKey();
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Quota exceeded: drop the oldest screenshot image and retry once.
    const entry = record.screenshots.find((s) => s.image);
    if (entry) {
      entry.image = null;
      try { localStorage.setItem(key, JSON.stringify(record)); } catch {}
    }
  }
}

export function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function nextId(prefix) {
  return `${prefix}${++seq}-${Date.now().toString(36)}`;
}

// Stamp the current model name into the record so the report survives a page
// reload (ctx resets, localStorage doesn't). Saves only when something changed.
function refreshMeta() {
  const name = ctx.modelName || '';
  if (name && record.meta.model !== name) {
    record.meta.model = name;
    save();
  }
}

// ---- Capture ------------------------------------------------------------
//
// preserveDrawingBuffer is enabled on the shared renderer (context.js), so the
// canvas can be read synchronously at any time.

function downscale(dataUrl, maxW, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function captureImage({ waitFrame = false } = {}) {
  // toDataURL reads the LAST PRESENTED frame. Auto-capture fires in the same
  // tick as a section change, so it must wait for the next rendered frame or
  // it grabs the stale pre-section view. Manual captures read immediately.
  if (waitFrame) await nextFrame();
  const png = ctx.renderer.domElement.toDataURL('image/png');
  const jpeg = await downscale(png, 1280, 0.85);
  return jpeg.length <= MAX_IMAGE_CHARS ? jpeg : await downscale(jpeg, 900, 0.75);
}

export async function captureScreenshot({ auto = false, cutName = null, cutProfile = null, profileImage = null, waitFrame = false } = {}) {
  ensureLoaded();
  if (!ctx.renderer || !ctx.model) { xferToast(t('ui.load.a.model.first')); return null; }
  refreshMeta();
  const image = await captureImage({ waitFrame });
  const entry = {
    id: nextId('shot'), ts: Date.now(), image, auto: !!auto,
    cutName: cutName || null,
    cutProfile: cutProfile ? {
      enabled: !!cutProfile.enabled,
      axis: cutProfile.axis,
      offset: Number(cutProfile.offset) || 0,
      reversed: !!cutProfile.reversed,
    } : null,
    profileImage: profileImage || null,
  };
  record.screenshots.push(entry);
  while (record.screenshots.length > MAX_SCREENSHOTS) record.screenshots.shift();
  save();
  renderRecordPanel();
  if (!auto) xferToast(t('ui.screenshot.saved.to.session.record'));
  return entry;
}

// ---- Section history ----------------------------------------------------
//
// applySectionState() fires for every internal refresh (remote apply, preset
// chip, drag tick), so entries are deduped against the last logged state and
// throttled unless the meaningful part (enabled/axis/reversed) changed.

export function logSection(state) {
  ensureLoaded();
  if (!state) return;
  const last = lastSectionLog.state;
  const meaningfulChanged = !last
    || last.enabled !== state.enabled
    || last.axis !== state.axis
    || !!last.reversed !== !!state.reversed;
  const identical = last
    && last.enabled === state.enabled
    && last.axis === state.axis
    && !!last.reversed === !!state.reversed
    && last.offset === state.offset;
  const now = Date.now();
  if (identical) return;
  if (!meaningfulChanged && (now - lastSectionLog.ts) < SECTION_MIN_GAP_MS) return;

  // Only record transitions the local viewer made while it had a model;
  // passive remote mirrors still count (the user is watching a peer's cut),
  // but boot-time defaults (disabled, offset 0) are skipped.
  if (!state.enabled && !last) { lastSectionLog = { state: { ...state }, ts: now }; return; }

  record.sections.push({
    id: nextId('sec'), ts: now,
    enabled: !!state.enabled, axis: state.axis,
    offset: Math.round(Number(state.offset) || 0), reversed: !!state.reversed,
  });
  if (record.sections.length > 500) record.sections.shift();
  lastSectionLog = { state: { ...state }, ts: now };
  save();
  renderRecordPanel();
}

// Auto-capture: fires when the user SAVES a named section cut ("Save cut"
// button), capturing the sectioned view and tagging it with the cut's name so
// the report can link the cut entry back to its picture. Always on — the
// capture only costs ~25 KB and Save cut is an explicit user action.
export function onSectionPresetSaved(preset, profileImage = null) {
  ensureLoaded();
  const name = (preset && preset.name) || '';
  const profile = {
    enabled: true,
    axis: preset?.axis || ctx.sectionAxis,
    offset: Number(preset?.offset) || 0,
    reversed: !!preset?.reversed,
  };
  // Save the exact cut profile immediately, even while the image capture is
  // waiting for the next rendered section frame.
  const cutEntry = {
    id: nextId('sec'), ts: Date.now(),
    enabled: profile.enabled, axis: profile.axis,
    offset: profile.offset, reversed: profile.reversed,
    name, saved: true, shotId: null,
  };
  record.sections.push(cutEntry);
  if (record.sections.length > 500) record.sections.shift();
  save();
  renderRecordPanel();

  captureScreenshot({ auto: true, cutName: name, cutProfile: profile, profileImage, waitFrame: true })
    .then((shot) => {
      if (!shot) return;
      cutEntry.shotId = shot.id;
      save();
      renderRecordPanel();
    });
}

// ---- Measurement history -------------------------------------------------

export function logMeasure(entry) {
  if (!entry) return;
  ensureLoaded();
  record.measures.push({
    id: nextId('mea'), ts: Date.now(),
    label: entry.label || '', mm: entry.mm || 0,
    elevation: entry.elevation || 0, azimuth: entry.azimuth || 0,
    part1: entry.part1 || '', part2: entry.part2 || '',
  });
  if (record.measures.length > 500) record.measures.shift();
  save();
  renderRecordPanel();
}

export function deleteScreenshot(id) {
  ensureLoaded();
  const index = record.screenshots.findIndex((s) => s.id === id);
  if (index < 0) return false;
  record.screenshots.splice(index, 1);
  // Remove report back-links to the deleted capture.
  for (const section of record.sections) {
    if (section.shotId === id) delete section.shotId;
  }
  save();
  renderRecordPanel();
  return true;
}

// ---- Panel ---------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function sectionLabel(s) {
  const state = s.enabled ? '▪' : '▫';
  const profile = `${state} ${s.axis.toUpperCase()} · ${s.offset} mm${s.reversed ? ' ↔' : ''}`;
  return s.name ? `${s.name} · ${profile}` : profile;
}

function renderRecordPanel() {
  const listEl = document.getElementById('record-list');
  if (!listEl) return;
  ensureLoaded();
  const groups = [];
  if (record.screenshots.length) {
    const shots = [...record.screenshots].reverse().map((s) => `
      <div class="rec-shot" data-shot-id="${esc(s.id)}">
        ${s.image ? `<img src="${s.image}" alt="capture">` : '<div class="rec-shot-missing"></div>'}
        ${s.profileImage ? `<img class="rec-profile" src="${s.profileImage}" alt="section cut profile">` : ''}
        <button type="button" class="rec-shot-delete" data-shot-id="${esc(s.id)}" title="Delete captured picture" aria-label="Delete captured picture">×</button>
        <span class="cm-time">${fmtClock(s.ts)}${s.auto ? ' · A' : ''}${s.cutName ? ` · ✂ ${esc(s.cutName)}` : ''}</span>
      </div>`).join('');
    groups.push(`<div class="rec-group"><div class="rec-group-head">${esc(t('ui.record.screenshots'))} (${record.screenshots.length})</div>${shots}</div>`);
  }
  if (record.sections.length) {
    const rows = [...record.sections].reverse().slice(0, 50).map((s) => `
      <div class="rec-row"><span class="cm-time">${fmtClock(s.ts)}</span><span class="cm-text">${esc(sectionLabel(s))}${s.shotId ? ' <span class="rec-link" title="captured">📷</span>' : ''}</span></div>`).join('');
    groups.push(`<div class="rec-group"><div class="rec-group-head">${esc(t('ui.record.section.cuts'))} (${record.sections.length})</div>${rows}</div>`);
  }
  if (record.measures.length) {
    const rows = [...record.measures].reverse().slice(0, 50).map((m) => `
      <div class="rec-row"><span class="cm-time">${fmtClock(m.ts)}</span><span class="cm-text">${esc(m.label)} · ${m.mm.toFixed(2)} mm</span></div>`).join('');
    groups.push(`<div class="rec-group"><div class="rec-group-head">${esc(t('ui.record.measurements'))} (${record.measures.length})</div>${rows}</div>`);
  }
  listEl.innerHTML = groups.length ? groups.join('')
    : `<span class="hint">${esc(t('ui.no.record.entries.yet'))}</span>`;
}

export function toggleRecordPanel(show) {
  const win = document.getElementById('record-window');
  if (!win) return;
  const target = typeof show === 'boolean' ? show : win.hidden;
  win.hidden = !target;
  if (target) renderRecordPanel();
}

export function toggleRecordCollapsed() {
  const win = document.getElementById('record-window');
  const button = document.getElementById('btn-record-collapse');
  if (!win) return;
  const collapsed = win.classList.toggle('record-collapsed');
  if (button) {
    button.textContent = collapsed ? '▸' : '▾';
    button.title = collapsed ? 'Expand session record' : 'Collapse session record';
    button.setAttribute('aria-label', button.title);
  }
}

// The chat window and the record window share the same bottom-right anchor.
// When both are open, lift the record window above the chat window instead of
// stacking on top of it. Re-checked whenever either window's visibility changes.
function updateRecordPosition() {
  const win = document.getElementById('record-window');
  if (!win) return;
  const chatOpen = ctx.chatWindowEl && !ctx.chatWindowEl.hidden;
  win.classList.toggle('above-chat', chatOpen);
}

if (typeof MutationObserver !== 'undefined' && ctx.chatWindowEl) {
  new MutationObserver(updateRecordPosition).observe(ctx.chatWindowEl, { attributes: true, attributeFilter: ['hidden'] });
}
window.addEventListener('resize', updateRecordPosition);

// ---- Report --------------------------------------------------------------

function modelName() {
  if (ctx.modelName) record.meta.model = ctx.modelName;   // keep the stored name fresh
  return record.meta.model
    || (ctx.currentModel && (ctx.currentModel.note || ctx.currentModel.filename))
    || (ctx.lastLocalModel && ctx.lastLocalModel.filename)
    || '—';
}

function participants() {
  return (ctx.roster || []).map((r) => r.name + (r.isHost ? ` (${t('ui.host').replace(/^·\s*/, '')})` : '')).join(', ') || '—';
}

export function buildReportHtml() {
  ensureLoaded();
  const code = (ctx.session && ctx.session.code) || '—';
  const now = new Date();
  const shotIndex = new Map(record.screenshots.map((s, i) => [s.id, i + 1]));
  const shots = record.screenshots.map((s, i) => `
    <figure id="shot-${esc(s.id)}">
      ${s.image ? `<img src="${s.image}" alt="capture ${i + 1}">` : '<div class="missing">image not retained</div>'}
      ${s.profileImage ? `<img class="profile-image" src="${s.profileImage}" alt="section cut profile ${i + 1}">` : ''}
      <figcaption>#${i + 1} · ${new Date(s.ts).toLocaleString()}${s.auto ? ' · auto' : ''}${s.cutName ? ` · ✂ ${esc(s.cutName)}` : ''}${s.cutProfile ? ` · ${esc(s.cutProfile.axis.toUpperCase())} plane · ${s.cutProfile.offset} mm${s.cutProfile.reversed ? ' · reversed' : ''}` : ''}</figcaption>
    </figure>`).join('');
  const secRows = record.sections.map((s) => {
    const n = s.shotId ? shotIndex.get(s.shotId) : null;
    const link = n ? `<a href="#shot-${esc(s.shotId)}">📷 #${n}</a>` : '—';
    return `
    <tr><td>${new Date(s.ts).toLocaleTimeString()}</td>
    <td>${s.name ? `<strong>${esc(s.name)}</strong><br>` : ''}${s.enabled ? '✓' : '✕'} ${esc(s.axis.toUpperCase())}${s.reversed ? ' (rev)' : ''}</td>
    <td>${s.offset} mm</td>
    <td>${link}</td></tr>`;
  }).join('');
  const meaRows = record.measures.map((m) => `
    <tr><td>${new Date(m.ts).toLocaleTimeString()}</td>
    <td>${esc(m.label)}</td>
    <td>${m.mm.toFixed(3)} mm</td>
    <td>${Number.isFinite(m.elevation) ? m.elevation.toFixed(1) : '—'}°</td>
    <td>${esc(m.part1)}${m.part2 && m.part2 !== m.part1 ? ` ↔ ${esc(m.part2)}` : ''}</td></tr>`).join('');
  const chatRows = (ctx.chatHistory || []).map((m) => `
    <tr class="${m.system ? 'sys' : ''}"><td>${new Date(m.ts).toLocaleTimeString()}</td>
    <td>${esc(m.system ? '[system]' : m.name)}</td><td>${esc(m.text)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>CAD Viewer — Session report ${esc(code)}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 32px auto; max-width: 900px; color: #1d2430; line-height: 1.5; }
  h1 { font-size: 22px; border-bottom: 2px solid #2f7dff; padding-bottom: 8px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 1px solid #ccd4e0; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #ccd4e0; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #eef2f8; }
  tr.sys td { color: #7a8494; font-style: italic; }
  figure { display: inline-block; margin: 8px; text-align: center; }
  figure img { max-width: 380px; border: 1px solid #ccd4e0; border-radius: 4px; display: block; margin-bottom: 5px; }
  figure img.profile-image { background: #fff; }
  figcaption { font-size: 11px; color: #5a6472; margin-top: 3px; }
  .missing { width: 240px; height: 140px; background: #f0f2f6; border: 1px dashed #b8c1cf; border-radius: 4px; font-size: 11px; color: #7a8494; display: flex; align-items: center; justify-content: center; }
  .meta td:first-child { font-weight: 600; width: 130px; background: #eef2f8; }
  @media print { body { margin: 10mm; } h2 { page-break-after: avoid; } figure { page-break-inside: avoid; } }
</style></head><body>
<h1>CAD Viewer — Session report</h1>
<table class="meta">
  <tr><td>Session code</td><td>${esc(code)}</td></tr>
  <tr><td>Generated</td><td>${now.toLocaleString()}</td></tr>
  <tr><td>Viewer name</td><td>${esc(ctx.userName || '—')}</td></tr>
  <tr><td>Participants</td><td>${esc(participants())}</td></tr>
  <tr><td>Model</td><td>${esc(modelName())}</td></tr>
</table>
<h2>Screenshots (${record.screenshots.length})</h2>
${shots || '<p>None recorded.</p>'}
<h2>Section cuts (${record.sections.length})</h2>
${secRows ? `<table><tr><th>Time</th><th>Plane</th><th>Offset</th><th>Photo</th></tr>${secRows}</table>` : '<p>None recorded.</p>'}
<h2>Measurements (${record.measures.length})</h2>
${meaRows ? `<table><tr><th>Time</th><th>Label</th><th>Distance</th><th>Elev</th><th>Parts</th></tr>${meaRows}</table>` : '<p>None recorded.</p>'}
<h2>Chat history (${(ctx.chatHistory || []).length})</h2>
${chatRows ? `<table><tr><th>Time</th><th>From</th><th>Message</th></tr>${chatRows}</table>` : '<p>No chat messages.</p>'}
</body></html>`;
}

export function downloadReport() {
  ensureLoaded();
  if (!record.screenshots.length && !record.sections.length && !record.measures.length && !(ctx.chatHistory || []).length) {
    xferToast(t('ui.nothing.recorded.for.this.session'));
    return null;
  }
  const html = buildReportHtml();
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const code = (ctx.session && ctx.session.code) || 'local';
  a.href = url;
  a.download = `session-report-${code}-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  xferToast(t('ui.session.report.downloaded'));
  return html;
}

export function clearRecord() {
  ensureLoaded();
  record = emptyRecord();
  lastSectionLog = { state: null, ts: 0 };
  try { localStorage.removeItem(lsKey()); } catch {}
  renderRecordPanel();
  xferToast(t('ui.session.record.cleared'));
}

// ---- Wiring ---------------------------------------------------------------

document.getElementById('btn-record')?.addEventListener('click', () => toggleRecordPanel());
document.getElementById('btn-record-collapse')?.addEventListener('click', () => toggleRecordCollapsed());
document.getElementById('btn-record-close')?.addEventListener('click', () => toggleRecordPanel(false));
document.getElementById('btn-capture')?.addEventListener('click', () => { captureScreenshot(); });
document.getElementById('btn-report')?.addEventListener('click', () => { downloadReport(); });
document.getElementById('btn-record-clear')?.addEventListener('click', () => { clearRecord(); });
document.getElementById('record-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('.rec-shot-delete');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  deleteScreenshot(button.dataset.shotId);
});
document.getElementById('btn-report-bottom')?.addEventListener('click', () => { downloadReport(); });
