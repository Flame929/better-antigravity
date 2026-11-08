# HUD 模拟页

`node tools/mock/server.mjs` 起本地模拟服务（https://127.0.0.1:4777，自签名证书首次运行自动生成），用 `?scenario=normal|danger|generating` 和 `?theme=dark` 切换场景与主题。
另开终端跑 `node tools/mock/shoot.mjs`，用本机 Chrome 无头模式依次截取各场景 × 浅/深色的上下文与额度面板，保存到 `docs/screenshots/<场景>-<主题>-<面板>.png`（2 倍缩放）。截图脚本需要本机安装 Google Chrome。
hud.js 只在 https://127.0.0.1 源下运行，所以模拟页必须走 HTTPS；截图脚本已带忽略证书错误的启动参数。
