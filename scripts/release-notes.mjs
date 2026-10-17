#!/usr/bin/env node
// scripts/release-notes.mjs — CHANGELOG 版本节校验 + 发布说明提取（release workflow 与本地预览共用）
//
// 发布说明就是 CHANGELOG 的版本节，逐字取用：workflow 在 publish 之前先跑校验，版式
// 不对就失败（不发布、不建 Release）；维护者用同一份输出预览，Release 正文与 CHANGELOG
// 因此不会出现两套文字。
//
// 用法：
//   node scripts/release-notes.mjs --version 0.27.0            # 输出该版本的发布说明
//   node scripts/release-notes.mjs --version 0.27.0 --check    # 只校验
//   node scripts/release-notes.mjs --version 0.27.0 --out notes.md
//   --changelog <path>  读另一个 CHANGELOG（预演 / 测试）
//
// 校验口径（docs/CONTRIBUTING.md「CHANGELOG」与 AGENTS.md 的版式）：
//   - 标题 `## [x.y.z] - YYYY-MM-DD`
//   - 双语切换行 `[中文](#cn-x.y.z) | [English](#en-x.y.z)`
//   - 中文块以 `<h3 id="cn-x.y.z">组名</h3>` 开头，英文块以 `<h3 id="en-x.y.z">组名</h3>` 开头，
//     锚点 id 必须带本版本号
//   - 组名只在固定四类里、同类不重复、顺序不变、空组不出现，每块至少一条 `- ` 条目
//   - 节尾 `**Full Changelog**: [v上一版...v本版](仓库 compare 链接)`，上一版取下一节的版本号

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// 顺序即允许出现的先后顺序：没有内容的分组整组省略，所以是子序列而不是全集。
const GROUPS = {
  cn: ['新增功能', '体验优化', '问题修复', '其他变更'],
  en: ['New Features', 'Improvements', 'Bug Fixes', 'Chores'],
}
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FOOTER = /^\*\*Full Changelog\*\*: \[v(\S+?)\.\.\.v(\S+?)\]\((\S+)\)$/

function fail(message) {
  console.error('release-notes: ' + message)
  process.exit(1)
}

function argOf(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}

// 仓库的 compare 基址取自 package.json，校验里不写死 owner/repo；读不到就跳过链接比对，
// 其余版式校验照做（脚本仍可用于别的 checkout）。
function compareBase() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(String(url || ''))
    return m ? `https://github.com/${m[1]}/${m[2]}` : null
  } catch (_) {
    // package.json 缺失或损坏不影响 CHANGELOG 校对，只让 compare 链接不再比对。
    return null
  }
}

const rawVersion = argOf('--version')
if (!rawVersion) fail('--version 必填，例如 --version 0.27.0')
const version = rawVersion.replace(/^v/, '')
if (!VERSION.test(version)) fail(`--version 不是合法版本号：${rawVersion}`)

const changelogPath = resolve(ROOT, argOf('--changelog') ?? 'CHANGELOG.md')
if (!existsSync(changelogPath)) fail('找不到 ' + changelogPath)
const text = readFileSync(changelogPath, 'utf8').replace(/\r\n?/g, '\n')

const headings = [...text.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)]
const match = headings.find((h) => h[1] === version)
if (!match) {
  const known = headings.map((h) => h[1]).join(', ') || '（没有带日期的版本节）'
  fail(`CHANGELOG 里没有 [${version}] 版本节；现有：${known}`)
}
if (headings.filter((h) => h[1] === version).length > 1) fail(`CHANGELOG 里 [${version}] 出现了不止一次`)

