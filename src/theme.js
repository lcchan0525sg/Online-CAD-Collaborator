// CAD Viewer — user-selectable viewport background schemes.
import * as THREE from 'three';
import { ctx } from './context.js';

const schemes = {
  graphite: { scene: 0x141822, css: 'graphite', colors: ['#283244', '#171c27', '#0d1016'] },
  gray: { scene: 0x737b86, css: 'gray', colors: ['#aeb7c2', '#7c858f', '#555d67'] },
  navy: { scene: 0x0d1b2a, css: 'navy', colors: ['#244665', '#10243a', '#07121e'] },
  light: { scene: 0xdfe5ec, css: 'light', colors: ['#ffffff', '#e7edf3', '#cbd5df'] },
  blueprint: { scene: 0x9bc4df, css: 'blueprint', colors: ['#e8f6ff', '#b9dbef', '#8fb9d8'] },
};

const select = document.getElementById('background-scheme');

function makeGradientTexture(colors) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const g = canvas.getContext('2d').createRadialGradient(256, 90, 0, 256, 360, 470);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.58, colors[1]);
  g.addColorStop(1, colors[2]);
  const context = canvas.getContext('2d');
  context.fillStyle = g;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}


export function applyBackgroundScheme(name, persist = true) {
  const key = schemes[name] ? name : 'graphite';
  const scheme = schemes[key];
  document.body.dataset.backgroundScheme = scheme.css;
  if (ctx.scene) {
    if (ctx.scene.background?.isTexture) ctx.scene.background.dispose();
    ctx.scene.background = makeGradientTexture(scheme.colors);
  }
  if (select) select.value = key;
  if (persist) localStorage.setItem('cad-viewer-background', key);
  return key;
}

select?.addEventListener('change', () => applyBackgroundScheme(select.value));
applyBackgroundScheme(localStorage.getItem('cad-viewer-background') || 'graphite', false);
