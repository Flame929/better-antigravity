// 安全注入测试：记录基线布局 → 注入 HUD → 30 秒内每秒检测页面响应 → 对比布局；任何异常立刻卸载
// 用法：node safe-inject.mjs [秒数]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect } from './cdplib.mjs';

const SECONDS = Number(process.argv[2] || 30);
const HUD = new URL('../hud.js', import.meta.url);

// 每次都重新连接：应用重启或更新后调试端口和页面都会变
async function withPage(fn, timeoutMs = 3000) {
  let c;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`页面 ${timeoutMs}ms 内无响应`)), timeoutMs));
  try {
    return await Promise.race([(async () => { c = await connect(); return fn(c); })(), timeout]);
  } finally {
    if (c) c.close();
  }
}

const LAYOUT = `JSON.stringify((()=>{const box=document.querySelector('[data-testid="agent-input-box"]');if(!box)return {box:null};
const r=e=>{const b=e.getBoundingClientRect();return [b.x,b.y,b.width,b.height].map(v=>Math.round(v*10)/10).join(",")};
const out={box:r(box),page:document.documentElement.scrollWidth+"x"+document.documentElement.scrollHeight};
[...box.querySelectorAll("button,[contenteditable=true]")].filter(e=>!e.closest("#ag-hud-bar")).forEach((e,i)=>out[i+":"+(e.innerText||e.getAttribute("aria-label")||"").trim().slice(0,20)]=r(e));return out})())`;

const rendererCpu = () => {
  try {
    const out = execFileSync('ps', ['-axo', '%cpu=,command=']).toString().split('\n')
      .filter(l => l.includes('Antigravity Helper (Renderer)')).map(l => parseFloat(l));
    return Math.max(0, ...out);
  } catch { return -1; }
};

async function remove(reason) {
  console.log('❌', reason, '→ 尝试卸载 HUD');
  try {
    await withPage(c => c.evaluate('window.__agHud && window.__agHud.destroy(), "ok"'), 4000);
    console.log('已卸载');
  } catch (e) {
    console.log('卸载失败：', e.message);
  }
  process.exit(1);
}

const before = JSON.parse(await withPage(c => c.evaluate(LAYOUT)));
if (!before.box) { console.log('当前页面没有输入框，无法测试'); process.exit(2); }
console.log('注入前 CPU', rendererCpu() + '%', '布局已记录');

await withPage(c => c.evaluate(fs.readFileSync(HUD, 'utf8')));
console.log('已注入，开始监测', SECONDS, '秒');

let maxCpu = 0;
let slowest = 0;
for (let i = 1; i <= SECONDS; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const t0 = Date.now();
  let st;
  try {
    st = JSON.parse(await withPage(c => c.evaluate('JSON.stringify({hud:!!window.__agHud,bar:!!document.getElementById("ag-hud-bar"),err:window.__agHud&&window.__agHud.state.error})')));
  } catch (e) {
    await remove(`第 ${i} 秒：${e.message}`);
  }
  const ms = Date.now() - t0;
  const cpu = rendererCpu();
  slowest = Math.max(slowest, ms);
  maxCpu = Math.max(maxCpu, cpu);
  if (!st.hud) await remove(`第 ${i} 秒：HUD 已不在（可能触发了熔断）`);
  if (i >= 3 && !st.bar) await remove(`第 ${i} 秒：HUD 在运行但仪表没有挂到页面上`);
  if (i % 5 === 0 || cpu > 80) console.log(`第 ${i} 秒：响应 ${ms}ms，渲染进程 CPU ${cpu}%`, st.err ? `错误: ${st.err}` : '');
}

const after = JSON.parse(await withPage(c => c.evaluate(LAYOUT)));
const changed = Object.keys(before).filter(k => before[k] !== after[k]);
console.log('最慢响应', slowest + 'ms', '，渲染进程最高 CPU', maxCpu + '%');
if (changed.length) {
  changed.forEach(k => console.log('  布局变化', k, before[k], '->', after[k]));
  await remove('注入改变了原有布局');
}
console.log('✅ 通过：页面一直有响应，原有元素位置尺寸完全不变');
