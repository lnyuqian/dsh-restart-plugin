# 安装失败 / 异常修复指引（Troubleshooting）

本文档沉淀本插件在真实环境（Windows + 中文路径 + 多插件共存）中踩过的坑。
遇到按钮不出现、点击无反应、无倒计时反馈、不自动刷新等问题时，按下面的
「5 步自检」和「症状对照表」逐项排查。

## 🔍 五步快速自检

在浏览器能打开 `http://127.0.0.1:3080` 的前提下，按顺序检查：

```powershell
# 1. host 路由是否挂载（没有这个路由 = 插件 host 未加载）
Invoke-RestMethod http://127.0.0.1:3080/_dsh/dsh-restart/state
# 期望：{"ok":true,"live":{...},"statusTail":"..."}

# 2. 页面 client 清单是否包含本插件
(Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing).Content -match 'dsh-restart-plugin'
# 期望：True（False = client 未挂载，按钮必然不出现）

# 3. 计划任务是否就绪
schtasks /Query /TN "dsh-web-restart-20s" /FO LIST | Select-String "Status"
# 期望：Status: Ready

# 4. ps1 必须是 UTF-8 带 BOM（239 187 191），否则中文路径在 PS 5.1 下乱码
$b = [System.IO.File]::ReadAllBytes('E:\pi-windows\restart-dsh-web.ps1')
$b[0..2] -join ','
# 期望：239,187,191

# 5. 触发一次重启后验证「真实重启」：
#    a) status 日志最后一行是 "self-check verdict: SUCCESS"
#    b) live 文件的 "at" 时间戳更新到当前时刻（不更新 = 问题 C）
#    c) 3080 监听进程 PID/StartTime 变化（真的换了新进程）
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object OwningProcess
Get-Process -Id <上面的PID> | Select-Object Id, StartTime
```

## 🩺 症状对照表

### A. 侧边栏完全没有重启按钮（展开/收起都没有）

**根因 1：插件目录迁移后 `link:` 悬空，且 bundle 列表丢失插件。**

迁移插件目录（例如 `D:\dsh-web\轻量事务\dsh-restart-plugin` → `D:\dsh-web\做项目\dsh-restart-plugin`）
后，`~/.dsh/profiles/web` 里的三处引用若不同步，插件整体不会加载：

- `package.json` 的 `dependencies["dsh-restart-plugin"]` 仍指向旧路径（已不存在）；
- `node_modules/dsh-restart-plugin` 是悬空 junction；
- `package.json` 的 `dsh.profile.bundles` 列表里丢了 `dsh-restart-plugin`。

**修复**：重新注册（会同步更新依赖、bundles、junction、lock）：

```powershell
dsh plugin --profile web add link:D:/dsh-web/做项目/dsh-restart-plugin
```

验证三处都正确：

