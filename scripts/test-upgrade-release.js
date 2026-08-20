#!/usr/bin/env node
/**
 * dsh-desktop release-channel unit tests (plain Node, drives dist/upgrade.js).
 * Covers: manifest parsing, os+arch matching, currentVersion, sha256, download,
 * extract, and the produceUpdate end-to-end flow against a local HTTP server.
 *
 * Usage:  pnpm build && node scripts/test-upgrade-release.js
 */
'use strict'
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execSync } = require('node:child_process')
const U = require('../dist/upgrade.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ut-'))
let passed = 0
let failed = 0
const tests = []

function test(name, fn) {
  tests.push(
    Promise.resolve()
      .then(fn)
      .then(() => { passed++; console.log(`ok   - ${name}`) })
      .catch((err) => { failed++; console.error(`FAIL - ${name}: ${err.message}`) }),
  )
}

function makeSettings(over = {}) {
  return {
    harnessDir: path.join(TMP, 'harness'),
    channel: 'tag',
    tagPrefix: 'dsh-v',
    remote: 'https://github.com/deepseek-ai/deepseek-harness.git',
    updateSource: 'release',
    releaseRepo: 'benson-album/dsh-desktop',
    releaseAssetPattern: 'DeepSeek-Harness-*-<os>-<arch>.zip',
    ...over,
  }
}

const noopEvents = {
  phase: () => {},
  log: () => {},
  progress: () => {},
}

/* ── 1. parseReleaseManifest ─────────────────────────────────────────────── */

test('parseReleaseManifest: valid manifest', () => {
  const m = U.parseReleaseManifest(JSON.stringify({
    schemaVersion: 1, version: '0.2.0', tag: 'dsh-v0.2.0',
    assets: [{ name: 'a.zip', url: 'https://x/a.zip', sha256: 'abc', size: 10, os: 'darwin', arch: 'x64' }],
  }))
  assert.ok(m)
  assert.strictEqual(m.version, '0.2.0')
  assert.strictEqual(m.tag, 'dsh-v0.2.0')
  assert.strictEqual(m.assets.length, 1)
})

test('parseReleaseManifest: invalid json -> null', () => {
  assert.strictEqual(U.parseReleaseManifest('not json{'), null)
})

test('parseReleaseManifest: missing version/tag -> null', () => {
  assert.strictEqual(U.parseReleaseManifest('{"assets":[]}'), null)
  assert.strictEqual(U.parseReleaseManifest('{"version":"1.0"}'), null)
})

test('parseReleaseManifest: empty assets -> null', () => {
  assert.strictEqual(U.parseReleaseManifest('{"version":"1.0","tag":"t","assets":[]}'), null)
})

test('parseReleaseManifest: unknown fields tolerated (forward compat)', () => {
  const m = U.parseReleaseManifest(JSON.stringify({
    schemaVersion: 2, version: '1.0', tag: 't', futureField: { x: 1 },
    assets: [{ name: 'a', url: 'u', sha256: 's', size: 1, os: 'darwin', arch: 'x64', extra: true }],
  }))
  assert.ok(m)
  assert.strictEqual(m.schemaVersion, 2)
})

/* ── 2. matchAsset (multi-arch / cross-platform protocol) ─────────────────── */

const MULTI = {
  schemaVersion: 1, version: '1.0', tag: 'dsh-v1.0',
  assets: [
    { name: 'darwin-x64.zip', url: 'u1', sha256: 's', size: 1, os: 'darwin', arch: 'x64' },
    { name: 'darwin-arm64.zip', url: 'u2', sha256: 's', size: 1, os: 'darwin', arch: 'arm64' },
    { name: 'win32-x64.zip', url: 'u3', sha256: 's', size: 1, os: 'win32', arch: 'x64' },
    { name: 'linux-x64.zip', url: 'u4', sha256: 's', size: 1, os: 'linux', arch: 'x64' },
  ],
}

test('matchAsset: picks the exact os+arch entry', () => {
  assert.strictEqual(U.matchAsset(MULTI, 'darwin', 'x64').name, 'darwin-x64.zip')
  assert.strictEqual(U.matchAsset(MULTI, 'darwin', 'arm64').name, 'darwin-arm64.zip')
  assert.strictEqual(U.matchAsset(MULTI, 'win32', 'x64').name, 'win32-x64.zip')
})

test('matchAsset: no artifact for this machine -> null', () => {
  assert.strictEqual(U.matchAsset(MULTI, 'linux', 'arm64'), null)
})

