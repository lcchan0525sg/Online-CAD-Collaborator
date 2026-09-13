#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectories = ['src', 'tools'];
const extensions = new Set(['.js', '.mjs']);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (extensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
  }
  return files;
}

function check(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

const files = (await Promise.all(sourceDirectories.map((directory) => collect(join(root, directory))))).flat().sort();
const failed = [];
for (const file of files) if (!await check(file)) failed.push(relative(root, file));
if (failed.length) {
  console.error(`Syntax check failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
