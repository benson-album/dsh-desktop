/**
 * dsh-desktop preload — exposes a minimal, typed API to the renderer
 * (the harness GUI page and the small progress window) via contextBridge.
 * No Node primitives leak into the page: everything goes through IPC.
 */

import { contextBridge, ipcRenderer } from 'electron'

export interface DshVersions {
  app: string
  harness: string
  commit: string
  tag: string
  channel: string
  harnessDir: string
  dshHome: string
  appHome: string
  backendUrl: string | null
}

export interface PhaseEvent { phase: string; detail?: string }

const api = {
  versions: (): Promise<DshVersions> => ipcRenderer.invoke('dsh:versions'),
  checkForUpdates: (): Promise<boolean> => ipcRenderer.invoke('dsh:check-for-updates'),
  updateStatus: (): Promise<UpdateStateInfo> => ipcRenderer.invoke('dsh:update-status'),
  applyUpdate: (): Promise<boolean> => ipcRenderer.invoke('dsh:apply-update'),
  dismissUpdate: (): Promise<boolean> => ipcRenderer.invoke('dsh:dismiss-update'),
  restartBackend: (): Promise<void> => ipcRenderer.invoke('dsh:restart-backend'),
  openLogs: (): Promise<void> => ipcRenderer.invoke('dsh:open-logs'),
  cancelUpgrade: (): Promise<boolean> => ipcRenderer.invoke('dsh:cancel-upgrade'),
  onPhase: (callback: (event: PhaseEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: PhaseEvent): void => callback(payload)
    ipcRenderer.on('dsh:phase', listener)
    return () => { ipcRenderer.removeListener('dsh:phase', listener) }
  },
  onLog: (callback: (line: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, line: string): void => callback(line)
    ipcRenderer.on('dsh:log', listener)
    return () => { ipcRenderer.removeListener('dsh:log', listener) }
  },
  onUpdateEvent: (callback: (state: UpdateStateInfo) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: UpdateStateInfo): void => callback(payload)
    ipcRenderer.on('dsh:update-event', listener)
    return () => { ipcRenderer.removeListener('dsh:update-event', listener) }
  },
}

contextBridge.exposeInMainWorld('dsh', api)

/* ── settings window API (src/settings.html) ── */

export interface SettingsSnapshot {
  updateSource: string
  channel: string
  autoCheck: boolean
  autoCheckIntervalMs: number
  releaseManifestUrl?: string
  releaseDownloadMirrors?: string[]
  harnessDir: string
  dshHome: string
  appHome: string
  releaseRepo: string
  remote: string
  releaseAssetPattern: string
  tagPrefix: string
  nodePath?: string
  pnpmPath?: string
  gitPath?: string
  locale: string
  appVersion: string
  harnessVersion: string
  updateState: string
}

const settingsApi = {
  get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke('dsh:settings-get'),
  save: (patch: Record<string, unknown>): Promise<boolean> => ipcRenderer.invoke('dsh:settings-save', patch),
  openSettingsFile: (): Promise<void> => ipcRenderer.invoke('dsh:settings-open-file'),
  openDshSettingsFile: (): Promise<void> => ipcRenderer.invoke('dsh:settings-open-dsh-file'),
  openRepo: (): Promise<void> => ipcRenderer.invoke('dsh:settings-open-repo'),
  browseDir: (): Promise<string | null> => ipcRenderer.invoke('dsh:settings-browse-dir'),
  close: (): void => ipcRenderer.send('dsh:settings-close'),
}

contextBridge.exposeInMainWorld('dshSettings', settingsApi)

/** Mirror of the main-process UpdateStateFile (only the fields the UI needs). */
export interface UpdateStateInfo {
  state: string
  fromCommit: string
  toCommit: string
  tag?: string
  targetName: string
  buildError?: string
  startedAt: number
  finishedAt: number
  source?: 'release' | 'source'
  assetUrl?: string
  progress?: { received: number; total: number }
}

/* ─────────────── immersive window: injected drag region ─────────────── */

const DRAG_REGION_ID = 'dsh-drag-region'
const WC_STYLE_ID = 'dsh-wc-style'

/**
 * Inject a top drag strip into the harness page so the frameless
 * (titleBarStyle:'hidden') window stays draggable. The native traffic lights
 * are system-rendered above the web content, so this strip never blocks them.
 * Runs in the preload's isolated world but shares the page DOM: the nodes are
 * appended to <body> and never touch harness source code.
 */
function injectDragRegion(): void {
  if (document.getElementById(DRAG_REGION_ID) !== null) return // idempotent
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', injectDragRegion, { once: true })
    return
  }
  const style = document.createElement('style')
  style.id = WC_STYLE_ID
  style.textContent = `
    #${DRAG_REGION_ID} {
      position: fixed; top: 0; left: 0; right: 0; height: 32px;
      -webkit-app-region: drag;
      z-index: 2147483000;
    }
    #${DRAG_REGION_ID}.dsh-fullscreen { display: none !important; }
  `
  const region = document.createElement('div')
  region.id = DRAG_REGION_ID
  region.addEventListener('dblclick', () => {
    ipcRenderer.send('dsh:window-control', 'toggle-maximize')
  })
  document.head.appendChild(style)
  document.body.appendChild(region)

  ipcRenderer.on('dsh:window-state', (_e, state: { maximized: boolean; fullscreen: boolean }) => {
    region.classList.toggle('dsh-fullscreen', state.fullscreen === true)
  })
}

injectDragRegion()

/* ─────────────── update-ready toast (background-built version) ─────────────── */

const TOAST_ID = 'dsh-update-toast'
const TOAST_STYLE_ID = 'dsh-toast-style'
let toastDismissedTag = ''

