# DSH 重启模式（10 秒倒计时）

用户要求重启 DSH 时的一键重启模式：页面字体变浅灰 → 10 秒倒计时 → 环境自动重启 → 自检 → 原页面自动刷新并弹出「重启成功」提示。

## 流程

1. 用户发送重启要求（例如「重启 DSH」），或点击侧边栏「重启」按钮（展开态在设置按钮右侧，收起态为设置图标上方的 ↻ 图标）。
2. 触发计划任务 `dsh-web-restart-20s`（wscript 静默启动，无 PowerShell 窗口）。
3. 页面字体整体变浅灰、重启按钮保持原色显示「重启中…」并旋转图标；模型立即用一句话通知用户并结束回合。
4. 10 秒倒计时结束后，脚本自动执行：杀掉 127.0.0.1:3080 的旧宿主 → 以 `--no-open` 拉起新实例（不新开浏览器标签页）→ 自检（3080 端口监听 + `GET /modlens/paste` + `GET /`）。
5. 原页面轮询到 `done+success` 后自动刷新，并在右上角弹出「重启成功」toast（约 4 秒自动消失）；失败则重启按钮变红「重启失败·重试」。
6. 重启后若用户询问结果，模型读取状态文件汇报。

## 组成

| 部件 | 路径 | 说明 |
|---|---|---|
| 重启脚本 | `E:\pi-windows\restart-dsh-web.ps1` | 统一入口，`-Mode Grace -Seconds 10` 为 10 秒倒计时；倒计时写 live 标记，自检后写 verdict |
| 静默启动器 | `E:\pi-windows\restart-dsh-web-silent.vbs` | wscript 包装，桌面永不弹出 PowerShell 窗口；倒计时秒数在此文件修改 |
| 计划任务 | `dsh-web-restart-20s` | `schtasks /Run /TN "dsh-web-restart-20s"` 触发（Interactive only），Action 指向静默启动器；任务名保留历史命名 |
| 启动脚本 | `E:\pi-windows\dsh-web-restart-start.bat` | 以 `--no-open` 拉起新实例：重启不新开浏览器标签页，由原页面自动刷新 |
| live 标记 | `D:\dsh-web\轻量事务\.dsh-restart-live.json` | `state=countdown/stopping/booting/done`、`deadline`、`success` verdict |
| 自检日志 | `E:\pi-windows\dsh-web-restart-status.txt` | 每一步时间线 + 最终 `self-check verdict: SUCCESS/FAILED` |
| 持久插件 | `D:\dsh-web\轻量事务\dsh-restart-plugin\` | host：`GET/POST /_dsh/dsh-restart/state|trigger` 路由 + `dsh_restart` 工具；client：侧边栏重启按钮（双态）、文字浅灰反馈、成功后自动刷新 + toast 提示。已 link 到 `~/.dsh/profiles/web` 的 bundles |
| 模式预设 | `~/.dsh/.agent-presets/dsh-restart\` | 基于 standard + `restart-sop.mjs` 提示词节（重启 SOP 教学）。在新会话选择「DSH 重启模式」使用 |
| 动态插件 | 会话内 Cordis 插件 `rstpl-1` | 与持久插件同功能，供当前会话立即使用（重启后失效，由持久插件接替） |

## 使用

- **页面按钮**：展开态点设置按钮右侧「重启」；收起态点设置图标上方的 ↻ 图标。
- **对话触发**：对模型说「重启」即可（`dsh_restart` 工具）。
- **手动触发**：`schtasks /Run /TN "dsh-web-restart-20s"`。
- **改倒计时**：编辑 `E:\pi-windows\restart-dsh-web-silent.vbs` 里的 `-Seconds 10`，并同步 `dsh-restart-plugin/lib/index.js` 的 `SECONDS` 常量与描述文案。若用 `schtasks /Change /TR` 覆盖 Action，请保持 `wscript.exe "E:\pi-windows\restart-dsh-web-silent.vbs"`，不要写回 powershell.exe（会恢复弹窗）。

## 注意事项

- 倒计时期间模型回合必须已结束（SOP 已固化：工具返回后立即一句短回复收尾）。
- 重启会短暂断开当前 Web 会话；原页面自动重连刷新，不新开标签页。
- 重启成功提示经 `sessionStorage` 跨刷新接力，仅原标签页显示、消费后即清除。
- 持久插件在重启后生效；若 client bundle 构建失败，按钮/提示缺失但 `dsh_restart` 工具与自检日志仍可用。
