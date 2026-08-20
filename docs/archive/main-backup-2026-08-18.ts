/**
 * dsh-desktop — Electron main process.
 *
 * A thin launcher shell:
 *   1. resolves APP_HOME (~/dsh-app, overridable via DSH_APP_HOME) and settings
 *   2. bootstraps / upgrades the git-managed harness checkout (upgrade.ts)
 *   3. spawns the dsh web backend as a child process with the system Node
 *   4. waits for the `dsh web: http://127.0.0.1:<port>` readiness line
 *   5. opens a BrowserWindow at that loopback URL
 *
 * The web page itself is a normal loopback HTTP page: the harness' own
 * browser-trust fence already accepts it, so no frontend changes were needed.
 */

import {
  app, BrowserWindow, Menu, dialog, shell, ipcMain,
  type MenuItemConstructorOptions,
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REMOTE, applyUpdate, bootstrapHarness, checkForUpdates, describeHarness,
  harnessEnv, type HarnessSnapshot, type UpgradeEvents, type UpgradeSettings, type UpgradeStatus,
} from './upgrade.js'

/* ─────────────────────────────── config ─────────────────────────────── */

const APP_HOME = process.env.DSH_APP_HOME ?? join(homedir(), 'dsh-app')
const SETTINGS_FILE = join(APP_HOME, 'settings.json')
const ENV_FILE = join(APP_HOME, 'env')
const LOGS_DIR = join(APP_HOME, 'logs')
const BACKEND_READY_RE = /dsh web: (http:\/\/[^\s]+)/
const BACKEND_READY_TIMEOUT_MS = 120_000

interface AppSettings extends UpgradeSettings {
  autoCheck: boolean
  backendPort: number
  dshHome: string
}

function defaultSettings(): AppSettings {
  return {
    harnessDir: join(APP_HOME, 'harness'),
    channel: 'tag',
    tagPrefix: 'dsh-v',
    remote: DEFAULT_REMOTE,
    autoCheck: false,
    backendPort: 0,
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  }
}

function loadSettings(): AppSettings {
  const merged = { ...defaultSettings() }
  if (existsSync(SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<AppSettings>
      for (const key of Object.keys(merged) as (keyof AppSettings)[]) {
        const v = raw[key]
        if (v !== undefined) (merged as Record<string, unknown>)[key] = v
      }
    } catch (err) {
      log(`settings.json unreadable: ${String(err)}`)
    }
  }
  return merged
}

/** KEY=VALUE lines from APP_HOME/env, merged into the backend environment. */
function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(ENV_FILE)) return out
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i <= 0) continue
    out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim()
  }
  return out
}