test('manifestOs/manifestArch: match process.platform/arch', () => {
  assert.strictEqual(U.manifestOs(), process.platform)
  assert.strictEqual(U.manifestArch(), process.arch)
})

/* ── 3. currentVersion ────────────────────────────────────────────────────── */

test('currentVersion: version.json wins', () => {
  const dir = path.join(TMP, 'cv1')
  fs.mkdirSync(path.join(dir, 'apps', 'cli', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '0.2.0', commit: 'abc123' }))
  const v = U.currentVersion(dir, makeSettings())
  assert.strictEqual(v.version, '0.2.0')
  assert.strictEqual(v.commit, 'abc123')
})

test('currentVersion: falls back to package.json when no version.json', () => {
  const dir = path.join(TMP, 'cv2')
  fs.mkdirSync(path.join(dir, 'apps', 'cli', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'deepseek-harness', version: '9.9.9' }))
  const v = U.currentVersion(dir, makeSettings())
  assert.strictEqual(v.version, '9.9.9')
})

/* ── 4. sha256File ────────────────────────────────────────────────────────── */

test('sha256File: known digest of "hello\\n"', async () => {
  const f = path.join(TMP, 'hello.txt')
  fs.writeFileSync(f, 'hello\n')
  const sha = await U.sha256File(f)
  assert.strictEqual(sha, '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')
})

/* ── helpers: local HTTP server serving a fake release ────────────────────── */

function startServer(payload) {
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    if (p === '/latest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload.manifest))
      return
    }
    if (p === '/artifact.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(payload.zip)
      return
    }
    if (p === '/redirect') {
      res.writeHead(302, { Location: '/artifact.zip' })
      res.end()
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, port: server.address().port })
  }))
}

/** Build a fake artifact zip: apps/cli/lib/bin.js + version.json at the zip root. */
function makeArtifactZip(version) {
  const dir = path.join(TMP, `zip-src-${version.replace(/[^a-zA-Z0-9]/g, '_')}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'apps', 'cli', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'apps', 'cli', 'lib', 'bin.js'), '#!/usr/bin/env node\nconsole.log("fake backend")\n')
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, commit: 'deadbeef' }))
  const zipPath = path.join(TMP, `artifact-${version.replace(/[^a-zA-Z0-9]/g, '_')}.zip`)
  execSync(`cd ${JSON.stringify(dir)} && zip -qr ${JSON.stringify(zipPath)} .`)
  return fs.readFileSync(zipPath)
}

async function shaOf(buf) {
  const f = path.join(TMP, 'tmp-sha.bin')
  fs.writeFileSync(f, buf)
  return U.sha256File(f)
}

/* ── 5. downloadAsset ─────────────────────────────────────────────────────── */

test('downloadAsset: downloads file with progress events', async () => {
  const zip = makeArtifactZip('0.2.0')
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const dest = path.join(TMP, 'dl-out.zip')
    const progress = []
    const dl = await U.downloadAsset(`http://127.0.0.1:${port}/artifact.zip`, dest, { ...noopEvents, progress: (r, t) => progress.push([r, t]) })
    assert.deepStrictEqual(dl, { ok: true })
    assert.ok(fs.existsSync(dest))
    assert.ok(!fs.existsSync(`${dest}.part`))
    assert.strictEqual(fs.readFileSync(dest).length, zip.length)
    assert.ok(progress.length > 0)
    assert.strictEqual(progress[progress.length - 1][0], zip.length)
  } finally { server.close() }
})

test('downloadAsset: follows redirects', async () => {
  const zip = makeArtifactZip('0.2.0')
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const dest = path.join(TMP, 'dl-redir.zip')
    const dl = await U.downloadAsset(`http://127.0.0.1:${port}/redirect`, dest, noopEvents)
    assert.deepStrictEqual(dl, { ok: true })
    assert.strictEqual(fs.readFileSync(dest).length, zip.length)
  } finally { server.close() }
})

test('downloadAsset: abort cancels cleanly', async () => {
  const zip = makeArtifactZip('0.2.0')
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const dest = path.join(TMP, 'dl-abort.zip')
    const ac = new AbortController()
    const promise = U.downloadAsset(`http://127.0.0.1:${port}/artifact.zip`, dest, noopEvents, ac.signal)
    ac.abort()
    const res = await promise
    assert.strictEqual(res.cancelled, true)
    assert.ok(!fs.existsSync(dest))
    assert.ok(!fs.existsSync(`${dest}.part`))
  } finally { server.close() }
})

