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
import { createHash } from 'node:crypto'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** Default remote the app clones and updates from. */
export const DEFAULT_REMOTE = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Default repo that hosts the release assets (this shell's repo). */
export const DEFAULT_RELEASE_REPO = 'benson-album/dsh-desktop'

/** Upgrade channels. 'tag' follows the latest `dsh-v*` release tag; 'master' follows origin/master. */
export type UpgradeChannel = 'tag' | 'master'

/** Update source: 'release' downloads a prebuilt artifact from GitHub Releases; 'source' builds from git. */
export type UpdateSource = 'release' | 'source'

/** Upgrade settings resolved by the main process from settings.json + defaults. */
export interface UpgradeSettings {
  harnessDir: string
  channel: UpgradeChannel
  tagPrefix: string
  remote: string
  nodePath?: string
  pnpmPath?: string
  gitPath?: string
  // Release channel (§8 / §13)
  updateSource: UpdateSource
  /** Repo that hosts the release artifacts, `owner/repo`. */
  releaseRepo: string
  /** Artifact name pattern (informational; matching is by os+arch in the manifest). */
  releaseAssetPattern: string
  /** Explicit manifest URL override (e.g. a mirror); defaults to GitHub `releases/latest/download/latest.json`. */
  releaseManifestUrl?: string
  /**
   * Download mirrors for the artifact, ghproxy-style: each entry is a PREFIX that
   * is prepended to the full GitHub asset URL, e.g. `https://ghfast.top/` turns
   * `https://github.com/…` into `https://ghfast.top/https://github.com/…`.
   * The downloader tries candidates in "best-first" order with automatic
   * failover (see downloadAssetSmart); sha256 verification guarantees integrity
   * regardless of which mirror served the bytes.
   */
  releaseDownloadMirrors?: string[]
}

/** Progress events streamed to the progress window / toast. */
export interface UpgradeEvents {
  phase: (phase: string, detail?: string) => void
  log: (line: string) => void
  /** Download progress (bytes). Used by the release channel; throttled by the caller. */
  progress?: (received: number, total: number) => void
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

/* ─────────────────────────── release manifest (protocol v1, §4 / §13) ─────────────────────────── */

export interface ReleaseAsset {
  name: string
  url: string
  sha256: string
  size: number
  os: string
  arch: string
}

export interface ReleaseManifest {
  schemaVersion?: number
  version: string
  tag: string
  publishedAt?: string
  notes?: string
  assets: ReleaseAsset[]
}

/**
 * Parse + validate a latest.json manifest. Returns null when required fields
 * are missing or malformed (the caller turns that into a failed check).
 * Unknown fields are ignored — old shells stay compatible with new manifests.
 */
export function parseReleaseManifest(raw: string): ReleaseManifest | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const m = doc as Record<string, unknown>
  if (typeof m.version !== 'string' || m.version === '' || typeof m.tag !== 'string' || m.tag === '') return null
  if (!Array.isArray(m.assets)) return null
  const assets: ReleaseAsset[] = []
  for (const a of m.assets as unknown[]) {
    if (typeof a !== 'object' || a === null) return null
    const item = a as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.url !== 'string' || typeof item.sha256 !== 'string'
      || typeof item.size !== 'number' || typeof item.os !== 'string' || typeof item.arch !== 'string') {
      return null
    }
    assets.push({ name: item.name, url: item.url, sha256: item.sha256, size: item.size, os: item.os, arch: item.arch })
  }
  if (assets.length === 0) return null
  return {
    schemaVersion: typeof m.schemaVersion === 'number' ? m.schemaVersion : 1,
    version: m.version,
    tag: m.tag,
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : undefined,
    notes: typeof m.notes === 'string' ? m.notes : undefined,
    assets,
  }
}

/** Node platform name as used in the manifest (`process.platform`: darwin/win32/linux). */
export function manifestOs(): string {
  return process.platform
}

/** Node arch name as used in the manifest (`process.arch`: x64/arm64/arm). */
export function manifestArch(): string {
  return process.arch
}

