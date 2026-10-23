// scripts/gen-logos.mjs — 生成 src/client/logos.js（来源品牌标 mark + 可选字标 word）。
//
// 为什么是生成物：面板要画 23 个来源的品牌标，官方 SVG 是单一事实来源；但客户端 bundle 是
// 单文件、不能引 npm 包，所以把用到的那些标取出来内联进 src/client/logos.js（logos.js 入库，
// 本脚本只在增删来源或上游换标时手动跑）。
//
// 两个来源：
//   1. @lobehub/icons 的静态 SVG 包（MIT）——18 个来源有官方标与字标；
//   2. 项目自己的 GitHub 仓库（在 REPO 表里逐个点名，MIT / Apache-2.0 / GPL 各不相同，
//      商标归各自权利人）——lobehub 没有的 5 个（ChatGPT 走 lobehub 的 OpenAI 标、
//      MimoCode 走 lobehub 的 XiaomiMiMo 标、Reasonix / Continue / Zed 从仓库取）。
//      仓库标只在构建期取一次，产物内联进 logos.js，运行时不联网。
//
// 准备输入（dev/ 不入库）：
//   mkdir dev/.lobehub && cd dev/.lobehub
//   npm pack @lobehub/icons-static-svg && tar -xzf lobehub-icons-static-svg-*.tgz
//   （第二个包 @lobehub/icons 只为量 ink 时对照，可选）
//
// 用法：node scripts/gen-logos.mjs [--refresh]（--refresh 重新下载仓库标，否则用 dev/.lobehub/raw 缓存）
//
// 生成物做两件事，都是为了「一排标看起来一样大、文字从同一列起」：
//   1. mark：按实测 ink 包围盒等比缩放进 24×24 里的 MARK_BOX 方框并居中——上游的标并不都
//      画满 viewBox（Antigravity 的 ink 是 47×53、溢出 viewBox 一倍多，Claude Code 只有
//      24×15），不归一化就会出现「有的标大一圈、有的小一圈」；
//   2. word：按 ink 高度归一（不再是各标自己的 COMBINE_TEXT_MULTIPLE），viewBox 宽度收紧到
//      ink 宽度、x 从 0 起，所有字标的字面高一致。
// INK 表是 dev/measure-all.mjs 在无头 Chrome 里对每个 svg 调 getBBox() 量出来的（Node 里没有
// SVG 路径包围盒）。上游换标后要重量一遍再更新这张表。
/* global fetch */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = path.join(ROOT, 'dev/.lobehub/package/icons')
// 仓库标的本地缓存（dev/ 不入库）：有缓存就不联网，删掉缓存或加 --refresh 强制重取
const CACHE = path.join(ROOT, 'dev/.lobehub/raw')
const REFRESH = process.argv.includes('--refresh')

