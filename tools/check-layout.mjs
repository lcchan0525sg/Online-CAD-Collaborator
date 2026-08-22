#!/usr/bin/env node
// Check translated layout overflow at the supported viewport widths.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const locale = process.env.CAD_LAYOUT_LOCALE || 'zz-PSEUDO';
const url = process.env.CAD_LAYOUT_URL || 'http://localhost:8088/';
const widths = [1280, 1024, 768];
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(url) { for (let i = 0; i < 100; i++) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await sleep(100); } throw new Error(`CDP unavailable: ${url}`); }
class Cdp {
  constructor(endpoint) { this.ws = new WebSocket(endpoint); this.id = 0; this.pending = new Map(); this.ws.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id || !this.pending.has(message.id)) return; const [resolve, reject] = this.pending.get(message.id); this.pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }; }
  open() { return new Promise((resolve) => { this.ws.onopen = resolve; }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, [resolve, reject]); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
  close() { this.ws.close(); }
}

const reports = [];
for (const width of widths) {
  const port = 9560 + widths.indexOf(width);
  const profile = join(os.tmpdir(), `cad-v098-layout-${Date.now()}-${width}`);
  const chrome = spawn(chromePath, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-automation', `--window-size=${width},800`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  let client;
  try {
    const page = (await json(`http://localhost:${port}/json`)).find((entry) => entry.type === 'page');
    client = new Cdp(page.webSocketDebuggerUrl); await client.open(); await client.send('Runtime.enable');
    for (let i = 0; i < 60; i++) { if (await client.evaluate('!!window.__viewer')) break; await sleep(100); }
    const switched = await client.evaluate(`window.__viewer?.setLocale(${JSON.stringify(locale)})`);
    await sleep(250);
    const report = await client.evaluate(`(() => {
      const ignored = new Set(['HTML', 'BODY']);
      const overflowing = [...document.querySelectorAll('*')].filter((el) => {
        if (ignored.has(el.tagName)) return false;
        const style = getComputedStyle(el);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowY === 'auto' || style.overflowY === 'scroll') return false;
        return el.scrollWidth > el.clientWidth + 1;
      }).slice(0, 20).map((el) => ({ tag: el.tagName, id: el.id, className: el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: (el.textContent || '').trim().slice(0, 80) }));
      return { locale: window.__viewer?.locale, document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight }, overflowing };
    })()`);
    reports.push({ width, switched, ...report });
  } finally { client?.close(); chrome.kill(); await sleep(500); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
console.log(JSON.stringify({ locale, reports }, null, 2));
if (reports.some((report) => report.overflowing.length || report.document.scrollWidth > report.document.clientWidth + 1)) process.exitCode = 1;