// 节边界按任意 `## [` 标题切（不只看带日期的版本节），版本号比较只看带日期的标题。
const sectionStarts = [...text.matchAll(/^## \[/gm)].map((m) => m.index)
const start = match.index
const end = sectionStarts.find((at) => at > start) ?? text.length
const section = text.slice(start, end).replace(/\n+$/, '')
const content = section.split('\n').slice(1)
while (content.length > 0 && content[0].trim() === '') content.shift()
while (content.length > 0 && content[content.length - 1].trim() === '') content.pop()

const switchLine = `[中文](#cn-${version}) | [English](#en-${version})`
if (content.length === 0) fail(`[${version}] 版本节是空的`)
if (content[0] !== switchLine) fail(`第一节必须是双语切换行 ${switchLine}，实际是：${content[0]}`)
content.shift()

const footerLine = content.pop()
const footer = footerLine === undefined ? null : FOOTER.exec(footerLine)
if (!footer) fail(`[${version}] 节尾缺少 **Full Changelog**: [v上一版...v${version}](compare 链接)`)
const [, previous, footerVersion, footerUrl] = footer
if (footerVersion !== version) fail(`Full Changelog 的当前版本应为 v${version}，实际是 v${footerVersion}`)

const nextVersion = headings.find((h) => h.index > start)
if (nextVersion && previous !== nextVersion[1]) {
  fail(`Full Changelog 的上一版应为下一节版本 ${nextVersion[1]}，实际是 ${previous}`)
}
const base = compareBase()
if (base && footerUrl !== `${base}/compare/v${previous}...v${version}`) {
  fail(`Full Changelog 链接应为 ${base}/compare/v${previous}...v${version}，实际是 ${footerUrl}`)
}

// 组标题两种写法都认：`<h3 id="cn-x.y.z">组名</h3>`（历史版本多数这样，同一节里 id 重复）
// 与规范里的 `### 组名`。锚点 id 仍必须带本版本号；语言块的先后固定为中文在前。
const blocks = []
let block = null
for (const line of content) {
  const anchor = /^<h3 id="(cn|en)-([^"]+)">(.+)<\/h3>$/.exec(line)
  if (anchor) {
    const [, lang, anchorVersion, name] = anchor
    if (anchorVersion !== version) fail(`锚点 id 必须带本版本号（cn-${version} / en-${version}），实际是：${line}`)
    if (lang === 'en') {
      if (!block) fail(`英文块之前必须有中文块：${line}`)
      if (block.lang === 'cn') {
        block = { lang: 'en', groups: [] }
        blocks.push(block)
      }
    } else {
      if (block && block.lang === 'en') fail(`中文块必须排在英文块之前，且只能有一块：${line}`)
      if (!block) {
        block = { lang: 'cn', groups: [] }
        blocks.push(block)
      }
    }
    block.groups.push({ name: name.trim(), entries: 0 })
    continue
  }
  const group = /^### (.+)$/.exec(line)
  if (group) {
    if (!block) fail(`分组标题出现在语言锚点之前：${line}`)
    block.groups.push({ name: group[1].trim(), entries: 0 })
    continue
  }
  if (line.startsWith('- ')) {
    if (!block) fail(`条目出现在语言锚点之前：${line}`)
    block.groups[block.groups.length - 1].entries += 1
    continue
  }
  if (line.trim() === '') continue
  fail(`版本节里有无法归类的内容：${line}`)
}

if (blocks.length !== 2 || blocks[0].lang !== 'cn' || blocks[1].lang !== 'en') {
  fail(`[${version}] 必须有且只有「中文锚点块 + 英文锚点块」两块，实际是：${blocks.map((b) => b.lang).join(', ') || '无'}`)
}
for (const one of blocks) {
  const allowed = GROUPS[one.lang]
  let last = -1
  for (const group of one.groups) {
    const at = allowed.indexOf(group.name)
    if (at === -1) fail(`组名「${group.name}」不在固定四类里（${allowed.join(' / ')}）`)
    if (at <= last) fail(`组「${group.name}」重复或顺序不对（固定顺序：${allowed.join(' / ')}）`)
    if (group.entries === 0) fail(`组「${group.name}」没有条目；空组应整组省略`)
    last = at
  }
}

const notes = [switchLine, '', ...content, footerLine].join('\n').replace(/\n{3,}/g, '\n\n')
const count = (lang) => blocks.find((b) => b.lang === lang).groups.reduce((sum, g) => sum + g.entries, 0)

const outPath = argOf('--out')
if (outPath) {
  const target = resolve(outPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, notes + '\n')
}
if (process.argv.includes('--check')) {
  console.log(`release-notes: OK — ${version}：中文 ${count('cn')} 条 / 英文 ${count('en')} 条，compare v${previous}...v${version}`)
  if (outPath) console.log('release-notes: 写入 ' + resolve(outPath))
} else if (outPath) {
  console.log('release-notes: 写入 ' + resolve(outPath))
} else {
  process.stdout.write(notes + '\n')
}
