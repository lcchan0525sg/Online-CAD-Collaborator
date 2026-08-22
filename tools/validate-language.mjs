#!/usr/bin/env node
// Validate an external CAD Viewer language add-on against the built-in catalog.
import { readFile, readdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { ENGLISH_UI, UI_CATALOG_META } from '../src/ui-english.js';

const source = process.argv[2] || process.env.CAD_LANGUAGE_SOURCE;
if (!source) {
  console.error('Usage: node tools/validate-language.mjs <locale.json|directory>');
  process.exit(2);
}

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const placeholders = (value) => [...String(value).matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort();
const translatableKeys = new Set(Object.entries(UI_CATALOG_META).filter(([, meta]) => meta.translatable).map(([key]) => key));

async function filesFor(input) {
  const path = resolve(input);
  if (extname(path).toLowerCase() === '.json') return [path];
  return (await readdir(path)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name)).map((name) => join(path, name));
}

const files = await filesFor(source);
if (!files.length) { console.error(`No locale JSON files found in ${resolve(source)}`); process.exit(1); }
let failed = false;
for (const file of files) {
  const errors = [];
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) { console.error(`${file}: invalid JSON: ${error.message}`); failed = true; continue; }
  const basename = file.replace(/\\/g, '/').split('/').pop().replace(/\.json$/i, '');
  if (data.locale !== basename) errors.push(`locale must match filename (${basename})`);
  if (!/^[A-Za-z0-9_-]+$/.test(data.locale || '')) errors.push('locale must contain only letters, numbers, _ or -');
  if (typeof data.displayName !== 'string' || !data.displayName.trim()) errors.push('displayName must be a non-empty string');
  if (data.humanReviewed !== true && data.humanReviewed !== false) errors.push('humanReviewed must be boolean');
  if (!data.strings || typeof data.strings !== 'object' || Array.isArray(data.strings)) errors.push('strings must be an object');
  const strings = data.strings && typeof data.strings === 'object' ? data.strings : {};
  for (const key of Object.keys(strings)) if (!translatableKeys.has(key)) errors.push(`unknown key: ${key}`);
  for (const key of translatableKeys) {
    if (!(key in strings)) { errors.push(`missing key: ${key}`); continue; }
    if (typeof strings[key] !== 'string' || !strings[key].trim()) errors.push(`empty/non-string value: ${key}`);
    if (JSON.stringify(placeholders(ENGLISH_UI[key])) !== JSON.stringify(placeholders(strings[key]))) errors.push(`placeholder mismatch: ${key}`);
  }
  if (errors.length) { failed = true; console.error(`${file}: FAIL\n  - ${errors.join('\n  - ')}`); }
  else console.log(`${file}: OK (${Object.keys(strings).length} strings, humanReviewed=${data.humanReviewed})`);
}
process.exit(failed ? 1 : 0);
