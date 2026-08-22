import { ENGLISH_UI, UI_CATALOG_META } from './ui-english.js';

const ENGLISH_LOCALE = 'en';
const STORAGE_KEY = 'cad-viewer.uiLocale';
const SAFE_LOCALE = /^[A-Za-z0-9_-]+$/;
const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
});

const state = {
  locale: ENGLISH_LOCALE,
  translations: Object.create(null),
  languages: [{ locale: ENGLISH_LOCALE, displayName: LANGUAGE_NAMES.en }],
  initialized: false,
  loading: false,
};
const listeners = new Set();
const ENGLISH_TO_KEY = new Map(
  Object.entries(ENGLISH_UI)
    .filter(([key]) => UI_CATALOG_META[key]?.translatable)
    .map(([key, value]) => [value, key]),
);
const PRESERVED_DOM_SELECTOR = '#floating-parts-list, #mats, #info, #chat-messages, #roster, #session-link, #session-code, #measure-list, #floating-measure-list, #section-preset-list';

function replaceParams(template, params) {
  if (!params || typeof template !== 'string') return template;
  return template.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

function validLocale(locale) {
  return typeof locale === 'string' && SAFE_LOCALE.test(locale) && locale.length <= 32;
}

function validTranslationMap(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const strings = candidate.strings;
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return null;
  const out = Object.create(null);
  for (const [key, value] of Object.entries(strings)) {
    if (Object.prototype.hasOwnProperty.call(ENGLISH_UI, key)
      && UI_CATALOG_META[key]?.translatable
      && typeof value === 'string'
      && value.trim()) {
      out[key] = value;
    }
  }
  return out;
}

export function t(key, params) {
  const english = Object.prototype.hasOwnProperty.call(ENGLISH_UI, key) ? ENGLISH_UI[key] : key;
  const value = state.translations[key] ?? english;
  return replaceParams(value, params);
}

export function currentLocale() {
  return state.locale;
}

export function availableLocales() {
  return state.languages.map((entry) => ({ ...entry }));
}

export function onLanguageChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function annotateStaticDom(root) {
  if (!root?.querySelectorAll || typeof document === 'undefined') return;
  const nodes = root.querySelectorAll('*');
  for (const el of nodes) {
    if (el.matches(PRESERVED_DOM_SELECTOR) || el.closest(PRESERVED_DOM_SELECTOR)) continue;
    for (const [attribute, dataKey] of [['title', 'uiTitle'], ['placeholder', 'uiPlaceholder'], ['aria-label', 'uiAriaLabel']]) {
      if (!el.dataset[dataKey] && ENGLISH_TO_KEY.has(el.getAttribute(attribute))) {
        el.dataset[dataKey] = ENGLISH_TO_KEY.get(el.getAttribute(attribute));
      }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const textNode of textNodes) {
      const parent = textNode.parentElement;
      if (!parent || parent.dataset.ui || /^(SCRIPT|STYLE)$/.test(parent.tagName)) continue;
      if (parent.closest(PRESERVED_DOM_SELECTOR)) continue;
      const text = textNode.nodeValue?.trim();
      const key = ENGLISH_TO_KEY.get(text);
      if (!key) continue;
      const start = textNode.nodeValue.indexOf(text);
      const fragment = document.createDocumentFragment();
      if (start > 0) fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(0, start)));
      const marker = document.createElement('span');
      marker.dataset.ui = key;
      marker.textContent = text;
      fragment.appendChild(marker);
      const end = start + text.length;
      if (end < textNode.nodeValue.length) fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(end)));
      textNode.replaceWith(fragment);
    }
  }
}

export function translateDom(root = document) {
  if (!root?.querySelectorAll) return;
  annotateStaticDom(root);
  for (const el of root.querySelectorAll('[data-ui]')) {
    el.textContent = t(el.dataset.ui);
  }
  for (const el of root.querySelectorAll('[data-ui-title]')) {
    el.title = t(el.dataset.uiTitle);
  }
  for (const el of root.querySelectorAll('[data-ui-placeholder]')) {
    el.placeholder = t(el.dataset.uiPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-ui-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.uiAriaLabel));
  }
  document.documentElement.lang = state.locale === ENGLISH_LOCALE ? 'en' : state.locale;
}

function renderLanguageOptions() {
  const select = document.getElementById('ui-language');
  if (!select) return;
  const previous = state.locale;
  select.replaceChildren();
  for (const entry of state.languages) {
    const option = document.createElement('option');
    option.value = entry.locale;
    option.textContent = entry.displayName || LANGUAGE_NAMES[entry.locale] || entry.locale;
    select.appendChild(option);
  }
  select.value = state.languages.some((entry) => entry.locale === previous) ? previous : ENGLISH_LOCALE;
}

async function discoverLanguages() {
  try {
    const response = await fetch('/languages', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload : payload?.languages;
    if (!Array.isArray(entries)) return;
    const discovered = entries
      .filter((entry) => validLocale(entry?.locale) && entry.locale !== ENGLISH_LOCALE)
      .map((entry) => ({
        locale: entry.locale,
        displayName: typeof entry.displayName === 'string' && entry.displayName.trim()
          ? entry.displayName : (LANGUAGE_NAMES[entry.locale] || entry.locale),
        viewerVersion: entry.viewerVersion || '',
      }));
    const unique = new Map([[ENGLISH_LOCALE, { locale: ENGLISH_LOCALE, displayName: LANGUAGE_NAMES.en }]]);
    for (const entry of discovered) unique.set(entry.locale, entry);
    state.languages = [...unique.values()];
  } catch {
    // Optional add-ons must never prevent the English viewer from starting.
  }
  renderLanguageOptions();
}

export async function setLocale(locale, { persist = true } = {}) {
  if (!validLocale(locale)) return false;
  if (locale === ENGLISH_LOCALE) {
    state.locale = ENGLISH_LOCALE;
    state.translations = Object.create(null);
  } else {
    try {
      const response = await fetch(`/languages/${encodeURIComponent(locale)}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`language request failed (${response.status})`);
      const candidate = await response.json();
      if (candidate.locale !== locale) throw new Error('language locale mismatch');
      const translations = validTranslationMap(candidate);
      if (!translations) throw new Error('invalid language file');
      state.locale = locale;
      state.translations = translations;
    } catch {
      state.locale = ENGLISH_LOCALE;
      state.translations = Object.create(null);
      renderLanguageOptions();
      translateDom();
      return false;
    }
  }
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, state.locale); } catch {}
  }
  renderLanguageOptions();
  translateDom();
  for (const listener of listeners) {
    try { listener(state.locale); } catch (error) { console.error(error); }
  }
  return true;
}

export async function initI18n() {
  if (state.initialized || state.loading) return;
  state.loading = true;
  translateDom();
  await discoverLanguages();
  let saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch {}
  if (saved && saved !== ENGLISH_LOCALE && state.languages.some((entry) => entry.locale === saved)) {
    await setLocale(saved, { persist: false });
  } else {
    await setLocale(ENGLISH_LOCALE, { persist: false });
  }
  const select = document.getElementById('ui-language');
  select?.addEventListener('change', () => { void setLocale(select.value); });
  state.initialized = true;
  state.loading = false;
}

if (typeof document !== 'undefined') void initI18n();