function ensureDirs(): void {
  for (const dir of [APP_HOME, LOGS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** Append-only app log inside APP_HOME/logs. */
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(join(LOGS_DIR, 'app.log'), line) } catch { /* never fatal */ }
  console.log(message)
}

/** Keep the last 5 backend logs. */
function pruneBackendLogs(): void {
  try {
    const files = readdirSync(LOGS_DIR).filter((f) => f.startsWith('backend-')).sort()
    while (files.length > 5) {
      const victim = files.shift()
      if (victim !== undefined) unlinkSync(join(LOGS_DIR, victim))
    }
  } catch { /* best effort */ }
}

const settings = loadSettings()
const extraEnv = loadEnvFile()

/** Backend child environment: augmented PATH, DSH_HOME, app env file. */
function backendEnv(): NodeJS.ProcessEnv {
  const env = harnessEnv(settings, process.env)
  return {
    ...env,
    DSH_HOME: settings.dshHome,
    DSH_APP_HOME: APP_HOME,
    DSH_APP_MODE: 'desktop',
    ...extraEnv,
  }
}

/* ─────────────────────────── backend lifecycle ─────────────────────────── */

let backend: ChildProcess | null = null
let backendUrl: string | null = null
let backendLogPath: string | null = null
/** Bumped per start; stale children (superseded by a restart) ignore their exit. */
let backendGen = 0
/** Set on the current child by stopBackend, so its exit is not treated as a crash. */
let backendStopRequested = false

/** Start the dsh web backend; resolves with the loopback URL once ready. */
async function startBackend(): Promise<string> {
  await stopBackend()
  const bin = join(settings.harnessDir, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    throw new Error(`backend entry missing: ${bin} (run the first-install / upgrade flow)`)
  }
  const gen = ++backendGen
  pruneBackendLogs()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  backendLogPath = join(LOGS_DIR, `backend-${stamp}.log`)
  const logStream = createWriteStream(backendLogPath, { flags: 'a' })

  log(`[backend] starting: node ${bin} --profile web --port ${settings.backendPort} (cwd=${settings.harnessDir})`)
  const child = spawn('node', [bin, '--profile', 'web', '--port', String(settings.backendPort)], {
    cwd: settings.harnessDir,
    env: backendEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend = child
  backendUrl = null
  backendStopRequested = false

  const ready = new Promise<string>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      if (gen === backendGen) {
        rejectPromise(new Error(`backend did not print a readiness URL within ${BACKEND_READY_TIMEOUT_MS / 1000}s (see ${backendLogPath ?? 'backend log'})`))
      }
    }, BACKEND_READY_TIMEOUT_MS)

    const resolveReady = (url: string): void => {
      if (gen !== backendGen) return
      clearTimeout(timer)
      backendUrl = url
      log(`[backend] ready at ${url}`)
      resolvePromise(url)
    }

    child.on('error', (err) => {
      log(`[backend] spawn error: ${String(err)}`)
      if (gen === backendGen) {
        clearTimeout(timer)
        backend = null
        rejectPromise(new Error(`backend failed to start: ${String(err)}`))
      }
    })

    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      stream.pipe(logStream, { end: false })
      const rl = createInterface({ input: stream })
      rl.on('line', (line) => {
        const match = BACKEND_READY_RE.exec(line)
        if (match !== null) resolveReady(match[1]!)
      })
    }

    child.on('exit', (code, signal) => {
      log(`[backend] exited code=${String(code)} signal=${String(signal)}`)
      if (gen !== backendGen) return // superseded by a restart
      backend = null
      backendUrl = null
      clearTimeout(timer)
      const wasStopping = backendStopRequested
      if (wasStopping || quitting) return
      rejectPromise(new Error(`backend exited before ready (code ${String(code)} signal ${String(signal)})`))
      if (backendLogPath !== null && !SMOKE) {
        void dialog.showMessageBox({
          type: 'error',
          message: 'DeepSeek Harness 后端进程已退出',
          detail: `退出码: ${String(code)} 信号: ${String(signal)}\n日志: ${backendLogPath}`,
          buttons: ['重启后端', '退出'],
        }).then(({ response }) => {
          if (response === 0) void restartBackend()
          else app.quit()
        })
      }
    })
  })
  return ready
}

function stopBackend(): Promise<void> {
  const child = backend
  if (child === null) return Promise.resolve()
  backendStopRequested = true
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    try { child.kill('SIGTERM') } catch { clearTimeout(timer); resolvePromise() }
  })
}

async function restartBackend(): Promise<void> {
  await stopBackend()
  try {
    const url = await startBackend()
    await loadMainWindow(url)
  } catch (err) {
    showFatal(err)
  }
}

/* ─────────────────────────────── windows ─────────────────────────────── */

let mainWindow: BrowserWindow | null = null
let progressWindow: BrowserWindow | null = null
const SMOKE = process.argv.includes('--smoke')
/** Origin the main window is allowed to navigate to (updated per backend restart). */
let mainOrigin: string | null = null

