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
  appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, watch, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REMOTE, DEFAULT_RELEASE_REPO, applyBuiltUpdate, checkForUpdates, defaultUpdateState,
  describeHarness, extractBundle, harnessEnv, loadUpdateState, produceUpdate, saveUpdateState,
  type HarnessSnapshot, type UpdateStateFile, type UpgradeEvents, type UpgradeSettings,
} from './upgrade.js'
import { MENU_STRINGS, resolveMenuLanguage } from './i18n.js'
import { gitBin, resolveNode, resolvePnpm } from './upgrade.js'

/* ─────────────────────────────── config ─────────────────────────────── */

const APP_HOME = process.env.DSH_APP_HOME ?? join(homedir(), 'dsh-app')
const SETTINGS_FILE = join(APP_HOME, 'settings.json')
const ENV_FILE = join(APP_HOME, 'env')
const LOGS_DIR = join(APP_HOME, 'logs')
const BACKEND_READY_RE = /dsh web: (http:\/\/[^\s]+)/
const BACKEND_READY_TIMEOUT_MS = 120_000

interface AppSettings extends UpgradeSettings {
  autoCheck: boolean
  autoCheckIntervalMs: number
  backendPort: number
  dshHome: string
}

function defaultSettings(): AppSettings {
  return {
    harnessDir: join(APP_HOME, 'harness'),
    channel: 'tag',
    tagPrefix: 'dsh-v',
    remote: DEFAULT_REMOTE,
    updateSource: 'release',
    releaseRepo: DEFAULT_RELEASE_REPO,
    releaseAssetPattern: 'DeepSeek-Harness-*-<os>-<arch>.zip',
    autoCheck: true,
    autoCheckIntervalMs: 6 * 3600_000,
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

  const nodeTool = resolveNode(settings, process.env)
  log(`[backend] starting: ${nodeTool.bin} ${bin} --profile web --port ${settings.backendPort} (cwd=${settings.harnessDir})`)
  const child = spawn(nodeTool.bin, [...nodeTool.prefix, bin, '--profile', 'web', '--port', String(settings.backendPort)], {
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
const DEBUG = process.argv.includes('--debug')
/** True once the real GUI window has been created (guards window-all-closed). */
let mainWindowEverCreated = false
/** Origin the main window is allowed to navigate to (updated per backend restart). */
let mainOrigin: string | null = null

async function loadMainWindow(url?: string): Promise<void> {
  const target = url ?? backendUrl
  if (target === null) throw new Error('no backend URL available')
  mainOrigin = new URL(target).origin
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindowEverCreated = true
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
    title: mode === 'bootstrap' ? 'DeepSeek Harness — 正在启动' : mode === 'apply' ? 'DeepSeek Harness — 正在更新' : 'DeepSeek Harness — 检查更新',
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

/* ─────────────────────────── upgrade（后台优先，前台无感） ─────────────────────────── */

const UPDATE_STATE_FILE = join(APP_HOME, 'update-state.json')
const BUILD_DIR = join(APP_HOME, 'harness-new')
const DOWNLOADS_DIR = join(APP_HOME, 'downloads')
/** Bundled harness archive (Resources/harness-bundle.tar.gz in the packaged app). */
const BUNDLE_ARCHIVE = join(process.resourcesPath ?? '', 'harness-bundle.tar.gz')

let updateState: UpdateStateFile = loadUpdateState(UPDATE_STATE_FILE)
let updateSignal: AbortController | null = null
let updateBusy = false

function setUpdateState(patch: Partial<UpdateStateFile>): void {
  updateState = { ...updateState, ...patch }
  saveUpdateState(UPDATE_STATE_FILE, updateState)
  broadcastUpdateState()
  log(`[update] state=${updateState.state}${updateState.tag !== undefined ? ` tag=${updateState.tag}` : ''}`)
}

/** Broadcast the in-memory state without persisting (download progress is high-frequency). */
function broadcastUpdateState(): void {
  mainWindow?.webContents.send('dsh:update-event', updateState)
}

function upgradeEvents(): UpgradeEvents {
  return {
    phase: (phase, detail) => log(`[update] ${phase}${detail !== undefined ? ` — ${detail}` : ''}`),
    log: (line) => log(`[update] ${line}`),
    // Download progress: broadcast only (update-state.json is persisted on state
    // transitions, not per chunk).
    progress: (received, total) => {
      updateState = { ...updateState, progress: { received, total } }
      broadcastUpdateState()
    },
  }
}

/** Crash recovery: reconcile update-state.json with the dirs on disk. */
function recoverUpdateState(): void {
  const harness = settings.harnessDir
  const backup = `${harness}-old`
  if (updateState.state === 'applying') {
    // interrupted mid-swap: restore the backup if the run dir is broken
    if (!existsSync(join(harness, 'apps', 'cli', 'lib', 'bin.js'))
      && existsSync(join(backup, 'apps', 'cli', 'lib', 'bin.js'))) {
      try {
        rmSync(harness, { recursive: true, force: true })
        renameSync(backup, harness)
        log('[update] recovered: rolled back interrupted apply')
      } catch (err) { log(`[update] recovery failed: ${String(err)}`) }
    }
    setUpdateState(defaultUpdateState())
  } else if (updateState.state === 'building' || updateState.state === 'downloading' || updateState.state === 'extracting') {
    // interrupted mid-production: drop the candidate dir and any partial downloads
    try { rmSync(BUILD_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
    try { rmSync(DOWNLOADS_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
    setUpdateState(defaultUpdateState())
  } else if (updateState.state === 'applied' || updateState.state === 'failed') {
    // applied: consumed; failed: a fresh launch re-checks anyway — never
    // resurrect a stale failure toast from a previous run.
    setUpdateState(defaultUpdateState())
  }
}

/**
 * Background-first update pipeline: check -> produce the candidate in BUILD_DIR
 * (release channel: download+verify+extract; source channel: git+build) while
 * the old version keeps serving -> ready (toast in the GUI).
 */
async function runUpdateCheck(manual: boolean): Promise<void> {
  if (updateBusy) return
  if (updateState.state === 'building' || updateState.state === 'downloading' || updateState.state === 'extracting' || updateState.state === 'ready') {
    if (manual) {
      const detail = updateState.state === 'ready'
        ? `新版本 ${updateState.tag ?? updateState.toCommit.slice(0, 12)} 已就绪，点右下角提示条更新`
        : '新版本正在后台准备中…完成后会提示你'
      void dialog.showMessageBox({ type: 'info', message: detail, buttons: ['好'] })
    }
    return
  }
  updateBusy = true
  try {
    setUpdateState({ state: 'checking', startedAt: Date.now(), finishedAt: 0, buildError: undefined })
    const result = await checkForUpdates(settings, process.env, upgradeEvents())
    if (result.status === 'update-available') {
      log(`[update] found ${result.tag ?? result.targetName} (${result.from.slice(0, 12)} -> ${result.to.slice(0, 12)})`)
      const producingState = settings.updateSource === 'release' ? 'downloading' : 'building'
      setUpdateState({
        state: producingState, fromCommit: result.from, toCommit: result.to,
        tag: result.tag, targetName: result.targetName, source: settings.updateSource,
        assetUrl: result.assetUrl, startedAt: Date.now(), finishedAt: 0, progress: undefined,
      })
      updateSignal = new AbortController()
      const produced = await produceUpdate(
        settings, process.env, BUILD_DIR, DOWNLOADS_DIR, result, upgradeEvents(), updateSignal.signal,
      )
      updateSignal = null
      if (produced.status === 'ready') {
        setUpdateState({ state: 'ready', finishedAt: Date.now(), progress: undefined })
        log(`[update] candidate ready: ${produced.tag ?? produced.to.slice(0, 12)}`)
      } else if (produced.status === 'failed') {
        setUpdateState({ state: 'failed', buildError: `${produced.step}: ${produced.message.slice(-500)}`, finishedAt: Date.now(), progress: undefined })
      } else {
        setUpdateState({ state: 'idle', finishedAt: Date.now(), progress: undefined })
      }
    } else if (result.status === 'failed' || result.status === 'no-target' || result.status === 'not-a-repo') {
      const detail = 'message' in result ? result.message : (result as { detail?: string }).detail ?? ''
      setUpdateState({ state: 'failed', buildError: `${result.status}: ${detail}`.slice(-500), finishedAt: Date.now() })
    } else {
      setUpdateState({ state: 'idle', finishedAt: Date.now() })
    }
  } catch (err) {
    setUpdateState({ state: 'failed', buildError: String(err).slice(-500), finishedAt: Date.now() })
  } finally {
    updateBusy = false
    if (manual) {
      const s = updateState
      const detail = s.state === 'idle'
        ? '已是最新版本'
        : s.state === 'failed'
          ? `检查更新失败：${s.buildError ?? '未知错误'}`
          : s.state === 'ready'
            ? `新版本 ${s.tag ?? s.toCommit.slice(0, 12)} 已就绪`
            : `当前状态：${s.state}`
      if (!SMOKE) void dialog.showMessageBox({ type: 'info', message: detail, buttons: ['好'] })
    }
    buildMenu()
  }
}

/** User clicked "更新" on the toast: swap in the built version, then ask to restart. */
async function applyReadyUpdate(): Promise<void> {
  if (updateBusy) return
  if (updateState.state !== 'ready') return
  updateBusy = true
  try {
    const snapshot = describeHarness(settings, process.env)
    if (snapshot.dirty) {
      if (!SMOKE) {
        await dialog.showMessageBox({
          type: 'warning',
          message: '运行区有未提交的修改，无法替换',
          detail: '替换会重置运行区（~/.dsh-app/harness）到新版本。请先提交或 stash 其中的改动，或删除后让应用重新解包。',
          buttons: ['好'],
        })
      }
      return
    }
    setUpdateState({ state: 'applying' })
    await stopBackend()
    const applied = await applyBuiltUpdate(settings, BUILD_DIR, updateState.toCommit, updateState.tag)
    if (applied.status === 'applied') {
      setUpdateState({ state: 'applied', finishedAt: Date.now() })
      log(`[update] applied ${applied.from.slice(0, 12)} -> ${applied.to.slice(0, 12)}`)
      try {
        const url = await startBackend()
        await loadMainWindow(url)
      } catch (err) { showFatal(err) }
      if (!SMOKE) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message: `新版本 ${applied.tag ?? applied.to.slice(0, 12)} 已生效`,
          detail: '建议重启应用以获得最佳状态。',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
          cancelId: 1,
        })
        if (response === 0) relaunchApp()
      }
    } else {
      setUpdateState({ state: 'failed', buildError: `${applied.step}: ${applied.message.slice(-500)}`, finishedAt: Date.now() })
      log(`[update] apply failed at ${applied.step}`)
      if (!SMOKE) {
        await dialog.showMessageBox({
          type: 'error',
          message: `更新替换失败（${applied.step}）`,
          detail: '已回滚到旧版本，应用可继续使用。',
          buttons: ['好'],
        })
      }
      try {
        const url = await startBackend()
        await loadMainWindow(url)
      } catch { /* backend may be broken; user checks logs */ }
    }
  } finally {
    updateBusy = false
    buildMenu()
  }
}

function relaunchApp(): void {
  app.relaunch()
  app.quit()
}

/** Background scheduler: first check shortly after launch, then periodically. */
function scheduleAutoCheck(): void {
  if (!settings.autoCheck || SMOKE) return
  const tick = (): void => {
    setTimeout(() => {
      void runUpdateCheck(false)
      tick()
    }, settings.autoCheckIntervalMs)
  }
  setTimeout(() => {
    void runUpdateCheck(false)
    tick()
  }, 20_000)
}

/** First run: unpack the bundled harness into the run dir (no git, no network). */
async function extractIfNeeded(): Promise<void> {
  const bin = join(settings.harnessDir, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(bin)) {
    // The bundled harness carries .git; a run dir without it cannot update.
    // Warn once (not blocking) so the user knows to re-extract.
    if (!existsSync(join(settings.harnessDir, '.git')) && existsSync(BUNDLE_ARCHIVE)) {
      log(`[bootstrap] 运行区缺少 .git，自动更新不可用；删除 ${settings.harnessDir} 后重启应用可重新解包内置版`)
      if (!SMOKE && !DEBUG) {
        void dialog.showMessageBox({
          type: 'warning',
          message: '运行区缺少 .git，自动更新不可用',
          detail: `请退出应用，删除 ${settings.harnessDir}，再重新打开应用以重新解包内置版本。\n（数据与会话在 ~/.dsh，不受影响）`,
          buttons: ['好'],
        })
      }
    }
    return
  }
  if (!existsSync(BUNDLE_ARCHIVE)) {
    throw new Error(`内置 harness 归档缺失（${BUNDLE_ARCHIVE}），且运行区不存在。`
      + '开发模式下请先准备一个构建好的 checkout，或配置 settings.json 的 harnessDir。')
  }
  updateBusy = true
  updateSignal = new AbortController()
  openProgressWindow('bootstrap')
  try {
    await extractBundle(BUNDLE_ARCHIVE, settings.harnessDir, upgradeEvents(), updateSignal.signal)
  } finally {
    updateSignal = null
    updateBusy = false
    closeProgressWindow()
    buildMenu()
  }
  log(`[bootstrap] extracted bundled harness to ${settings.harnessDir}`)
}


/* ─────────────────────────────── menu / ipc ─────────────────────────────── */

function harnessSnapshot(): HarnessSnapshot {
  return describeHarness(settings, process.env)
}

/** Human-readable byte size (for the About download progress line). */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/**
 * Aggregate startup/runtime diagnostics into one text blob — the "debug"
 * feature: `--debug` logs it at startup, and the menu item writes it to
 * ~/dsh-app/diagnostics-<ts>.txt for sharing with the developer.
 */
function buildDiagnostics(): string {
  const s = describeHarness(settings, process.env)
  const bundleOk = existsSync(BUNDLE_ARCHIVE)
  const gitDir = join(settings.harnessDir, '.git')
  const lines: string[] = [
    `app version      : ${app.getVersion()}`,
    `platform         : ${process.platform} ${process.arch}`,
    `APP_HOME         : ${APP_HOME}`,
    `DSH_HOME         : ${settings.dshHome}`,
    `harnessDir       : ${settings.harnessDir}`,
    `bundle archive   : ${BUNDLE_ARCHIVE} (${bundleOk ? 'present' : 'MISSING'})`,
    `harness .git     : ${existsSync(gitDir) ? 'present' : 'MISSING (自动更新不可用)'}`,
    `harness HEAD     : ${s.commitShort || '—'}`,
    `harness tag      : ${s.tag || '—'}`,
    `harness dirty    : ${s.dirty}`,
    `git remote       : ${remoteOf(settings.harnessDir)}`,
    `menu language    : ${resolveMenuLanguage(settings.dshHome, app.getPreferredSystemLanguages())}`,
    `update source    : ${settings.updateSource} (repo=${settings.releaseRepo})`,
    `update state     : ${updateState.state}${updateState.tag !== undefined ? ` (${updateState.tag})` : ''}`,
    `build error      : ${updateState.buildError ?? '—'}`,
    `backend url      : ${backendUrl ?? '—'}`,
    `build dir        : ${BUILD_DIR} (${existsSync(BUILD_DIR) ? 'exists' : 'absent'})`,
    `downloads dir    : ${DOWNLOADS_DIR} (${existsSync(DOWNLOADS_DIR) ? 'exists' : 'absent'})`,
    `node             : ${resolveNode(settings, process.env).bin} (${resolveNode(settings, process.env).version ?? '?'})`,
    `pnpm             : ${resolvePnpm(settings, process.env)?.bin ?? 'NOT FOUND (needs pnpm 11)'}`,
    `git              : ${gitBin(settings, process.env)}`,
  ]
  return lines.join('\n')
}

/** Write the diagnostics blob to a file (used by the menu item). */
function writeDiagnostics(filePath: string): void {
  writeFileSync(filePath, `DeepSeek Harness diagnostics\n${'='.repeat(40)}\n${buildDiagnostics()}\n\n--- recent app.log ---\n`)
  try {
    const tail = readFileSync(join(LOGS_DIR, 'app.log'), 'utf8').split('\n').slice(-60).join('\n')
    writeFileSync(filePath, tail, { flag: 'a' })
  } catch { /* log may be absent */ }
}

/** One-line git remote summary (graceful when not a repo). */
function remoteOf(dir: string): string {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 })
    return out.trim()
  } catch {
    return '—'
  }
}

function buildMenu(): void {
  const lang = resolveMenuLanguage(settings.dshHome, app.getPreferredSystemLanguages())
  const T = MENU_STRINGS[lang]
  log(`[menu] language=${lang}`)
  if (SMOKE) console.log(`MENU_LANG ${lang}`)
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: T.about,
          click: () => {
            const s = harnessSnapshot()
            void dialog.showMessageBox({
              type: 'info',
              message: 'DeepSeek Harness 桌面版',
              detail: [
                `应用版本: ${app.getVersion()}`,
                `harness 版本: ${s.version}`,
                `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
                `提交: ${s.commitShort || '（非 git 目录）'}`,
                `tag: ${s.tag || '—'}`,
                `更新通道: ${s.channel} / ${settings.updateSource}`,
                `更新状态: ${updateState.state}${updateState.tag !== undefined ? ` (${updateState.tag})` : ''}`,
                `${updateState.state === 'downloading' && updateState.progress !== undefined
                  ? `下载进度: ${fmtBytes(updateState.progress.received)} / ${fmtBytes(updateState.progress.total)}`
                  : ''}`,
                `harness 目录: ${s.harnessDir}`,
                `数据目录 (DSH_HOME): ${settings.dshHome}`,
                `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
                `编译者: BenSon.Album`,
                `邮箱: chinasir@qq.com`,
              ].join('\n'),
              buttons: ['好'],
            })
          },
        },
        { type: 'separator' },
        {
          label: T.checkUpdates,
          accelerator: 'CmdOrCtrl+U',
          enabled: !updateBusy,
          click: () => void runUpdateCheck(true),
        },
        {
          label: T.restartBackend,
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: !updateBusy,
          click: () => void restartBackend(),
        },
        {
          label: T.openLogs,
          click: () => void shell.openPath(LOGS_DIR),
        },
        {
          label: T.diagnostics,
          click: () => {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const out = join(APP_HOME, `diagnostics-${stamp}.txt`)
            try {
              writeDiagnostics(out)
              void shell.openPath(out)
            } catch (err) {
              void dialog.showMessageBox({ type: 'error', message: '生成诊断报告失败', detail: String(err), buttons: ['好'] })
            }
          },
        },
        { type: 'separator' },
        { role: 'services', label: T.services },
        { type: 'separator' },
        { role: 'hide', label: T.hide },
        { role: 'hideOthers', label: T.hideOthers },
        { role: 'unhide', label: T.unhide },
        { type: 'separator' },
        { role: 'quit', label: T.quit },
      ],
    },
    {
      role: 'editMenu',
      label: T.edit,
      submenu: [
        { role: 'undo', label: T.undo },
        { role: 'redo', label: T.redo },
        { type: 'separator' },
        { role: 'cut', label: T.cut },
        { role: 'copy', label: T.copy },
        { role: 'paste', label: T.paste },
        { role: 'pasteAndMatchStyle', label: T.pasteAndMatchStyle },
        { role: 'delete', label: T.delete },
        { role: 'selectAll', label: T.selectAll },
      ],
    },
    {
      label: T.view,
      submenu: [
        { role: 'reload', label: T.reload },
        { role: 'toggleDevTools', label: T.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: T.resetZoom },
        { role: 'zoomIn', label: T.zoomIn },
        { role: 'zoomOut', label: T.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: T.toggleFullscreen },
      ],
    },
    {
      role: 'windowMenu',
      label: T.window,
      submenu: [
        { role: 'minimize', label: T.minimize },
        { role: 'zoom', label: T.zoom },
        { type: 'separator' },
        { role: 'front', label: T.front },
        { role: 'close', label: T.close },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (SMOKE) {
    // Machine-checkable menu dump: zh should produce Chinese top-level menus.
    const dump = (items: MenuItemConstructorOptions[], depth = 0): string[] =>
      items.flatMap((item) => [
        `${'  '.repeat(depth)}- ${item.label ?? item.role ?? ''}`,
        ...(item.submenu !== undefined && Array.isArray(item.submenu) ? dump(item.submenu as MenuItemConstructorOptions[], depth + 1) : []),
      ])
    console.log(`MENU_DUMP ${lang}\n${dump(template).join('\n')}`)
  }
}

/** Rebuild the menu when dsh-app's language preference changes (~/.dsh/settings.yaml). */
function watchSettingsForMenuReload(): void {
  let timer: NodeJS.Timeout | null = null
  try {
    const dir = settings.dshHome
    if (!existsSync(dir)) return
    const watcher = watch(dir, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : String(filename ?? '')
      if (name !== 'settings.yaml') return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => buildMenu(), 500)
    })
    watcher.on('error', () => { /* ignore watcher errors; menu stays as-is */ })
  } catch { /* watch unavailable: menu language fixed at startup */ }
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
  ipcMain.handle('dsh:check-for-updates', () => { void runUpdateCheck(true); return true })
  ipcMain.handle('dsh:update-status', () => updateState)
  ipcMain.handle('dsh:apply-update', () => { void applyReadyUpdate(); return true })
  ipcMain.handle('dsh:dismiss-update', () => true)
  ipcMain.handle('dsh:restart-backend', () => void restartBackend())
  ipcMain.handle('dsh:open-logs', () => void shell.openPath(LOGS_DIR))
  ipcMain.handle('dsh:cancel-upgrade', () => { updateSignal?.abort(); return true })
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

  // Chromium locale for the renderer's navigator.language. app.getLocale() is
  // already correct on macOS, but the renderer can default to en-US when the
  // system REGION differs from the PREFERRED language (as here: preferred
  // zh-Hans-CN, region en-US). dsh's GUI falls back to navigator.languages
  // when its own locale preference is unset, so pinning the Chromium lang to
  // the OS preferred language makes the GUI follow the OS language.
  const osLang = (app.getPreferredSystemLanguages()[0] ?? '').toLowerCase()
  app.commandLine.appendSwitch('lang', osLang.startsWith('zh') ? 'zh-CN' : 'en-US')

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
    if (DEBUG) log(`[debug] diagnostics:\n${buildDiagnostics()}`)
    try {
      await extractIfNeeded()
      recoverUpdateState()
      const url = await startBackend()
      await loadMainWindow(url)
      watchSettingsForMenuReload()
      scheduleAutoCheck()
    } catch (err) {
      showFatal(err)
    }
  }).catch((err) => showFatal(err))

  app.on('window-all-closed', () => {
    // Startup progress windows closing before the main window exists must
    // NOT quit the app; quit only when the real main window is gone.
    if (mainWindowEverCreated && mainWindow === null) app.quit()
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
