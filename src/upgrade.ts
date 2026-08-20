/**
 * dsh-desktop upgrade module — background-first update pipeline.
 *
 * Owns the git-managed harness lifecycle with the "never disturb the running
 * app" principle:
 *  - extractBundle:   first run — unpack the bundled harness into the run dir
 *  - checkForUpdates: pure `git fetch` on the run dir (never touches its
 *                     working tree) and resolve the upgrade target
 *  - buildUpdate:     export the target snapshot (git archive) into a separate
 *                     build dir, then pnpm install + pnpm build there, while
 *                     the old version keeps serving the GUI
 *  - applyBuiltUpdate: atomically swap build dir -> run dir, migrate .git,
 *                     reset HEAD, roll back on failure
 *  - describeHarness: version/commit/tag/dirty snapshot for the About panel
 *
 * Everything shells out to the machine's real git/pnpm/node binaries. No
 * Electron imports here, so the module stays unit-testable under plain Node.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default remote the app clones and updates from. */
export const DEFAULT_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Upgrade channels. 'tag' follows the latest `dsh-v*` release tag; 'master' follows origin/master. */
export type UpgradeChannel = 'tag' | 'master'

/** Upgrade settings resolved by the main process from settings.json + defaults. */
export interface UpgradeSettings {
  harnessDir: string
  channel: UpgradeChannel
  tagPrefix: string
  remote: string
  nodePath?: string
  pnpmPath?: string
  gitPath?: string
}

/** Progress events streamed to the progress window / toast. */
export interface UpgradeEvents {
  phase: (phase: string, detail?: string) => void
  log: (line: string) => void
}

/** Harness snapshot used by the About panel and update dialogs. */
export interface HarnessSnapshot {
  version: string
  commit: string
  commitShort: string
  tag: string
  dirty: boolean
  channel: UpgradeChannel
  harnessDir: string
}

/* ─────────────────────────── update state machine ─────────────────────────── */

export type UpdateState =
  | 'idle' | 'checking' | 'building' | 'ready' | 'applying' | 'applied' | 'failed'

/** Persistent state across crashes, stored at APP_HOME/update-state.json. */
export interface UpdateStateFile {
  state: UpdateState
  fromCommit: string
  toCommit: string
  tag?: string
  targetName: string
  buildError?: string
  startedAt: number
  finishedAt: number
}

export function defaultUpdateState(): UpdateStateFile {
  return {
    state: 'idle', fromCommit: '', toCommit: '', targetName: '', startedAt: 0, finishedAt: 0,
  }
}

export function loadUpdateState(statePath: string): UpdateStateFile {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<UpdateStateFile>
    return { ...defaultUpdateState(), ...raw }
  } catch {
    return defaultUpdateState()
  }
}

export function saveUpdateState(statePath: string, state: UpdateStateFile): void {
  try { writeFileSync(statePath, JSON.stringify(state, null, 2)) } catch { /* best effort */ }
}

/* ─────────────────────────── result types ─────────────────────────── */

export type CheckResult =
  | { status: 'up-to-date'; current: string; target: string; tag?: string }
  | { status: 'update-available'; from: string; to: string; tag?: string; targetName: string }
  | { status: 'not-a-repo'; dir: string }
  | { status: 'no-target'; detail: string }
  | { status: 'failed'; step: string; message: string }
  | { status: 'cancelled' }

export type BuildResult =
  | { status: 'ready'; from: string; to: string; tag?: string }
  | { status: 'failed'; step: string; message: string }
  | { status: 'cancelled' }

export type ApplyResult =
  | { status: 'applied'; from: string; to: string; tag?: string }
  | { status: 'failed'; step: string; message: string }

/* ─────────────────────────── low-level run helpers ─────────────────────────── */

interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  events?: UpgradeEvents
  signal?: AbortSignal
  timeoutMs?: number
  detached?: boolean
}

interface RunResult {
  code: number | null
  tail: string
  killed: boolean
  spawnError?: string
}

