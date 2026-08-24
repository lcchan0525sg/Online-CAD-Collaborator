#!/usr/bin/env node
// Regenerate src/ui-english.js from the external vocabulary catalog.
// Usage: node tools/gen-english-catalog.mjs [vocab.json]
import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2] || 'C:/Users/chan_/Projects/cad-viewer-ui-v0.98-vocabulary.json';
const v = JSON.parse(readFileSync(source, 'utf8'));

const keys = v.entries.map((e) => e.key).sort();
let out = '// Generated from external vocabulary. Do not hand-edit.\nexport const ENGLISH_UI = Object.freeze({\n';
for (const k of keys) {
  const e = v.entries.find((x) => x.key === k);
  out += `  ${JSON.stringify(k)}: ${JSON.stringify(e.english)},\n`;
}
out += '});\nexport const UI_CATALOG_META = Object.freeze({\n';
for (const k of keys) {
  const e = v.entries.find((x) => x.key === k);
  out += `  ${JSON.stringify(k)}: {\n    "translatable": ${e.translatable ? 'true' : 'false'},\n    "sourceFiles": [\n${e.sourceFiles.map((s) => '      ' + JSON.stringify(s)).join(',\n')}\n    ],\n`;
  const notes = e.notes || '';
  if (notes) {
    out += `    "context": "",\n    "notes": ${JSON.stringify(notes)}\n  },\n`;
  } else {
    out += '    "context": "",\n    "notes": ""\n  },\n';
  }
}
out += '});\n';
writeFileSync('src/ui-english.js', out);
console.log('written src/ui-english.js with', keys.length, 'keys');
