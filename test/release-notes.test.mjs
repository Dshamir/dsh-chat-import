// test/release-notes.test.mjs — release-notes 脚本：版本节版式校验与发布说明切取
//
// 发布 workflow 在 publish 之前用它把关，所以这里钉住三件事：合法版本节能逐字切出
// （标题与日期不进正文、节尾 compare 链接随版本走）、版式错误带着具体位置失败、
// 仓库自己 CHANGELOG 的最新版本节始终可发布。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs')
const REPO = (() => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return String(pkg.repository.url).replace(/^git\+/, '').replace(/\.git$/, '')
})()

// 一个版本节的两种组标题写法：默认全用带锚点的 <h3>（历史版本多数如此），
// specGroups 为 true 时只有首个组带锚点、其余用规范里的 ###。
function section(version, previous, {
  date = '2026-10-17',
  zh = [['问题修复', ['中文条目']]],
  en = [['Bug Fixes', ['English entry']]],
  footer,
  specGroups = false,
  anchorVersion = version,
} = {}) {
  const block = (lang, list) => list.flatMap(([name, entries], i) => [
    i === 0 || !specGroups ? `<h3 id="${lang}-${anchorVersion}">${name}</h3>` : `### ${name}`,
    '',
    ...entries.map((entry) => `- ${entry}`),
    '',
  ])
  return [
    `## [${version}] - ${date}`,
    '',
    `[中文](#cn-${version}) | [English](#en-${version})`,
    '',
    ...block('cn', zh),
    ...block('en', en),
    footer ?? `**Full Changelog**: [v${previous}...v${version}](${REPO}/compare/v${previous}...v${version})`,
    '',
  ].join('\n')
}

function changelog(version, previous, opts) {
  return [
    '# Changelog',
    '',
    section(version, previous, opts),
    `## [${previous}] - 2026-10-01`,
    '',
    `[中文](#cn-${previous}) | [English](#en-${previous})`,
    '',
  ].join('\n')
}

function run(t, body, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'CHANGELOG.md')
  writeFileSync(file, body)
  const result = spawnSync(process.execPath, [SCRIPT, '--changelog', file, ...args], { encoding: 'utf8' })
  return { ...result, dir, file }
}

test('release-notes：合法版本节输出说明（不含标题/日期），节尾是 compare 链接', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0'), ['--version', '0.2.1'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^\[中文\]\(#cn-0\.2\.1\) \| \[English\]\(#en-0\.2\.1\)\n/)
  assert.doesNotMatch(r.stdout, /^## \[0\.2\.1\]/m)
  assert.doesNotMatch(r.stdout, /2026-10-17/)
  assert.match(r.stdout, new RegExp(`\\*\\*Full Changelog\\*\\*: \\[v0\\.2\\.0\\.\\.\\.v0\\.2\\.1\\]\\(${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/compare/v0\\.2\\.0\\.\\.\\.v0\\.2\\.1\\)\\n$`))
})

test('release-notes：--check 校验通过并给出条目计数', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0'), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /release-notes: OK — 0\.2\.1：中文 1 条 \/ 英文 1 条，compare v0\.2\.0\.\.\.v0\.2\.1/)
})

test('release-notes：规范里的 ### 组写法同样接受', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', {
    specGroups: true,
    zh: [['问题修复', ['中文条目']], ['其他变更', ['另一条中文']]],
    en: [['Bug Fixes', ['English entry']], ['Chores', ['Another entry']]],
  }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /中文 2 条 \/ 英文 2 条/)
})

test('release-notes：缺版本节时失败并列出已有版本', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0'), ['--version', '9.9.9', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /没有 \[9\.9\.9\] 版本节；现有：0\.2\.1, 0\.2\.0/)
})

test('release-notes：锚点 id 没带本版本号时失败', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', { anchorVersion: '0.2.0' }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /锚点 id 必须带本版本号/)
})

test('release-notes：组顺序反了时失败', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', {
    zh: [['问题修复', ['中文条目']], ['体验优化', ['另一条中文']]],
  }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /组「体验优化」重复或顺序不对/)
})

test('release-notes：空组必须整组省略', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', {
    zh: [['问题修复', []]],
  }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /组「问题修复」没有条目/)
})

test('release-notes：Full Changelog 的上一版必须等于下一节版本', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', {
    footer: `**Full Changelog**: [v0.1.9...v0.2.1](${REPO}/compare/v0.1.9...v0.2.1)`,
  }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /上一版应为下一节版本 0\.2\.0，实际是 0\.1\.9/)
})

test('release-notes：compare 链接与仓库不一致时失败', (t) => {
  const r = run(t, changelog('0.2.1', '0.2.0', {
    footer: '**Full Changelog**: [v0.2.0...v0.2.1](https://example.com/compare/v0.2.0...v0.2.1)',
  }), ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Full Changelog 链接应为/)
})

test('release-notes：CRLF 的 CHANGELOG 同样可读', (t) => {
  const body = changelog('0.2.1', '0.2.0').replace(/\n/g, '\r\n')
  const r = run(t, body, ['--version', '0.2.1', '--check'])
  assert.equal(r.status, 0, r.stderr)
})

test('release-notes：--out 写出的内容与 stdout 一致', (t) => {
  const out = join(tmpdir(), `release-notes-${process.pid}-${Date.now()}.md`)
  t.after(() => rmSync(out, { force: true }))
  const plain = run(t, changelog('0.2.1', '0.2.0'), ['--version', '0.2.1'])
  const written = run(t, changelog('0.2.1', '0.2.0'), ['--version', '0.2.1', '--out', out])
  assert.equal(written.status, 0, written.stderr)
  assert.equal(readFileSync(out, 'utf8'), plain.stdout)
})

test('release-notes：仓库 CHANGELOG 的最新版本节始终可发布', () => {
  const latest = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))
  assert.ok(latest, 'CHANGELOG 里至少要有一个带日期的版本节')
  const r = spawnSync(process.execPath, [SCRIPT, '--version', latest[1], '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
