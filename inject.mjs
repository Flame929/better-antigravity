#!/usr/bin/env node
// Antigravity HUD 注入器：通过 Antigravity 自带的远程调试端口，把 hud.js 注入到主界面。
// 用法：
//   node inject.mjs          常驻运行：应用启动、页面刷新、新开窗口时自动注入（给 launchd 用）
//   node inject.mjs --once   只注入一次当前打开的窗口后退出
//   node inject.mjs --remove 从当前打开的窗口移除 HUD
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUD_FILE = path.join(HERE, 'hud.js');
const PORT_FILE = path.join(os.homedir(), 'Library/Application Support/Antigravity/DevToolsActivePort');
const PAGE_PREFIX = 'https://127.0.0.1';
const SCAN_INTERVAL = 3000;

const mode = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--once') ? 'once' : 'daemon';
const log = (...a) => console.log(new Date().toISOString(), ...a);

function readPort() {
  try {
    return fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  const list = await res.json();
  return list.filter(t => t.type === 'page' && t.url.startsWith(PAGE_PREFIX));
}

// 打开一个页面的 CDP 会话
function openSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method) {
        handlers.forEach(h => h(m));
      }
    };
    ws.onopen = () => resolve({
      ws,
      send: (method, params = {}) => new Promise(r => {
        const i = ++id;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
      on: h => handlers.push(h),
    });
    ws.onerror = () => reject(new Error('无法连接页面调试会话'));
  });
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: false });
  if (r.result && r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  }
}

// 每次注入都重新读取 hud.js，修改后无需重启注入器
const hudSource = () => fs.readFileSync(HUD_FILE, 'utf8');

async function runOnce(remove) {
  const port = readPort();
  if (!port) throw new Error('找不到 DevToolsActivePort，Antigravity 是否在运行？');
  const pages = await listPages(port);
  if (!pages.length) throw new Error('没有找到 Antigravity 主界面窗口');
  for (const p of pages) {
    const s = await openSession(p.webSocketDebuggerUrl);
    await evaluate(s, remove ? 'window.__agHud && window.__agHud.destroy()' : hudSource());
    s.ws.close();
    log(remove ? '已移除' : '已注入', p.url);
  }
}

// 常驻模式：为每个主界面窗口保持一个会话，页面重新加载后再次注入
async function daemon() {
  const sessions = new Map(); // targetId -> session
  log('注入器已启动，等待 Antigravity…');

  async function attach(page) {
    const s = await openSession(page.webSocketDebuggerUrl);
    sessions.set(page.id, s);
    s.ws.onclose = () => {
      sessions.delete(page.id);
      log('会话断开', page.id);
    };
    s.on(m => {
      // 页面刷新或跳转后，主框架的新执行上下文出现时重新注入
      if (m.method === 'Runtime.executionContextCreated' && m.params.context.auxData?.isDefault) {
        setTimeout(() => evaluate(s, hudSource()).catch(e => log('注入失败', e.message)), 500);
      }
    });
    await s.send('Runtime.enable'); // 会立刻为现有上下文触发 executionContextCreated，从而完成首次注入
    log('已连接窗口', page.url);
  }

  for (;;) {
    try {
      const port = readPort();
      if (port) {
        const pages = await listPages(port);
        for (const p of pages) {
          if (!sessions.has(p.id)) await attach(p).catch(e => log('连接失败', e.message));
        }
      }
    } catch {
      // 应用没在运行或正在重启，稍后重试
    }
    // 兜底：应用启动时页面会加载多次，上面的事件可能错过最终页面；发现 HUD 不在就补注入。
    // 每个窗口 10 分钟内最多补 3 次，避免 HUD 自己熔断卸载后被反复注入。
    for (const [id, s] of sessions) {
      const r = await s.send('Runtime.evaluate', { expression: '!!window.__agHud', returnByValue: true }).catch(() => null);
      if (r?.result?.result?.value !== false) continue;
      const now = Date.now();
      const refillState = await s.send('Runtime.evaluate', {
        expression: 'JSON.stringify((JSON.parse(localStorage.getItem("ag-hud-refill-times-v1") || "[]")).filter(t => Date.now() - t < 600000))',
        returnByValue: true,
      }).catch(() => null);
      let refillTimes = [];
      try { refillTimes = JSON.parse(refillState?.result?.result?.value || '[]'); } catch {}
      if (refillTimes.length >= 3) continue;
      const lastDestroy = await s.send('Runtime.evaluate', {
        expression: 'JSON.stringify(([...(window.__agHud && window.__agHud.log ? window.__agHud.log() : JSON.parse(localStorage.getItem("ag-hud-events-v1") || "[]"))].reverse().find(e => e.type === "destroy") || null))',
        returnByValue: true,
      }).catch(() => null);
      const reason = lastDestroy?.result?.result?.value;
      if (reason) log('补注入前最后事件', id, reason);
      refillTimes.push(now);
      await evaluate(s, `localStorage.setItem("ag-hud-refill-times-v1",${JSON.stringify(JSON.stringify(refillTimes))})`);
      await evaluate(s, hudSource()).then(() => log('已补注入', id)).catch(e => log('注入失败', e.message));
    }
    await new Promise(r => setTimeout(r, SCAN_INTERVAL));
  }
}

if (mode === 'daemon') {
  daemon();
} else {
  runOnce(mode === 'remove').catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