```powershell
# bundles 含 dsh-restart-plugin
(Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles -join "`n"
# junction Target 指向存在的目录
(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-restart-plugin" -Force).Target
```

最后重启 dsh web 并在浏览器 **Ctrl+Shift+R 硬刷新**。

**根因 2：浏览器缓存了旧的 client bundle。**
重启 web 后 `rev` 会更新，但旧标签页可能仍用缓存；硬刷新即可。

### B. 展开态按钮不可见 / 位置不对（收起态图标正常）

**根因：client 依赖原生左侧边栏的 CSS Module 类名 `.hHd-Xa_root`。**
该类名由 `@deepseek-ai/dsh-client-ui-layout`（原生侧边栏）编译生成；**不是**
dsh-better-sidebar（右侧面板，`data-dsh-better-sidebar`）。若 DSH 核心升级导致
类名 hash 变化，`findRoot()` 找不到侧边栏根，按钮定位退化甚至不出现。

**修复要点（已内置在 client v14+）**：

- `findSettingsBtn()` 三级兜底：按钮文本精确「设置」→ 文本包含「设置」→ 侧边栏
  底部四分之一区域内最宽的按钮；
- 展开态按钮定位锚点兜底：设置按钮找不到时退回侧边栏根底部；
- 展开态按钮与「设置」同一行（垂直居中、右缘对齐），黑色文字、无阴影；
- z-index 用 `2147483000`，避免被其它面板层盖住。

若仍不对齐/不可见，用无头浏览器 CDP 实测按钮真实 `getBoundingClientRect` 与
`elementFromPoint` 命中目标（见文末「CDP 实测技巧」）。

### C. 点击后页面不变灰 / 松开鼠标就恢复 / 重启成功但不自动刷新、无提示

**根因：`restart-dsh-web.ps1` 是 UTF-8 无 BOM + 中文路径 → PowerShell 5.1 按
系统 ANSI(GBK) 误读 → live 文件写入失败。**

脚本里的 `$live = 'D:\dsh-web\做项目\.dsh-restart-live.json'` 等中文路径，在
无 BOM 的 UTF-8 文件里被 Windows PowerShell 5.1 按 GBK 解析成乱码，
`[System.IO.File]::WriteAllText` 抛 `Illegal characters in path`，`Write-Live`
静默失败 → live 标记永远是旧值。

**典型症状组合（三者同时出现即可确诊）**：

1. status 日志正常更新（`countdown started` / `done` 都在），但 live 文件的
   `at` 时间戳一动不动；
2. 点击按钮后变灰瞬间被恢复（client 每秒轮询 state 路由，读到历史
   `done` 就撤销变灰）；
3. 重启实际发生了，但页面不自动刷新、没有「重启成功」toast（
   `sawRestartFlow` 从未置位）。

**修复**：把 ps1 重新保存为 **UTF-8 带 BOM**：

```powershell
$p = 'E:\pi-windows\restart-dsh-web.ps1'
$content = [System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($p, $content, (New-Object System.Text.UTF8Encoding($true)))
```

> 这也是 README「安装」章节要求 ps1 用 UTF-8 BOM 的原因——不要图省事用
> 默认编码保存。`.vbs` / `.bat` 则用 GBK（系统 ANSI），正好相反。

**双保险（client v15/v16 已内置）**：点击按钮后**立即**乐观变灰 + 文案
「重启中…」，并设 20 秒乐观窗口——窗口内忽略历史 `done`，即使 live 文件
再次出问题，点击也有可见反馈、不会被立刻撤销。

### D. 点击按钮完全无反应（host 也没重启）

**先验证 host 链路是否正常**（绕过浏览器直接测）：

```powershell
# 注意：必须带 Origin 与 sec-fetch-site 头模拟同源浏览器；
# 不带 Origin 的 POST 会被安全校验拒绝（403），这是设计行为。
$r = Invoke-WebRequest -Uri "http://127.0.0.1:3080/_dsh/dsh-restart/trigger" `
  -Method POST -Headers @{ Origin = "http://127.0.0.1:3080"; "sec-fetch-site" = "same-origin" } `
  -UseBasicParsing
$r.Content
# 期望：{"ok":true,"code":0,"task":"dsh-web-restart-20s","seconds":10}
```

- 返回 `{"ok":false,...}` → 计划任务不存在或 schtasks 失败，回到第 2 步；
- 返回 403 → 检查访问方式（loopback + 同源）；
- 返回 200 且 `ok:true` 但没重启 → 检查计划任务 → vbs → ps1 链：
  `schtasks /Query /TN "dsh-web-restart-20s" /XML` 的 Action 是
  `wscript.exe` + vbs 路径；vbs 内 `-File` 指向的 ps1 存在；ps1 的
  `$live` / `$status` 与 `lib/index.js` 的 `LIVE` / `STATUS` 常量一致。

### E. 其它经验

- **lib/index.js 常量必须与脚本链一致**：`TASK` = 计划任务名、
  `LIVE` = ps1 的 `$live`、`STATUS` = ps1 的 `$status`、`SECONDS` 文案与
  vbs 的 `-Seconds` 一致。任何一处不一致都会表现为「触发成功但反馈错乱」。
- **点按钮后 10 秒倒计时**：倒计时秒数由 vbs 的 `-Seconds 10` 决定（
  计划任务 `dsh-web-restart-20s` 的历史名字里有 20，但实际倒计时是 10 秒，
  改秒数请同步 vbs 与 `lib/index.js` 的 `SECONDS` 文案）。
- **修改 client.js 后无需重启 web 即可生效**（`/plugins/dsh-restart-plugin/client.js`
  由服务动态读取），但浏览器可能缓存旧 `rev`——硬刷新或重启 web 更新 rev。

## 🧪 CDP 实测技巧（无头浏览器验证按钮/点击）

按钮的 DOM 存在 ≠ 用户可点。用 Chrome 远程调试 + Node 内置 WebSocket 实测：

```powershell
# 1. 启动无头 Chrome 打开页面
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
  "--headless=new","--remote-debugging-port=9222","--user-data-dir=$env:TEMP\cdp-probe",`
  "http://127.0.0.1:3080/"
```

```js
// 2. Node 脚本：连 http://127.0.0.1:9222/json 拿 webSocketDebuggerUrl，
//    用 WebSocket 发 Runtime.evaluate / Input.dispatchMouseEvent /
//    Page.captureScreenshot，验证：
//    - document.querySelector('[data-dsh-restart-btn]') 的 getBoundingClientRect
//    - elementFromPoint(按钮中心) 是否命中按钮自身（未被遮挡）
//    - Input.dispatchMouseEvent 真实点击后，按钮文案是否变「重启中…」、
//      body 是否出现 dsh-restart-pending 类
```

## 📦 版本对照

| client 版本 | 关键变化 |
|---|---|
| v11 及之前 | 依赖 `.hHd-Xa_root` + 精确「设置」文本，按钮叠在设置按钮上 |
| v12–v13 | 强化查找兜底；按钮移到设置按钮上方（后被否掉，改回同一行） |
| v14 | 与设置按钮同一行、黑色文字、无阴影、灰色边框 |
| v15 | 点击立即乐观变灰（不等网络响应）、z-index 提到最大 |
| v16 | 20 秒乐观窗口，防御 live 文件陈旧导致的历史 done 撤销变灰（**当前基线**） |
