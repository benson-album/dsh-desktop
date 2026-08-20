const sharp = require('sharp')
const fs = require('node:fs')
async function main() {
  const a = await sharp('preview-icon-A-transparent-blue.png').resize(260, 260).png().toBuffer()
  const b = await sharp('preview-icon-B-blue-bg-white-whale.png').resize(260, 260).png().toBuffer()
  const size = 260, gap = 60, pad = 40
  const W = pad * 2 + size * 2 + gap
  const H = pad * 2 + size
  const canvas = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 0xe8, g: 0xe8, b: 0xe8 } },
  }).composite([
    { input: a, left: pad, top: pad },
    { input: b, left: pad + size + gap, top: pad },
  ]).png().toBuffer()
  fs.writeFileSync('dock-preview-A-vs-B.png', canvas)
  console.log('written dock-preview-A-vs-B.png', W + 'x' + H)
}
main().catch(e => { console.error(e.message); process.exit(1) })
