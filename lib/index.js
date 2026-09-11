// dsh-restart-plugin host half.
//
// - GET  /_dsh/dsh-restart/state   -> { ok, live, statusTail } (loopback + same-origin only)
// - POST /_dsh/dsh-restart/trigger -> fires the dsh-web-restart-20s scheduled task
//
// The scheduled task runs E:\pi-windows\restart-dsh-web.ps1 -Mode Grace -Seconds 20,
// which stops the old dsh web on 127.0.0.1:3080, boots a fresh one, self-checks
// (port 3080 + GET /_dsh/dsh-restart/state + GET /) and writes the verdict into
// D:\dsh-web\做项目\.dsh-restart-live.json plus E:\pi-windows\dsh-web-restart-status.txt.
import { readFile } from 'node:fs/promises'

const LIVE = 'D:\\dsh-web\\做项目\\.dsh-restart-live.json'
const STATUS = 'E:\\pi-windows\\dsh-web-restart-status.txt'
const TASK = 'dsh-web-restart-20s'
const SECONDS = 10
const ROUTE = '/_dsh/dsh-restart/state'
const ROUTE_TRIGGER = '/_dsh/dsh-restart/trigger'

export const name = 'dsh-restart-plugin'
export const inject = ['tools']

function isLoopbackRemoteAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]
  if (normalized === '::1') return true
  const parts = normalized.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/u.test(p) && Number(p) <= 255)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  const parts6 = mapped.split('.')
  return parts6.length === 4 && parts6.every((p) => /^\d{1,3}$/u.test(p) && Number(p) <= 255)
}

function isLoopbackRequest(req) {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  return host.startsWith('127.') || host.startsWith('localhost') || host.startsWith('[::1]') || host.startsWith('::1')
}

function isTrustedBrowserRequest(req, requireOrigin) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  if (typeof origin !== 'string') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === new URL('http://' + host).host
  } catch {
    return false
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

async function readTextFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function currentState() {
  const liveRaw = await readTextFile(LIVE)
  const statusRaw = await readTextFile(STATUS)
  let live = null
  if (liveRaw !== null) {
    try { live = JSON.parse(liveRaw) } catch { live = null }
  }
  const statusTail = statusRaw === null ? '' : statusRaw.split(/\r?\n/).filter((line) => line.length > 0).slice(-10).join('\n')
  return { live, statusTail }
}

async function triggerRestart(subprocess) {
  if (subprocess === undefined) return { ok: false, reason: 'subprocess 服务不可用' }
  const handle = subprocess.spawn({
    argv: ['C:\\Windows\\System32\\schtasks.exe', '/Run', '/TN', TASK],
    cwd: 'D:\\dsh-web\\做项目',
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 8000,
  })
  const done = await handle.done
  const code = done && done.exitCode
  return { ok: code === 0, code, task: TASK, seconds: SECONDS }
}

export function apply(ctx) {
  const disposers = []

  // webServer and subprocess services are not synchronously available at
  // apply() time under the web profile (the cordis has no optional-inject
  // form), so the HTTP routes ride a scoped ctx.inject like the modlens
  // plugin's paste route. The callback fires as soon as the services appear
  // and never runs where they do not (e.g. headless).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'subprocess'], (scope) => {
      try {
        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req) || !isTrustedBrowserRequest(req, req.method === 'POST')) {
              sendJson(res, 403, { ok: false, error: 'loopback + same-origin only' })
              return
            }
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, ...(await currentState()) })
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
          },
        }))

        disposers.push(scope.webServer.register({
          kind: 'exact',
          path: ROUTE_TRIGGER,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req) || !isTrustedBrowserRequest(req, true)) {
              sendJson(res, 403, { ok: false, error: 'loopback + same-origin only' })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              sendJson(res, 200, await triggerRestart(scope.subprocess))
            } catch (error) {
              sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }))
      } catch (error) {
        console.error(`[dsh-restart-plugin] webServer routes skipped: ${error}`)
      }
    })
  }

  disposers.push(ctx.effect(() => ctx.tools.register({
    name: 'dsh_restart',
    description: '触发 DSH Web 环境重启（固定 10 秒倒计时模式）。调用后：计划任务 dsh-web-restart-20s 立即启动，10 秒后杀掉 127.0.0.1:3080 的旧 DSH 宿主进程并用同一方式拉起新实例，然后自动自检（3080 端口监听 + GET /_dsh/dsh-restart/state + GET /），结果写入 E:\\pi-windows\\dsh-web-restart-status.txt 与 D:\\dsh-web\\做项目\\.dsh-restart-live.json。浏览器页面会在倒计时期间整体变灰，重启完成后自动重连并刷新。注意：本回合的宿主进程将在倒计时结束后被杀，所以调用本工具后必须立即结束回合、只输出一句简短的中文通知，不要再调用任何其他工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const res = await triggerRestart(ctx.get('subprocess'))
      if (!res.ok) {
        return { ok: false, tool: 'dsh_restart', text: '重启触发失败：' + (res.reason || ('schtasks 退出码 ' + res.code)) }
      }
      return {
        ok: true,
        tool: 'dsh_restart',
        text: '已触发 DSH 环境重启（倒计时 10 秒，计划任务 ' + TASK + '）。页面已进入重启状态；倒计时结束后环境自动重启并自检，页面会自动重连刷新。你现在必须立即结束本回合：用一句简短的中文告诉用户环境将在 10 秒后重启、页面会自动重连，不要做任何其他工具调用或额外输出。',
      }
    },
  }), 'dsh-restart-plugin: dsh_restart tool'))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
