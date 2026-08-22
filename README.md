# DSH Restart Plugin

一键重启 DeepSeek Harness Web（`127.0.0.1:3080`）：侧边栏一个按钮，10 秒倒计时，自动完成「杀旧进程 → 拉起新实例 → 自检 → 原页面刷新」。从"打开终端、记步骤、赌运气"变成"点一下、等 10 秒、看结果"。

- **全程无弹窗** — wscript 静默启动，桌面不出现任何 PowerShell 命令行窗口
- **无终端操作** — 无需开终端 / 任务管理器找 PID / 手敲命令
- **不开新标签页** — 重启拉起不触发浏览器新页，由原标签页自动刷新收尾

## 痛点：没有这个按钮时，重启一次有多麻烦

DSH Web 是常驻宿主进程，改插件、改配置、装新 bundle 后都必须重启才生效——而"重启得好"常常也是一切疑难杂症的答案。但每一次重启，都要走一串手工步骤：

1. 打开终端或任务管理器，从 3080 端口反查宿主 PID；
2. 手动 `Stop-Process` 杀掉它（PID 每次不同，杀错有风险）；
3. 找到启动脚本、重新拉起服务；
4. 干等几秒，轮询端口确认监听成功；
5. 验证插件路由真的加载了（如 `/modlens/paste`），才算重启"成功"；
6. 浏览器里手动刷新页面，甚至被迫接受一个新开的标签页。

全程 5~8 步、牵扯多个窗口，过程中**零反馈**——不知道进行到哪一步、也不知道失败没有。步骤越多越容易出错，而每次出错都要从头再来。

## 解决方案：一键完成全部

这个插件把整条链路收敛成一个侧边栏按钮：

![侧边栏底部「设置」与「重启」按钮（展开态）](docs/sidebar-restart-button.png)

- **双态按钮**：展开态在「设置」右侧显示 [↻ 重启]；收起态在设置齿轮正上方显示圆形 ↻ 图标，随侧边栏实时同步、动画跟手；
- **点击即走**：触发 10 秒倒计时，页面文字整体变浅灰作为进行中反馈（按钮自身保持醒目原色）；
- **全自动执行**：计划任务静默杀旧进程 → 拉起新实例 → 自检（3080 监听 + `GET /modlens/paste` + `GET /`）；
- **原页面收尾**：自检成功后原标签页自动刷新，右上角弹出绿色「✅ 重启成功」提示；失败则按钮变红，可一键重试；
- **模型也能触发**：对话里说「重启」即可（`dsh_restart` 工具），适合当前回合需要收尾的场景。

## 特性

- 双态侧边栏按钮（展开文字 / 收起图标），React 重渲染不掉、收起展开跟手不偏移
- 10 秒倒计时 + 页面文字浅灰 + 按钮状态机（重启中 / 失败重试）
- 静默启动：**无弹窗、无终端、不开新标签页**，原页面自动刷新
- 自检驱动：端口 + 插件路由双重验证，成功才提示，失败可重试
- 对话触发：`dsh_restart` 工具（模型侧）

## 环境与兼容性

| 项目 | 要求 |
|---|---|
| 操作系统 | **Windows 必选**：host 端依赖计划任务 `schtasks`、`wscript.exe` 静默启动、PowerShell 重启脚本，跨平台不可用 |
| 浏览器 | 在 **Windows 11 + 谷歌 Chrome** 开发验证；Chromium 系（Edge 等）可用（client 仅使用标准 DOM API） |
| DSH Web | 侧边栏定位依赖当前 dsh web 构建的 CSS Modules 类名，DSH 升级后可能需要适配选择器 |

## 工作流程

1. 用户要求重启（点按钮，或对模型说「重启 DSH」触发 `dsh_restart` 工具）。
2. 触发计划任务 `dsh-web-restart-20s`（wscript 静默启动，无 PowerShell 窗口）。
3. 页面字体整体变浅灰、重启按钮保持原色显示「重启中…」并旋转图标；模型立即用一句话通知用户并结束回合。
4. 10 秒倒计时结束后，脚本自动执行：杀掉 127.0.0.1:3080 的旧宿主 → 以 `--no-open` 拉起新实例（不新开浏览器标签页）→ 自检（3080 端口监听 + `GET /modlens/paste` + `GET /`）。
5. 原页面轮询到 `done+success` 后自动刷新，并在右上角弹出「重启成功」toast（约 4 秒自动消失）；失败则重启按钮变红「重启失败·重试」。
6. 重启后若用户询问结果，可读取状态文件汇报（`E:\pi-windows\dsh-web-restart-status.txt`）。

## 组成

| 部件 | 路径 | 说明 |
|---|---|---|
| 重启脚本 | `E:\pi-windows\restart-dsh-web.ps1` | 统一入口，`-Mode Grace -Seconds 10` 为 10 秒倒计时；倒计时写 live 标记，自检后写 verdict |
| 静默启动器 | `E:\pi-windows\restart-dsh-web-silent.vbs` | wscript 包装，桌面永不弹出 PowerShell 窗口；倒计时秒数在此文件修改 |
| 计划任务 | `dsh-web-restart-20s` | `schtasks /Run /TN "dsh-web-restart-20s"` 触发（Interactive only），Action 指向静默启动器；任务名保留历史命名 |
| 启动脚本 | `E:\pi-windows\dsh-web-restart-start.bat` | 以 `--no-open` 拉起新实例：重启不新开浏览器标签页，由原页面自动刷新 |
| live 标记 | `D:\dsh-web\轻量事务\.dsh-restart-live.json` | `state=countdown/stopping/booting/done`、`deadline`、`success` verdict |
| 自检日志 | `E:\pi-windows\dsh-web-restart-status.txt` | 每一步时间线 + 最终 `self-check verdict: SUCCESS/FAILED` |
| 持久插件 | 本仓库 | host：`GET/POST /_dsh/dsh-restart/state|trigger` 路由 + `dsh_restart` 工具；client：侧边栏重启按钮（双态）、文字浅灰反馈、成功后自动刷新 + toast 提示。link 到 `~/.dsh/profiles/web` 的 bundles |

## 使用

- **页面按钮**：展开态点设置按钮右侧「重启」；收起态点设置图标上方的 ↻ 图标。
- **对话触发**：对模型说「重启」即可（`dsh_restart` 工具）。
- **手动触发**：`schtasks /Run /TN "dsh-web-restart-20s"`。
- **改倒计时**：编辑 `E:\pi-windows\restart-dsh-web-silent.vbs` 里的 `-Seconds 10`，并同步本仓库 `lib/index.js` 的 `SECONDS` 常量与描述文案。若用 `schtasks /Change /TR` 覆盖 Action，请保持 `wscript.exe "E:\pi-windows\restart-dsh-web-silent.vbs"`，不要写回 powershell.exe（会恢复弹窗）。

## 注意事项

- 倒计时期间模型回合必须已结束（SOP 已固化：工具返回后立即一句短回复收尾）。
- 重启会短暂断开当前 Web 会话；原页面自动重连刷新，不新开标签页。
- 重启成功提示经 `sessionStorage` 跨刷新接力，仅原标签页显示、消费后即清除。
- 持久插件在重启后生效；若 client bundle 构建失败，按钮/提示缺失但 `dsh_restart` 工具与自检日志仍可用。

## License

[MIT](LICENSE)