// 键 = discovery format 短名（与 sources.js 的 SOURCE_BADGES 同键空间）
// lobe  = [lobehub id, 是否带字标]；mono = 强制用 currentColor 标（color 变体是给深底画的）
// repo  = 仓库标 URL（+ stripRect 去底板 / recolor 改色）
// ink / wordInk = [x, y, w, h]，dev/measure-all.mjs 实测
const MAP = {
  claude: { lobe: ['claude', true], ink: [0, 0, 24, 24], wordInk: [2, 0, 93, 22] },
  codex: { lobe: ['codex', true], ink: [0, 0, 24, 24], wordInk: [2, 1, 86.9, 22] },
  cursor: { lobe: ['cursor', true], ink: [1.47, 0, 21.05, 24], wordInk: [2, 2, 119, 20] },
  gemini: { lobe: ['geminicli', true], ink: [0, 0, 24, 24], wordInk: [2, 1, 147.76, 22] },
  antigravity: { lobe: ['antigravity', true], ink: [-12.71, -13.75, 46.71, 52.75], wordInk: [2, 2, 170.22, 22] },
  opencode: { lobe: ['opencode', true], ink: [4, 2, 16, 20], wordInk: [2.14, 0, 133.71, 24] },
  kilocode: { lobe: ['kilocode', true], ink: [0, 0, 24, 24], wordInk: [2, 0, 142.91, 22] },
  grokbuild: { lobe: ['grok', true], ink: [0, 0.5, 24, 23.04], wordInk: [2, 2, 58.6, 20] },
  openclaw: { lobe: ['openclaw', true], ink: [0, 1.68, 24, 21.98], wordInk: [2, 2, 135.78, 22] },
  kimi: { lobe: ['kimi', true], mono: true, ink: [3, 0, 20.77, 20], wordInk: [2, 2, 60, 20] },
  qoder: { lobe: ['qoder', true], ink: [0, 0, 23.38, 24], wordInk: [2, 1, 92, 22] },
  qwen: { lobe: ['qwen', true], ink: [1, 1, 22, 22], wordInk: [2, 0, 70.81, 22] },
  cline: { lobe: ['cline', true], ink: [0.5, 0, 23.07, 24], wordInk: [2, 0, 83.96, 22] },
  copilot: { lobe: ['githubcopilot', false], ink: [0, 2.5, 24, 19] },
  goose: { lobe: ['goose', true], ink: [0, 0, 24, 24], wordInk: [2, 2, 82.89, 22] },
  pi: { lobe: ['pi', false], ink: [1, 1, 22, 22] },
  hermes: { lobe: ['hermesagent', false], ink: [1, 0, 23, 24] },
  zcode: { lobe: ['zai', false], ink: [0, 2, 24, 20] },
  dsh: { lobe: ['deepseek', false], ink: [0, 3, 24, 17.66] },
  chatgpt: { lobe: ['openai', false], ink: [0, 0, 24, 23.79] },
  mimocode: { lobe: ['xiaomimimo', false], ink: [0, 5, 24, 14.56] },
  reasonix: {
    repo: 'https://raw.githubusercontent.com/esengine/DeepSeek-Reasonix/main-v2/desktop/build/appicon.svg',
    stripRect: true, recolor: '#0153e5', ink: [0, 0, 1024, 1024],
  },
  continue: {
    repo: 'https://raw.githubusercontent.com/continuedev/continue/main/docs/logo/light.svg',
    recolor: 'currentColor', ink: [0, 0, 25.48, 23.69],
  },
  zed: {
    repo: 'https://raw.githubusercontent.com/zed-industries/zed/main/assets/images/zed_logo.svg',
    recolor: 'currentColor', ink: [0, 0, 96, 96],
  },
}

// mark 的 ink 最大边（24 单位 viewBox 里）：22 单位 ≈ 槽位 16px 下的 14.7px
const MARK_BOX = 22
// word 的 ink 高度（24 单位 viewBox 里）：22 单位 ≈ 渲染 11px 下的 10px 字面高
const WORD_BOX = 22

