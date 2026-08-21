#!/usr/bin/env node
/**
 * 从 DeepSeek 官方 favicon.svg 生成 macOS 应用图标（build/icon.png，1024×1024）。
 * 样式：品牌蓝圆角底（#4D6BFE，squircle 圆角）+ 居中白色鲸鱼（四周留边距）。
 * 用法：node scripts/gen-icon.js
 * 依赖：sharp（devDependency）
 */
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SVG_SRC = path.join(ROOT, 'build', 'deepseek-favicon.svg')
const PNG_OUT = path.join(ROOT, 'build', 'icon.png')
const SIZE = 1024
const BG = 824         // 内容安全区（Apple HIG：图标内容约占 80%，四周透明边距）
                       // 视觉上与其他带边距的系统图标一致（Dock 上约 40px 可见内容）
const RADIUS = Math.round(BG * 0.22)   // macOS squircle 圆角（约 22%）
const WHALE = Math.round(BG * 0.6)     // 白鲸渲染尺寸（蓝底内 60%，四周留边距）
const BRAND_BLUE = '#4D6BFE'

async function main() {
  const svg = fs.readFileSync(SVG_SRC)

  // 白鲸：官方 favicon 蓝鲸换白
  const whale = svg.toString().replace(/#4D6BFE/g, '#FFFFFF')
  const whalePng = await sharp(Buffer.from(whale), { density: 600 })
    .resize(WHALE, WHALE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  // 品牌蓝底（824×824 安全区内，非全幅）
  const bgPng = await sharp({
    create: { width: BG, height: BG, channels: 4, background: { r: 0x4d, g: 0x6b, b: 0xfe, alpha: 255 } },
  }).png().toBuffer()

  // 蓝底圆角（macOS squircle 近似）
  const bgMaskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BG}" height="${BG}">` +
    `<rect width="${BG}" height="${BG}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`,
  )
  const bgMask = await sharp(bgMaskSvg).png().toBuffer()
  const roundedBg = await sharp(bgPng).composite([{ input: bgMask, blend: 'dest-in' }]).png().toBuffer()

  // 透明 1024 画布：圆角蓝底 + 白鲸居中
  const canvas = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer()
  const icon = await sharp(canvas)
    .composite([
      { input: roundedBg, left: (SIZE - BG) / 2, top: (SIZE - BG) / 2 },
      { input: whalePng, left: (SIZE - WHALE) / 2, top: (SIZE - WHALE) / 2 },
    ])
    .png()
    .toBuffer()

  fs.writeFileSync(PNG_OUT, icon)
  console.log(`icon written: ${PNG_OUT} (${icon.length} bytes, 蓝底 ${BG}×${BG} 安全区)`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