/* ── 6. extractAsset ──────────────────────────────────────────────────────── */

test('extractAsset: valid artifact extracts and passes version check', async () => {
  const zip = makeArtifactZip('0.3.0')
  const zipPath = path.join(TMP, 'ex.zip')
  fs.writeFileSync(zipPath, zip)
  const buildDir = path.join(TMP, 'ex-build')
  const res = await U.extractAsset(zipPath, buildDir, '0.3.0', noopEvents)
  assert.deepStrictEqual(res, { ok: true })
  assert.ok(fs.existsSync(path.join(buildDir, 'apps', 'cli', 'lib', 'bin.js')))
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(buildDir, 'version.json'), 'utf8')).version, '0.3.0')
})

test('extractAsset: version mismatch fails', async () => {
  const zip = makeArtifactZip('0.3.0')
  const zipPath = path.join(TMP, 'ex2.zip')
  fs.writeFileSync(zipPath, zip)
  const buildDir = path.join(TMP, 'ex2-build')
  const res = await U.extractAsset(zipPath, buildDir, '9.9.9', noopEvents)
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /version mismatch/)
})

test('extractAsset: missing backend entry fails', async () => {
  const dir = path.join(TMP, 'badzip-src')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '0.3.0' }))
  const zipPath = path.join(TMP, 'bad.zip')
  execSync(`cd ${JSON.stringify(dir)} && zip -qr ${JSON.stringify(zipPath)} .`)
  const res = await U.extractAsset(zipPath, path.join(TMP, 'bad-build'), '0.3.0', noopEvents)
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /backend entry/)
})

/* ── 7. checkForUpdates + produceUpdate end-to-end (release channel) ──────── */