async function loadMainWindow(url?: string): Promise<void> {
  const target = url ?? backendUrl
  if (target === null) throw new Error('no backend URL available')
  mainOrigin = new URL(target).origin
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      title: 'DeepSeek Harness',
      // Immersive window: hide the title bar but keep the native macOS
      // traffic lights; the shell injects a top drag region via preload.
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 14 },
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    mainWindow.on('ready-to-show', () => mainWindow?.show())
    mainWindow.on('closed', () => { mainWindow = null })
    // Window-state push for the injected drag region (hide on fullscreen).
    const pushWindowState = (): void => {
      mainWindow?.webContents.send('dsh:window-state', {
        maximized: mainWindow?.isMaximized() ?? false,
        fullscreen: mainWindow?.isFullScreen() ?? false,
      })
    }
    mainWindow.on('maximize', pushWindowState)
    mainWindow.on('unmaximize', pushWindowState)
    mainWindow.on('enter-full-screen', pushWindowState)
    mainWindow.on('leave-full-screen', pushWindowState)
    mainWindow.webContents.on('will-navigate', (event, navUrl) => {
      try {
        if (mainOrigin !== null && new URL(navUrl).origin !== mainOrigin) event.preventDefault()
      } catch { event.preventDefault() }
    })
    mainWindow.webContents.setWindowOpenHandler(({ url: opened }) => {
      if (opened.startsWith('http://') || opened.startsWith('https://')) {
        void shell.openExternal(opened)
      }
      return { action: 'deny' }
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      if (!SMOKE && backendUrl !== null) {
        void dialog.showMessageBox({
          type: 'error',
          message: '页面加载失败',
          detail: `${code} ${desc}`,
          buttons: ['重试', '退出'],
        }).then(({ response }) => {
          if (response === 0) void loadMainWindow()
          else app.quit()
        })
      }
    })
    mainWindow.webContents.on('did-finish-load', () => {
      if (SMOKE) {
        // Assert the injected drag region exists in the page DOM, then quit
        // via app.quit() so the before-quit hook stops the backend cleanly.
        void mainWindow?.webContents.executeJavaScript(
          `document.getElementById('dsh-drag-region') !== null`,
        ).then((ok) => {
          console.log(`SMOKE_DRAG_REGION ${ok ? 'OK' : 'FAIL'}`)
        }).finally(() => {
          setTimeout(() => {
            console.log(`SMOKE_OK url=${backendUrl ?? ''} pid=${backend?.pid ?? ''}`)
            app.quit()
          }, 1200)
        })
      }
    })
  }
  if (mainWindow.webContents.getURL() !== target) {
    await mainWindow.loadURL(target)
  }
}

