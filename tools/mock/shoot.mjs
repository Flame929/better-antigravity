// 用本机 Chrome 无头模式 + CDP 给模拟页截图：三个场景 × 浅/深色，每个面板一张 PNG。
// 用法：先 node tools/mock/server.mjs，再 node tools/mock/shoot.mjs
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.MOCK_URL || 'https://127.0.0.1:4777';
const OUT_DIR = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const CID = '3f2b9c1e-7d4a-4b8e-9c2d-1a2b3c4d5e6f';
const SCENARIOS = ['normal', 'danger', 'generating'];
const THEMES = ['light', 'dark'];
const VIEWPORT = { width: 1440, height: 1000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- 检查服务 ----------

function checkServer() {
  return new Promise((resolve, reject) => {
    const req = https.get(`${BASE}/c/${CID}`, { rejectUnauthorized: false, timeout: 3000 }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

// ---------- CDP ----------

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function waitForChrome(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeout}ms 内没有就绪`);
}

async function evalValue(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`页面脚本报错：${result.exceptionDetails.text || ''} ${result.exceptionDetails.exception?.description || ''}`.trim());
  }
  return result.result?.value;
}

async function waitReady(cdp, sessionId, scenario, timeout = 20000) {
  const expression = `(() => {
    const bar = document.getElementById('ag-hud-bar');
    if (!bar || !window.__agHud) return { ready: false, hud: !!bar };
    const text = key => {
      const el = bar.querySelector('[data-bind="' + key + '"]');
      return el ? el.textContent : '';
    };
    const ctx = text('ctx-pct');
    const live = text('live-speed');
    const quota = text('quota-left');
    const rate = text('quota-rate');
    const status = text('status');
    const ready = !!ctx && ctx !== '-' && !!live && live !== '-' &&
      !!quota && quota !== '-' && !!rate && rate !== '-' &&
      (${JSON.stringify(scenario)} !== 'generating' || /生成中/.test(status));
    return { ready, hud: true, ctx, live, quota, rate, status };
  })()`;
  const deadline = Date.now() + timeout;
  let last = {};
  while (Date.now() < deadline) {
    try {
      last = await evalValue(cdp, sessionId, expression);
      if (last.ready) return last;
    } catch {}
    await sleep(250);
  }
  throw new Error(`等待 HUD 数据超时：${JSON.stringify(last)}`);
}

async function openPanels(cdp, sessionId) {
  const placed = await evalValue(cdp, sessionId, `(() => {
    window.dispatchEvent(new Event('resize'));
    const bar = document.getElementById('ag-hud-bar');
    if (!bar) return 'no-bar';
    // 面板后面垫一层同色背景，裁剪时边缘只留面板阴影，不露出页面其他文字
    let backdrop = document.getElementById('mock-shot-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'mock-shot-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--bg)';
      document.body.appendChild(backdrop);
    }
    const place = (key, left, top) => {
      const pop = bar.querySelector('[data-item="' + key + '"] .ag-pop');
      if (!pop) return false;
      pop.classList.add('open');
      pop.style.maxHeight = 'none';
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      return true;
    };
    const context = place('context', 90, 110);
    const quota = place('quota', 470, 110);
    const details = bar.querySelector('[data-item="context"] details');
    if (details) details.open = true;
    return context && quota ? 'ok' : 'missing-panel';
  })()`);
  if (placed !== 'ok') throw new Error(`强制打开面板失败：${placed}`);
  await sleep(200);
}

async function panelRect(cdp, sessionId, key) {
  return evalValue(cdp, sessionId, `(() => {
    const pop = document.querySelector('#ag-hud-bar [data-item="${key}"] .ag-pop');
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, open: pop.classList.contains('open') };
  })()`);
}

async function hudValues(cdp, sessionId) {
  return evalValue(cdp, sessionId, `(() => {
    const bar = document.getElementById('ag-hud-bar');
    const text = key => {
      const el = bar.querySelector('[data-bind="' + key + '"]');
      return el ? el.textContent : '';
    };
    return {
      ctx: text('ctx-pct'), ctxUsed: text('ctx-used'), compressions: text('compressions'),
      rounds: text('rounds'), live: text('live-speed'), level: text('speed-level'),
      status: text('status'), recent: text('recent-speeds'),
      quota: text('quota-left'), week: text('quota-week-left'),
      quotaLevel: text('quota-level'), weekLevel: text('quota-week-level'),
      quotaRate: text('quota-rate'), weekRate: text('quota-week-rate'), eta: text('quota-eta'),
      waiting: bar.innerText.includes('等待数据'),
    };
  })()`);
}

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function verify(scenario, v) {
  const errors = [];
  const expect = {
    normal: { ctx: '36%', compressions: '0 次', quota: '94%', week: '72%', level: '正常' },
    danger: { ctx: '82%', compressions: '2 次', quota: '25%', week: '8%' },
    generating: { ctx: '42%', compressions: '0 次', quota: '94%', week: '72%' },
  }[scenario];
  for (const [key, value] of Object.entries(expect)) {
    if (v[key] !== value) errors.push(`${key}=${JSON.stringify(v[key])}，期望 ${JSON.stringify(value)}`);
  }
  if (v.waiting) errors.push('面板仍是“等待数据”');
  if (/暂无数据|观察中/.test(v.level + v.quotaLevel + v.weekLevel)) errors.push('评级没有数据');
  if (v.quotaRate === '-' || v.weekRate === '-') errors.push('消耗速度没有数据');
  if (!/tok\/s/.test(v.recent)) errors.push('最近速度没有数据');
  if (scenario === 'generating') {
    if (!/生成中/.test(v.status)) errors.push(`运行状态=${JSON.stringify(v.status)}`);
    if (!(Number(v.live) > 0)) errors.push(`实时速度=${JSON.stringify(v.live)}`);
  }
  return errors;
}

function summary(v) {
  return `上下文 ${v.ctx}（已压缩 ${v.compressions}，${v.rounds}）| 速度 ${v.live} tok/s ${v.level} | 5h ${v.quota} ${v.quotaLevel} ${v.quotaRate} | 周 ${v.week} ${v.weekLevel} ${v.weekRate}`;
}

async function shot(cdp, sessionId, scenario, theme, key) {
  const rect = await panelRect(cdp, sessionId, key);
  if (!rect || !rect.open || rect.width < 100 || rect.height < 40) {
    throw new Error(`${key} 面板尺寸异常：${JSON.stringify(rect)}`);
  }
  const pad = 8;
  const clip = {
    x: Math.max(0, Math.floor(rect.x - pad)),
    y: Math.max(0, Math.floor(rect.y - pad)),
    width: Math.ceil(rect.width + pad * 2),
    height: Math.ceil(rect.height + pad * 2),
    scale: 1,
  };
  if (clip.x + clip.width > VIEWPORT.width || clip.y + clip.height > VIEWPORT.height) {
    throw new Error(`${key} 面板超出视口：${JSON.stringify({ clip, rect })}`);
  }
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false, clip,
  }, sessionId);
  const buffer = Buffer.from(data, 'base64');
  const size = pngSize(buffer);
  if (!size) throw new Error('截图不是有效 PNG');
  const file = path.join(OUT_DIR, `${scenario}-${theme}-${key}.png`);
  fs.writeFileSync(file, buffer);
  return { file, size, clip };
}

function removeProfile(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Chrome 可能还没完全退出，稍等重试
    }
  }
}

async function main() {
  try {
    await checkServer();
  } catch (e) {
    console.error(`连不上 ${BASE}：${e.message}`);
    console.error('请先运行：node tools/mock/server.mjs');
    process.exit(1);
  }
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hud-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  let failed = 0;
  try {
    const version = await waitForChrome(port);
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();
    console.log(`Chrome ${version.Browser} · 视口 ${VIEWPORT.width}×${VIEWPORT.height} @2x`);

    for (const scenario of SCENARIOS) {
      for (const theme of THEMES) {
        const url = `${BASE}/c/${CID}?scenario=${scenario}&theme=${theme}`;
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        try {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 2, mobile: false,
          }, sessionId);
          await cdp.send('Page.enable', {}, sessionId);
          await cdp.send('Runtime.enable', {}, sessionId);
          await cdp.send('Page.navigate', { url }, sessionId);
          await waitReady(cdp, sessionId, scenario);

          if (scenario === 'generating') {
            // 多采几次实时速度，确认“速度在变”的场景确实在变化
            const speeds = new Set();
            for (let i = 0; i < 6; i++) {
              await sleep(600);
              speeds.add(await evalValue(cdp, sessionId, `(() => {
                const el = document.querySelector('#ag-hud-bar [data-bind="live-speed"]');
                return el ? el.textContent : '';
              })()`));
            }
            if (speeds.size < 2) throw new Error(`生成中场景速度没有变化：${[...speeds].join(',')}`);
            console.log(`  生成中速度变化：${[...speeds].join(' → ')} tok/s`);
          }

          await openPanels(cdp, sessionId);
          const values = await hudValues(cdp, sessionId);
          const errors = verify(scenario, values);
          if (errors.length) throw new Error(`数据校验失败：${errors.join('；')}`);
          console.log(`\n${scenario} / ${theme}：${summary(values)}`);

          for (const key of ['context', 'quota']) {
            const result = await shot(cdp, sessionId, scenario, theme, key);
            const scale = result.size.width / result.clip.width;
            if (scale < 1.8) throw new Error(`设备缩放不是 2：${result.size.width}/${result.clip.width}`);
            console.log(`  ${path.relative(process.cwd(), result.file)}  ${result.size.width}×${result.size.height}（${(scale).toFixed(1)}x）`);
          }
        } catch (e) {
          failed++;
          console.error(`\n${scenario} / ${theme} 失败：${e.message}`);
        } finally {
          try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    await sleep(500);
    removeProfile(profile);
  }

  if (failed) {
    console.error(`\n${failed} 个组合失败`);
    process.exit(1);
  }
  console.log(`\n完成：${SCENARIOS.length * THEMES.length * 2} 张截图 → docs/screenshots/`);
}

main().catch(e => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
