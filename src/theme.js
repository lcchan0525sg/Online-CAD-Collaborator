// CAD Viewer — user-selectable viewport background schemes.
import * as THREE from 'three';
import { ctx } from './context.js';

const schemes = {
  graphite: { scene: 0x141822, css: 'graphite' },
  navy: { scene: 0x0d1b2a, css: 'navy' },
  light: { scene: 0xdfe5ec, css: 'light' },
  blueprint: { scene: 0x9bc4df, css: 'blueprint' },
};

const select = document.getElementById('background-scheme');

export function applyBackgroundScheme(name, persist = true) {
  const key = schemes[name] ? name : 'graphite';
  const scheme = schemes[key];
  document.body.dataset.backgroundScheme = scheme.css;
  if (ctx.scene) ctx.scene.background = new THREE.Color(scheme.scene);
  if (select) select.value = key;
  if (persist) localStorage.setItem('cad-viewer-background', key);
  return key;
}

select?.addEventListener('change', () => applyBackgroundScheme(select.value));
applyBackgroundScheme(localStorage.getItem('cad-viewer-background') || 'graphite', false);
