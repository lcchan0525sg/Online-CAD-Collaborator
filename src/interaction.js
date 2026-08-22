// CAD Viewer — unified interaction state and compact viewport toolbar.
// This layer keeps the legacy sidebar controls working while making the active
// tool, transform axis, selected part, and next action visible in the viewport.
import { ctx } from './context.js';
import { onLanguageChange, t } from './ui-i18n.js';
import {
  cancelMoveDrag,
  cancelRotateDrag,
  resetPivot,
  setMoveAxis,
  setPivotMode,
  setRotateMode,
} from './move.js';
import { cancelSectionDrag, setSectionMode } from './section.js';
import {
  clearPartSelection,
  partNameForKey,
  partTransparent,
  setPartTransparent,
  setPartVisible,
  showOnlyPart,
  showPartMenu,
} from './parts.js';

const toolbar = document.getElementById('interaction-toolbar');
const statusEl = document.getElementById('interaction-status');
const transformReadoutEl = document.getElementById('transform-readout');
const contextEl = document.getElementById('interaction-context');
const selectedLabelEl = document.getElementById('selected-part-label');
const toolButtons = [...document.querySelectorAll('[data-tool]')];
const axisButtons = [...document.querySelectorAll('[data-axis]')];
const contextButtons = [...document.querySelectorAll('[data-part-action]')];

function isTextEntry(target) {
  return target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable);
}

export function activeTool() {
  if (ctx.sectionMode && ctx.sectionOn) return 'section';
  if (ctx.measureOn) return 'measure';
  if (ctx.pivotMode) return 'pivot';
  if (ctx.moveOnChk?.checked) return ctx.rotateMode ? 'rotate' : 'move';
  return 'select';
}

function toolStatus(tool) {
  if (tool === 'section') {
    const offset = ctx.sectionOffsetValEl?.textContent || `${ctx.sectionOffset} mm`;
    return t('ui.section.status', { axis: ctx.sectionAxis.toUpperCase(), offset });
  }
  if (tool === 'measure') {
    return ctx.measureP1 ? t('ui.measure.first.point.set') : t('ui.measure.click.corner');
  }
  if (tool === 'pivot') {
    if (!ctx.selectedPartKey) return t('ui.select.part.to.edit.pivot');
    return t('ui.pivot.status');
  }
  if (tool === 'move' || tool === 'rotate') {
    const label = tool[0].toUpperCase() + tool.slice(1);
    if (!ctx.selectedPartKey) return t('ui.select.part.to.tool', { tool: t(tool === 'rotate' ? 'ui.rotation' : 'ui.move').toLowerCase() });
    if (!ctx.moveAxis) return t('ui.tool.choose.axis', { tool: label });
    return t('ui.tool.axis.status', { tool: label, axis: ctx.moveAxis.toUpperCase() });
  }
  return ctx.selectedPartKey ? t('ui.part.selected.choose.tool') : t('ui.select.part');
}

function selectedBreadcrumb(key) {
  if (!ctx.model || !key) return '';
  const root = ctx.model.children[0];
  const names = [];
  let node = root;
  for (const index of key.split('.').map(Number)) {
    node = node?.children?.[index];
    if (!node) break;
    if (node.name) names.push(node.name);
  }
  return names.join(' › ') || partNameForKey(key);
}

function formatMm(value) {
  const mm = Math.abs(value) * 1000;
  return mm >= 100 ? mm.toFixed(0) : mm >= 10 ? mm.toFixed(1) : mm.toFixed(2);
}

function setTransformReadout(text) {
  if (transformReadoutEl) transformReadoutEl.textContent = text || '';
}

