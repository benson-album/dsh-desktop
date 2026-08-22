/**
 * dsh-desktop menu localization.
 *
 * The macOS top menu bar follows the dsh-app language (Host user-settings
 * `locale.preference` in ~/.dsh/settings.yaml, 'zh' | 'en'); when unset it
 * falls back to the macOS system language. Electron hard-codes English labels
 * for role-based menu items, so EVERY menu item (including roles like
 * editMenu/windowMenu and their children) gets an explicit localized label
 * here — nothing is left to Electron's English defaults.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type MenuLang = 'zh' | 'en'

/** Localized labels for every menu item we build (custom and role items). */
export const MENU_STRINGS: Record<MenuLang, Record<string, string>> = {
  zh: {
    // app menu
    about: '关于 DeepSeek Harness',
    services: '服务',
    hide: '隐藏 DeepSeek Harness',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 DeepSeek Harness',
    checkUpdates: '检查更新…',
    settings: '应用设置…',
    restartBackend: '重启后端',
    openLogs: '打开日志目录',
    diagnostics: '生成诊断报告',
    // edit menu
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    // view menu
    view: '视图',
    reload: '重新加载',
    toggleDevTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullscreen: '切换全屏',
    // window menu
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    close: '关闭窗口',
  },
  en: {
    about: 'About DeepSeek Harness',
    services: 'Services',
    hide: 'Hide DeepSeek Harness',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit DeepSeek Harness',
    checkUpdates: 'Check for Updates…',
    settings: 'Settings…',
    restartBackend: 'Restart Backend',
    openLogs: 'Open Logs Folder',
    diagnostics: 'Generate Diagnostics Report',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullscreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    close: 'Close Window',
  },
}

/**
 * Lightweight YAML subset parse: top-level keys at column 0, two-space nested
 * keys. Extracts `locale.preference` (a 'zh' | 'en' value, quotes tolerated).
 * The shell stays dependency-free at runtime, so this is intentionally small.
 */
export function parseLocalePreference(settingsYamlPath: string): MenuLang | undefined {
  let text: string
  try {
    text = readFileSync(settingsYamlPath, 'utf8')
  } catch {
    return undefined
  }
  let inLocale = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (!inLocale) {
      if (line === 'locale' || line === 'locale:' || /^locale:/.test(line)) {
        inLocale = true
        // Inline form: `locale: { preference: en }` (tolerant, uncommon)
        const inline = /preference\s*:\s*["']?(zh|en)["']?/.exec(line)
        if (inline !== null) return inline[1] as MenuLang
      }
      continue
    }
    // Inside the locale block
    if (/^preference\s*:/.test(line)) {
      const value = line.replace(/^preference\s*:\s*/, '').trim().replace(/^["']|["']$/g, '')
      if (value === 'zh' || value === 'en') return value
      continue
    }
    if (/^\S/.test(line)) inLocale = false // left the locale block
  }
  return undefined
}

/**
 * Resolve the menu language:
 *  1. explicit `locale.preference` in ~/.dsh/settings.yaml
 *  2. system preferred languages (zh -> zh, otherwise en)
 *  3. 'zh' fallback (dsh's FALLBACK_LOCALE)
 */
export function resolveMenuLanguage(dshHome: string, systemLanguages: readonly string[]): MenuLang {
  const explicit = parseLocalePreference(join(dshHome, 'settings.yaml'))
  if (explicit !== undefined) return explicit
  const primary = systemLanguages[0]?.toLowerCase() ?? ''
  return primary.startsWith('zh') ? 'zh' : 'en'
}
