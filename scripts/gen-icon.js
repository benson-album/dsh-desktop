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
const BRAND_BLUE = '#4D6BFE'
const RADIUS = 225      // macOS squircle 圆角（约 22%）
const WHALE = 620       // 白鲸渲染尺寸（画布的 ~60%，四周留边距）

async function main() {
  const svg = fs.readFileSync(SVG_SRC)

  // 白鲸：官方 favicon 蓝鲸换白
  const whale = svg.toString().replace(/#4D6BFE/g, '#FFFFFF')
  const whalePng = await sharp(Buffer.from(whale), { density: 600 })
    .resize(WHALE, WHALE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  // 品牌蓝背景
  const bgPng = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0x4d, g: 0x6b, b: 0xfe, alpha: 255 } },
  }).png().toBuffer()

  // 合成：蓝底 + 白鲸居中
  const composed = await sharp(bgPng)
    .composite([{ input: whalePng, left: (SIZE - WHALE) / 2, top: (SIZE - WHALE) / 2 }])
    .png()
    .toBuffer()

  // 圆角裁剪（macOS squircle 近似）
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/></svg>`,
  )
  const mask = await sharp(maskSvg).png().toBuffer()
  const icon = await sharp(composed).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()

  fs.writeFileSync(PNG_OUT, icon)
  console.log(`icon written: ${PNG_OUT} (${icon.length} bytes)`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
