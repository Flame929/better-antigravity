// 模拟 Antigravity 主界面和 LanguageServerService，用假数据驱动 hud.js，供无头浏览器截图检查界面。
// 用法：node tools/mock/server.mjs [端口]（默认 4777，只监听 127.0.0.1）
// hud.js 只在 https://127.0.0.1 源下运行，所以这里用自签名证书起 HTTPS；证书首次运行生成到临时目录。
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HUD_FILE = path.join(ROOT, 'hud.js');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || process.argv[2] || 4777);
const RPC_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const MODEL = 'Gemini 3.8 Flash High';
const MAX_CTX = 200000;
const START = Date.now();

// ---------- 证书 ----------

function loadCert() {
  const dir = path.join(os.tmpdir(), 'ag-hud-mock-cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) {
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '3650',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
  } catch {
    throw new Error('生成自签名证书失败：需要本机 openssl');
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// ---------- 场景数据 ----------

const iso = ms => new Date(ms).toISOString();
const RESETS = {
  normal: { five: iso(START + 3 * 3.6e6), week: iso(START + 5 * 24 * 3.6e6) },
  danger: { five: iso(START + 1.8 * 3.6e6), week: iso(START + 2 * 24 * 3.6e6) },
};
RESETS.generating = RESETS.normal;

// points: [多少分钟前, 当时剩余比例]，hud 用最早一条和当前值估算消耗速度
const QUOTA = {
  normal: {
    five: { remaining: 0.94, reset: RESETS.normal.five, points: [[55, 0.99], [44, 0.984], [33, 0.977], [22, 0.969], [11, 0.958], [0, 0.94]] },
    week: { remaining: 0.72, reset: RESETS.normal.week, points: [[330, 0.745], [264, 0.741], [198, 0.737], [132, 0.733], [66, 0.728], [0, 0.72]] },
  },
  danger: {
    five: { remaining: 0.25, reset: RESETS.danger.five, points: [[55, 0.45], [44, 0.42], [33, 0.39], [22, 0.35], [11, 0.31], [0, 0.25]] },
    week: { remaining: 0.08, reset: RESETS.danger.week, points: [[330, 0.30], [264, 0.27], [198, 0.23], [132, 0.19], [66, 0.14], [0, 0.08]] },
  },
};
QUOTA.generating = QUOTA.normal;

const TPS = {
  normal: [112, 98, 126, 105, 118, 110, 108],
  danger: [64, 58, 72, 66, 70, 62, 58],
};
const USED = {
  normal: [38000, 44000, 50000, 56000, 62000, 68000, 72000], // 当前 36%
  danger: [188000, 72000, 46000, 80000, 110000, 140000, 164000], // 压缩 2 次后回到 82%
};
const DUR = 25;

const SAMPLE = '检查工具链配置，读取仓库里的上下文文件，确认 HUD 的渲染路径和 RPC 字段。';
const filler = len => {
  let s = '';
  while (s.length < len) s += SAMPLE;
  return s.slice(0, len);
};

// hud 从 generatorMetadata 里读上下文占用、token 用量和速度
function metaEntry(index, used, tps, createdAt) {
  const out = Math.round(tps * DUR);
  return {
    stepIndices: [index],
    chatModel: {
      chatStartMetadata: {
        contextWindowMetadata: {
          estimatedTokensUsed: used,
          maxContextTokens: MAX_CTX,
          tokenBreakdown: {
            groups: [
              { name: 'System', numTokens: Math.round(used * 0.40) },
              { name: 'Tools', numTokens: Math.round(used * 0.35) },
              { name: 'Chat', numTokens: used - Math.round(used * 0.40) - Math.round(used * 0.35) },
            ],
          },
        },
      },
      usage: {
        inputTokens: 18000,
        cacheReadTokens: 9000,
        outputTokens: out,
        thinkingOutputTokens: 420,
        model: MODEL,
      },
      streamingDuration: String(DUR),
      timeToFirstToken: '1.4',
      responseModel: MODEL,
    },
  };
}

function plannerStep(index, response, createdAt, status = 'CORTEX_STEP_STATUS_DONE') {
  return {
    index,
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status,
    plannerResponse: { response, toolCalls: [] },
    metadata: {
      createdAt: iso(createdAt),
      stepIndex: index,
      modelUsage: { responseOutputTokens: Math.round(response.length * 0.45) },
    },
  };
}

function userStep(index, createdAt) {
  return {
    index,
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    userInput: { items: [{ text: '检查 HUD 面板数据' }] },
    metadata: { createdAt: iso(createdAt), stepIndex: index },
  };
}

function toolStep(index, type, createdAt) {
  return {
    index,
    type,
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: iso(createdAt), stepIndex: index },
  };
}

function buildStaticTrajectory(name) {
  const used = USED[name];
  const tps = TPS[name];
  const base = START - used.length * 60000;
  const meta = used.map((value, i) => metaEntry(i + 1, value, tps[i], base + i * 60000));
  const steps = [userStep(0, base)];
  used.forEach((value, i) => {
    const out = Math.round(tps[i] * DUR);
    steps.push(plannerStep(i + 1, filler(Math.round(out / 0.45)), base + i * 60000));
  });
  return { meta, steps, maxStep: used.length };
}

const STATIC = {
  normal: buildStaticTrajectory('normal'),
  danger: buildStaticTrajectory('danger'),
};

// 生成中场景：已完成的 3 次调用 + 一个不断变长的进行中回复
const GENERATING = {
  meta: [
    metaEntry(1, 56000, 120, START - 3 * 60000),
    metaEntry(3, 66000, 112, START - 2 * 60000),
    metaEntry(5, 76000, 135, START - 60000),
    {
      stepIndices: [7, 8],
      chatModel: {
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 84000,
            maxContextTokens: MAX_CTX,
            tokenBreakdown: {
              groups: [
                { name: 'System', numTokens: 33600 },
                { name: 'Tools', numTokens: 29400 },
                { name: 'Chat', numTokens: 21000 },
              ],
            },
          },
        },
      },
    },
  ],
  steps: [
    userStep(0, START - 4 * 60000),
    plannerStep(1, filler(2600), START - 3.6 * 60000),
    toolStep(2, 'CORTEX_STEP_TYPE_VIEW_FILE', START - 3.3 * 60000),
    plannerStep(3, filler(2400), START - 2.6 * 60000),
    toolStep(4, 'CORTEX_STEP_TYPE_LIST_DIRECTORY', START - 2.3 * 60000),
    plannerStep(5, filler(2900), START - 1.6 * 60000),
    userStep(6, START - 1.2 * 60000),
    toolStep(7, 'CORTEX_STEP_TYPE_GREP_SEARCH', START - 0.9 * 60000),
  ],
  maxStep: 8,
};

