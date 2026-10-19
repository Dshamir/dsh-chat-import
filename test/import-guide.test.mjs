// test/import-guide.test.mjs — import_chat 的常驻 schema 与下沉指南之间的一致性
//
// 背景：工具 schema 是每轮对话都要付的常驻成本（宿主的 provider 层只把 name / description /
// parameters 发给模型，见 dsh-llm-deepseek 与 dsh-llm 的 toolDeclarations；output.schema 不上线，
// 所以只有这三项算钱）。29 个来源的 path 形状表、参数长文与重导细则因此下沉到
// docs/IMPORT-GUIDE.md，由运行时 skill dsh-chat-import-usage 按需加载。
//
// 下沉的风险是「搬走了但没搬全」和「指南与代码各写一份」，两条都在这里拦住；
// 常驻成本本身的上限护栏在 test/tools-injection.test.mjs（同口径只留一份）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../lib/tools.mjs'
import { CHAT_FORMATS } from '../lib/toolkit.mjs'
import { USAGE_SKILL_NAME, buildUsageSkill, registerUsageSkill } from '../lib/skill.mjs'
import { makeCtx } from './_support/fake-host.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const EN_GUIDE = read('docs/IMPORT-GUIDE.md')
const ZH_GUIDE = read('docs/IMPORT-GUIDE.zh-CN.md')

function registeredTools() {
  const { ctx, registered } = makeCtx()
  registerTools(ctx, '.import-guide-test')
  return new Map(registered.map((d) => [d.name, d]))
}

// Markdown 表格里的来源行：| `format` | shape |
function guideRows(text) {
  return [...text.matchAll(/^\| `([a-z0-9-]+)` \| (.+?) \|$/gm)].map((m) => [m[1], m[2]])
}

test('schema 不再携带来源 path 形状表：format 只留枚举 + 一行指针', () => {
  const format = registeredTools().get('import_chat').parameters.properties.format
  assert.equal(format.enum.length, CHAT_FORMATS.length)
  assert.match(format.description, new RegExp(USAGE_SKILL_NAME))
  // 形状表搬走后，schema 里不该再出现任何来源的根路径
  for (const [, shape] of CHAT_FORMATS) {
    const hint = /\(([^)]*[/\\][^)]*)\)/.exec(shape)
    if (hint) assert.ok(!format.description.includes(hint[1]), 'format.description 又带上了 ' + hint[1])
  }
  assert.ok(format.description.length <= 160, 'format.description 回肥到 ' + format.description.length + ' 字符')
})

test('工具 description 点名 usage skill（模型据此在调用前加载长文）', () => {
  const desc = registeredTools().get('import_chat').description
  assert.match(desc, new RegExp(USAGE_SKILL_NAME))
})

test('下沉完整性：每个声明的参数在指南里都有条目（含中英两份）', () => {
  const params = Object.keys(registeredTools().get('import_chat').parameters.properties)
  assert.ok(params.length >= 20, '参数数量异常：' + params.length)
  for (const name of params) {
    assert.ok(new RegExp('`' + name + '`').test(EN_GUIDE), 'docs/IMPORT-GUIDE.md 缺参数条目：' + name)
    assert.ok(new RegExp('`' + name + '`').test(ZH_GUIDE), 'docs/IMPORT-GUIDE.zh-CN.md 缺参数条目：' + name)
  }
})

test('来源表单一事实源：指南表格与 CHAT_FORMATS 逐字一致（中英两份）', () => {
  const expected = CHAT_FORMATS.map(([f, d]) => [f, d])
  assert.deepEqual(guideRows(EN_GUIDE), expected)
  // 中文版的形状列保持英文原文：路径与技术名词不翻译，才好在两版之间、以及与代码之间对账
  assert.deepEqual(guideRows(ZH_GUIDE), expected)
})

test('buildUsageSkill：指南内容组装成运行时 skill 定义；空内容返回 null', () => {
  const def = buildUsageSkill('# Guide\n…')
  assert.equal(def.name, USAGE_SKILL_NAME)
  assert.equal(def.source, 'runtime')
  assert.equal(def.content, '# Guide\n…')
  assert.ok(def.description.length > 0)
  assert.ok(def.whenToUse.length > 0)
  // resourceBase 指到包内 docs/：指南里的相对链接（USAGE.md、INTERCHANGE.md）按目录解析
  assert.ok(def.resourceBase.path.replace(/\\/g, '/').endsWith('/docs'))
  assert.equal(buildUsageSkill(''), null)
  assert.equal(buildUsageSkill(undefined), null)
})

test('registerUsageSkill：读包内指南并注册，正文含来源表与重导规则', () => {
  const registered = []
  const dispose = registerUsageSkill({}, { register(def) { registered.push(def); return () => {} } })
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, USAGE_SKILL_NAME)
  assert.ok(registered[0].content.includes('| `local-jsonl` |'))
  assert.match(registered[0].content, /Re-import rules/)
})

test('registerUsageSkill：指南读取失败只警告不注册（大声但不炸导入）', () => {
  const registered = []
  const warns = []
  const origWarn = console.warn
  console.warn = (m) => warns.push(m)
  try {
    const out = registerUsageSkill(
      {},
      { register(def) { registered.push(def) } },
      { readFile() { throw new Error('EIO') } },
    )
    assert.equal(out, undefined)
  } finally {
    console.warn = origWarn
  }
  assert.equal(registered.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skill/)
})