/** Progress window for bootstrap / check / apply flows. */
function openProgressWindow(mode: 'check' | 'apply' | 'bootstrap'): BrowserWindow {
  if (progressWindow !== null && !progressWindow.isDestroyed()) {
    progressWindow.close()
  }
  progressWindow = new BrowserWindow({
    width: 640,
    height: 480,
    show: true,
    title: mode === 'bootstrap' ? 'DeepSeek Harness — 首次安装' : mode === 'apply' ? 'DeepSeek Harness — 正在更新' : 'DeepSeek Harness — 检查更新',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void progressWindow.loadFile(join(__dirname, 'progress.html'), { query: { mode } })
  progressWindow.on('closed', () => { progressWindow = null })
  return progressWindow
}

function closeProgressWindow(): void {
  if (progressWindow !== null && !progressWindow.isDestroyed()) progressWindow.close()
}

/* ─────────────────────────────── upgrade ─────────────────────────────── */

let upgrading = false
let upgradeSignal: AbortController | null = null

function upgradeEvents(): UpgradeEvents {
  return {
    phase: (phase, detail) => progressWindow?.webContents.send('dsh:phase', { phase, detail }),
    log: (line) => progressWindow?.webContents.send('dsh:log', line),
  }
}

async function menuCheckForUpdates(): Promise<void> {
  if (upgrading) {
    void dialog.showMessageBox({ type: 'info', message: '更新流程正在进行中', buttons: ['好'] })
    return
  }
  openProgressWindow('check')
  const events = upgradeEvents()
  const result = await checkForUpdates(settings, process.env, events)
  progressWindow?.webContents.send('dsh:phase', { phase: 'done' })
  closeProgressWindow()
  await handleCheckResult(result)
}

async function handleCheckResult(result: UpgradeStatus): Promise<void> {
  switch (result.status) {
    case 'up-to-date': {
      if (!SMOKE) {
        await dialog.showMessageBox({ type: 'info', message: '已是最新版本', detail: `当前提交: ${result.current.slice(0, 12)}` })
      }
      return
    }
    case 'update-available': {
      const from = result.from.slice(0, 12)
      const to = result.to.slice(0, 12)
      const label = result.tag ?? result.targetName
      if (SMOKE) {
        log(`[smoke] update available ${from} -> ${to} (${label}); not applying in smoke mode`)
        return
      }
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `发现新版本: ${label}`,
        detail: `当前: ${from}\n新版本: ${to}\n\n将停止后端、更新代码并重新构建（可能需要几分钟），然后自动重启。`,
        buttons: ['应用并重启', '暂不更新'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await applyUpgrade(result)
      return
    }
    case 'dirty': {
      if (!SMOKE) {
        await dialog.showMessageBox({
          type: 'warning',
          message: '工作区有未提交的修改，无法自动更新',
          detail: `检测到 ${result.files.length} 个改动文件。请先在 checkout 中提交或 stash 后再更新。\n\n${result.files.slice(0, 8).join('\n')}`,
          buttons: ['好'],
        })
      }
      return
    }
    case 'not-a-repo': {
      if (!SMOKE) {
        await dialog.showMessageBox({
          type: 'warning',
          message: 'harness 目录不是 git 仓库，无法通过 git 更新',
          detail: `${result.dir}\n\n该目录缺少 .git。请删除它或修改 settings.json 的 harnessDir 指向一个 git 克隆。`,
          buttons: ['好'],
        })
      }
      return
    }
    case 'cancelled': {
      if (!SMOKE) {
        await dialog.showMessageBox({ type: 'info', message: '更新已取消', buttons: ['好'] })
      }
      return
    }
    default: {
      if (!SMOKE) {
        const detail = (result as { message?: string; detail?: string })
        await dialog.showMessageBox({
          type: 'error',
          message: `检查更新失败（${result.status}）`,
          detail: detail.message ?? detail.detail ?? '未知错误',
          buttons: ['好'],
        })
      }
    }
  }
}

async function applyUpgrade(result: Extract<UpgradeStatus, { status: 'update-available' }>): Promise<void> {
  upgrading = true
  upgradeSignal = new AbortController()
  await stopBackend()
  openProgressWindow('apply')
  const events = upgradeEvents()
  const applied = await applyUpdate(settings, process.env, result.from, result.targetName, events, upgradeSignal.signal)
  progressWindow?.webContents.send('dsh:phase', { phase: applied.status === 'updated' ? 'done' : 'error' })
  closeProgressWindow()
  if (applied.status === 'updated') {
    log(`[upgrade] applied ${applied.from.slice(0, 12)} -> ${applied.to.slice(0, 12)}`)
    try {
      const url = await startBackend()
      await loadMainWindow(url)
    } catch (err) {
      showFatal(err)
    }
    if (!SMOKE) {
      await dialog.showMessageBox({
        type: 'info',
        message: `已更新到 ${applied.tag ?? applied.to.slice(0, 12)}`,
        detail: '后端已重启。',
        buttons: ['好'],
      })
    }
  } else if (applied.status === 'failed') {
    log(`[upgrade] failed at ${applied.step}: ${applied.message.slice(0, 300)}`)
    if (!SMOKE) {
      await dialog.showMessageBox({
        type: 'error',
        message: `更新失败（${applied.step}）`,
        detail: `已尝试回滚到原提交。\n\n${applied.message.slice(-1200)}\n\n日志目录: ${LOGS_DIR}`,
        buttons: ['好'],
      })
    }
    try {
      const url = await startBackend()
      await loadMainWindow(url)
    } catch { /* backend may be broken; user checks logs */ }
  } else {
    // cancelled: bring the backend back up on the old checkout
    log('[upgrade] cancelled; restarting backend on the previous checkout')
    try {
      const url = await startBackend()
      await loadMainWindow(url)
    } catch (err) { showFatal(err) }
  }
  upgradeSignal = null
  upgrading = false
  buildMenu()
}

/** First-run: clone + install + build the harness, then start the backend. */
async function bootstrapIfNeeded(): Promise<void> {
  const bin = join(settings.harnessDir, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(bin)) return
  if (existsSync(settings.harnessDir)) {
    throw new Error(`harness 目录已存在但缺少构建产物: ${settings.harnessDir}\n请删除该目录后重试，或修改 settings.json 的 harnessDir。`)
  }
  upgrading = true
  upgradeSignal = new AbortController()
  openProgressWindow('bootstrap')
  const events = upgradeEvents()
  log(`[bootstrap] cloning ${settings.remote} -> ${settings.harnessDir}`)
  const result = await bootstrapHarness(settings, process.env, events, upgradeSignal.signal)
  progressWindow?.webContents.send('dsh:phase', { phase: result.status === 'bootstrapped' ? 'done' : 'error' })
  closeProgressWindow()
  upgrading = false
  upgradeSignal = null
  if (result.status === 'bootstrapped') {
    log(`[bootstrap] done at ${result.commit.slice(0, 12)}`)
  } else if (result.status === 'failed') {
    throw new Error(`首次安装失败（${result.step}）: ${result.message.slice(-800)}`)
  } else if (result.status === 'cancelled') {
    throw new Error('首次安装已取消')
  }
  buildMenu()
}

/* ─────────────────────────────── menu / ipc ─────────────────────────────── */

function harnessSnapshot(): HarnessSnapshot {
  return describeHarness(settings, process.env)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: '关于 DeepSeek Harness',
          click: () => {
            const s = harnessSnapshot()
            void dialog.showMessageBox({
              type: 'info',
              message: 'DeepSeek Harness 桌面版',
              detail: [
                `应用版本: ${app.getVersion()}`,
                `harness 版本: ${s.version}`,
                `提交: ${s.commitShort || '（非 git 目录）'}`,
                `tag: ${s.tag || '—'}`,
                `更新通道: ${s.channel}`,
                `harness 目录: ${s.harnessDir}`,
                `数据目录 (DSH_HOME): ${settings.dshHome}`,
              ].join('\n'),
              buttons: ['好'],
            })
          },
        },
        { type: 'separator' },
        {
          label: '检查更新…',
          accelerator: 'CmdOrCtrl+U',
          enabled: !upgrading,
          click: () => void menuCheckForUpdates(),
        },
        {
          label: '重启后端',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: !upgrading,
          click: () => void restartBackend(),
        },
        {
          label: '打开日志目录',
          click: () => void shell.openPath(LOGS_DIR),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle('dsh:versions', () => {
    const s = harnessSnapshot()
    return {
      app: app.getVersion(),
      harness: s.version,
      commit: s.commitShort,
      tag: s.tag,
      channel: s.channel,
      harnessDir: s.harnessDir,
      dshHome: settings.dshHome,
      appHome: APP_HOME,
      backendUrl,
    }
  })
  ipcMain.handle('dsh:check-for-updates', () => { void menuCheckForUpdates(); return true })
  ipcMain.handle('dsh:restart-backend', () => void restartBackend())
  ipcMain.handle('dsh:open-logs', () => void shell.openPath(LOGS_DIR))
  ipcMain.handle('dsh:cancel-upgrade', () => { upgradeSignal?.abort(); return true })
  // Window control from the injected drag region (dblclick -> toggle maximize).
  // Only the main window's webContents may drive the window.
  ipcMain.on('dsh:window-control', (event, action: unknown) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return
    if (event.sender !== mainWindow.webContents) return
    if (action === 'toggle-maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
  })
}

/* ─────────────────────────────── lifecycle ─────────────────────────────── */

let quitting = false
let fatalShown = false

function showFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  log(`[fatal] ${message}`)
  if (SMOKE) {
    console.error(`SMOKE_FAIL ${message}`)
    app.exit(1)
    return
  }
  if (fatalShown) return
  fatalShown = true
  void dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness',
    message: '启动失败',
    detail: `${message}\n\n日志目录: ${LOGS_DIR}`,
    buttons: ['退出'],
  }).then(() => app.quit())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Before any window/menu exists: the app name drives the menu title and the
  // default userData directory (~/Library/Application Support/DeepSeek Harness).
  app.setName('DeepSeek Harness')

  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    ensureDirs()
    registerIpc()
    buildMenu()
    log(`[app] starting (APP_HOME=${APP_HOME} DSH_HOME=${settings.dshHome} harness=${settings.harnessDir})`)
    try {
      await bootstrapIfNeeded()
      const url = await startBackend()
      await loadMainWindow(url)
      if (settings.autoCheck && !SMOKE) {
        setTimeout(() => {
          void checkForUpdates(settings, process.env, { phase: () => {}, log: (l) => log(`[auto-check] ${l}`) })
            .then((r) => { if (r.status === 'update-available') void handleCheckResult(r) })
            .catch((e) => log(`[auto-check] error: ${String(e)}`))
        }, 15_000)
      }
    } catch (err) {
      showFatal(err)
    }
  }).catch((err) => showFatal(err))

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopBackend().finally(() => app.quit())
  })

  process.on('uncaughtException', (err) => {
    log(`[uncaught] ${String(err)}`)
  })
}