export function syncInteractionUI() {
  const tool = activeTool();
  for (const button of toolButtons) {
    const on = button.dataset.tool === tool;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
  const transform = tool === 'move' || tool === 'rotate' || tool === 'pivot';
  for (const button of axisButtons) {
    const on = ctx.moveAxis === button.dataset.axis;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    button.disabled = !transform;
  }
  if (statusEl) statusEl.textContent = toolStatus(tool);
  if (toolbar) toolbar.dataset.tool = tool;
  if (contextEl) contextEl.hidden = !ctx.selectedPartKey;
  if (selectedLabelEl) {
    selectedLabelEl.textContent = ctx.selectedPartKey ? selectedBreadcrumb(ctx.selectedPartKey) : '';
    selectedLabelEl.title = ctx.selectedPartKey ? selectedLabelEl.textContent : t('ui.selected.part');
  }
  const transBtn = contextButtons.find((button) => button.dataset.partAction === 'transparent');
  if (transBtn) transBtn.textContent = ctx.selectedPartKey && partTransparent(ctx.selectedPartKey) ? t('ui.opaque') : t('ui.transparent');
}

function setTool(tool) {
  if (tool !== 'section') setSectionMode(false);
  if (tool === 'select') {
    if (ctx.measureOnChk.checked) {
      ctx.measureOnChk.checked = false;
      ctx.measureOnChk.dispatchEvent(new Event('change'));
    }
    if (ctx.moveOnChk.checked) {
      ctx.moveOnChk.checked = false;
      ctx.moveOnChk.dispatchEvent(new Event('change'));
    }
    setMoveAxis(null);
    setRotateMode(false);
    setPivotMode(false);
  } else if (tool === 'move') {
    if (ctx.measureOnChk.checked) {
      ctx.measureOnChk.checked = false;
      ctx.measureOnChk.dispatchEvent(new Event('change'));
    }
    ctx.moveOnChk.checked = true;
    ctx.moveOnChk.dispatchEvent(new Event('change'));
    setRotateMode(false);
    setPivotMode(false);
  } else if (tool === 'rotate') {
    if (ctx.measureOnChk.checked) {
      ctx.measureOnChk.checked = false;
      ctx.measureOnChk.dispatchEvent(new Event('change'));
    }
    ctx.moveOnChk.checked = true;
    ctx.moveOnChk.dispatchEvent(new Event('change'));
    setRotateMode(true);
    setPivotMode(false);
  } else if (tool === 'pivot') {
    if (ctx.measureOnChk.checked) {
      ctx.measureOnChk.checked = false;
      ctx.measureOnChk.dispatchEvent(new Event('change'));
    }
    ctx.moveOnChk.checked = true;
    ctx.moveOnChk.dispatchEvent(new Event('change'));
    setRotateMode(false);
    setPivotMode(true);
  } else if (tool === 'measure') {
    if (ctx.moveOnChk.checked) {
      ctx.moveOnChk.checked = false;
      ctx.moveOnChk.dispatchEvent(new Event('change'));
    }
    setRotateMode(false);
    setPivotMode(false);
    ctx.measureOnChk.checked = true;
    ctx.measureOnChk.dispatchEvent(new Event('change'));
  } else if (tool === 'section') {
    if (ctx.measureOnChk.checked) {
      ctx.measureOnChk.checked = false;
      ctx.measureOnChk.dispatchEvent(new Event('change'));
    }
    if (ctx.moveOnChk.checked) {
      ctx.moveOnChk.checked = false;
      ctx.moveOnChk.dispatchEvent(new Event('change'));
    }
    if (!ctx.sectionOn) {
      ctx.sectionOnChk.checked = true;
      ctx.sectionOnChk.dispatchEvent(new Event('change'));
    }
    setSectionMode(true);
  }
  syncInteractionUI();
}

for (const button of toolButtons) {
  button.addEventListener('click', () => setTool(button.dataset.tool));
}

for (const button of axisButtons) {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    setMoveAxis(button.dataset.axis);
    syncInteractionUI();
  });
}

for (const button of contextButtons) {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const key = ctx.selectedPartKey;
    if (!key) return;
    switch (button.dataset.partAction) {
      case 'hide':
        setPartVisible(key, false);
        clearPartSelection();
        break;
      case 'only':
        showOnlyPart(key);
        break;
      case 'transparent':
        setPartTransparent(key, !partTransparent(key));
        break;
      case 'comment':
        // Reuse the existing comment editor and session validation rather than
        // creating a second comment implementation for the toolbar.
        showPartMenu(50, 50, key);
        document.getElementById('part-menu-comment')?.click();
        break;
      case 'reset-pivot':
        resetPivot();
        break;
    }
    syncInteractionUI();
  });
}

ctx.moveOnChk?.addEventListener('change', syncInteractionUI);
ctx.measureOnChk?.addEventListener('change', syncInteractionUI);

document.addEventListener('keydown', (event) => {
  if (isTextEntry(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === 'escape') {
    cancelMoveDrag();
    cancelRotateDrag();
    cancelSectionDrag();
    setTool('select');
    return;
  }
  if (!ctx.moveOnChk?.checked) return;
  if (key === 'x' || key === 'y' || key === 'z') {
    setMoveAxis(key);
    syncInteractionUI();
  } else if (key === 'r') {
    setRotateMode(!ctx.rotateMode);
    syncInteractionUI();
  }
});

window.addEventListener('viewer-transform', (event) => {
  const { kind, value, state } = event.detail || {};
  const label = t(kind === 'rotate' ? 'ui.rotation' : 'ui.move');
  if (state === 'done') setTransformReadout(`✓ ${t('ui.transform.complete', { label })}`);
  else if (state === 'cancelled') setTransformReadout(`↶ ${t('ui.transform.cancelled', { label })}`);
  else if (kind === 'rotate') setTransformReadout(`↻ ${Math.abs(value || 0).toFixed(1)}°`);
  else if (kind === 'move') setTransformReadout(`Δ ${formatMm(value || 0)} mm`);
});

// Selection changes happen in the parts module. A lightweight refresh keeps the
// status text correct without coupling parts.js back to this presentation layer.
window.setInterval(syncInteractionUI, 150);
onLanguageChange(() => syncInteractionUI());
syncInteractionUI();
