// CDP 连接工具：找到 Antigravity 主界面页面并在其中执行 JS
import fs from 'node:fs';
import os from 'node:os';
const PORT_FILE = `${os.homedir()}/Library/Application Support/Antigravity/DevToolsActivePort`;

export async function connect() {
  const port = fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.startsWith('https://127.0.0.1'));
  if (!page) throw new Error('没有找到 Antigravity 主界面页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach(fn => fn(m));
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, on: fn => listeners.push(fn), close: () => ws.close() };
}
