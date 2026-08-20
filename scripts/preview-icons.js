const sharp = require('sharp')
const fs = require('node:fs')

const SVG_SRC = 'build/deepseek-favicon.svg'
const svg = fs.readFileSync(SVG_SRC)

// 候选 A：透明底 + 蓝鲸（当前 .app 用的样式）
// 候选 B：品牌蓝底 + 白鲸（App Store 风格）
async function render(out, bg, fg) {
  let s = svg.toString().replace(/#4D6BFE/g, fg)
  if (bg) {
    // 在 SVG 里插一个背景矩形
    s = s.replace('<path', `<rect width="50" height="50" fill="${bg}"/><path`)
  }
  await sharp(Buffer.from(s), { density: 300 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer()
    .then(buf => fs.writeFileSync(out, buf))
  console.log('written', out)
}

;(async () => {
  await render('preview-icon-A-transparent-blue.png', null, '#4D6BFE')
  await render('preview-icon-B-blue-bg-white-whale.png', '#4D6BFE', '#FFFFFF')
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