const GENERATING_STARTED = new Map();

function generatingSteps(cascadeId) {
  if (!GENERATING_STARTED.has(cascadeId)) GENERATING_STARTED.set(cascadeId, Date.now() - 2600);
  const startedAt = GENERATING_STARTED.get(cascadeId);
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  // 字符增长速度在 150~350 字/秒之间变化，乘 0.45 后约 67~157 tok/s
  const len = Math.min(60000, Math.round(600 + 250 * elapsed + 190 * Math.sin(elapsed / 1.9)));
  const active = plannerStep(8, filler(Math.max(600, len)), startedAt, 'CORTEX_STEP_STATUS_RUNNING');
  active.plannerResponse.toolCalls = [];
  return [...GENERATING.steps, active];
}

function trajectory(name, cascadeId) {
  if (name === 'generating') return { meta: GENERATING.meta, steps: generatingSteps(cascadeId), maxStep: 8 };
  return STATIC[name];
}

// ---------- HTML ----------

const CSS = `
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--foreground);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;
  --bg:#f5f5f6;--panel:#fff;--foreground:#1f2328;--muted-foreground:#6b7280;--border:#e3e4e8;--accent:#3e8ef7}
body.dark{--bg:#141414;--panel:#1d1d1f;--foreground:#e6e6e6;--muted-foreground:#9aa0a6;--border:#333;--accent:#5b9dff}
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);height:100vh}
.sidebar{background:var(--panel);border-right:1px solid var(--border);padding:18px 14px;color:var(--muted-foreground);font-size:13px}
.brand{color:var(--foreground);font-weight:600;font-size:15px;margin:2px 6px 22px;display:flex;align-items:center;gap:8px}
.brand span{font-size:10px;letter-spacing:.08em;border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--muted-foreground)}
.side-item{padding:7px 8px;border-radius:7px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side-item.active{background:rgba(127,127,127,.13);color:var(--foreground)}
.side-title{margin:20px 8px 6px;font-size:11px;opacity:.75}
.main{display:flex;flex-direction:column;min-width:0;height:100vh}
.topbar{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted-foreground)}
.pill{border:1px solid var(--border);border-radius:999px;padding:2px 9px}
.chat{flex:1;overflow:hidden;padding:28px 32px 8px;display:flex;flex-direction:column;gap:14px;align-items:center}
.msg{width:min(760px,100%);border-radius:12px;padding:10px 14px;font-size:13px;background:var(--panel);border:1px solid var(--border)}
.msg.user{align-self:center;background:rgba(127,127,127,.10);border-color:transparent}
.msg.ai{color:var(--foreground)}
.msg .who{display:block;font-size:11px;color:var(--muted-foreground);margin-bottom:3px}
.composer{padding:14px 24px 26px;display:flex;flex-direction:column;align-items:center;gap:8px}
.input{width:min(780px,100%);background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.06)}
body.dark .input{box-shadow:0 6px 24px rgba(0,0,0,.35)}
.editor{min-height:48px;outline:none;font-size:14px;color:var(--foreground);white-space:pre-wrap;word-break:break-word}
.editor:empty::before{content:attr(data-placeholder);color:var(--muted-foreground)}
.controls{display:flex;align-items:center;gap:10px;margin-top:8px}
.model{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);background:transparent;color:var(--foreground);
  border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.model .dot{width:8px;height:8px;border-radius:50%;background:#28c840;display:inline-block}
.spacer{flex:1}
.icon-btn{width:30px;height:30px;border-radius:50%;border:0;background:var(--accent);color:#fff;font-size:15px;line-height:1;cursor:pointer}
.hint{font-size:11px;color:var(--muted-foreground)}
`;