/** Toast copy follows the dsh-app UI language (same source as the menus). */
type ToastText = {
  title: (tag: string) => string
  detail: string
  failedTitle: string
  dismiss: string
  apply: string
}
const TOAST_TEXT: Record<string, ToastText> = {
  zh: {
    title: (tag) => `新版本 ${tag} 已就绪`,
    detail: '已在后台构建完成，点击更新后需重启生效。',
    failedTitle: '自动更新失败',
    dismiss: '忽略',
    apply: '立即更新',
  },
  en: {
    title: (tag) => `New version ${tag} is ready`,
    detail: 'Built in the background. Click update; a restart is needed.',
    failedTitle: 'Update failed',
    dismiss: 'Dismiss',
    apply: 'Update Now',
  },
}

/**
 * Non-modal bottom-right toast shown when the background build is ready.
 * Never interrupts the running GUI; it can be ignored or dismissed.
 * Colors reference the harness design tokens (--dsw-alias-* on <body>, which
 * follow light/dark theme) with hard-coded fallbacks when tokens are absent.
 */
function injectUpdateToast(): void {
  if (document.getElementById(TOAST_ID) !== null) return
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', injectUpdateToast, { once: true })
    return
  }
  const style = document.createElement('style')
  style.id = TOAST_STYLE_ID
  style.textContent = `
    #${TOAST_ID} {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483001;
      display: none; box-sizing: border-box; max-width: 360px;
      background: var(--dsw-alias-bg-overlay, rgba(28, 30, 34, 0.96));
      color: var(--dsw-alias-label-primary, #e6e6e6);
      border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
      border-radius: 10px;
      padding: 12px 14px; font: 12.5px/1.5 -apple-system, "PingFang SC", sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    }
    #${TOAST_ID} .dsh-toast-title { font-weight: 600; margin-bottom: 4px; }
    #${TOAST_ID} .dsh-toast-detail {
      color: var(--dsw-alias-label-primary-dimmed, #9aa0a6); margin-top: 2px;
    }
    #${TOAST_ID} .dsh-toast-actions { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
    #${TOAST_ID} button {
      background: var(--dsw-alias-interactive-bg-hover, #2f343d);
      color: var(--dsw-alias-label-primary, #e6e6e6);
      border: 1px solid var(--dsw-alias-border-l3, #3a4048);
      border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
    }
    #${TOAST_ID} button:hover {
      background: var(--dsw-alias-interactive-bg-hover-accent, #3a4048);
    }
    #${TOAST_ID} button.dsh-primary {
      background: var(--dsw-alias-button-primary-fill, #0b5fff);
      border-color: var(--dsw-alias-button-primary-fill, #0b5fff);
      color: var(--dsw-alias-label-primary-foreground, #ffffff);
    }
    #${TOAST_ID}.dsh-fullscreen { display: none !important; }
  `
  const toast = document.createElement('div')
  toast.id = TOAST_ID
  toast.innerHTML = `
    <div class="dsh-toast-title"></div>
    <div class="dsh-toast-detail"></div>
    <div class="dsh-toast-actions">
      <button class="dsh-dismiss"></button>
      <button class="dsh-apply dsh-primary"></button>
    </div>
  `
  const title = toast.querySelector('.dsh-toast-title') as HTMLElement
  const detail = toast.querySelector('.dsh-toast-detail') as HTMLElement
  const applyBtn = toast.querySelector('.dsh-apply') as HTMLButtonElement
  const dismissBtn = toast.querySelector('.dsh-dismiss') as HTMLButtonElement

  let updateStateCache: UpdateStateInfo = { state: 'idle', fromCommit: '', toCommit: '', targetName: '', startedAt: 0, finishedAt: 0 }
  let toastLang = 'zh'

  const showToast = (state: UpdateStateInfo): void => {
    const T = TOAST_TEXT[toastLang === 'en' ? 'en' : 'zh']
    applyBtn.textContent = T.apply
    dismissBtn.textContent = T.dismiss
    if (state.state === 'ready' && state.tag !== toastDismissedTag) {
      title.textContent = T.title(state.tag ?? state.toCommit.slice(0, 12))
      detail.textContent = T.detail
      toast.style.display = 'block'
    } else if (state.state === 'failed' && state.buildError !== undefined) {
      title.textContent = T.failedTitle
      detail.textContent = state.buildError.slice(0, 120)
      toast.style.display = 'block'
      applyBtn.style.display = 'none'
    } else {
      toast.style.display = 'none'
    }
  }
  void ipcRenderer.invoke('dsh:menu-language').then((lang: string) => {
    toastLang = lang
    showToast(updateStateCache)
  })
  applyBtn.addEventListener('click', () => {
    toast.style.display = 'none'
    void ipcRenderer.invoke('dsh:apply-update')
  })
  dismissBtn.addEventListener('click', () => {
    toastDismissedTag = updateStateCache.tag ?? toastDismissedTag
    toast.style.display = 'none'
    void ipcRenderer.invoke('dsh:dismiss-update')
  })

  ipcRenderer.on('dsh:update-event', (_e, state: UpdateStateInfo) => {
    updateStateCache = state
    showToast(state)
  })
  ipcRenderer.on('dsh:window-state', (_e, state: { fullscreen: boolean }) => {
    toast.classList.toggle('dsh-fullscreen', state.fullscreen === true)
  })

  document.head.appendChild(style)
  document.body.appendChild(toast)
  // Reconcile with any pre-existing state (e.g. ready before the page loaded).
  void ipcRenderer.invoke('dsh:update-status').then((state: UpdateStateInfo) => {
    updateStateCache = state
    showToast(state)
  })
}

injectUpdateToast()