/** Pick the artifact matching the host os+arch; null when no artifact exists for this machine. */
export function matchAsset(manifest: ReleaseManifest, os: string, arch: string): ReleaseAsset | null {
  return manifest.assets.find((a) => a.os === os && a.arch === arch) ?? null
}

/**
 * Default manifest URL: the manifest is synced to the repo's main branch
 * (`latest.json` at the repo root) so it does NOT depend on
 * `releases/latest` — a newer shell release (dsh-desktop-v*) would shadow the
 * content release and make `releases/latest/download/latest.json` 404.
 * Served via jsDelivr CDN: `raw.githubusercontent.com` is unreachable in many
 * networks (esp. CN), while jsDelivr has good global/CN reachability.
 * `releaseManifestUrl` in settings.json overrides this default.
 */
export function releaseManifestUrl(settings: UpgradeSettings): string {
  if (settings.releaseManifestUrl !== undefined && settings.releaseManifestUrl !== '') return settings.releaseManifestUrl
  return `https://cdn.jsdelivr.net/gh/${settings.releaseRepo}@main/latest.json`
}

/* ─────────────────────────── update state machine ─────────────────────────── */

export type UpdateState =
  | 'idle' | 'checking' | 'building' | 'downloading' | 'extracting'
  | 'ready' | 'applying' | 'applied' | 'failed'

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
  /** Channel that produced this update ('release' | 'source'); release state may lack commits. */
  source?: UpdateSource
  /** Artifact URL for the release channel (diagnostics). */
  assetUrl?: string
  /** Download progress (release channel, in-memory only, not persisted frequently). */
  progress?: { received: number; total: number }
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
  | { status: 'update-available'; from: string; to: string; tag?: string; targetName: string; assetUrl?: string; assetSha256?: string; assetSize?: number }
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
 * Decide whether an upgrade exists. The release channel fetches the latest
 * manifest from GitHub Releases; the source channel runs a pure `git fetch`
 * (the run dir's working tree is never touched). Never builds or modifies.
 */
export async function checkForUpdates(
  settings: UpgradeSettings,
  baseEnv: NodeJS.ProcessEnv,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<CheckResult> {
  if (settings.updateSource === 'release') return checkReleaseUpdates(settings, events, signal)
  return checkGitUpdates(settings, baseEnv, events, signal)
}

/** Source channel: pure `git fetch` + tag resolution (existing pipeline, kept intact). */
async function checkGitUpdates(
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

/* ─────────────────────────── release channel (check) ─────────────────────────── */

/** Release channel: fetch latest.json, pick the host's artifact, compare versions. */
async function checkReleaseUpdates(
  settings: UpgradeSettings,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const url = releaseManifestUrl(settings)
  events.phase('checking', url)
  const res = await httpGetText(url, 30_000, signal)
  if (res.cancelled) return { status: 'cancelled' }
  if (!res.ok) return { status: 'failed', step: 'fetch manifest', message: `${url}: ${res.message}` }
  const manifest = parseReleaseManifest(res.text)
  if (manifest === null) return { status: 'failed', step: 'parse manifest', message: `invalid latest.json from ${url}` }
  const asset = matchAsset(manifest, manifestOs(), manifestArch())
  if (asset === null) {
    return { status: 'no-target', detail: `no artifact for ${process.platform}-${process.arch} in ${manifest.tag}` }
  }
  const current = currentVersion(settings.harnessDir, settings)
  const from = current.version
  const to = manifest.version
  if (from === to) return { status: 'up-to-date', current: from, target: to, tag: manifest.tag }
  events.log(`[release] found ${manifest.tag}: ${from} -> ${to}`)
  return {
    status: 'update-available', from, to, tag: manifest.tag, targetName: manifest.tag,
    assetUrl: asset.url, assetSha256: asset.sha256, assetSize: asset.size,
  }
}

/**
 * Local version for the release channel: harness/version.json first (written by
 * the release packaging), then the git-based snapshot as a fallback.
 */
export function currentVersion(harnessDir: string, settings: UpgradeSettings): { version: string; commit: string; tag: string } {
  const vj = join(harnessDir, 'version.json')
  if (existsSync(vj)) {
    try {
      const v = JSON.parse(readFileSync(vj, 'utf8')) as { version?: unknown; commit?: unknown }
      if (typeof v.version === 'string' && v.version !== '') {
        return { version: v.version, commit: typeof v.commit === 'string' ? v.commit : '', tag: '' }
      }
    } catch { /* fall through to the git snapshot */ }
  }
  const s = describeHarness({ ...settings, harnessDir }, process.env)
  return { version: s.version, commit: s.commit, tag: s.tag }
}

/** Pick the http(s) client by URL scheme (local mirrors / tests may be plain http). */
function httpGetByScheme(
  url: string,
  opts: { headers: Record<string, string> },
  cb: (res: import('node:http').IncomingMessage) => void,
): import('node:http').ClientRequest {
  return url.startsWith('https:')
    ? httpsGet(url, opts, cb)
    : httpGet(url, opts, cb)
}

/** GET text with redirect following (GitHub `releases/latest/download` redirects) + abort support. */
function httpGetText(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  redirects = 5,
): Promise<{ ok: boolean; text: string; message: string; cancelled: boolean }> {
  return new Promise((resolve) => {
    let done = false
    let ignoreError = false
    const finish = (r: { ok: boolean; text: string; message: string; cancelled: boolean }): void => {
      if (!done) { done = true; resolve(r) }
    }
    const req = httpGetByScheme(url, { headers: { 'User-Agent': 'dsh-desktop-updater' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location !== undefined && redirects > 0) {
        ignoreError = true
        res.resume()
        req.destroy()
        void httpGetText(new URL(res.headers.location, url).toString(), timeoutMs, signal, redirects - 1).then(finish)
        return
      }
      if (status !== 200) {
        res.resume()
        finish({ ok: false, text: '', message: `HTTP ${status}`, cancelled: false })
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8'), message: '', cancelled: false }))
      res.on('error', (err) => finish({ ok: false, text: '', message: String(err), cancelled: false }))
    })
    req.on('error', (err) => {
      if (ignoreError) return
      finish({ ok: false, text: '', message: String(err), cancelled: false })
    })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    const onAbort = (): void => finish({ ok: false, text: '', message: 'cancelled', cancelled: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) })
  })
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

/* ─────────────────────────── release channel (produce candidate) ─────────────────────────── */

/**
 * Produce the next-version candidate in the build dir while the old version
 * keeps serving. Channel dispatch:
 *  - source:  existing git archive + pnpm install/build pipeline (buildUpdate)
 *  - release: download the artifact → verify size+sha256 → extract → validate
 */
export async function produceUpdate(
  settings: UpgradeSettings,
  baseEnv: NodeJS.ProcessEnv,
  buildDir: string,
  downloadsDir: string,
  target: { from: string; to: string; tag?: string; assetUrl?: string; assetSha256?: string; assetSize?: number },
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<BuildResult> {
  if (settings.updateSource !== 'release') {
    return buildUpdate(settings, baseEnv, buildDir, target.to, target.tag, events, signal)
  }
  if (target.assetUrl === undefined) {
    return { status: 'failed', step: 'download', message: 'update-available without assetUrl (release channel)' }
  }
  const tagDir = join(downloadsDir, target.tag ?? target.to)
  const zipPath = join(tagDir, `${target.tag ?? target.to}.tar.gz`)
  const cleanupDownloads = (): void => {
    try { rmSync(tagDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  try { rmSync(tagDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { mkdirSync(tagDir, { recursive: true }) } catch { /* best effort */ }

  // 1. download with mirror failover (.part → rename)
  events.phase('downloading', target.assetUrl)
  const dl = await downloadAssetSmart(settings, target.assetUrl, zipPath, events, signal)
  if (!dl.ok) {
    if (dl.cancelled) return { status: 'cancelled' }
    cleanupDownloads()
    return { status: 'failed', step: 'download', message: dl.message.slice(-500) }
  }

  // 2. verify size + sha256 against the manifest
  events.phase('verifying', 'sha256 + size')
  let size = 0
  try { size = statSync(zipPath).size } catch { /* 0 */ }
  if (target.assetSize !== undefined && size !== target.assetSize) {
    cleanupDownloads()
    return { status: 'failed', step: 'verify', message: `size mismatch: expected ${target.assetSize}, got ${size}` }
  }
  const sha = await sha256File(zipPath).catch(() => '')
  if (sha === '' || (target.assetSha256 !== undefined && sha !== target.assetSha256)) {
    cleanupDownloads()
    return { status: 'failed', step: 'verify', message: 'sha256 mismatch (artifact integrity check failed)' }
  }

  // 3. extract into the build dir and validate
  const ex = await extractAsset(zipPath, buildDir, target.to, events, signal)
  if (!ex.ok) {
    if (ex.cancelled) return { status: 'cancelled' }
    cleanupDownloads()
    try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* best effort */ }
    return { status: 'failed', step: 'extract', message: ex.message.slice(-500) }
  }
  cleanupDownloads()
  return { status: 'ready', from: target.from, to: target.to, tag: target.tag }
}

/** Default ghproxy-style mirrors (CN-friendly) used when settings don't specify any. */
const DEFAULT_DOWNLOAD_MIRRORS: readonly string[] = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://github.moeyy.xyz/',
]

/** Mirrors configured in settings, or the built-in defaults. */
function downloadMirrors(settings: UpgradeSettings): readonly string[] {
  if (settings.releaseDownloadMirrors !== undefined && settings.releaseDownloadMirrors.length > 0) {
    return settings.releaseDownloadMirrors
  }
  return DEFAULT_DOWNLOAD_MIRRORS
}

/**
 * Session memory of the mirror that last succeeded, so subsequent downloads
 * try the proven-fast path first ("best-first" order):
 *   [last-good mirror (if any)] → [direct github.com] → [other mirrors]
 * The direct URL is always kept in the rotation as the integrity/fallback
 * baseline; sha256 verification happens after the download either way.
 */
let lastGoodMirror: string | null = null

function downloadCandidates(settings: UpgradeSettings, baseUrl: string): string[] {
  const mirrors = downloadMirrors(settings)
  const direct: string = baseUrl
  const prefixed = (m: string): string => `${m}${baseUrl}`
  const ordered: string[] = []
  if (lastGoodMirror !== null) ordered.push(prefixed(lastGoodMirror))
  ordered.push(direct)
  for (const m of mirrors) {
    const p = prefixed(m)
    if (!ordered.includes(p)) ordered.push(p)
  }
  return ordered
}

/**
 * Download with mirror failover: try each candidate (last-good mirror first,
 * then direct GitHub, then the rest) until one completes; remember the winner
 * for the next download. Every path still lands in `.part → rename`, and the
 * caller verifies size+sha256 afterwards, so a compromised mirror cannot
 * inject bad bytes undetected.
 */
export async function downloadAssetSmart(
  settings: UpgradeSettings,
  url: string,
  destZip: string,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string; cancelled: boolean }> {
  const candidates = downloadCandidates(settings, url)
  let last: { ok: false; message: string; cancelled: boolean } | null = null
  for (const cand of candidates) {
    if (signal?.aborted) return { ok: false, message: 'cancelled', cancelled: true }
    events.log(`[download] 尝试: ${cand === url ? '直达 github.com' : cand}`)
    const r = await downloadAsset(cand, destZip, events, signal)
    if (r.ok) {
      if (cand !== url) lastGoodMirror = cand.slice(0, cand.length - url.length)
      return r
    }
    last = r
    if (r.cancelled) return r
    events.log(`[download] ${cand === url ? '直达' : '镜像'}失败: ${r.message.slice(-200)}`)
  }
  return { ok: false, message: last?.message ?? 'all download candidates failed', cancelled: false }
}

/** Stream-download a URL to destZip via a `.part` temp file (redirect-following, abortable). */
export async function downloadAsset(
  url: string,
  destZip: string,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string; cancelled: boolean }> {
  const part = `${destZip}.part`
  try { mkdirSync(parentOf(destZip), { recursive: true }) } catch { /* best effort */ }
  try { rmSync(part, { force: true }) } catch { /* best effort */ }
  return new Promise((resolve) => {
    let finished = false
    let ignoreError = false
    const done = (r: { ok: true } | { ok: false; message: string; cancelled: boolean }): void => {
      if (!finished) { finished = true; resolve(r) }
    }
    const req = httpGetByScheme(url, { headers: { 'User-Agent': 'dsh-desktop-updater' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        ignoreError = true
        res.resume()
        req.destroy()
        void downloadAsset(new URL(res.headers.location, url).toString(), destZip, events, signal).then(done)
        return
      }
      if (status !== 200) {
        res.resume()
        done({ ok: false, message: `HTTP ${status} from ${url}`, cancelled: false })
        return
      }
      const total = Number(res.headers['content-length'] ?? 0)
      const out = createWriteStream(part)
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        events.progress?.(received, total)
      })
      res.pipe(out)
      out.on('finish', () => {
        try { renameSync(part, destZip) } catch (err) { done({ ok: false, message: String(err), cancelled: false }); return }
        done({ ok: true })
      })
      const fail = (err: unknown): void => {
        try { rmSync(part, { force: true }) } catch { /* best effort */ }
        done({ ok: false, message: String(err), cancelled: false })
      }
      out.on('error', fail)
      res.on('error', fail)
    })
    req.on('error', (err) => {
      if (ignoreError) return
      try { rmSync(part, { force: true }) } catch { /* best effort */ }
      done({ ok: false, message: String(err), cancelled: false })
    })
    const onAbort = (): void => {
      try { rmSync(part, { force: true }) } catch { /* best effort */ }
      done({ ok: false, message: 'cancelled', cancelled: true })
      req.destroy()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
  })
}

/** SHA-256 of a file (streamed). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve())
    stream.on('error', (err) => reject(err))
  })
  return hash.digest('hex')
}

/** Unpack a tar.gz artifact into the build dir and validate the backend entry + version. */
export async function extractAsset(
  zipPath: string,
  buildDir: string,
  expectedVersion: string,
  events: UpgradeEvents,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string; cancelled: boolean }> {
  try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { mkdirSync(parentOf(buildDir), { recursive: true }) } catch { /* best effort */ }
  try { mkdirSync(buildDir, { recursive: true }) } catch { /* best effort */ }
  events.phase('extracting', zipPath)
  // tar.gz is universal: darwin/win32 ship bsdtar, linux ships gnu tar — no unzip
  // dependency anywhere (and tar is far faster than zip over pnpm's many small files).
  const extract = await run('tar', ['-xzf', zipPath, '-C', buildDir], {
    cwd: parentOf(buildDir), env: process.env, events, signal, timeoutMs: 15 * 60_000,
  })
  if (extract.killed) return { ok: false, message: 'cancelled', cancelled: true }
  if (extract.code !== 0) {
    return { ok: false, message: `extract failed: ${extract.tail.slice(-500)}`, cancelled: false }
  }
  if (!existsSync(join(buildDir, 'apps', 'cli', 'lib', 'bin.js'))) {
    return { ok: false, message: 'artifact is missing the backend entry (apps/cli/lib/bin.js)', cancelled: false }
  }
  const vj = join(buildDir, 'version.json')
  let versionOk = false
  if (existsSync(vj)) {
    try {
      const v = JSON.parse(readFileSync(vj, 'utf8')) as { version?: unknown }
      versionOk = typeof v.version === 'string' && v.version === expectedVersion
    } catch { /* treated as mismatch */ }
  }
  if (!versionOk) {
    return { ok: false, message: `artifact version mismatch: expected ${expectedVersion}`, cancelled: false }
  }
  return { ok: true }
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
  const hasGit = existsSync(join(harness, '.git'))
  const fromCommit = hasGit
    ? gitSync(settings, ['rev-parse', 'HEAD']).out
    : currentVersion(harness, settings).version

  if (!existsSync(join(buildDir, 'apps', 'cli', 'lib', 'bin.js'))) {
    return { status: 'failed', step: 'validate', message: `build dir missing backend entry: ${buildDir}` }
  }
  if (settings.updateSource === 'source' && !hasGit) {
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

  // 3. migrate .git and align HEAD (source channel / git-backed run dir only;
  //    the release channel ships a version.json instead of a repository)
  if (hasGit) {
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
