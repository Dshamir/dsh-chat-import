// test/check-coverage-script.test.mjs — 覆盖率结构护栏自身的解析口径
//
// 报告行的前缀随 Node 大版本变：22 是 `#`（CI 的 setup-node 固定 22），24 起是 `ℹ`。此前只认
// `ℹ`，于是 CI 上解析器一行都匹配不到，报出「目录下限有记账但目录下没有文件」这类误报，test
// job 从 2026-10-13 起每个 PR 都红。这里照抄两种前缀下的真实报告形状各钉一遍，并确认「失败
// 用例不被管道吞掉」这条检查同样不挑前缀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dirname, '..', '.github', 'scripts', 'check-coverage.mjs')

// 报告体按 node:test 的真实排版：目录行只有名字（数字列空），文件行缩进 2 空格（嵌套目录下再
// +2）。数值刻意全达标，只让 KNOWN_GAPS 里的 ignore-command.mjs 停在 18.60 —— 记账之所以存在
// 的原因；于是结论只可能由「解析到没解析到」决定。数量上顶层 lib/ 至少要 7 个文件才拉得动
// 逐目录均值下限（90%），故此处铺 10 个。不含表头行：表头（`file | line % | …`）在真实报告
// 里解析器会当成噪声行，不属于本用例要守的口径。
const DIRS = [
  ['lib', ['index.mjs', 'ignore-command.mjs', 'imports.mjs', 'purge.mjs', 'discovery.mjs', 'panel.mjs', 'tools.mjs', 'toolkit.mjs', 'doctor.mjs', 'ignore.mjs']],
  ['convert', ['codex.mjs']],
  ['discovery', ['jsonl.mjs']],
  ['export', ['common.mjs']],
  ['sources', ['codex.mjs']],
  ['tools', ['import-sources.mjs']],
]

function report(prefix, { allFiles = null } = {}) {
  const row = (name, indent, cols) => `${prefix}${' '.repeat(indent)}${name.padEnd(26)}| ${cols}`
  const lines = [
    'TAP version 13',
    `${prefix} tests 1`,
    `${prefix} pass 1`,
    `${prefix} fail 0`,
    `${prefix} start of coverage report`,
  ]
  if (allFiles !== null) lines.push(row('all files', 1, `${allFiles} |    87.21 |   95.77 | `))
  // 缩进照抄 node 22 的真实报告：顶层目录 1 空格，其下文件 2 空格；嵌套目录 2 空格，其下文件
  // 3 空格（解析器按「数字列为空 = 目录」判层级，路径由父级栈拼出）。
  for (const [dir, files] of DIRS) {
    lines.push(row(dir, dir === 'lib' ? 1 : 2, '       |          |         | '))
    for (const name of files) {
      const pct = name === 'ignore-command.mjs' ? ' 18.60' : '100.00'
      lines.push(row(name, dir === 'lib' ? 2 : 3, `${pct} |   100.00 |  100.00 | `))
    }
  }
  lines.push(`${prefix} end of coverage report`)
  return lines.join('\n') + '\n'
}

function runCheck(body) {
  const dir = mkdtempSync(join(tmpdir(), 'check-coverage-'))
  try {
    const file = join(dir, 'cov.txt')
    writeFileSync(file, body)
    const r = spawnSync(process.execPath, [SCRIPT, '--file=' + file], { encoding: 'utf8' })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const [label, prefix] of [['node 24（ℹ 前缀）', '\u2139'], ['node 22（# 前缀，CI 实际版本）', '#']]) {
  test(`check-coverage：${label} 的报告逐文件解析生效`, () => {
    const r = runCheck(report(prefix, { allFiles: ' 97.78' }))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^check-coverage: OK — 全局 97\.78%、15 个 lib 文件逐个 ≥75%/m)
    // 解析到了目录下的文件（而不是「目录下限有记账但目录下没有文件」）
    assert.doesNotMatch(r.stderr, /目录下没有文件/)
  })

  test(`check-coverage：${label} 的报告里全局行覆盖下限照查`, () => {
    const r = runCheck(report(prefix, { allFiles: ' 50.00' }))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /全局行覆盖 50% 低于下限 75%/)
  })
}

for (const [label, prefix] of [['ℹ', '\u2139'], ['#', '#']]) {
  test(`check-coverage：${label} 前缀下失败用例不被管道吞掉`, () => {
    const r = runCheck(report(prefix).replace(`${prefix} fail 0`, `${prefix} fail 2`))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /有 2 个失败用例/)
  })
}