const TAIL_LINES = 120

/** Spawn a command, stream stdout/stderr lines to events.log, collect a tail. */
function run(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.detached ?? false,
    })
    const tail: string[] = []
    const push = (line: string): void => {
      tail.push(line)
      if (tail.length > TAIL_LINES) tail.shift()
      options.events?.log(line)
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      const rl = createInterface({ input: stream })
      rl.on('line', (line) => push(line))
    }
    let killed = false
    const killTree = (): void => {
      killed = true
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGTERM') } catch {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
      }
    }
    options.signal?.addEventListener('abort', killTree, { once: true })
    const timer = options.timeoutMs === undefined ? undefined
      : setTimeout(() => killTree(), options.timeoutMs)
    child.on('error', (err) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code: null, tail: tail.join('\n'), killed: false, spawnError: String(err) })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, tail: tail.join('\n'), killed })
    })
  })
}

let cachedGitBin: string | null = null

/** Resolved git binary (cross-device), cached per process. */
export function gitBin(settings: UpgradeSettings, baseEnv: NodeJS.ProcessEnv): string {
  if (cachedGitBin === null) cachedGitBin = resolveGit(settings, baseEnv)
  return cachedGitBin
}

/** Short synchronous git read (rev-parse/status). */
function gitSync(settings: UpgradeSettings, args: readonly string[]): { ok: boolean; out: string; err: string } {
  const res = spawnSync(gitBin(settings, process.env), [...args], {
    cwd: settings.harnessDir, encoding: 'utf8', timeout: 30_000,
  })
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

/** Resolve the latest tag matching the prefix, version-sorted by git itself. */
function latestTag(settings: UpgradeSettings): string | undefined {
  const res = gitSync(settings, ['tag', '--list', `${settings.tagPrefix}*`, '--sort=-v:refname'])
  if (!res.ok) return undefined
  const tags = res.out.split('\n').filter(Boolean)
  return tags[0]
}

/**
 * Environment for harness tooling (cross-device). The user's own PATH stays
 * FIRST (a terminal launch already resolves the right tools), then candidate
 * bin dirs for the current platform are appended best-first so a Finder/desktop
 * launch with a minimal PATH still finds pnpm/node/git.
 */
export function harnessEnv(settings: UpgradeSettings, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = [
    settings.nodePath !== undefined ? dirOf(settings.nodePath) : undefined,
    settings.pnpmPath !== undefined ? dirOf(settings.pnpmPath) : undefined,
    ...platformToolDirs(base).all,
  ].filter((p): p is string => p !== undefined && p !== '')
  const path = [base.PATH ?? '', ...extra].filter(Boolean).join(':')
  return { ...base, PATH: path }
}

/* ─────────── cross-device tool discovery (git / node / pnpm) ─────────── */

export interface ResolvedTool {
  /** Executable to invoke (absolute path, bare name resolved via PATH, or corepack/npx). */
  bin: string
  /** Extra argv prefix (e.g. ['pnpm'] when bin is corepack). */
  prefix: string[]
  /** `--version` output (trimmed, first line), when obtainable. */
  version: string | null
}

/** Platform-specific candidate bin dirs for git/node/pnpm. */
function platformToolDirs(env: NodeJS.ProcessEnv): { node: string[]; pnpm: string[]; git: string[]; all: string[] } {
  const home = env.HOME ?? ''
  const darwin = process.platform === 'darwin'
  const linux = process.platform === 'linux'
  const win = process.platform === 'win32'

  // node: nvm keeps versioned subdirs (~/.nvm/versions/node/vXX/bin)
  const nvmNodeBins = (): string[] => {
    const root = join(home, '.nvm', 'versions', 'node')
    try {
      return readdirSync(root).map((v) => join(root, v, 'bin'))
    } catch {
      return []
    }
  }
  const node = [
    ...(darwin ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(linux ? [join(home, '.volta', 'bin'), '/usr/local/bin', '/usr/bin'] : []),
    ...(win ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')] : []),
    ...nvmNodeBins(),
  ]
  const pnpm = [
    ...pnpmSelfManagedBins(home),
    ...(darwin ? [join(home, 'Library', 'pnpm'), join(home, '.local', 'share', 'pnpm'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(linux ? [join(home, '.local', 'share', 'pnpm'), join(home, '.local', 'bin'), join(home, '.volta', 'bin'), '/usr/local/bin', '/usr/bin'] : []),
    ...(win ? [join(env.LOCALAPPDATA ?? '', 'pnpm'), join(env.APPDATA ?? '', 'npm')] : []),
  ]
  const git = [
    ...(darwin || linux ? ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(win ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd')] : []),
  ]
  return { node, pnpm, git, all: [...new Set([...node, ...pnpm, ...git])] }
}

/** pnpm self-managed tool dirs (macOS corepack-era): ~/Library/pnpm/.tools/pnpm/<version>/bin. */
function pnpmSelfManagedBins(home: string): string[] {
  if (process.platform !== 'darwin') return []
  const toolsRoot = join(home, 'Library', 'pnpm', '.tools', 'pnpm')
  let versions: string[]
  try {
    versions = readdirSync(toolsRoot)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) {
          if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
        }
        return 0
      })
  } catch {
    return []
  }
  return versions.map((v) => join(toolsRoot, v, 'bin'))
}

/** Executable lookup through PATH (no shell). */
function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of (env.PATH ?? '').split(sep).filter(Boolean)) {
    const cand = join(dir, name)
    try {
      if (statSync(cand).isFile()) return cand
    } catch { /* keep looking */ }
  }
  return null
}

/** Find the first usable executable: pins (settings/env) > PATH names > platform dirs. */
function findTool(
  env: NodeJS.ProcessEnv,
  pins: readonly string[],
  commonNames: readonly string[],
  platformDirs: readonly string[],
): string | null {
  const seen = new Set<string>()
  const candidates = [
    ...pins.filter(Boolean),
    ...commonNames,
    ...platformDirs.flatMap((dir) => commonNames.map((name) => join(dir, name))),
  ]
  for (const cand of candidates) {
    if (seen.has(cand)) continue
    seen.add(cand)
    let resolved: string | null = null
    if (cand.includes('/') || cand.includes('\\')) {
      try { if (statSync(cand).isFile()) resolved = cand } catch { /* not there */ }
    } else {
      resolved = whichOnPath(cand, env)
    }
    if (resolved !== null) return resolved
  }
  return null
}

/** Read `bin --version` (with prefix args) under the harness env. */
function versionOf(bin: string, prefix: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  const res = spawnSync(bin, [...prefix, '--version'], { encoding: 'utf8', timeout: 20_000, env, cwd })
  if (res.error !== undefined || res.status !== 0) return null
  const out = ((res.stdout ?? '') + (res.stderr ?? '')).trim().split('\n')[0]
  return out === '' ? null : out
}

const VERSION_OK = (want: (major: number) => boolean) =>
  (v: string): boolean => {
    const cleaned = v.replace(/^v/, '')
    const major = Number(cleaned.split('.')[0])
    return Number.isFinite(major) && want(major)
  }
/** harness lockfile is pnpm 11. */
const PNPM_OK = VERSION_OK((major) => major >= 11)

/** Resolve node (>=22), falling back to a bare name only when nothing is found. */
export function resolveNode(settings: UpgradeSettings, baseEnv: NodeJS.ProcessEnv): ResolvedTool {
  const env = harnessEnv(settings, baseEnv)
  const dirs = platformToolDirs(baseEnv)
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  const found = findTool(env, [settings.nodePath ?? '', baseEnv.DSH_NODE_PATH ?? ''], names, dirs.node)
  if (found === null) return { bin: 'node', prefix: [], version: null }
  const version = versionOf(found, [], env, settings.harnessDir)
  return { bin: found, prefix: [], version }
}

/** Resolve git; falls back to a bare name. */
export function resolveGit(settings: UpgradeSettings, baseEnv: NodeJS.ProcessEnv): string {
  const env = harnessEnv(settings, baseEnv)
  const dirs = platformToolDirs(baseEnv)
  const names = process.platform === 'win32' ? ['git.exe'] : ['git']
  return findTool(env, [settings.gitPath ?? '', baseEnv.DSH_GIT_PATH ?? ''], names, dirs.git) ?? 'git'
}

/**
 * Resolve a pnpm >= 11 for the harness lockfile, across devices:
 *  1. settings.pnpmPath / DSH_PNPM_PATH pin
 *  2. PATH + platform dirs (macOS ~/Library/pnpm, Homebrew; Linux ~/.local/share/pnpm,
 *     Volta, ~/.nvm; Windows LocalAppData/pnpm, APPDATA/npm)
 *  3. corepack (ships with node >= 16.9; `corepack pnpm` honours the repo's
 *     packageManager field and downloads the exact pnpm when needed)
 *  4. npx pnpm@11 (network fallback)
 * Returns null when no pnpm >= 11 can be found.
 */
export function resolvePnpm(settings: UpgradeSettings, baseEnv: NodeJS.ProcessEnv): ResolvedTool | null {
  const env = harnessEnv(settings, baseEnv)
  const dirs = platformToolDirs(baseEnv)
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe'] : ['pnpm']
  const pins = [settings.pnpmPath ?? '', baseEnv.DSH_PNPM_PATH ?? '']

  // Walk every candidate best-first until one satisfies pnpm >= 11: a stale
  // pnpm 10 earlier on PATH must not shadow a pnpm 11 in platform dirs.
  const candidates = [
    ...pins,
    ...names,
    ...dirs.pnpm.flatMap((dir) => names.map((name) => join(dir, name))),
  ]
  const seen = new Set<string>()
  for (const cand of candidates) {
    if (seen.has(cand)) continue
    seen.add(cand)
    let resolved: string | null = null
    if (cand.includes('/') || cand.includes('\\')) {
      try { if (statSync(cand).isFile()) resolved = cand } catch { continue }
    } else {
      resolved = whichOnPath(cand, env)
    }
    if (resolved === null) continue
    const version = versionOf(resolved, [], env, settings.harnessDir)
    if (version !== null && PNPM_OK(version)) return { bin: resolved, prefix: [], version }
  }
  // corepack: `corepack pnpm --version`
  const corepackName = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
  const cp = whichOnPath(corepackName, env)
  if (cp !== null) {
    const version = versionOf(cp, ['pnpm'], env, settings.harnessDir)
    if (version !== null && PNPM_OK(version)) return { bin: cp, prefix: ['pnpm'], version }
  }
  // npx pnpm@11 (network fallback, last resort)
  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const npx = whichOnPath(npxName, env)
  if (npx !== null) {
    const version = versionOf(npx, ['pnpm@11'], env, settings.harnessDir)
    if (version !== null && PNPM_OK(version)) return { bin: npx, prefix: ['pnpm@11'], version }
  }
  return null
}

function dirOf(p: string): string | undefined {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : undefined
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}



/* ─────────────────────────── snapshot / check ─────────────────────────── */

/** Snapshot the harness checkout (graceful when it is not a git repo yet). */
export function describeHarness(settings: UpgradeSettings, baseEnv: NodeJS.ProcessEnv): HarnessSnapshot {
  const manifestPath = join(settings.harnessDir, 'package.json')
  let version = 'unknown'
  if (existsSync(manifestPath)) {
    try {
      version = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }).version ?? 'unknown'
    } catch { /* keep unknown */ }
  }
  let commit = '', commitShort = '', tag = '', dirty = false
  if (existsSync(join(settings.harnessDir, '.git'))) {
    const rev = gitSync(settings, ['rev-parse', 'HEAD'])
    if (rev.ok) {
      commit = rev.out
      commitShort = commit.slice(0, 12)
    }
    const exact = gitSync(settings, ['describe', '--tags', '--exact-match', 'HEAD'])
    if (exact.ok) tag = exact.out
    const st = gitSync(settings, ['status', '--porcelain'])
    dirty = st.ok && st.out.length > 0
  }
  return { version, commit, commitShort, tag, dirty, channel: settings.channel, harnessDir: settings.harnessDir }
}

/**
 * Fetch and decide whether an upgrade exists. Pure `git fetch` — the run
 * dir's working tree is never touched. Does NOT build or modify anything.
 */
export async function checkForUpdates(
  settings: UpgradeSettings,
  baseEnv: NodeJS.ProcessEnv,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<CheckResult> {
  if (!existsSync(join(settings.harnessDir, '.git'))) {
    return { status: 'not-a-repo', dir: settings.harnessDir }
  }
  const env = harnessEnv(settings, baseEnv)

  events.phase('fetching', 'git fetch origin')
  const fetch = await run(settings.gitPath ?? 'git', ['fetch', 'origin', '--tags', '--prune'], {
    cwd: settings.harnessDir, env, events, signal, timeoutMs: 5 * 60_000, detached: true,
  })
  if (fetch.killed) return { status: 'cancelled' }
  if (fetch.code !== 0) {
    return { status: 'failed', step: 'git fetch', message: fetch.tail.slice(-1500) }
  }

  let target: string
  let tag: string | undefined
  if (settings.channel === 'tag') {
    const latest = latestTag(settings)
    if (latest === undefined) return { status: 'no-target', detail: `no tag matching "${settings.tagPrefix}*"` }
    tag = latest
    target = latest
  } else {
    target = 'origin/master'
  }

  const current = gitSync(settings, ['rev-parse', 'HEAD'])
  const toCommit = gitSync(settings, ['rev-parse', `${target}^{commit}`])
  if (!current.ok || !toCommit.ok) {
    return { status: 'failed', step: 'resolve refs', message: `${current.err} ${toCommit.err}`.trim() }
  }
  const from = current.out
  const to = toCommit.out
  if (from === to) {
    return { status: 'up-to-date', current: from, target: to, tag }
  }
  return { status: 'update-available', from, to, tag, targetName: tag ?? 'origin/master' }
}

/* ─────────────────────────── background build ─────────────────────────── */

/**
 * Build the new version in a separate build dir while the old one keeps
 * serving. The target snapshot is exported with `git archive` (no .git), then
 * pnpm install + build run inside the build dir.
 */
export async function buildUpdate(
  settings: UpgradeSettings,
  baseEnv: NodeJS.ProcessEnv,
  buildDir: string,
  toCommit: string,
  tag: string | undefined,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<BuildResult> {
  // 构建区是 `git archive` 导出的快照（无 .git）：rc.8 起 harness 的
  // scripts/build.ts 会执行 `git rev-parse HEAD` 取提交哈希，在无 .git 目录下
  // git 以 128 退出导致 pnpm build 失败。harness 的 repositoryCommitHash() 优先
  // 读取 DSH_CLIENT_COMMIT_HASH 环境变量，这里注入目标提交以绕开对 .git 的依赖。
  const env: NodeJS.ProcessEnv = { ...harnessEnv(settings, baseEnv), DSH_CLIENT_COMMIT_HASH: toCommit }
  const gitBinResolved = gitBin(settings, baseEnv)

  // Clean slate for the build dir.
  try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { mkdirSync(parentOf(buildDir), { recursive: true }) } catch { /* best effort */ }

  events.phase('exporting', `git archive ${tag ?? toCommit.slice(0, 12)}`)
  const archivePath = join(parentOf(buildDir), `.dsh-archive-${Date.now()}.tar`)
  const archive = await run(gitBinResolved, ['archive', '--format=tar', '-o', archivePath, toCommit], {
    cwd: settings.harnessDir, env, events, signal, timeoutMs: 5 * 60_000,
  })
  if (archive.killed) return { status: 'cancelled' }
  if (archive.code !== 0) {
    return { status: 'failed', step: 'git archive', message: archive.tail.slice(-1500) }
  }
  try { mkdirSync(buildDir, { recursive: true }) } catch { /* best effort */ }
  const extract = await run('tar', ['-xf', archivePath, '-C', buildDir], {
    cwd: parentOf(buildDir), env, events, signal, timeoutMs: 5 * 60_000,
  })
  try { rmSync(archivePath, { force: true }) } catch { /* best effort */ }
  if (extract.killed) return { status: 'cancelled' }
  if (extract.code !== 0) {
    return { status: 'failed', step: 'extract archive', message: extract.tail.slice(-1500) }
  }

  const install = await runHarnessBuild(settings, env, 'install', buildDir, events, signal)
  if (install.killed) return { status: 'cancelled' }
  if (!install.ok) {
    cleanupBuildDir(buildDir)
    return { status: 'failed', step: 'pnpm install', message: install.tail.slice(-1500) }
  }

  const build = await runHarnessBuild(settings, env, 'build', buildDir, events, signal)
  if (build.killed) return { status: 'cancelled' }
  if (!build.ok) {
    cleanupBuildDir(buildDir)
    return { status: 'failed', step: 'pnpm build', message: build.tail.slice(-1500) }
  }

  return { status: 'ready', from: describeHarness(settings, baseEnv).commit, to: toCommit, tag }
}

function cleanupBuildDir(buildDir: string): void {
  try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/** pnpm install / pnpm build in a given work dir (build dir). */
async function runHarnessBuild(
  settings: UpgradeSettings,
  env: NodeJS.ProcessEnv,
  step: 'install' | 'build',
  cwd: string,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<{ ok: boolean; tail: string; killed: boolean }> {
  // Cross-device pnpm discovery: pin > PATH/platform dirs > corepack > npx.
  // Only a pnpm >= 11 (the harness lockfile's requirement) is accepted.
  const pnpm = resolvePnpm(settings, env)
  if (pnpm === null) {
    const message = '找不到满足要求的 pnpm 11（用于构建 harness）。'
      + '请安装 pnpm 11（corepack pnpm / pnpm i -g pnpm@11），'
      + '或在 settings.json 的 "pnpmPath" 指定 pnpm 11 的绝对路径。'
    events.log(`[dsh-app] ${message}`)
    return { ok: false, tail: message, killed: false }
  }
  const pnpmArgs = (args: readonly string[]): string[] => [...pnpm.prefix, ...args]
  if (step === 'install') {
    // CI=true lets pnpm drop a stale node_modules without a TTY prompt
    // (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
    const installEnv = { ...env, CI: 'true' }
    events.phase('installing', 'pnpm install --frozen-lockfile')
    const frozen = await run(pnpm.bin, pnpmArgs(['install', '--frozen-lockfile']), {
      cwd, env: installEnv, events, signal, detached: true,
    })
    if (frozen.killed) return { ok: false, tail: frozen.tail, killed: true }
    if (frozen.code === 0) return { ok: true, tail: frozen.tail, killed: false }
    events.log('[dsh-app] frozen install failed; retrying with a plain install')
    const plain = await run(pnpm.bin, pnpmArgs(['install']), {
      cwd, env: installEnv, events, signal, detached: true,
    })
    return { ok: plain.code === 0, tail: plain.tail, killed: plain.killed }
  }
  events.phase('building', 'pnpm build (lib + web)')
  const build = await run(pnpm.bin, pnpmArgs(['build']), {
    cwd, env, events, signal, detached: true,
  })
  return { ok: build.code === 0, tail: build.tail, killed: build.killed }
}

/* ─────────────────────────── atomic apply ─────────────────────────── */

/**
 * Swap the built dir into the run dir atomically, migrate the old .git,
 * reset HEAD to the new commit, and roll back on any failure.
 * Caller must stop the backend first and verify the run dir is clean.
 */
export async function applyBuiltUpdate(
  settings: UpgradeSettings,
  buildDir: string,
  toCommit: string,
  tag: string | undefined,
): Promise<ApplyResult> {
  const harness = settings.harnessDir
  const backup = `${harness}-old`
  const gitBinResolved = gitBin(settings, process.env)
  const fromCommit = gitSync(settings, ['rev-parse', 'HEAD']).out

  if (!existsSync(join(buildDir, 'apps', 'cli', 'lib', 'bin.js'))) {
    return { status: 'failed', step: 'validate', message: `build dir missing backend entry: ${buildDir}` }
  }
  if (!existsSync(join(harness, '.git'))) {
    return { status: 'failed', step: 'validate', message: 'run dir is missing .git; cannot migrate repository state' }
  }

  // 1. backup run dir, promote build dir
  try {
    rmSync(backup, { recursive: true, force: true })
    renameSync(harness, backup)
    renameSync(buildDir, harness)
  } catch (err) {
    rollbackSwap(harness, backup)
    return { status: 'failed', step: 'swap directories', message: String(err) }
  }

  // 2. validate promoted dir, else roll back
  if (!existsSync(join(harness, 'apps', 'cli', 'lib', 'bin.js'))) {
    rollbackSwap(harness, backup)
    return { status: 'failed', step: 'validate promoted', message: 'promoted harness is missing the backend entry' }
  }

  // 3. migrate .git and align HEAD
  try {
    renameSync(join(backup, '.git'), join(harness, '.git'))
    const res = spawnSync(gitBinResolved, ['reset', '--hard', toCommit], {
      cwd: harness, encoding: 'utf8', timeout: 60_000,
    })
    if (res.status !== 0) throw new Error((res.stderr ?? res.stdout ?? '').slice(-800))
  } catch (err) {
    // roll back: restore the backup
    try { rmSync(harness, { recursive: true, force: true }) } catch { /* best effort */ }
    try { renameSync(backup, harness) } catch { /* best effort */ }
    return { status: 'failed', step: 'migrate git', message: String(err) }
  }

  // 4. cleanup backup
  try { rmSync(backup, { recursive: true, force: true }) } catch { /* best effort */ }
  return { status: 'applied', from: fromCommit, to: toCommit, tag }
}

function rollbackSwap(harness: string, backup: string): void {
  try {
    if (existsSync(harness)) rmSync(harness, { recursive: true, force: true })
  } catch { /* best effort */ }
  try {
    if (existsSync(backup)) renameSync(backup, harness)
  } catch { /* best effort */ }
}

/* ─────────────────────────── first-run extract ─────────────────────────── */

/**
 * First run: unpack the bundled harness archive (tar.gz, built by
 * scripts/bundle-harness.sh) into the run dir. tar preserves pnpm's symlinks.
 * No git, no network.
 */
export async function extractBundle(
  bundleArchive: string,
  harnessDir: string,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<void> {
  events.phase('extracting', 'unpack bundled harness')
  if (!existsSync(bundleArchive)) {
    throw new Error(`bundled harness missing: ${bundleArchive}`)
  }
  try { mkdirSync(parentOf(harnessDir), { recursive: true }) } catch { /* best effort */ }
  try { mkdirSync(harnessDir, { recursive: true }) } catch { /* best effort */ }
  const res = await run('tar', ['-xzf', bundleArchive, '-C', harnessDir], {
    cwd: parentOf(harnessDir), env: process.env, events, signal, timeoutMs: 15 * 60_000,
  })
  if (res.killed) throw new Error('extract cancelled')
  if (res.code !== 0 || !existsSync(join(harnessDir, 'apps', 'cli', 'lib', 'bin.js'))) {
    try { rmSync(harnessDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw new Error(`failed to extract bundled harness: ${res.tail.slice(-800)}`)
  }
}