test('checkForUpdates: release channel detects update via local manifest', async () => {
  const zip = makeArtifactZip('0.4.0')
  const sha = await shaOf(zip)
  const manifest = {
    schemaVersion: 1, version: '0.4.0', tag: 'dsh-v0.4.0',
    assets: [{ name: 'a.zip', url: `http://127.0.0.1:PORT/artifact.zip`, sha256: sha, size: zip.length, os: process.platform, arch: process.arch }],
  }
  const { server, port } = await startServer({ manifest, zip })
  try {
    for (const a of manifest.assets) a.url = a.url.replace('PORT', String(port))
    const harness = path.join(TMP, 'harness-040')
    fs.mkdirSync(path.join(harness, 'apps', 'cli', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(harness, 'version.json'), JSON.stringify({ version: '0.3.0' }))
    const settings = makeSettings({ harnessDir: harness, releaseManifestUrl: `http://127.0.0.1:${port}/latest.json` })
    const res = await U.checkForUpdates(settings, process.env, noopEvents)
    assert.strictEqual(res.status, 'update-available')
    assert.strictEqual(res.to, '0.4.0')
    assert.strictEqual(res.tag, 'dsh-v0.4.0')
    assert.strictEqual(res.assetUrl, manifest.assets[0].url)
    assert.strictEqual(res.assetSha256, sha)
  } finally { server.close() }
})

test('checkForUpdates: release channel up-to-date is silent', async () => {
  const zip = makeArtifactZip('0.5.0')
  const sha = await shaOf(zip)
  const manifest = {
    schemaVersion: 1, version: '0.5.0', tag: 'dsh-v0.5.0',
    assets: [{ name: 'a.zip', url: `http://127.0.0.1:PORT/artifact.zip`, sha256: sha, size: zip.length, os: process.platform, arch: process.arch }],
  }
  const { server, port } = await startServer({ manifest, zip })
  try {
    for (const a of manifest.assets) a.url = a.url.replace('PORT', String(port))
    const harness = path.join(TMP, 'harness-050')
    fs.mkdirSync(path.join(harness, 'apps', 'cli', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(harness, 'version.json'), JSON.stringify({ version: '0.5.0' }))
    const settings = makeSettings({ harnessDir: harness, releaseManifestUrl: `http://127.0.0.1:${port}/latest.json` })
    const res = await U.checkForUpdates(settings, process.env, noopEvents)
    assert.strictEqual(res.status, 'up-to-date')
  } finally { server.close() }
})

test('checkForUpdates: no artifact for this platform -> no-target', async () => {
  const zip = makeArtifactZip('0.6.0')
  const manifest = {
    schemaVersion: 1, version: '0.6.0', tag: 'dsh-v0.6.0',
    assets: [{ name: 'other.zip', url: 'http://127.0.0.1:PORT/artifact.zip', sha256: 'x', size: 1, os: 'win32', arch: 'x64' }],
  }
  const { server, port } = await startServer({ manifest, zip })
  try {
    const harness = path.join(TMP, 'harness-060')
    fs.mkdirSync(path.join(harness, 'apps', 'cli', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(harness, 'version.json'), JSON.stringify({ version: '0.5.0' }))
    const settings = makeSettings({ harnessDir: harness, releaseManifestUrl: `http://127.0.0.1:${port}/latest.json` })
    const res = await U.checkForUpdates(settings, process.env, noopEvents)
    assert.strictEqual(res.status, 'no-target')
  } finally { server.close() }
})

test('produceUpdate: full download -> verify -> extract -> ready', async () => {
  const zip = makeArtifactZip('0.7.0')
  const sha = await shaOf(zip)
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const downloadsDir = path.join(TMP, 'dl-dir-070')
    const buildDir = path.join(TMP, 'build-070')
    const res = await U.produceUpdate(
      makeSettings(), process.env, buildDir, downloadsDir,
      { from: '0.6.0', to: '0.7.0', tag: 'dsh-v0.7.0', assetUrl: `http://127.0.0.1:${port}/artifact.zip`, assetSha256: sha, assetSize: zip.length },
      noopEvents,
    )
    assert.strictEqual(res.status, 'ready')
    assert.strictEqual(res.to, '0.7.0')
    assert.ok(fs.existsSync(path.join(buildDir, 'apps', 'cli', 'lib', 'bin.js')))
    assert.ok(!fs.existsSync(path.join(downloadsDir, 'dsh-v0.7.0'))) // per-tag downloads cleaned up
  } finally { server.close() }
})

test('produceUpdate: sha256 mismatch fails and cleans up', async () => {
  const zip = makeArtifactZip('0.8.0')
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const downloadsDir = path.join(TMP, 'dl-dir-080')
    const buildDir = path.join(TMP, 'build-080')
    const res = await U.produceUpdate(
      makeSettings(), process.env, buildDir, downloadsDir,
      { from: '0.7.0', to: '0.8.0', tag: 'dsh-v0.8.0', assetUrl: `http://127.0.0.1:${port}/artifact.zip`, assetSha256: '0'.repeat(64), assetSize: zip.length },
      noopEvents,
    )
    assert.strictEqual(res.status, 'failed')
    assert.strictEqual(res.step, 'verify')
    assert.ok(!fs.existsSync(path.join(downloadsDir, 'dsh-v0.8.0')))
    assert.ok(!fs.existsSync(buildDir))
  } finally { server.close() }
})

test('produceUpdate: size mismatch fails', async () => {
  const zip = makeArtifactZip('0.8.1')
  const { server, port } = await startServer({ manifest: null, zip })
  try {
    const res = await U.produceUpdate(
      makeSettings(), process.env, path.join(TMP, 'build-081'), path.join(TMP, 'dl-081'),
      { from: '0.7.0', to: '0.8.1', assetUrl: `http://127.0.0.1:${port}/artifact.zip`, assetSize: zip.length + 123 },
      noopEvents,
    )
    assert.strictEqual(res.status, 'failed')
    assert.strictEqual(res.step, 'verify')
  } finally { server.close() }
})

/* ── 8. source channel regression (existing pipeline untouched) ───────────── */

test('produceUpdate: source channel still dispatches to buildUpdate', async () => {
  const settings = makeSettings({ updateSource: 'source' })
  // No real repo here: expect a build failure (not a download failure), proving
  // the dispatch took the source path. `git archive` will fail on a non-repo dir.
  const res = await U.produceUpdate(
    settings, process.env, path.join(TMP, 'src-build'), path.join(TMP, 'src-dl'),
    { from: 'x', to: 'y', tag: 'dsh-v0.9.0' },
    noopEvents,
  )
  assert.strictEqual(res.status, 'failed')
  assert.notStrictEqual(res.step, 'download') // never went down the release path
})

/* ── run ──────────────────────────────────────────────────────────────────── */

;(async () => {
  await Promise.all(tests)
  console.log(`\nrelease-channel unit tests: ${passed} passed, ${failed} failed`)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
})()