const read = (p) => fs.readFileSync(p, 'utf8')
const round = (n) => Math.round(n * 10000) / 10000
/** 去掉 <title>（面板自己给可访问名），宽高/内联样式换成本地口径：高度 1em、宽度按比例。 */
const normalize = (svg) => svg
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<svg([^>]*)>/, (m, attrs) => '<svg' + attrs
    .replace(/\s(width|height)="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '') + ' aria-hidden="true" focusable="false" style="height:1em;width:auto;display:block">')
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const attrsOf = (svg) => (svg.match(/<svg([^>]*)>/) || [])[1] || ''
// 根上的绘制属性（mono 标靠 fill="currentColor" 上色）要跟着内容搬进 <g>，否则丢色
const PRESENT = ['fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']
const presentation = (svg) => {
  const tag = attrsOf(svg)
  return PRESENT.filter((k) => new RegExp('\\s' + k + '="').test(tag))
    .map((k) => ' ' + k + '="' + (tag.match(new RegExp('\\s' + k + '="([^"]*)"')) || [])[1] + '"')
    .join('')
}
/**
 * 归一化：把 ink 等比缩放并居中。
 *  - mark：24×24 方框（槽位是方的），最长边 = MARK_BOX，viewBox 不变；
 *  - word：viewBox 高度仍 24、宽度收紧到 ink 宽，ink 高 = WORD_BOX、垂直居中。
 */
const fit = (svg, box, view, square) => {
  const s = square ? box / Math.max(view[2], view[3]) : box / view[3]
  const tx = round(square ? 12 - s * (view[0] + view[2] / 2) : -view[0] * s)
  const ty = round(12 - s * (view[1] + view[3] / 2))
  const width = round(square ? 24 : view[2] * s)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' 24"'
    + ' aria-hidden="true" focusable="false" style="height:1em;width:auto;display:block">'
    + '<g transform="translate(' + tx + ' ' + ty + ') scale(' + round(s) + ')"' + presentation(svg) + '>'
    + inner(svg).trim() + '</g></svg>'
}
const recolor = (svg, to) => svg.replace(/fill="(?!none)[^"]*"/g, 'fill="' + to + '"')

const entries = []
for (const [key, spec] of Object.entries(MAP)) {
  let markSvg
  if (spec.lobe) {
    const [id] = spec.lobe
    if (!fs.existsSync(ICONS)) {
      console.error('gen-logos: 缺少 ' + path.relative(ROOT, ICONS) + ' —— 先按脚本头 npm pack lobehub 的静态 SVG 包')
      process.exit(1)
    }
    const color = path.join(ICONS, id + '-color.svg')
    const mono = path.join(ICONS, id + '.svg')
    if (!fs.existsSync(mono)) { console.error('gen-logos: lobehub 里没有 ' + id); process.exit(1) }
    markSvg = read(!spec.mono && fs.existsSync(color) ? color : mono)
  } else {
    const cached = path.join(CACHE, key + '.svg')
    if (!REFRESH && fs.existsSync(cached)) {
      markSvg = read(cached)
    } else {
      const res = await fetch(spec.repo, { headers: { 'user-agent': 'dsh-chat-import-gen-logos' } })
      if (!res.ok) { console.error('gen-logos: 取不到 ' + spec.repo + '（' + res.status + '）'); process.exit(1) }
      markSvg = await res.text()
      if (spec.stripRect) markSvg = markSvg.replace(/<rect[^>]*\/>/g, '')
      if (spec.recolor) markSvg = recolor(markSvg, spec.recolor)
      fs.mkdirSync(CACHE, { recursive: true })
      fs.writeFileSync(cached, markSvg)
    }
  }
  let wordSvg = null
  if (spec.lobe && spec.lobe[1] && spec.wordInk) {
    const text = path.join(ICONS, spec.lobe[0] + '-text.svg')
    const mono = path.join(ICONS, spec.lobe[0] + '.svg')
    if (fs.existsSync(text) && read(text) !== read(mono)) wordSvg = read(text)
  }
  const mark = fit(normalize(markSvg), MARK_BOX, spec.ink, true)
  const word = wordSvg && spec.wordInk ? fit(normalize(wordSvg), WORD_BOX, spec.wordInk, false) : null
  entries.push('      ' + key + ': { mark: ' + JSON.stringify(mark)
    + ', word: ' + (word ? JSON.stringify(word) : 'null') + ' },')
}

const out = [
  '    // Agent 品牌标（mark）与品牌字标（wordmark）：18 个取自 @lobehub/icons 的静态 SVG 包',
  '    //（MIT），5 个取自项目自己的仓库——ChatGPT 用 lobehub 的 OpenAI 标、MimoCode 用 lobehub 的',
  '    // XiaomiMiMo 标，Reasonix / Continue / Zed 从各自仓库的官方标取（商标归各自权利人）。',
  '    // 生成物，勿手改——由 scripts/gen-logos.mjs 生成（增删来源或上游换标时重跑）。',
  '    // 键与 SOURCE_BADGES 同口径（discovery format 短名）。生成时已把每个标的 ink 包围盒',
  '    // 归一化：mark 等比缩放进 24×24 里的 22 单位方框并居中（上游的标并不都画满 viewBox，',
  '    // 不归一化会大小不一），word 的 ink 高度统一为 22 单位、viewBox 宽度收紧到 ink 宽度。',
  '    // 两者都是完整的内联 <svg>：viewBox 保留，高度交给 CSS 的 1em，宽度按比例。',
  '    // word 为 null = 该品牌没有字标（Pi 等），或字标拼的不是我们展示的名字（Hermes /',
  '    // ZCode / DSH 展示的是工具名而非厂商名），此时用品牌标 + 我们自己的标签文本。',
  '    // svg 是静态受信标记，经 dangerouslySetInnerHTML 注入。',
  '    const SOURCE_LOGOS = {',
  ...entries,
  '    };',
  '',
].join('\n')

fs.writeFileSync(path.join(ROOT, 'src/client/logos.js'), out)
console.log('gen-logos: wrote src/client/logos.js（' + entries.length + ' 个标，' + out.length + ' 字节）')
