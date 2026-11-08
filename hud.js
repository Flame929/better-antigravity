// Antigravity HUD：注入到 Antigravity 桌面应用主界面，在输入框下方显示运行状态、速度、上下文和额度。
// 由 inject.mjs 通过 Chrome DevTools Protocol 注入；可重复执行，新版本会替换旧版本。
(() => {
  // 只在主界面顶层页面运行，跳过插件 iframe 等子框架
  if (window.top !== window || !location.origin.startsWith('https://127.0.0.1')) return;
  if (window.__agHud) window.__agHud.destroy('被新注入替换');

  const RPC = '/exa.language_server_pb.LanguageServerService/';
  const META_INTERVAL = 3000;       // 模型调用元数据（增量）刷新间隔
  const LIVE_INTERVAL = 1000;       // 生成中状态刷新间隔
  const IDLE_LIVE_INTERVAL = 2500;  // 空闲时放慢
  const QUOTA_INTERVAL = 60000;     // 额度刷新间隔
  const COMPACT_AT = 0.85;          // 上下文占用超过这个比例时出现压缩按钮
  const AUTO_THRESHOLD_DEFAULT = 0.75;
  const AUTO_IDLE_MS_DEFAULT = 20000;
  const BACKGROUND_CHECK_INTERVAL = 30000;
  const QUOTA_PREFIX = 'Gemini 3.8 Flash';
  const QUOTA_STORE = 'ag-hud-quota-v1';
  const QUOTA_WEEK_STORE = 'ag-hud-quota-week-v1';
  const QUOTA_OBSERVE_MS = 5 * 6e4;
  const AUTO_COMPACT_STORE = 'ag-hud-auto-compact-v2';
  const COMPACT_RUN_STORE = 'ag-hud-compact-runs-v1';
  const EVENT_STORE = 'ag-hud-events-v1';
  const COMPACT_RESUME_MS = 20 * 60 * 1000;
  const COMPACT_LOCK_MS = 15 * 1000;
  const COMPACT_NO_DUP_MS = 30 * 60 * 1000;
  const HUD_ID = 'ag-hud-bar';

  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function loadStore(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
  }
  function saveStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function loadCompactRuns() { return loadStore(COMPACT_RUN_STORE, {}); }
  function getCompactRun(cascadeId) { return loadCompactRuns()[cascadeId] || null; }
  function saveCompactRun(cascadeId, patch) {
    const runs = loadCompactRuns();
    runs[cascadeId] = { ...(runs[cascadeId] || {}), ...patch };
    saveStore(COMPACT_RUN_STORE, runs);
    return runs[cascadeId];
  }
  function appendEvent(type, data = {}) {
    const events = loadStore(EVENT_STORE, []);
    events.push({ t: Date.now(), type, ...data });
    saveStore(EVENT_STORE, events.slice(-50));
    return events;
  }
  function readEvents() { return loadStore(EVENT_STORE, []).slice(-50); }
  appendEvent('instance', { id: instanceId });

  const pendingControllers = new Set();
  let cascadeConfigCache = null;
  const debug = { autoThreshold: AUTO_THRESHOLD_DEFAULT, idleMs: AUTO_IDLE_MS_DEFAULT };

  const state = {
    cascadeId: null,
    meta: null,     // 当前对话的模型调用统计（增量累计）
    live: null,     // 当前生成状态
    quota: null,    // Gemini 3.8 Flash 额度
    compactUntil: 0,
    compact: {
      step: 'idle',
      result: '',
      error: '',
      running: false,
      awaitingConfirmation: false,
      auto: loadAutoCompact(),
      autoLoaded: true,
      idleSince: 0,
      lastAutoAt: new Map(),
      autoGuard: new Map(),
    },
    toast: null,
    error: null,
    at: { meta: 0, live: 0, quota: 0 },
    busy: { meta: false, live: false },
  };

  async function rpc(method, body) {
    const token = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    pendingControllers.add(controller);
    try {
      const res = await fetch(RPC + method, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': token || '',
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${method} ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timeout);
      pendingControllers.delete(controller);
    }
  }

  const seconds = d => (typeof d === 'string' ? parseFloat(d) : Number(d)) || 0;
  const num = v => Number(v) || 0;

  function currentCascadeId() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function findCascadeConfig() {
    if (cascadeConfigCache) return cascadeConfigCache;
    const roots = [window.__INITIAL_STATE__, window.__APP_STATE__, window.__AG_STATE__,
      window.__CASCADE_CONFIG__, window.__AG_CASCADE_CONFIG__,
      window.__APP_CONFIG__ && window.__APP_CONFIG__.cascadeConfig];
    const box = document.querySelector('[data-testid="agent-input-box"]');
    const model = document.querySelector('[data-testid="model-selector-trigger"]');
    [box, model].forEach(node => {
      if (!node) return;
      Object.keys(node).filter(key => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$')).forEach(key => roots.push(node[key]));
    });
    const seen = new WeakSet();
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 7) return null;
      if (seen.has(value)) return null;
      seen.add(value);
      for (const key of Object.keys(value)) {
        if (key === 'cascadeConfig' && value[key] && typeof value[key] === 'object') return value[key];
      }
      for (const key of Object.keys(value)) {
        const found = walk(value[key], depth + 1);
        if (found) return found;
      }
      return null;
    };
    for (const root of roots) {
      const found = walk(root, 0);
      if (found) {
        cascadeConfigCache = found;
        return found;
      }
    }
    return null;
  }

  // ---------- 模型调用元数据：上下文、速度 ----------

  function emptyMeta() {
    return {
      settled: 0,   // 已经结束、不会再变化的调用条数（下次从这里开始增量拉取）
      acc: { calls: 0, out: 0, stream: 0, input: 0, cache: 0 },
      ctx: null,
      last: null,
      recentSpeeds: [],
      compressions: 0,
      ctxLastUsed: 0,
      maxStep: -1,
      ctxHistory: [],
    };
  }

  // 把一条调用记录并入统计；acc 为 null 时只更新“最新值”而不累计
  function absorb(m, g, acc) {
    for (const i of g.stepIndices || []) m.maxStep = Math.max(m.maxStep, num(i));
    const cm = g.chatModel;
    if (!cm) return;
    const cw = cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata;
    if (cw && cw.estimatedTokensUsed) {
      const used = num(cw.estimatedTokensUsed);
      if (m.ctxLastUsed > 0 && used < m.ctxLastUsed * 0.7) {
        m.compressions = (m.compressions || 0) + 1;
        m.ctxHistory = [];
      }
      m.ctxLastUsed = used;
      m.ctx = {
        used,
        max: num(cw.maxContextTokens) || (m.ctx && m.ctx.max) || 0,
        groups: (cw.tokenBreakdown && cw.tokenBreakdown.groups) || [],
      };
      if (!m.ctxHistory) m.ctxHistory = [];
      if (!m.ctxHistory.length || m.ctxHistory[m.ctxHistory.length - 1].used !== used) {
        m.ctxHistory.push({ t: Date.now(), used });
        if (m.ctxHistory.length > 20) m.ctxHistory.splice(0, m.ctxHistory.length - 20);
      }
    }
    const u = cm.usage;
    if (!u) return;
    const out = num(u.outputTokens);
    const dur = seconds(cm.streamingDuration);
    const input = num(u.inputTokens);
    const cache = num(u.cacheReadTokens);
    if (acc) {
      acc.calls++;
      acc.input += input;
      acc.cache += cache;
    }
    // 过滤太短或明显异常的速度样本
    const tps = dur ? out / dur : 0;
    if (out > 0 && dur >= 1.5 && tps <= 800) {
      if (acc) {
        acc.out += out;
        acc.stream += dur;
      }
      m.last = {
        tps,
        out,
        thinking: num(u.thinkingOutputTokens),
        ttft: seconds(cm.timeToFirstToken),
        dur,
        hit: input + cache ? cache / (input + cache) : 0,
        model: cm.responseModel || u.model,
      };
      if (acc) m.recentSpeeds = [...(m.recentSpeeds || []), m.last.tps].slice(-5);
    }
  }

  async function refreshMeta(force) {
    const id = state.cascadeId;
    if (!id || state.busy.meta) return;
    if (!force && Date.now() - state.at.meta < META_INTERVAL) return;
    state.busy.meta = true;
    try {
      const m = state.meta || emptyMeta();
      const json = await rpc('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: id,
        generatorMetadataOffset: m.settled,
      });
      if (id !== state.cascadeId) return;
      const list = json.generatorMetadata || [];
      // 前面的调用已经结束，计入累计；最后一条可能还在进行，只做临时统计，下次重新拉
      list.slice(0, -1).forEach(g => absorb(m, g, m.acc));
      m.settled += Math.max(0, list.length - 1);
      const view = { ...m, acc: { ...m.acc }, ctxHistory: [...(m.ctxHistory || [])], recentSpeeds: [...(m.recentSpeeds || [])] };
      if (list.length) absorb(view, list[list.length - 1], view.acc);
      state.meta = m;
      state.metaView = view;
      state.error = null;
    } catch (e) {
      state.error = String(e.message || e);
    } finally {
      state.at.meta = Date.now();
      state.busy.meta = false;
    }
  }

  // ---------- 生成中状态与实时速度 ----------

  const TOOL_NAMES = {
    CORTEX_STEP_TYPE_RUN_COMMAND: '执行命令',
    CORTEX_STEP_TYPE_VIEW_FILE: '读取文件',
    CORTEX_STEP_TYPE_CODE_ACTION: '修改代码',
    CORTEX_STEP_TYPE_GREP_SEARCH: '搜索代码',
    CORTEX_STEP_TYPE_FIND: '查找文件',
    CORTEX_STEP_TYPE_LIST_DIRECTORY: '浏览目录',
    CORTEX_STEP_TYPE_SEARCH_WEB: '搜索网页',
    CORTEX_STEP_TYPE_READ_URL_CONTENT: '读取网页',
    CORTEX_STEP_TYPE_BROWSER_SUBAGENT: '操作浏览器',
    CORTEX_STEP_TYPE_MCP_TOOL: '调用 MCP 工具',
  };
  const toolName = t => TOOL_NAMES[t] || '执行工具';

  let charRatio = 0.45; // 每个字符约多少 token，用已完成的回复不断校准
  let samples = { key: null, list: [] };
  let idleStepKey = null;
  let idleStepSince = 0;

  async function refreshLive(force) {
    const id = state.cascadeId;
    const m = state.meta;
    if (!id || !m || state.busy.live) return;
    const generating = state.live && state.live.status !== 'idle';
    const interval = generating ? LIVE_INTERVAL : IDLE_LIVE_INTERVAL;
    if (!force && Date.now() - state.at.live < interval) return;
    state.busy.live = true;
    try {
      // 只取最后几步，避免每秒拉完整的对话记录
      const json = await rpc('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: Math.max(0, m.maxStep - 2) });
      if (id !== state.cascadeId) return;
      const steps = json.steps || [];

      // 用已完成回复的 “输出 token / 回复字数” 校准换算比例
      let tok = 0;
      let chars = 0;
      for (const s of steps) {
        const pr = s.plannerResponse;
        const u = s.metadata && s.metadata.modelUsage;
        if (s.status === 'CORTEX_STEP_STATUS_DONE' && pr && u && pr.response && pr.response.length > 50) {
          tok += num(u.responseOutputTokens);
          chars += pr.response.length;
        }
      }
      if (tok && chars) charRatio = charRatio * 0.5 + (tok / chars) * 0.5;

      const active = [...steps].reverse().find(s => s.status && s.status !== 'CORTEX_STEP_STATUS_DONE' &&
        !/CANCELED|CLEARED|ERROR|HALTED|INTERRUPTED|INVALID/.test(s.status));
      const live = { status: 'idle', tps: 0, since: 0, label: '' };
      if (active) {
        const created = active.metadata && Date.parse(active.metadata.createdAt);
        live.since = created || Date.now();
        const st = active.status;
        if (st === 'CORTEX_STEP_STATUS_WAITING') {
          live.status = 'waiting';
          live.label = '等待你确认';
        } else if (st === 'CORTEX_STEP_STATUS_PENDING' || st === 'CORTEX_STEP_STATUS_QUEUED') {
          live.status = 'queued';
          live.label = '排队中';
        } else if (active.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
          const pr = active.plannerResponse || {};
          const len = (pr.response || '').length;
          const key = active.metadata && active.metadata.createdAt;
          if (samples.key !== key) samples = { key, list: [] };
          const now = Date.now();
          samples.list.push({ t: now, len });
          samples.list = samples.list.filter(x => now - x.t <= 5000);
          const a = samples.list[0];
          const b = samples.list[samples.list.length - 1];
          if (b.t - a.t >= 900 && b.len > a.len) live.tps = ((b.len - a.len) / ((b.t - a.t) / 1000)) * charRatio;
          if (live.tps > 800) live.tps = 0;
          live.status = len ? 'generating' : 'thinking';
          live.label = len ? '生成中' : '思考中';
        } else {
          live.status = 'tool';
          live.label = toolName(active.type);
        }
      }
      if (live.status === 'idle') samples = { key: null, list: [] };
      const tail = steps[steps.length - 1];
      const tailResponse = tail && tail.plannerResponse;
      const terminalTail = tail && (!tail.status || TERMINAL_STEP.test(tail.status));
      if (live.status === 'idle' && tail && tail.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' &&
        tailResponse && tailResponse.response && !(tailResponse.toolCalls && tailResponse.toolCalls.length) && terminalTail) {
        const key = String(tail.index ?? (tail.metadata && (tail.metadata.stepIndex || tail.metadata.createdAt)) ?? tailResponse.response.slice(0, 40));
        if (idleStepKey !== key) {
          idleStepKey = key;
          idleStepSince = Date.now();
        }
        live.idleSince = idleStepSince;
      } else {
        idleStepKey = null;
        idleStepSince = 0;
        live.idleSince = 0;
      }
      // 刚结束时立刻刷新元数据，让“上一次速度”和上下文尽快更新
      if (state.live && state.live.status !== 'idle' && live.status === 'idle') state.at.meta = 0;
      state.live = live;
    } catch (e) {
      state.error = String(e.message || e);
    } finally {
      state.at.live = Date.now();
      state.busy.live = false;
    }
  }

  // ---------- 额度与用完预测 ----------

  function loadHistory(store = QUOTA_STORE) {
    try {
      return JSON.parse(localStorage.getItem(store) || '[]');
    } catch {
      return [];
    }
  }
  function saveHistory(h, store = QUOTA_STORE) {
    try {
      localStorage.setItem(store, JSON.stringify(h));
    } catch {
      // 存不了就只是没有预测，不影响其他显示
    }
  }

  function loadAutoCompact() {
    try {
      return localStorage.getItem(AUTO_COMPACT_STORE) === '1';
    } catch {
      return false;
    }
  }
  function saveAutoCompact(enabled) {
    try {
      localStorage.setItem(AUTO_COMPACT_STORE, enabled ? '1' : '0');
    } catch {
    }
  }

  // 根据同一个重置周期内的剩余比例变化，估算消耗速度和用完时间。
  // 5 小时窗口看最近 1 小时、观察不足 30 分钟按 30 分钟算；周窗口看最近 6 小时、不足 2 小时按 2 小时算
  const QUOTA_WINDOWS = {
    '5h': { store: QUOTA_STORE, lookback: 60 * 6e4, floor: 30 * 6e4 },
    weekly: { store: QUOTA_WEEK_STORE, lookback: 6 * 3.6e6, floor: 2 * 3.6e6 },
  };
  function predict(q, win = '5h') {
    const cfg = QUOTA_WINDOWS[win];
    const now = Date.now();
    let h = loadHistory(cfg.store).filter(x => now - x.t < 48 * 3.6e6);
    const prev = h[h.length - 1];
    if (!prev || prev.f !== q.remaining || prev.reset !== q.reset || now - prev.t > 10 * 6e4) {
      h.push({ t: now, f: q.remaining, reset: q.reset });
      saveHistory(h, cfg.store);
    }
    // 重置时间每次返回会有几十秒到几分钟的抖动，差 30 分钟以内都算同一个周期
    const cycle = Date.parse(q.reset);
    h = h.filter(x => Math.abs(Date.parse(x.reset) - cycle) < 30 * 6e4);
    const old = h.find(x => now - x.t <= cfg.lookback);
    if (!old || now - old.t < QUOTA_OBSERVE_MS) return { rate: 0, eta: 0, ready: false };
    const rate = Math.max(0, old.f - q.remaining) / Math.max(now - old.t, cfg.floor); // 每毫秒消耗的比例
    return { rate, eta: rate ? now + q.remaining / rate : 0, ready: true };
  }

  // Gemini 有 5 小时和每周两个限额，设置页的数据来自 RetrieveUserQuotaSummary；
  // GetUserStatus 只给两者中更紧的那个，作为接口不可用时的退路
  async function fetchGeminiBuckets() {
    try {
      const json = await rpc('RetrieveUserQuotaSummary', {});
      const groups = (json.response && json.response.groups) || [];
      const group = groups.find(g => /gemini/i.test(g.displayName || '') || (g.buckets || []).some(b => /gemini/i.test(b.bucketId || '')));
      const buckets = (group && group.buckets) || [];
      const pick = win => {
        const b = buckets.find(x => String(x.window || '').toLowerCase() === win);
        return b && b.resetTime ? { remaining: num(b.remainingFraction), reset: b.resetTime } : null;
      };
      const five = pick('5h');
      if (five) return { five, weekly: pick('weekly') };
    } catch {
    }
    return null;
  }

  async function refreshQuota(force) {
    if (!force && Date.now() - state.at.quota < QUOTA_INTERVAL) return;
    state.at.quota = Date.now();
    try {
      const buckets = await fetchGeminiBuckets();
      if (buckets) {
        const q = { ...buckets.five, weekly: buckets.weekly };
        q.pred = predict(q, '5h');
        if (q.weekly) q.weekly.pred = predict(q.weekly, 'weekly');
        state.quota = q;
        return;
      }
      const json = await rpc('GetUserStatus', {});
      const cfg = json.userStatus && json.userStatus.cascadeModelConfigData;
      // High/Medium/Low 合并成一条：取最低剩余比例和最早的重置时间
      const list = ((cfg && cfg.clientModelConfigs) || [])
        .filter(m => m.label && m.label.startsWith(QUOTA_PREFIX) && m.quotaInfo && m.quotaInfo.resetTime);
      if (!list.length) return;
      const resets = list.map(m => ({ raw: m.quotaInfo.resetTime, time: Date.parse(m.quotaInfo.resetTime) }));
      const validResets = resets.filter(x => Number.isFinite(x.time));
      const reset = validResets.length
        ? validResets.reduce((a, b) => a.time <= b.time ? a : b).raw
        : resets[0].raw;
      const q = {
        remaining: Math.min(...list.map(m => num(m.quotaInfo.remainingFraction))),
        reset,
      };
      q.pred = predict(q);
      state.quota = q;
    } catch (e) {
      state.error = String(e.message || e);
    }
  }

  // ---------- 智能压缩上下文 ----------

  let cancelled = false;
  let activeCompact = null;
  const resumeAttempted = new Set();
  let trackedInput = null;
  let lastInputAt = 0;
  function onTrackedInputKey(event) {
    if (event.isTrusted) lastInputAt = Date.now();
  }
  function trackInputActivity(input) {
    if (trackedInput === input) return;
    if (trackedInput) trackedInput.removeEventListener('keydown', onTrackedInputKey);
    trackedInput = input || null;
    if (trackedInput) trackedInput.addEventListener('keydown', onTrackedInputKey);
  }
  const compactWaiters = new Set();
  const sleep = ms => new Promise(resolve => {
    const timer = setTimeout(() => {
      compactWaiters.delete(cancel);
      resolve(true);
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      compactWaiters.delete(cancel);
      resolve(false);
    };
    compactWaiters.add(cancel);
  });
  const pressEnter = el => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));

  function textItem(text) {
    return { text };
  }

  function compactSlashItem() {
    return { item: { slashCommand: { info: { name: 'compact', modelFacingText: '/compact' }, argumentValues: {} } } };
  }

  async function sendUserCascadeMessage(cascadeId, items) {
    const body = { cascadeId, items };
    const config = findCascadeConfig();
    if (config) body.cascadeConfig = config;
    return rpc('SendUserCascadeMessage', body);
  }

  // ---------- 快捷键：Ctrl+G 切换侧边栏分组（Status ⇄ 原来的分组） ----------

  // 应用的设置存在 React 上下文里的 storageService，改 projectsGroupBy 后侧边栏会立刻刷新
  function appStorage() {
    const el = document.querySelector('[data-testid="new-conversation-button"]');
    const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    for (let f = key && el[key], n = 0; f && n < 1000; f = f.return, n++) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && v.core && v.core.storageService) return v.core.storageService;
    }
    return null;
  }

  let groupByBefore = 'project';
  function onShortcut(e) {
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.code !== 'KeyG') return;
    const store = appStorage();
    if (!store) return;
    e.preventDefault();
    e.stopPropagation();
    const key = store.get('projectsGroupByInternal') != null ? 'projectsGroupByInternal' : 'projectsGroupBy';
    const now = store.get(key) || 'project';
    if (now !== 'status') groupByBefore = now;
    store.store(key, now === 'status' ? groupByBefore : 'status');
  }

  function toast(text) {
    state.toast = { text, until: Date.now() + 4000 };
    renderCompact();
  }

  function setCompactStatus(step, result = '', error = '') {
    state.compact.step = step;
    state.compact.result = result;
    state.compact.error = error;
    if (!destroyed) render();
  }

  function renderCompact() {
    if (!destroyed && !document.hidden) render();
  }

  function cancelActiveCompact(reason) {
    const run = activeCompact;
    if (!run) return;
    run.cancelled = true;
    if (run.decision) run.decision(false);
    compactWaiters.forEach(cancel => cancel());
    if (run.ed && run.writtenSnapshot) clearWrittenText(run);
    const cancelledAt = Date.now();
    state.compact.lastAutoAt.set(run.cascadeId, cancelledAt);
    state.compact.autoGuard.set(run.cascadeId, { at: cancelledAt, checkpoint: false, failed: true });
    const preserve = run.stage === 'm1-sent' && /destroy|新注入/.test(reason || '');
    saveCompactRun(run.cascadeId, {
      stage: preserve ? 'm1-sent' : 'error', error: preserve ? '' : (reason || '已取消'), heartbeat: preserve ? 0 : cancelledAt,
      lastAutoAt: run.auto ? cancelledAt : (getCompactRun(run.cascadeId) || {}).lastAutoAt || 0,
      owner: instanceId,
    });
    appendEvent('compact', { cascadeId: run.cascadeId, stage: preserve ? 'm1-sent' : (run.stage || 'cancelled'), error: reason || '已取消' });
    activeCompact = null;
    state.compact.running = false;
    state.compact.awaitingConfirmation = false;
    state.compact.error = reason || '已取消';
    state.compact.result = '已取消';
    state.compact.step = 'cancelled';
    state.compactUntil = 0;
    renderCompact();
  }

  function compactValid(run, cascadeId, ed) {
    return !cancelled && !destroyed && activeCompact === run && !run.cancelled &&
      (!run.pageCascade || state.cascadeId === cascadeId) && (!ed || ed.isConnected);
  }

  async function compactBaseline(run, cascadeId, ed) {
    while (state.busy.meta) {
      if (!compactValid(run, cascadeId, ed) || !(await sleep(100))) return null;
    }
    if (run.pageCascade) {
      await refreshMeta(true);
    } else {
      const json = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 });
      let maxStep = -1;
      for (const g of json.generatorMetadata || []) for (const index of g.stepIndices || []) maxStep = Math.max(maxStep, num(index));
      run.targetMaxStep = maxStep;
    }
    if (!compactValid(run, cascadeId, ed)) return null;
    return Math.max(0, (run.pageCascade ? (state.meta && state.meta.maxStep != null ? state.meta.maxStep : -1) : run.targetMaxStep) + 1);
  }

  async function targetIdle(cascadeId) {
    const metadata = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 });
    let maxStep = -1;
    for (const generator of metadata.generatorMetadata || []) {
      for (const index of generator.stepIndices || []) maxStep = Math.max(maxStep, num(index));
    }
    const json = await rpc('GetCascadeTrajectorySteps', { cascadeId, stepOffset: Math.max(0, maxStep - 39) });
    const steps = json.steps || [];
    const tail = steps[steps.length - 1];
    const response = tail && tail.plannerResponse;
    return !!tail && !steps.some(step => step.status === 'CORTEX_STEP_STATUS_WAITING') &&
      tail.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && response && response.response &&
      !(response.toolCalls && response.toolCalls.length) && (!tail.status || TERMINAL_STEP.test(tail.status));
  }

  async function latestSteps(cascadeId, pageCascade) {
    let maxStep = pageCascade && state.meta ? state.meta.maxStep : -1;
    if (maxStep < 0) {
      const metadata = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 });
      for (const generator of metadata.generatorMetadata || []) {
        for (const index of generator.stepIndices || []) maxStep = Math.max(maxStep, num(index));
      }
    }
    const json = await rpc('GetCascadeTrajectorySteps', { cascadeId, stepOffset: Math.max(0, maxStep - 39) });
    return json.steps || [];
  }

  function recentHandoffPath(steps) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const recent = (steps || []).slice(-40);
    for (let i = recent.length - 1; i >= 0; i--) {
      const step = recent[i];
      const created = Date.parse(step.metadata && step.metadata.createdAt);
      if (Number.isFinite(created) && created < cutoff) continue;
      if (!/CODE_ACTION|WRITE|CREATE|EDIT/.test(step.type || '')) continue;
      const raw = JSON.stringify(step);
      const match = raw.match(/\.agents\/handoff\/[A-Za-z0-9._/-]+\.md/);
      if (match) return match[0];
    }
    return null;
  }

  // 只看发送之后新增的步骤来判断这一轮是否结束，不依赖“忙碌”状态：
  // AI 回复太快时轮询可能看不到忙碌；用户输入步骤一发出就会出现，不能算作 AI 已处理；
  // AI 决定调用工具和开始执行工具之间也会有几秒“所有步骤都已结束”的空档，不能算作一轮结束。
  // 完成条件：全部步骤处于结束状态、数量不再变化，并且最后一步是不带工具调用的文字回复（持续 3 秒），
  // 或者最后一步是压缩检查点、之后 AI 没有继续（持续 8 秒）。
  const TERMINAL_STEP = /DONE|CANCELED|CLEARED|ERROR|HALTED|INTERRUPTED|INVALID/;
  function turnFinished(steps) {
    const last = steps[steps.length - 1];
    if (!last) return 0;
    const pr = last.plannerResponse;
    if (last.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && pr && pr.response && !(pr.toolCalls && pr.toolCalls.length)) return 3000;
    if (last.type === 'CORTEX_STEP_TYPE_CHECKPOINT') return 8000;
    return 0;
  }
  async function waitForLiveCycle(run, cascadeId, ed, baseline) {
    const deadline = Date.now() + 5 * 60 * 1000;
    let doneSince = 0;
    let lastCount = -1;
    while (Date.now() < deadline) {
      if (!compactValid(run, cascadeId, ed)) return { cancelled: true };
      const json = await rpc('GetCascadeTrajectorySteps', { cascadeId, stepOffset: baseline });
      if (!compactValid(run, cascadeId, ed)) return { cancelled: true };
      const steps = json.steps || [];
      const settled = steps.every(s => !s.status || TERMINAL_STEP.test(s.status));
      const holdMs = settled && steps.length === lastCount ? turnFinished(steps) : 0;
      if (holdMs) {
        if (!doneSince) doneSince = Date.now();
        if (Date.now() - doneSince >= holdMs) return { ok: true, steps };
      } else {
        doneSince = 0;
      }
      lastCount = steps.length;
      if (run.pageCascade) await refreshLive(true); // 让仪表上的运行状态同步更新
      if (!(await sleep(1000))) return { cancelled: true };
    }
    return { timeout: true };
  }

  // 只在这一轮新增的步骤里找 AI 的最后一条回复，避免读到上一轮的旧回复
  function lastReplyIn(steps) {
    const step = [...(steps || [])].reverse().find(item => item.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && item.plannerResponse && item.plannerResponse.response);
    return step ? step.plannerResponse.response : '';
  }

  function waitForCompactDecision(run) {
    return new Promise(resolve => {
      run.decision = resolve;
    });
  }

  function chooseCompactDecision(continueIt) {
    if (!activeCompact || !activeCompact.decision) return;
    const resolve = activeCompact.decision;
    activeCompact.decision = null;
    state.compact.awaitingConfirmation = false;
    resolve(continueIt);
  }

  function editorSnapshot(ed) {
    const label = ed.querySelector('[data-uri="slashCommand:compact"]');
    const normalize = text => String(text || '').trim().replace(/\s+/g, ' ');
    return { text: normalize(ed.innerText), label: normalize(label ? label.innerText : ''), hasLabel: !!label };
  }

  function sameEditorSnapshot(ed, snapshot) {
    const current = editorSnapshot(ed);
    return current.text === snapshot.text && current.hasLabel === snapshot.hasLabel && current.label === snapshot.label;
  }

  function editorMatchesExpected(run, ed) {
    if (sameEditorSnapshot(ed, run.expectedSnapshot)) return true;
    cancelActiveCompact('用户修改了输入框');
    return false;
  }

  function moveCaretToEnd(ed) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearWrittenText(run) {
    if (!run.ed || !run.writtenSnapshot || !sameEditorSnapshot(run.ed, run.writtenSnapshot)) return false;
    const lex = run.ed.__lexicalEditor;
    lex.update(() => lex._pendingEditorState._nodeMap.get('root').clear());
    return lex.getEditorState()._nodeMap.get('root').__size === 0 &&
      sameEditorSnapshot(run.ed, { text: '', label: '', hasLabel: false });
  }

  function insertCompactText(run, ed, text) {
    if (!compactValid(run, state.cascadeId, ed)) return false;
    ed.focus();
    moveCaretToEnd(ed);
    const before = editorSnapshot(ed);
    const result = document.execCommand('insertText', false, text);
    run.ed = ed;
    const combined = `${before.text}${before.text && text ? ' ' : ''}${text}`.trim().replace(/\s+/g, ' ');
    run.writtenSnapshot = { text: combined, label: before.label, hasLabel: before.hasLabel };
    run.expectedSnapshot = run.writtenSnapshot;
    if (result === false) {
      clearWrittenText(run);
      return false;
    }
    return compactValid(run, state.cascadeId, ed);
  }

  async function waitForUserInputStep(run, cascadeId, ed, baseline) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!compactValid(run, cascadeId, ed)) return { cancelled: true };
      const json = await rpc('GetCascadeTrajectorySteps', { cascadeId, stepOffset: baseline });
      if (!compactValid(run, cascadeId, ed)) return { cancelled: true };
      const steps = json.steps || [];
      if (steps.some(s => s.type === 'CORTEX_STEP_TYPE_USER_INPUT')) return { ok: true };
      if (!(await sleep(500))) return { cancelled: true };
    }
    return { timeout: true };
  }

  async function smartCompactInput(run, cascadeId, box, ed, m1, m2, handoff) {
    const emptySnapshot = { text: '', label: '', hasLabel: false };
    const base1 = await compactBaseline(run, cascadeId, ed);
    if (!compactValid(run, cascadeId, ed)) return false;
    if (!insertCompactText(run, ed, m1)) return false;
    if (!(await sleep(1200)) || !compactValid(run, cascadeId, ed)) return false;
    if (!editorMatchesExpected(run, ed)) return false;
    pressEnter(ed);
    if (!(await sleep(1000)) || !compactValid(run, cascadeId, ed)) return false;
    if (!sameEditorSnapshot(ed, emptySnapshot)) {
      if (!editorMatchesExpected(run, ed)) return false;
      const send = [...box.querySelectorAll('button')].find(button => /send message/i.test(button.getAttribute('aria-label') || '') || /send message/i.test(button.textContent || ''));
      if (!send) {
        clearWrittenText(run);
        throw new Error('消息没有发出去');
      }
      if (!editorMatchesExpected(run, ed)) return false;
      send.click();
    }
    run.stage = 'm1-sent';
    saveCompactRun(cascadeId, { stage: 'm1-sent', m1SentAt: Date.now(), m1Baseline: base1, heartbeat: Date.now(), owner: instanceId, handoff });
    appendEvent('compact', { cascadeId, stage: 'm1-sent', baseline: base1 });
    run.expectedSnapshot = emptySnapshot;
    const sent = await waitForUserInputStep(run, cascadeId, ed, base1);
    if (sent.cancelled) return false;
    if (sent.timeout) {
      clearWrittenText(run);
      throw new Error('消息没有发出去');
    }
    state.at.live = 0;
    const firstWait = await waitForLiveCycle(run, cascadeId, ed, base1);
    if (firstWait.cancelled) return false;
    if (firstWait.timeout) throw new Error('第 1 步等待超时');
    const reply = lastReplyIn(firstWait.steps);
    if (!compactValid(run, cascadeId, ed)) return false;
    if (!reply.includes(`交接文档已更新：${handoff}`)) {
      state.compact.awaitingConfirmation = true;
      state.compact.result = 'AI 没有确认写入交接文档';
      renderCompact();
      const confirmed = await waitForCompactDecision(run);
      if (!compactValid(run, cascadeId, ed)) return false;
      if (!confirmed) return false;
    }
    state.compact.step = '2/2';
    state.compact.result = '';
    renderCompact();
    const base2 = await compactBaseline(run, cascadeId, ed);
    if (!compactValid(run, cascadeId, ed)) return false;
    if (!editorMatchesExpected(run, ed)) return false;
    if (!insertCompactText(run, ed, '/compact')) return false;
    if (!(await sleep(500)) || !compactValid(run, cascadeId, ed)) return false;
    if (!editorMatchesExpected(run, ed)) return false;
    run.selectingSlash = true;
    pressEnter(ed);
    if (!(await sleep(500)) || !compactValid(run, cascadeId, ed)) return false;
    run.selectingSlash = false;
    const compactLabel = ed.querySelector('[data-uri="slashCommand:compact"]');
    if (!compactLabel) throw new Error('没有选中 /compact 命令');
    const tagSnapshot = editorSnapshot(ed);
    const expectedTag = { text: tagSnapshot.label, label: tagSnapshot.label, hasLabel: true };
    if (!sameEditorSnapshot(ed, expectedTag)) return cancelActiveCompact('用户修改了输入框');
    run.expectedSnapshot = expectedTag;
    run.writtenSnapshot = expectedTag;
    ed.focus();
    moveCaretToEnd(ed);
    const appendResult = document.execCommand('insertText', false, ` ${m2}`);
    run.writtenSnapshot = { text: `${tagSnapshot.text} ${m2}`.trim().replace(/\s+/g, ' '), label: tagSnapshot.label, hasLabel: true };
    run.expectedSnapshot = run.writtenSnapshot;
    if (appendResult === false) {
      clearWrittenText(run);
      throw new Error('无法写入压缩指令');
    }
    if (!(await sleep(400)) || !compactValid(run, cascadeId, ed)) return false;
    if (!editorMatchesExpected(run, ed)) return false;
    run.stage = 'm2-sent';
    saveCompactRun(cascadeId, { stage: 'm2-sent', m2Baseline: base2, heartbeat: Date.now(), owner: instanceId, handoff });
    pressEnter(ed);
    run.expectedSnapshot = emptySnapshot;
    if (!(await sleep(1200)) || !compactValid(run, cascadeId, ed)) return false;
    state.at.live = 0;
    const secondWait = await waitForLiveCycle(run, cascadeId, ed, base2);
    if (secondWait.cancelled) return false;
    if (secondWait.timeout) throw new Error('第 2 步等待超时');
    const success = secondWait.steps.some(s => s.type === 'CORTEX_STEP_TYPE_CHECKPOINT');
    const reread = secondWait.steps.some(s => s.type === 'CORTEX_STEP_TYPE_VIEW_FILE' && JSON.stringify(s.viewFile || {}).includes('.agents/handoff/'));
    await refreshMeta(true);
    if (!compactValid(run, cascadeId, ed)) return false;
    run.success = success;
    state.compact.step = success ? 'done' : 'error';
    state.compact.result = success
      ? `压缩完成${reread ? '，AI 已重新读取交接文档' : `；下一条消息时 AI 会先读取交接文档 ${handoff}`}`
      : '';
    if (!success) state.compact.error = '没有检测到压缩检查点，压缩可能没有执行';
    saveCompactRun(cascadeId, { stage: success ? 'done' : 'error', error: state.compact.error, heartbeat: Date.now(), owner: instanceId });
    appendEvent('compact', { cascadeId, stage: state.compact.step, error: state.compact.error || '' });
    return success;
  }

  async function smartCompactDirect(run, cascadeId, m1, m2, handoff, resume = null) {
    let base1 = resume && resume.m1Baseline;
    if (base1 == null && !(resume && resume.stage === 'm2-sent') && !(resume && resume.skipM1)) {
      base1 = await compactBaseline(run, cascadeId, null);
      if (!compactValid(run, cascadeId, null)) return false;
      saveCompactRun(cascadeId, { stage: 'm1-sending', startedAt: Date.now(), m1Baseline: base1, heartbeat: Date.now(), owner: instanceId, handoff });
      await sendUserCascadeMessage(cascadeId, [textItem(m1)]);
      run.directSent = true;
      run.stage = 'm1-sent';
      saveCompactRun(cascadeId, { stage: 'm1-sent', m1SentAt: Date.now(), heartbeat: Date.now(), owner: instanceId });
      appendEvent('compact', { cascadeId, stage: 'm1-sent', baseline: base1 });
    }
    if (resume && resume.stage === 'm2-sent') {
      const wait = await waitForLiveCycle(run, cascadeId, null, resume.m2Baseline);
      if (wait.cancelled) return false;
      if (wait.timeout) throw new Error('第 2 步等待超时');
      run.success = wait.steps.some(s => s.type === 'CORTEX_STEP_TYPE_CHECKPOINT');
      if (!run.success) throw new Error('没有检测到压缩检查点，压缩可能没有执行');
      state.compact.step = 'done';
      state.compact.result = '压缩完成';
      saveCompactRun(cascadeId, { stage: 'done', heartbeat: Date.now(), owner: instanceId });
      appendEvent('compact', { cascadeId, stage: 'done', resumed: true });
      return true;
    }
    let reply = '';
    if (!(resume && resume.skipM1)) {
      const firstWait = await waitForLiveCycle(run, cascadeId, null, base1);
      if (firstWait.cancelled) return false;
      if (firstWait.timeout) throw new Error('第 1 步等待超时');
      reply = lastReplyIn(firstWait.steps);
    }
    const writtenPath = (resume && resume.handoff) || reply.match(/交接文档已更新：([^\s。]+)/)?.[1] || handoff;
    run.handoff = writtenPath;
    if (!compactValid(run, cascadeId, null)) return false;
    if (!(resume && resume.skipM1) && !reply.includes('交接文档已更新')) {
      state.compact.awaitingConfirmation = true;
      state.compact.result = 'AI 没有确认写入交接文档';
      renderCompact();
      const confirmed = await waitForCompactDecision(run);
      if (!compactValid(run, cascadeId, null)) return false;
      if (!confirmed) return false;
    }
    state.compact.step = '2/2';
    state.compact.result = '';
    renderCompact();
    const base2 = await compactBaseline(run, cascadeId, null);
    if (!compactValid(run, cascadeId, null)) return false;
    run.stage = 'm2-sending';
    saveCompactRun(cascadeId, { stage: 'm2-sending', m2Baseline: base2, handoff: writtenPath, heartbeat: Date.now(), owner: instanceId });
    const finalM2 = m2.replaceAll(handoff, writtenPath);
    await sendUserCascadeMessage(cascadeId, [compactSlashItem(), textItem(finalM2)]);
    run.directSent = true;
    run.stage = 'm2-sent';
    saveCompactRun(cascadeId, { stage: 'm2-sent', heartbeat: Date.now(), owner: instanceId });
    appendEvent('compact', { cascadeId, stage: 'm2-sent', baseline: base2, handoff: writtenPath });
    const secondWait = await waitForLiveCycle(run, cascadeId, null, base2);
    if (secondWait.cancelled) return false;
    if (secondWait.timeout) throw new Error('第 2 步等待超时');
    const success = secondWait.steps.some(s => s.type === 'CORTEX_STEP_TYPE_CHECKPOINT');
    const reread = secondWait.steps.some(s => s.type === 'CORTEX_STEP_TYPE_VIEW_FILE' && JSON.stringify(s.viewFile || {}).includes('.agents/handoff/'));
    if (run.pageCascade) await refreshMeta(true);
    if (!compactValid(run, cascadeId, null)) return false;
    run.success = success;
    state.compact.step = success ? 'done' : 'error';
    state.compact.result = success
      ? `压缩完成${reread ? '，AI 已重新读取交接文档' : `；下一条消息时 AI 会先读取交接文档 ${writtenPath}`}`
      : '';
    if (!success) state.compact.error = '没有检测到压缩检查点，压缩可能没有执行';
    saveCompactRun(cascadeId, { stage: success ? 'done' : 'error', error: state.compact.error, heartbeat: Date.now(), owner: instanceId });
    appendEvent('compact', { cascadeId, stage: state.compact.step, error: state.compact.error || '' });
    return success;
  }

  async function smartCompact(options = false) {
    const auto = options === true || !!(options && options.auto);
    const requestedCascadeId = options && typeof options === 'object' ? options.cascadeId : null;
    if (cancelled || destroyed || activeCompact || state.compact.running) return false;
    syncConversation();
    const cascadeId = requestedCascadeId || state.cascadeId;
    const box = document.querySelector('[data-testid="agent-input-box"]');
    const ed = box && box.querySelector('[contenteditable="true"]');
    if (!cascadeId) return toast('当前没有对话，无法压缩');
    const pageCascade = cascadeId === state.cascadeId;
    const persisted = getCompactRun(cascadeId);
    if (pageCascade && (!state.live || state.live.status !== 'idle')) return toast('当前仍在运行，请稍后再压缩');
    if (!pageCascade && !(persisted && /m2-/.test(persisted.stage)) && !(await targetIdle(cascadeId))) return false;
    const guard = state.compact.autoGuard.get(cascadeId);
    const now = Date.now();
    if (persisted && persisted.heartbeat && now - persisted.heartbeat < COMPACT_LOCK_MS && persisted.owner !== instanceId) return false;
    if (auto && ((guard && guard.failed && now - guard.at < 600000) || (persisted && persisted.lastAutoAt && now - persisted.lastAutoAt < 600000))) return false;
    let handoff = `.agents/handoff/${cascadeId.slice(0, 8)}.md`;
    const recentSteps = await latestSteps(cascadeId, pageCascade);
    const recentPath = recentHandoffPath(recentSteps);
    const resume = persisted && ((persisted.startedAt && now - persisted.startedAt <= COMPACT_RESUME_MS) || (persisted.m1SentAt && now - persisted.m1SentAt < COMPACT_NO_DUP_MS)) &&
      ['m1-sent', 'm2-sending', 'm2-sent'].includes(persisted.stage)
      ? { ...persisted, stage: /m2-/.test(persisted.stage) ? 'm2-sent' : 'm1-sent' } : null;
    const skipM1 = !resume && !!recentPath;
    if (!resume && !skipM1 && persisted && persisted.m1SentAt && now - persisted.m1SentAt < COMPACT_NO_DUP_MS) return false;
    if (recentPath) handoff = recentPath;
    const m1 = `【智能压缩 1/2】上下文快满了。请暂停当前任务，按全局规则中的“交接文档结构”，把当前工作状态覆盖写入 ${handoff}（相对于当前工作区根目录，文件夹不存在就创建）。写完只回复“交接文档已更新：${handoff}”，不要做别的事。`;
    const m2 = `【智能压缩 2/2】请按以下结构写压缩总结，并原样保留文件路径、命令、接口名和报错原文：1 目标与要求；2 当前进度；3 关键发现；4 文件与代码；5 错误与修复；6 决定与约束；7 下一步；8 关键文件清单。最后一行写：继续工作前先读取交接文档 ${handoff} 和其中的关键文件清单。不确定的标“未验证”，不要编造。压缩完成后只回复“压缩完成，等待下一步指示”，不要读取文件、不要运行命令、不要继续之前的任务。`;
    const emptySnapshot = { text: '', label: '', hasLabel: false };
    const run = { cancelled: false, decision: null, cascadeId, ed, writtenSnapshot: null, expectedSnapshot: emptySnapshot, auto, direct: false, success: false, pageCascade, stage: resume ? resume.stage : (skipM1 ? 'm2-sending' : 'idle'), handoff };
    activeCompact = run;
    saveCompactRun(cascadeId, {
      stage: resume ? resume.stage : (skipM1 ? 'm2-sending' : 'starting'),
      startedAt: resume ? resume.startedAt : now,
      heartbeat: now,
      lastAutoAt: auto ? now : ((persisted && persisted.lastAutoAt) || 0),
      owner: instanceId,
      handoff,
    });
    const heartbeatTimer = setInterval(() => saveCompactRun(cascadeId, { heartbeat: Date.now(), owner: instanceId }), 5000);
    run.heartbeatTimer = heartbeatTimer;
    appendEvent('compact', { cascadeId, stage: resume ? `resume-${resume.stage}` : (skipM1 ? 'skip-m1' : 'starting'), auto });
    state.compact.running = true;
    state.compact.awaitingConfirmation = false;
    state.compact.error = '';
    state.compact.result = '';
    state.compact.step = resume && resume.stage === 'm2-sent' ? '2/2' : (skipM1 ? '2/2' : '1/2');
    state.compactUntil = Date.now() + 5 * 60 * 1000;
    renderCompact();
    try {
      try {
        run.direct = true;
        return await smartCompactDirect(run, cascadeId, m1, m2, handoff, resume || (skipM1 ? { skipM1: true, handoff } : null));
      } catch (directError) {
        run.direct = false;
        if (run.directSent) throw directError;
        if (!ed || !box || ed.innerText.trim()) throw directError;
        return await smartCompactInput(run, cascadeId, box, ed, m1, m2, handoff);
      }
    } catch (e) {
      if (!run.cancelled && !cancelled) {
        state.compact.error = String(e.message || e);
        state.compact.step = 'error';
        saveCompactRun(cascadeId, { stage: 'error', error: state.compact.error, heartbeat: Date.now(), lastAutoAt: auto ? Date.now() : ((persisted && persisted.lastAutoAt) || 0), owner: instanceId });
        appendEvent('compact', { cascadeId, stage: run.stage, error: state.compact.error });
        return false;
      }
      return false;
    } finally {
      clearInterval(heartbeatTimer);
      if (activeCompact !== run) return;
      activeCompact = null;
      const now = Date.now();
      state.compact.lastAutoAt.set(cascadeId, now);
      saveCompactRun(cascadeId, { heartbeat: 0, owner: '', lastAutoAt: auto ? now : ((persisted && persisted.lastAutoAt) || 0) });
      state.compact.autoGuard.set(cascadeId, run.success
        ? { at: now, checkpoint: true, failed: false }
        : { at: now, checkpoint: false, failed: true });
      state.compact.running = false;
      state.compact.awaitingConfirmation = false;
      state.compactUntil = 0;
      renderCompact();
    }
  }

  // ---------- 渲染 ----------

  const fmtK = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
  const pct = f => Math.round(f * 100) + '%';
  const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  function fmtLeft(ms) {
    if (!(ms > 0)) return '0分';
    const h = Math.floor(ms / 3.6e6);
    const m = Math.floor((ms % 3.6e6) / 6e4);
    if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}小时`;
    return h ? `${h}小时${m}分` : `${m}分`;
  }
  const fmtSec = s => (s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${Math.round(s)}秒`);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const clamp01 = f => Math.max(0, Math.min(1, Number(f) || 0));
  const ARC_START = 145;
  const ARC_END = 395;
  const BOLT_PATH = 'M41 14 18 35h13l-5 15 24-24H38l3-12Z';
  const GEMINI_STAR_PATH = 'M32 12 C33.6 23.5 39.5 29.4 51 31 C39.5 32.6 33.6 38.5 32 50 C30.4 38.5 24.5 32.6 13 31 C24.5 29.4 30.4 23.5 32 12 Z';
  const GREEN = '#28C840';
  const YELLOW = '#FEBC2E';
  const RED = '#FF5F57';
  const GRAY = 'rgba(127,127,127,.4)';
  const SOFT_GRAY = '#9ca3af';
  const darkMode = () => document.body.classList.contains('dark') || document.body.classList.contains('theme-dark');
  const arcDash = fraction => clamp01(fraction).toFixed(4) + ' 1';

  function contextArcColor(fraction) {
    return fraction >= 0.85 ? RED : fraction >= 0.6 ? YELLOW : GREEN;
  }
  function pointOnArc(radius, degrees, cx = 32, cy = 31) {
    const a = degrees * Math.PI / 180;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  }
  function arcPath(radius, start, end, cx = 32, cy = 31, sweep = 1) {
    const a = pointOnArc(radius, start, cx, cy);
    const b = pointOnArc(radius, end, cx, cy);
    return `M${a.x.toFixed(3)} ${a.y.toFixed(3)} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} ${sweep} ${b.x.toFixed(3)} ${b.y.toFixed(3)}`;
  }
  const QUOTA_LEVELS = [
    { max: 0.5, color: GRAY, text: '完全够用' },
    { max: 0.9, color: GREEN, text: '大概率够用' },
    { max: 1.2, color: YELLOW, text: '需要节省一点' },
    { max: Infinity, color: RED, text: '按这个速度肯定不够' },
  ];
  function quotaSpendRatio(q, prediction) {
    if (!q || !prediction || !prediction.rate) return 0;
    const reset = Date.parse(q.reset);
    if (!Number.isFinite(reset)) return 0;
    const left = Math.max(0, reset - Date.now());
    const sustainable = left ? num(q.remaining) / left : 0;
    return sustainable ? Math.max(0, prediction.rate / sustainable) : 0;
  }

  // 圆弧只看剩余额度：低于 66% 黄色，低于 33% 红色；消耗速度由中间的星星表示
  function quotaArcColor(q) {
    if (!q) return GRAY;
    const remaining = clamp01(num(q.remaining));
    return remaining < 0.33 ? RED : remaining < 0.66 ? YELLOW : GREEN;
  }

  // 按当前速度，到重置前会用掉剩余额度的多少，分四档
  // 生成速度评级，门槛按 Gemini 3.8 Flash 平时 100~180 tok/s 的表现定
  const SPEED_LEVELS = [
    { min: 150, color: GREEN, text: '优秀' },
    { min: 80, color: SOFT_GRAY, text: '正常' },
    { min: 40, color: YELLOW, text: '偏慢' },
    { min: 0, color: RED, text: '很慢' },
  ];
  const speedLevel = tps => (tps > 0 ? SPEED_LEVELS.find(l => tps >= l.min) : null);

  function quotaWindowLevel(w, prediction = w && w.pred) {
    if (!w || !prediction || !prediction.ready) return null;
    const ratio = quotaSpendRatio(w, prediction);
    return { ...QUOTA_LEVELS.find(l => ratio < l.max), ratio, rate: prediction.rate, eta: prediction.eta, reset: Date.parse(w.reset) };
  }

  // 星星只看 5 小时窗口；每周窗口的速度只在面板里显示
  function quotaLevel(q, prediction = q && q.pred) {
    return quotaWindowLevel(q, prediction);
  }

  function quotaCenterIcon(q, prediction = q && q.pred) {
    const level = quotaLevel(q, prediction);
    const color = level ? level.color : GRAY;
    return '<path class="ag-quota-icon" d="' + GEMINI_STAR_PATH + '" fill="' + color + '" aria-hidden="true"/>';
  }

  function gaugeSvg(kind, data) {
    const quota = kind === 'quota';
    const fraction = quota ? (data && data.remaining) : (data && data.usedRatio);
    const dotAngles = [126.7, 108.3, 90, 71.7, 53.3];
    const dots = dotAngles.map((angle, i) => {
      const p = pointOnArc(27.5, angle);
      return '<circle class="ag-dot" data-dot="' + i + '" cx="' + p.x.toFixed(3) + '" cy="' + p.y.toFixed(3) + '" r="3.75" fill="' + GRAY + '"/>';
    }).join('');
    const speed = clamp01((data && data.tps) / 300);
    const icon = quota ? quotaCenterIcon(data) : '<g class="ag-bolt-icon">' +
      '<defs><clipPath id="' + HUD_ID + '-bolt-clip"><path d="' + BOLT_PATH + '"/></clipPath></defs>' +
      '<path d="' + BOLT_PATH + '" fill="' + GRAY + '"/>' +
      '<rect class="ag-bolt-fill" x="0" y="' + (50 - 36 * speed).toFixed(3) + '" width="64" height="' + (36 * speed).toFixed(3) + '" fill="' + YELLOW + '" clip-path="url(#' + HUD_ID + '-bolt-clip)"/>' +
      '</g>';
    const arcColor = quota ? quotaArcColor(data) : contextArcColor(clamp01(fraction));
    const arc = arcPath(26, ARC_START, ARC_END);
    return '<svg class="ag-gauge ag-' + kind + '-svg" width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">' +
      '<path class="ag-track" d="' + arc + '" fill="none" stroke="' + GRAY + '" stroke-width="5.5" stroke-linecap="round"/>' +
      '<path class="ag-arc" d="' + arc + '" pathLength="1" fill="none" stroke="' + arcColor + '" stroke-width="5.5" stroke-linecap="round" stroke-dasharray="' + arcDash(fraction) + '"/>' +
      '<g class="ag-dots">' + dots + '</g>' + icon +
      '</svg>';
  }

  const STYLE = `
    #${HUD_ID}{position:fixed;display:inline-flex;align-items:center;gap:6px;width:62px;height:28px;flex:none;z-index:2147483647;color:var(--foreground);font:12px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;user-select:none;font-variant-numeric:tabular-nums}
    #${HUD_ID}.ag-fallback{width:28px;height:64px;flex-direction:column;gap:8px}
    #${HUD_ID}.ag-hidden{display:none}
    #${HUD_ID} .ag-item{position:relative;width:28px;height:28px;flex:none}
    #${HUD_ID} .ag-hot{display:block;width:28px;height:28px;cursor:pointer;border-radius:50%;outline:none}
    #${HUD_ID} .ag-gauge{display:block;width:28px;height:28px;overflow:visible}
    #${HUD_ID} .ag-arc{transition:stroke-dasharray .35s}
    #${HUD_ID} .ag-arc.ag-pulse{animation:ag-pulse 2.2s ease-in-out infinite}
    #${HUD_ID} .ag-dot{transition:fill .2s}
    #${HUD_ID} .ag-bolt-fill{transition:y .35s,height .35s}
    #${HUD_ID} .ag-bolt-icon.generating{animation:ag-pulse 1.5s ease-in-out infinite}
    #${HUD_ID} .ag-bolt-icon.ag-pulse{animation:ag-pulse 1.5s ease-in-out infinite}
    #${HUD_ID} .ag-bolt-icon.ag-waiting{animation:ag-pulse 1s ease-in-out infinite}
    #${HUD_ID} .ag-bolt-icon.ag-outline-pulse{animation:ag-outline-pulse 1.5s ease-in-out infinite}
    #${HUD_ID} .ag-bolt-icon.ag-outline-pulse>path:first-of-type{fill:none;stroke:${YELLOW};stroke-width:2}
    #${HUD_ID} .ag-quota-icon{transition:fill .6s}
    #${HUD_ID} .ag-pop{display:none;position:fixed;left:8px;top:8px;box-sizing:border-box;width:300px;max-height:70vh;overflow-y:auto;overscroll-behavior:contain;padding:10px;border:1px solid var(--border);border-radius:12px;background:#fff;color:var(--foreground);box-shadow:0 8px 28px rgba(0,0,0,.14);font-size:12px;line-height:1.55;z-index:2147483647;font-variant-numeric:tabular-nums}
    body.dark #${HUD_ID} .ag-pop,body.theme-dark #${HUD_ID} .ag-pop{background:#1f1f1f;box-shadow:0 8px 28px rgba(0,0,0,.55)}
    #${HUD_ID} .ag-pop.open{display:block}
    #${HUD_ID} .ag-pop h4{margin:2px 4px 8px;color:var(--muted-foreground);font-size:12px;font-weight:600}
    #${HUD_ID} .ag-bento{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px}
    #${HUD_ID} .ag-tile{min-width:0;box-sizing:border-box;padding:9px 11px;border-radius:10px;background:rgba(127,127,127,.09)}
    #${HUD_ID} .ag-wide{grid-column:1 / -1}
    #${HUD_ID} .ag-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;min-width:0}
    #${HUD_ID} .ag-head>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${HUD_ID} .ag-label,#${HUD_ID} .ag-head,#${HUD_ID} .ag-note{color:var(--muted-foreground);font-size:11px;line-height:1.45}
    #${HUD_ID} .ag-big{margin-top:1px;color:var(--foreground);font-size:22px;font-weight:600;line-height:1.25;letter-spacing:-.01em}
    #${HUD_ID} .ag-mid{margin-top:1px;color:var(--foreground);font-size:14px;font-weight:600;line-height:1.35}
    #${HUD_ID} .ag-bar{height:4px;margin:6px 0 5px;border-radius:999px;overflow:hidden;background:rgba(127,127,127,.18)}
    #${HUD_ID} .ag-bar i{display:block;width:0;height:100%;border-radius:999px;transition:width .35s}
    #${HUD_ID} .ag-rate{display:grid;grid-template-columns:44px 72px minmax(0,1fr);align-items:center;gap:6px;margin-top:5px}
    #${HUD_ID} .ag-rate>span:first-child{color:var(--muted-foreground);font-size:11px}
    #${HUD_ID} .ag-rate>span:nth-child(2){color:var(--foreground);font-weight:600;white-space:nowrap}
    #${HUD_ID} .ag-level{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;color:var(--foreground);white-space:nowrap}
    #${HUD_ID} .ag-level i{flex:none;width:7px;height:7px;border-radius:50%;background:${GRAY}}
    #${HUD_ID} .ag-level b{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:400}
    #${HUD_ID} .ag-actions{display:flex;align-items:center;gap:6px}
    #${HUD_ID} .ag-big small{margin-left:3px;color:var(--muted-foreground);font-size:11px;font-weight:400;letter-spacing:0}
    #${HUD_ID} .ag-speed{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:2px}
    #${HUD_ID} .ag-speed .ag-level{justify-content:flex-start;font-size:12px}
    #${HUD_ID} .ag-spark{display:flex;align-items:flex-end;gap:4px;height:40px;flex:none}
    #${HUD_ID} .ag-spark i{display:block;width:12px;height:12%;border-radius:3px;background:rgba(127,127,127,.18);transition:height .35s}
    #${HUD_ID} .ag-meter{position:relative;height:4px;margin:4px 0 7px;border-radius:999px;background:rgba(127,127,127,.18)}
    #${HUD_ID} .ag-meter i{display:block;width:0;height:100%;border-radius:999px;transition:width .35s}
    #${HUD_ID} .ag-meter::after{content:"";position:absolute;left:66.67%;top:-2px;width:1.5px;height:8px;background:var(--foreground);opacity:.45}
    #${HUD_ID} .ag-row{display:flex;justify-content:space-between;gap:12px;margin:2px 0;min-width:0}
    #${HUD_ID} .ag-row span:first-child{color:var(--muted-foreground);white-space:nowrap;flex:none}
    #${HUD_ID} .ag-row span:last-child{color:var(--foreground);text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${HUD_ID} .ag-stack{display:flex;height:9px;border-radius:999px;overflow:hidden;background:rgba(127,127,127,.16);margin:4px 0 3px}
    #${HUD_ID} .ag-stack i{display:block;height:100%;min-width:0;transition:width .35s}
    #${HUD_ID} .ag-stack i[data-stack="System"]{background:#6b7280}
    #${HUD_ID} .ag-stack i[data-stack="Tools"]{background:#3e8ef7}
    #${HUD_ID} .ag-stack i[data-stack="Chat"]{background:#9ca3af}
    #${HUD_ID} .ag-legend{font-size:10px;line-height:1.3;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${HUD_ID} .ag-legend b{font-weight:500}
    #${HUD_ID} .ag-more{margin:8px 4px 0}
    #${HUD_ID} .ag-more .ag-bento{margin:6px -4px 0}
    #${HUD_ID} .ag-more summary{cursor:pointer;color:var(--muted-foreground);white-space:nowrap}
    #${HUD_ID} .ag-btn{display:inline-flex;align-items:center;padding:5px 9px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--foreground);font:inherit;cursor:pointer}
        #${HUD_ID} .ag-btn.danger{border-color:#ff3b30;background:#ff3b30;color:#fff}
    #${HUD_ID} .ag-btn[disabled]{opacity:.6;cursor:default}
    #${HUD_ID} .ag-btn.danger{border-color:#ff3b30;background:#ff3b30;color:#fff}
    #${HUD_ID} .ag-muted{color:var(--muted-foreground)}
    #${HUD_ID} .ag-toast{margin:6px 4px 0;color:#b7791f}
    #${HUD_ID} .ag-error{margin:6px 4px 0;color:#ff3b30}
    #${HUD_ID} .ag-pop [hidden]{display:none}
    #${HUD_ID} .ag-auto-compact{display:block;margin-top:8px;color:var(--muted-foreground);font-size:11px;white-space:nowrap}
    #${HUD_ID} .ag-compact-status{display:block;margin-top:6px;color:var(--muted-foreground)}
    #${HUD_ID} .ag-compact-status span:empty{display:none}
    @keyframes ag-pulse{0%,100%{opacity:1}50%{opacity:.55}}
    @keyframes ag-outline-pulse{0%,100%{opacity:.65;filter:drop-shadow(0 0 0 transparent)}50%{opacity:1;filter:drop-shadow(0 0 2px ${YELLOW})}}
  `;

  function ensureStyle() {
    if (document.getElementById(HUD_ID + '-style')) return;
    const s = document.createElement('style');
    s.id = HUD_ID + '-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function onClick(e) {
    if (e.target.closest('[data-act="compact"]')) {
      e.stopPropagation();
      smartCompact();
    } else if (e.target.closest('[data-act="compact-cancel"]')) {
      e.stopPropagation();
      cancelActiveCompact('已取消');
    } else if (e.target.closest('[data-act="compact-continue"]')) {
      e.stopPropagation();
      chooseCompactDecision(true);
    } else if (e.target.closest('[data-act="compact-stop"]')) {
      e.stopPropagation();
      chooseCompactDecision(false);
    } else if (e.target.closest('[data-refresh]')) {
      refresh();
    }
  }

  function onChange(e) {
    const input = e.target.closest('[data-act="auto-compact"]');
    if (!input) return;
    state.compact.auto = !!input.checked;
    state.compact.idleSince = 0;
    saveAutoCompact(state.compact.auto);
  }

  function renderCompactControls(bar) {
    const compact = state.compact;
    const button = bar.querySelector('[data-act="compact"]');
    const cancel = bar.querySelector('[data-act="compact-cancel"]');
    const status = bar.querySelector('[data-bind="compact-status"]');
    const choice = bar.querySelector('[data-bind="compact-choice"]');
    const toggle = bar.querySelector('[data-act="auto-compact"]');
    if (toggle && !compact.autoLoaded) {
      compact.auto = loadAutoCompact();
      compact.autoLoaded = true;
    }
    if (toggle) toggle.checked = compact.auto;
    button.hidden = compact.running;
    button.disabled = compact.running;
    cancel.hidden = !compact.running;
    cancel.disabled = !compact.running;
    status.hidden = !(compact.running || compact.result || compact.error);
    status.querySelector('span:first-child').textContent = compact.running ? compact.step : '';
    status.querySelector('span:last-child').textContent = compact.error || compact.result || '';
    choice.hidden = !compact.awaitingConfirmation;
    if (compact.running) {
      button.textContent = compact.step === '1/2' ? '1/2 写交接文档…' : '2/2 压缩中…';
    } else {
      button.textContent = '⚡ 智能压缩上下文';
    }
  }

  function estimateRounds(m) {
    const h = (m && m.ctxHistory) || [];
    if (h.length < 2 || !m.ctx || !m.ctx.max) return '数据不足';
    const growths = [];
    for (let i = 1; i < h.length; i++) {
      const d = h[i].used - h[i - 1].used;
      if (d > 0) growths.push(d);
    }
    if (!growths.length) return '数据不足';
    const avg = growths.reduce((a, b) => a + b, 0) / growths.length;
    return `约 ${Math.max(0, Math.floor((m.ctx.max - m.ctx.used) / avg))} 次模型调用`;
  }

  function contextGroups() {
    return `<div class="ag-stack"><i data-stack="System" style="width:0%"></i><i data-stack="Tools" style="width:0%"></i><i data-stack="Chat" style="width:0%"></i></div>
      <div class="ag-legend"><b>System</b> · <b>Tools</b> · <b>Chat</b></div>`;
  }

  function contextBreakdown(ctx) {
    const values = { System: 0, Tools: 0, Chat: 0 };
    for (const g of (ctx && ctx.groups) || []) {
      const name = String(g.name || '').toLowerCase();
      const key = /system|instruction|系统/.test(name) ? 'System' : /tool|工具/.test(name) ? 'Tools' : 'Chat';
      values[key] += num(g.numTokens);
    }
    return values;
  }

  const popupTimers = new WeakMap();
  const popupItems = new Set();
  let activePopupItem = null;

  function positionPopup(item) {
    const hot = item.querySelector('.ag-hot');
    const pop = item.querySelector('.ag-pop');
    if (!hot || !pop || !pop.classList.contains('open')) return;
    const rect = hot.getBoundingClientRect();
    const maxHeight = Math.max(0, Math.floor(rect.top - 16));
    pop.style.maxHeight = `${maxHeight}px`;
    const width = 300;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
    const height = pop.getBoundingClientRect().height;
    pop.style.top = `${Math.max(8, rect.top - height - 8)}px`;
  }

  function openPopup(item) {
    const timers = popupTimers.get(item);
    if (!timers) return;
    const bar = document.getElementById(HUD_ID);
    if (!bar) return;
    bar.querySelectorAll('.ag-item').forEach(other => {
      if (other === item) return;
      const otherTimers = popupTimers.get(other);
      clearTimeout(otherTimers.open);
      clearTimeout(otherTimers.close);
      other.querySelector('.ag-pop').classList.remove('open');
      if (activePopupItem === other) activePopupItem = null;
    });
    clearTimeout(timers.close);
    clearTimeout(timers.open);
    timers.open = setTimeout(() => {
      item.querySelector('.ag-pop').classList.add('open');
      activePopupItem = item;
      positionPopup(item);
    }, 120);
  }

  function closePopup(item) {
    const timers = popupTimers.get(item);
    clearTimeout(timers.open);
    clearTimeout(timers.close);
    timers.close = setTimeout(() => closePopupNow(item), 200);
  }

  function closePopupNow(item) {
    const timers = popupTimers.get(item);
    clearTimeout(timers.open);
    clearTimeout(timers.close);
    item.querySelector('.ag-pop').classList.remove('open');
    if (activePopupItem === item) activePopupItem = null;
  }

  function buildHud() {
    ensureStyle();
    const bar = document.createElement('div');
    bar.id = HUD_ID;
    bar.innerHTML = `<div class="ag-item" data-item="context"><span class="ag-hot" data-refresh tabindex="0">${gaugeSvg('context', null)}</span><div class="ag-pop">
      <div class="ag-bento">
      <div class="ag-tile ag-wide"><div class="ag-head"><span>上下文</span><span data-bind="ctx-used">等待数据</span></div><div class="ag-big" data-bind="ctx-pct">-</div><div class="ag-bar"><i data-bind="ctx-bar"></i></div></div>
      <div class="ag-tile"><div class="ag-label">预计还能</div><div class="ag-mid" data-bind="rounds">数据不足</div></div>
      <div class="ag-tile"><div class="ag-label">已压缩</div><div class="ag-mid" data-bind="compressions">0 次</div></div>
      <div class="ag-tile ag-wide"><div class="ag-head"><span>速度</span><span data-bind="status">空闲</span></div><div class="ag-speed"><div><div class="ag-big"><span data-bind="live-speed">-</span><small>tok/s</small></div><span class="ag-level"><i data-bind="speed-dot"></i><b data-bind="speed-level">暂无数据</b></span></div><div class="ag-spark" data-bind="speed-spark"><i></i><i></i><i></i><i></i><i></i></div></div><div class="ag-note" data-bind="recent-speeds">-</div></div>
      <div class="ag-tile ag-wide"><div class="ag-actions"><button class="ag-btn" data-act="compact">⚡ 压缩上下文</button><button class="ag-btn" data-act="compact-cancel" hidden>取消</button></div>
      <div class="ag-row ag-compact-status" data-bind="compact-status" hidden><span></span><span></span></div><div class="ag-row ag-compact-choice" data-bind="compact-choice" hidden><span></span><span><button class="ag-btn" data-act="compact-continue">仍然压缩</button><button class="ag-btn" data-act="compact-stop">取消</button></span></div>
      <label class="ag-auto-compact"><input type="checkbox" data-act="auto-compact"> 上下文 ≥75% 时自动智能压缩</label></div>
      </div>
      <details class="ag-more"><summary>更多</summary><div class="ag-bento">
      <div class="ag-tile ag-wide"><div class="ag-label">上下文构成</div><div data-bind="groups" class="ag-muted">暂无构成数据</div></div>
      <div class="ag-tile"><div class="ag-label">输出 token</div><div class="ag-mid" data-bind="out">-</div></div><div class="ag-tile"><div class="ag-label">思考 token</div><div class="ag-mid" data-bind="thinking">-</div></div>
      <div class="ag-tile"><div class="ag-label">生成耗时</div><div class="ag-mid" data-bind="duration">-</div></div><div class="ag-tile"><div class="ag-label">首字等待</div><div class="ag-mid" data-bind="ttft">-</div></div>
      <div class="ag-tile"><div class="ag-label">本对话平均</div><div class="ag-mid" data-bind="average">-</div></div><div class="ag-tile"><div class="ag-label">模型调用</div><div class="ag-mid" data-bind="calls">0 次</div></div>
      <div class="ag-tile ag-wide"><div class="ag-head"><span>模型</span><span data-bind="model">-</span></div></div>
      </div></details>
      <div class="ag-toast" data-bind="toast" hidden></div><div class="ag-error" data-bind="error" hidden></div>
      </div></div><div class="ag-item" data-item="quota"><span class="ag-hot" data-refresh tabindex="0">${gaugeSvg('quota', null)}</span><div class="ag-pop">
      <h4>${QUOTA_PREFIX} 额度</h4><div class="ag-bento">
      <div class="ag-tile"><div class="ag-label">5 小时</div><div class="ag-big" data-bind="quota-left">-</div><div class="ag-bar"><i data-bind="quota-bar"></i></div><div class="ag-note" data-bind="quota-reset">-</div><div class="ag-note" data-bind="quota-reset-left"></div></div>
      <div class="ag-tile"><div class="ag-label">每周</div><div class="ag-big" data-bind="quota-week-left">-</div><div class="ag-bar"><i data-bind="quota-week-bar"></i></div><div class="ag-note" data-bind="quota-week-reset">-</div><div class="ag-note" data-bind="quota-week-reset-left"></div></div>
      <div class="ag-tile ag-wide"><div class="ag-head"><span>消耗速度</span><span>竖线 = 刚好用到重置</span></div>
      <div class="ag-rate"><span>5 小时</span><span data-bind="quota-rate">-</span><span class="ag-level"><i data-bind="quota-dot"></i><b data-bind="quota-level">观察中</b></span></div><div class="ag-meter"><i data-bind="quota-meter"></i></div>
      <div class="ag-rate"><span>每周</span><span data-bind="quota-week-rate">-</span><span class="ag-level"><i data-bind="quota-week-dot"></i><b data-bind="quota-week-level">观察中</b></span></div><div class="ag-meter"><i data-bind="quota-week-meter"></i></div>
      <div class="ag-note" data-bind="quota-eta" hidden></div></div></div>
      </div></div>`;
    bar.querySelectorAll('.ag-item').forEach(item => {
      popupTimers.set(item, { open: 0, close: 0 });
      popupItems.add(item);
      item.addEventListener('pointerenter', () => openPopup(item));
      item.addEventListener('pointerleave', () => closePopup(item));
      item.querySelector('.ag-pop').addEventListener('pointerenter', () => {
        const timers = popupTimers.get(item);
        clearTimeout(timers.close);
      });
      item.querySelector('.ag-pop').addEventListener('pointerleave', () => closePopup(item));
      const details = item.querySelector('details');
      if (details) details.addEventListener('toggle', () => {
        if (activePopupItem === item) positionPopup(item);
      });
    });
    bar.addEventListener('click', onClick);
    bar.addEventListener('change', onChange);
    return bar;
  }

  function setBar(root, key, fraction, color) {
    const el = root.querySelector(`[data-bind="${key}"]`);
    const width = `${(clamp01(fraction) * 100).toFixed(1)}%`;
    if (el.style.width !== width) el.style.width = width;
    setDot(root, key, color);
  }
  function setDot(root, key, color) {
    const el = root.querySelector(`[data-bind="${key}"]`);
    if (el.__color === color) return;
    el.__color = color;
    el.style.background = color;
  }
  function setText(root, key, value) {
    const el = root.querySelector(`[data-bind="${key}"]`);
    if (el.textContent !== String(value)) el.textContent = String(value);
  }

  let layoutCache = { dirty: true, mode: 'none', anchor: null, box: null, anchorLabel: '', anchorRect: null, boxRect: null, showQuota: false, showContext: false, left: 0, top: 0, width: 28 };
  let observedAnchor = null;
  let observedBox = null;
  let layoutObserver = null;
  let layoutRaf = 0;

  function scheduleLayoutRender() {
    layoutCache.dirty = true;
    if (destroyed || layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      if (!destroyed) render();
    });
  }

  function syncLayoutObservers(anchor, box) {
    if (!layoutObserver) layoutObserver = new ResizeObserver(scheduleLayoutRender);
    if (observedAnchor !== anchor) {
      if (observedAnchor) layoutObserver.unobserve(observedAnchor);
      observedAnchor = anchor;
      if (observedAnchor) layoutObserver.observe(observedAnchor);
      layoutCache.dirty = true;
    }
    if (observedBox !== box) {
      if (observedBox) layoutObserver.unobserve(observedBox);
      observedBox = box;
      if (observedBox) layoutObserver.observe(observedBox);
      layoutCache.dirty = true;
    }
    const label = anchor ? anchor.textContent : '';
    if (layoutCache.anchorLabel !== label) {
      layoutCache.anchorLabel = label;
      layoutCache.dirty = true;
    }
  }

  function measureLayout(anchor, box) {
    const cache = layoutCache;
    cache.dirty = false;
    cache.mode = 'none';
    cache.anchorRect = null;
    cache.boxRect = null;
    if (anchor && anchor.textContent.includes('Gemini')) {
      const anchorRect = anchor.getBoundingClientRect();
      const midY = anchorRect.top + anchorRect.height / 2;
      const bar = document.getElementById(HUD_ID);
      const rightButtons = [...(box || document).querySelectorAll('button')]
        .filter(el => !(bar && bar.contains(el))) // 首次渲染时 HUD 还没挂进页面，bar 为 null
        .map(el => el.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.left >= anchorRect.right && Math.abs(rect.top + rect.height / 2 - midY) < 12);
      const boxRight = box ? box.getBoundingClientRect().right - 8 : window.innerWidth - 8;
      const nextLeft = rightButtons.length ? Math.min(...rightButtons.map(rect => rect.left)) : boxRight;
      const room = Math.min(window.innerWidth - 8, nextLeft) - anchorRect.right - 6;
      const showQuota = room >= 62;
      cache.mode = 'anchor';
      cache.anchorRect = { right: anchorRect.right, top: anchorRect.top, height: anchorRect.height };
      cache.showQuota = showQuota;
      cache.showContext = room >= 28;
      cache.left = anchorRect.right + 6;
      cache.top = anchorRect.top + anchorRect.height / 2 - 14;
      cache.width = showQuota ? 62 : 28;
    } else if (box) {
      const rect = box.getBoundingClientRect();
      cache.mode = 'fallback';
      cache.boxRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      cache.left = Math.max(8, rect.left - 42);
      cache.top = rect.top + rect.height / 2 - 32;
      cache.width = 28;
    }
  }

  // 熔断：一秒内渲染超过 30 次说明出现了循环，立刻卸载 HUD，保证不会卡住应用
  let renderBurst = { start: 0, count: 0 };
  let remountBurst = { start: 0, count: 0 };
  let destroyed = false;
  let destroyHud = () => {};
  function render(kind = 'normal') {
    if (destroyed) return;
    const burstNow = performance.now();
    const burst = kind === 'remount' ? remountBurst : renderBurst;
    if (burstNow - burst.start > 1000) {
      if (kind === 'remount') remountBurst = { start: burstNow, count: 0 };
      else renderBurst = { start: burstNow, count: 0 };
    }
    const activeBurst = kind === 'remount' ? remountBurst : renderBurst;
    if (++activeBurst.count > (kind === 'remount' ? 20 : 30)) {
      if (kind === 'remount') return;
      console.warn('[Antigravity HUD] 渲染过于频繁，已自动关闭以保护界面');
      destroyHud('熔断');
      return;
    }
    let bar = document.getElementById(HUD_ID);
    if (!bar) bar = buildHud();
    const anchor = document.querySelector('[data-testid="model-selector-trigger"]');
    const box = document.querySelector('[data-testid="agent-input-box"]');
    syncLayoutObservers(anchor, box);
    if (layoutCache.dirty) measureLayout(anchor, box);
    if (layoutCache.mode === 'anchor') {
      if (bar.parentElement !== anchor.parentElement || bar.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', bar);
      bar.classList.remove('ag-fallback', 'ag-hidden');
      bar.querySelector('[data-item="quota"]').hidden = !layoutCache.showQuota;
      bar.style.width = `${layoutCache.width}px`;
      bar.style.left = `${layoutCache.left}px`;
      bar.style.top = `${layoutCache.top}px`;
      bar.classList.toggle('ag-hidden', !layoutCache.showContext);
    } else if (layoutCache.mode === 'fallback') {
      if (bar.parentElement !== box) box.appendChild(bar);
      bar.classList.add('ag-fallback');
      bar.classList.remove('ag-hidden');
      bar.style.left = `${layoutCache.left}px`;
      bar.style.top = `${layoutCache.top}px`;
      bar.querySelector('[data-item="quota"]').hidden = false;
    } else {
      bar.remove();
      return;
    }

    const now = Date.now();
    const m = state.metaView;
    const live = state.live || { status: 'idle', tps: 0, since: 0, label: '' };
    const q = state.quota;
    const ctx = m && m.ctx && m.ctx.max ? m.ctx : null;
    const ctxF = ctx ? clamp01(ctx.used / ctx.max) : 0;
    const active = live.status !== 'idle';
    const tps = live.status === 'generating' && live.tps ? live.tps : (m && m.last ? m.last.tps : 0);
    const speedF = clamp01(tps / 300);
    const contextItem = bar.querySelector('[data-item="context"]');
    const contextSvg = contextItem.querySelector('.ag-gauge');
    const contextArc = contextSvg.querySelector('.ag-arc');
    contextArc.setAttribute('stroke-dasharray', arcDash(ctxF));
    contextArc.setAttribute('stroke', contextArcColor(ctxF));
    contextArc.classList.toggle('ag-pulse', ctxF >= 0.85 && !active);
    contextSvg.querySelectorAll('.ag-dots circle').forEach((dot, i) => dot.setAttribute('fill', m && (m.compressions || 0) > i ? YELLOW : GRAY));
    const bolt = contextSvg.querySelector('.ag-bolt-icon');
    const boltFill = contextSvg.querySelector('.ag-bolt-fill');
    bolt.classList.toggle('ag-waiting', live.status === 'waiting');
    bolt.classList.toggle('ag-outline-pulse', active && live.status !== 'generating' && live.status !== 'waiting');
    bolt.classList.toggle('ag-pulse', live.status === 'generating');
    bolt.style.color = YELLOW;
    boltFill.setAttribute('y', (50 - 36 * speedF).toFixed(2));
    boltFill.setAttribute('height', (36 * speedF).toFixed(2));
    boltFill.setAttribute('fill', YELLOW);

    const popCtx = ctx || { used: 0, max: 0 };
    setText(bar, 'ctx-used', ctx ? `${fmtK(ctx.used)} / ${fmtK(ctx.max)}` : '等待数据');
    setText(bar, 'ctx-pct', ctx ? pct(ctxF) : '-');
    setBar(bar, 'ctx-bar', ctxF, contextArcColor(ctxF));
    setText(bar, 'compressions', `${m ? (m.compressions || 0) : 0} 次`);
    setText(bar, 'rounds', ctx ? estimateRounds(m) : '数据不足');
    const groups = bar.querySelector('[data-bind="groups"]');
    const groupKey = 'stack-v1';
    if (groups.__key !== groupKey) {
      groups.__key = groupKey;
      groups.innerHTML = contextGroups();
    }
    const breakdown = contextBreakdown(popCtx);
    const groupTotal = Object.values(breakdown).reduce((sum, value) => sum + value, 0) || 1;
    groups.querySelectorAll('[data-stack]').forEach(segment => {
      segment.style.width = `${(breakdown[segment.dataset.stack] / groupTotal * 100).toFixed(1)}%`;
    });
    setText(bar, 'status', live.status === 'idle' ? '空闲' : `${live.label}（${fmtSec((now - live.since) / 1000)}）`);
    const speedRating = speedLevel(tps);
    const recentSpeeds = (m && m.recentSpeeds) || [];
    setText(bar, 'live-speed', tps ? tps.toFixed(0) : '-');
    setText(bar, 'speed-level', speedRating ? speedRating.text : '暂无数据');
    setDot(bar, 'speed-dot', speedRating ? speedRating.color : GRAY);
    setText(bar, 'recent-speeds', recentSpeeds.length ? `最近 ${recentSpeeds.length} 次平均 ${(recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length).toFixed(0)} tok/s` : '暂无最近记录');
    bar.querySelector('[data-bind="speed-spark"]').querySelectorAll('i').forEach((column, i) => {
      const value = recentSpeeds[recentSpeeds.length - 5 + i];
      const rating = speedLevel(value);
      const height = `${Math.max(12, Math.round(clamp01(value / 250) * 100))}%`;
      if (column.style.height !== height) column.style.height = height;
      const color = rating ? rating.color : '';
      if (column.__color !== color) {
        column.__color = color;
        column.style.background = color;
      }
    });
    setText(bar, 'out', m && m.last ? fmtK(m.last.out) : '-');
    setText(bar, 'thinking', m && m.last ? fmtK(m.last.thinking) : '-');
    setText(bar, 'duration', m && m.last ? `${m.last.dur.toFixed(1)}s` : '-');
    setText(bar, 'ttft', m && m.last ? `${m.last.ttft.toFixed(1)}s` : '-');
    setText(bar, 'model', m && m.last ? m.last.model || '-' : '-');
    setText(bar, 'average', m && m.acc && m.acc.stream ? `${(m.acc.out / m.acc.stream).toFixed(0)} tok/s` : '-');
    setText(bar, 'calls', `${m && m.acc ? m.acc.calls : 0} 次`);

    const quotaItem = bar.querySelector('[data-item="quota"]');
    const quotaSvg = quotaItem.querySelector('.ag-gauge');
    const reset = q ? Date.parse(q.reset) : 0;
    const validReset = Number.isFinite(reset);
    const left = q && validReset ? Math.max(0, reset - now) : 0;
    const quotaArc = quotaSvg.querySelector('.ag-arc');
    quotaArc.setAttribute('stroke-dasharray', arcDash(q ? q.remaining : 0));
    quotaArc.setAttribute('stroke', quotaArcColor(q));
    const hours = left / 3.6e6;
    quotaSvg.querySelectorAll('.ag-dots circle').forEach((dot, i) => {
      const color = hours >= i + 1 ? GREEN : hours >= i + 0.5 ? YELLOW : GRAY;
      dot.setAttribute('fill', q && validReset ? color : GRAY);
    });
    const quotaIcon = quotaSvg.querySelector('.ag-quota-icon');
    const level = quotaLevel(q);
    quotaIcon.setAttribute('fill', level ? level.color : GRAY);
    // 重置常在一两天后，只写钟点会看错日子，所以不是今天就加上日期
    const dayClock = t => (new Date(t).toDateString() === new Date(now).toDateString() ? '' : `${new Date(t).getMonth() + 1}/${new Date(t).getDate()} `) + clock(t);
    const week = q && q.weekly;
    const etaNotes = [];
    [['quota', '5 小时', q], ['quota-week', '每周', week]].forEach(([key, name, w]) => {
      const resetAt = w ? Date.parse(w.reset) : NaN;
      const hasReset = Number.isFinite(resetAt);
      const windowLevel = quotaWindowLevel(w);
      setText(bar, `${key}-left`, w ? pct(w.remaining) : '-');
      setBar(bar, `${key}-bar`, w ? w.remaining : 0, quotaArcColor(w));
      setText(bar, `${key}-reset`, hasReset ? `${dayClock(resetAt)} 重置` : '-');
      setText(bar, `${key}-reset-left`, hasReset ? `${fmtLeft(Math.max(0, resetAt - now))}后` : '');
      setText(bar, `${key}-rate`, windowLevel ? `${(windowLevel.rate * 3.6e6 * 100).toFixed(1)}%/时` : '-');
      setText(bar, `${key}-level`, windowLevel ? windowLevel.text : '观察中');
      setDot(bar, `${key}-dot`, windowLevel ? windowLevel.color : GRAY);
      // 满格是可持续速度的 1.5 倍，竖线在 2/3 处：越过竖线就撑不到重置
      setBar(bar, `${key}-meter`, windowLevel ? windowLevel.ratio / 1.5 : 0, windowLevel && windowLevel.color !== GRAY ? windowLevel.color : SOFT_GRAY);
      if (windowLevel && windowLevel.eta && windowLevel.eta < windowLevel.reset) etaNotes.push(`${name}预计 ${dayClock(windowLevel.eta)} 用完`);
    });
    const etaNote = bar.querySelector('[data-bind="quota-eta"]');
    setText(bar, 'quota-eta', etaNotes.join(' · '));
    etaNote.hidden = !etaNotes.length;

    const compactButton = bar.querySelector('[data-act="compact"]');
    compactButton.classList.toggle('danger', ctxF >= COMPACT_AT && live.status === 'idle');
    renderCompactControls(bar);
    const toast = bar.querySelector('[data-bind="toast"]');
    toast.textContent = state.toast && now < state.toast.until ? state.toast.text : '';
    toast.hidden = !toast.textContent;
    const error = bar.querySelector('[data-bind="error"]');
    error.textContent = state.error ? `⚠ ${state.error}` : '';
    error.hidden = !error.textContent;
  }

  // ---------- 调度 ----------

  function syncConversation() {
    const id = currentCascadeId();
    if (id === state.cascadeId) return;
    if (activeCompact) cancelActiveCompact('已切换对话');
    state.cascadeId = id;
    state.meta = null;
    state.metaView = null;
    state.live = null;
    state.at.meta = 0;
    state.at.live = 0;
    samples = { key: null, list: [] };
    idleStepKey = null;
    idleStepSince = 0;
    cascadeConfigCache = null;
  }

  function maybeAutoCompact() {
    if (!state.compact.autoLoaded) {
      state.compact.auto = loadAutoCompact();
      state.compact.autoLoaded = true;
    }
    const m = state.metaView;
    const ctxF = m && m.ctx && m.ctx.max ? clamp01(m.ctx.used / m.ctx.max) : 0;
    const id = state.cascadeId;
    const live = state.live;
    const now = Date.now();
    const persisted = id && getCompactRun(id);
    const pendingResume = persisted && persisted.startedAt && now - persisted.startedAt <= COMPACT_RESUME_MS &&
      ['m1-sent', 'm2-sending', 'm2-sent'].includes(persisted.stage);
    if (pendingResume && !state.compact.running && !resumeAttempted.has(id)) {
      smartCompact({ cascadeId: id }).finally(() => resumeAttempted.add(id));
      return;
    }
    let guard = id && state.compact.autoGuard.get(id);
    if (guard && guard.checkpoint && ctxF < 0.5) {
      state.compact.autoGuard.delete(id);
      guard = null;
    }
    // 任何一次压缩结束后 10 分钟内不再自动触发，防止上下文数据还没更新就二次触发
    const cooling = id && now - Math.max(state.compact.lastAutoAt.get(id) || 0, persisted && persisted.lastAutoAt || 0) < 600000;
    const blocked = cooling || (guard && ((guard.failed && now - guard.at < 600000) || (guard.checkpoint && ctxF >= 0.5)));
    const idle = live && live.status === 'idle' && live.idleSince && now - live.idleSince >= debug.idleMs;
    if (state.compact.auto && !state.compact.running && id && ctxF >= debug.autoThreshold && !blocked &&
      idle && now - lastInputAt >= 30000) {
      smartCompact(true);
    }
  }

  async function tick() {
    if (document.hidden) {
      if (!document.getElementById(HUD_ID)) render();
      return;
    }
    syncConversation();
    const input = document.querySelector('[data-testid="agent-input-box"] [contenteditable="true"]');
    trackInputActivity(input);
    await refreshMeta(false);
    await Promise.all([refreshLive(false), refreshQuota(false)]);
    render();
    maybeAutoCompact();
  }

  async function backgroundTick() {
    if (!document.hidden || destroyed) return;
    syncConversation();
    trackInputActivity(document.querySelector('[data-testid="agent-input-box"] [contenteditable="true"]'));
    await refreshMeta(false);
    await refreshLive(false);
    maybeAutoCompact();
  }

  async function refresh() {
    syncConversation();
    await refreshMeta(true);
    await Promise.all([refreshLive(true), refreshQuota(true)]);
    render();
  }

  function positionOpenPopups() {
    popupItems.forEach(item => {
      const pop = item.querySelector('.ag-pop');
      if (pop && pop.classList.contains('open')) positionPopup(item);
    });
  }

  function onWindowResize() {
    layoutCache.dirty = true;
    render();
    positionOpenPopups();
  }

  const timer = setInterval(tick, 500);
  const backgroundTimer = setInterval(backgroundTick, BACKGROUND_CHECK_INTERVAL);
  // 只在 HUD 被应用重渲染挤掉（或还没挂上）时补挂一次；HUD 自身的更新和应用的其他 DOM 变化都不触发渲染，
  // 否则 render() 修改 DOM → 触发监听 → 再 render()，会形成死循环把页面卡死
  let remountQueued = false;
  let remountRaf = 0;
  const observer = new MutationObserver(() => {
    if (remountQueued || document.getElementById(HUD_ID)) return;
    remountQueued = true;
    remountRaf = requestAnimationFrame(() => {
      remountRaf = 0;
      remountQueued = false;
      render('remount');
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onShortcut, true);
  tick();

  const api = {
    state,
    debug,
    refresh,
    smartCompact,
    log: readEvents,
    destroy(reason = '手动 destroy') {
      if (destroyed) return;
      appendEvent('destroy', { reason, cascadeId: state.cascadeId, stage: activeCompact && activeCompact.stage || state.compact.step });
      destroyed = true;
      cancelled = true;
      cancelActiveCompact(reason);
      clearInterval(timer);
      clearInterval(backgroundTimer);
      if (remountRaf) cancelAnimationFrame(remountRaf);
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      observer.disconnect();
      if (layoutObserver) layoutObserver.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('keydown', onShortcut, true);
      trackInputActivity(null);
      compactWaiters.forEach(cancel => cancel());
      popupItems.forEach(item => {
        const timers = popupTimers.get(item);
        if (timers) {
          clearTimeout(timers.open);
          clearTimeout(timers.close);
        }
      });
      pendingControllers.forEach(controller => controller.abort());
      const bar = document.getElementById(HUD_ID);
      if (bar) bar.remove();
      const st = document.getElementById(HUD_ID + '-style');
      if (st) st.remove();
      popupItems.clear();
      activePopupItem = null;
      delete window.__agHud;
    },
  };
  destroyHud = api.destroy;
  window.__agHud = api;
  window.addEventListener('beforeunload', () => appendEvent('destroy', { reason: '页面卸载', cascadeId: state.cascadeId, stage: activeCompact && activeCompact.stage || state.compact.step }), { once: true });
})();