function pageHtml(scenario, theme) {
  const q = QUOTA[scenario];
  const mock = {
    scenario,
    theme,
    cascadeId: '3f2b9c1e-7d4a-4b8e-9c2d-1a2b3c4d5e6f',
    seed: {
      'ag-hud-quota-v1': { reset: q.five.reset, points: q.five.points },
      'ag-hud-quota-week-v1': { reset: q.week.reset, points: q.week.points },
    },
  };
  const dark = theme === 'dark';
  const json = JSON.stringify(mock).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antigravity HUD 模拟页 · ${scenario}</title>
<style>${CSS}</style>
</head>
<body class="${dark ? 'dark' : ''}">
<div class="shell">
  <aside class="sidebar">
    <div class="brand">Antigravity <span>MOCK</span></div>
    <div class="side-item active">检查 HUD 面板数据</div>
    <div class="side-item">整理模拟数据字段</div>
    <div class="side-item">无头截图流程</div>
    <div class="side-title">项目</div>
    <div class="side-item">better-antigravity</div>
    <div class="side-item">tools/mock</div>
    <div class="side-title">场景</div>
    <div class="side-item">${scenario}</div>
  </aside>
  <main class="main">
    <header class="topbar"><span>模拟对话 / HUD 预览</span><span class="pill">${scenario} · ${theme}</span></header>
    <section class="chat">
      <div class="msg user"><span class="who">你</span>先读 .xay/context.md，再读 hud.js 弄清它依赖哪些 DOM 和 RPC 字段。</div>
      <div class="msg ai"><span class="who">Antigravity</span>已读取上下文和 HUD 源码，正在检查面板数据。所有数值都来自本地模拟服务。</div>
      <div class="msg ai"><span class="who">Antigravity</span>当前为 ${scenario} 场景，输入框、模型选择器和额度数据均已就绪。</div>
    </section>
    <div class="composer">
      <div class="input" data-testid="agent-input-box">
        <div class="editor" contenteditable="true" role="textbox" aria-label="输入消息" data-placeholder="输入消息，或按住 Ctrl+G 切换分组"></div>
        <div class="controls">
          <button type="button" class="model" data-testid="model-selector-trigger"><span class="dot"></span>${MODEL}</button>
          <span class="spacer"></span>
          <button type="button" class="icon-btn" aria-label="Send message">↑</button>
        </div>
      </div>
      <div class="hint">本页只用于截图检查 HUD，数据全部为模拟值</div>
    </div>
  </main>
</div>
<script>window.__APP_CONFIG__ = { csrfToken: 'mock' };</script>
<script>window.__MOCK__ = ${json};</script>
<script>
// 在任何 RPC 之前写入额度历史样本，hud 的消耗速度评级和曲线才有数据
(function () {
  var seed = window.__MOCK__.seed;
  var now = Date.now();
  Object.keys(seed).forEach(function (key) {
    var sample = seed[key];
    var history = sample.points.map(function (point) {
      return { t: now - point[0] * 60000, f: point[1], reset: sample.reset };
    });
    localStorage.setItem(key, JSON.stringify(history));
  });
})();
</script>
<script src="/hud.js?t=${Date.now()}"></script>
</body>
</html>`;
}

// ---------- RPC ----------

function rpcResponse(method, body) {
  const scenario = body.__scenario || 'normal';
  const cascadeId = body.cascadeId || '3f2b9c1e-7d4a-4b8e-9c2d-1a2b3c4d5e6f';
  const q = QUOTA[scenario];
  switch (method) {
    case 'GetCascadeTrajectoryGeneratorMetadata': {
      const data = trajectory(scenario, cascadeId);
      const offset = Math.max(0, Number(body.generatorMetadataOffset) || 0);
      return { generatorMetadata: data.meta.slice(offset) };
    }
    case 'GetCascadeTrajectorySteps': {
      const data = trajectory(scenario, cascadeId);
      const offset = Math.max(0, Number(body.stepOffset) || 0);
      return { steps: data.steps.filter(step => step.index >= offset) };
    }
    case 'RetrieveUserQuotaSummary':
      return {
        response: {
          groups: [{
            displayName: 'Gemini',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: q.five.remaining, resetTime: q.five.reset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: q.week.remaining, resetTime: q.week.reset },
            ],
          }],
        },
      };
    case 'GetUserStatus':
      return {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: MODEL, quotaInfo: { remainingFraction: q.five.remaining, resetTime: q.five.reset } },
              { label: 'Gemini 3.8 Flash Medium', quotaInfo: { remainingFraction: q.five.remaining + 0.02, resetTime: q.five.reset } },
              { label: 'Gemini 3.8 Flash Low', quotaInfo: { remainingFraction: q.five.remaining + 0.04, resetTime: q.five.reset } },
            ],
          },
        },
      };
    case 'GetAllRules':
      return { rules: [] };
    case 'SendUserCascadeMessage':
      return { cascadeId };
    default:
      return {};
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('请求体过大'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// 场景放在查询参数里；RPC 请求本身不带查询参数，所以按 referer 判断当前页面场景
function scenarioFromReferer(req, body) {
  if (body && body.__scenario) return body.__scenario;
  try {
    const referer = new URL(req.headers.referer || '', `https://${HOST}:${PORT}`);
    const value = referer.searchParams.get('scenario');
    if (value === 'danger' || value === 'generating') return value;
  } catch {
    // 没有 referer 就按 normal 处理
  }
  return 'normal';
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${HOST}:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/c/'))) {
      const scenario = ['normal', 'danger', 'generating'].includes(url.searchParams.get('scenario'))
        ? url.searchParams.get('scenario') : 'normal';
      const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
      // 每次打开生成中场景都重新计时，长时间运行时回复长度不会顶到上限
      if (scenario === 'generating') GENERATING_STARTED.set('3f2b9c1e-7d4a-4b8e-9c2d-1a2b3c4d5e6f', Date.now() - 2600);
      const html = pageHtml(scenario, theme);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/hud.js') {
      // 每次请求都重新读仓库根目录的 hud.js，避免改完源码后拿到旧缓存
      const js = fs.readFileSync(HUD_FILE);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': js.length,
        'cache-control': 'no-store',
      });
      res.end(js);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith(RPC_PREFIX)) {
      const method = url.pathname.slice(RPC_PREFIX.length);
      const body = await readBody(req);
      body.__scenario = scenarioFromReferer(req, body);
      sendJson(res, rpcResponse(method, body));
      return;
    }
    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { error: String(e.message || e) }, 500);
  }
}

const server = https.createServer(loadCert(), handler);
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用，可用 PORT=其他端口 启动`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`HUD 模拟页: https://${HOST}:${PORT}/c/3f2b9c1e-7d4a-4b8e-9c2d-1a2b3c4d5e6f`);
  console.log(`场景: ?scenario=normal|danger|generating  主题: ?theme=dark`);
  console.log(`hud.js: ${HUD_FILE}（每次请求重新读取）`);
});
