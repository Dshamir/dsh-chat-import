// convert-jsonl-sources.test.mjs — JSONL 源转换（cursor / pi / omp）
// composer id 派生、pi 压缩边界与保留窗口、omp 的标题槽与 /clear 边界。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import assert from 'node:assert/strict'

import { convertCursorJsonl, convertPiJsonl, convertOmpJsonl, SESSION_FORMAT_VERSION, validateSessionEvents } from '../lib/convert/index.mjs'
import { pinSourcedSessionTitle } from '../lib/sourced-title.mjs'

import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertCursorJsonl: 简单问答、user_query 剥离、平衡回合', () => {
  const out = convertCursorJsonl(load('cursor-simple.jsonl'), { cursorId: 'abc123', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 3) // user + assistant×2
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-abc123') // cursorId 传入
  assert.equal(out.meta.sourceId, 'abc123')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal(types.filter((t) => t === 'turn/end').length, 1)
  assertSeqContinuity(out.events)
  // user_query 标签被剥离
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // provider
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'cursor', model: 'cursor' })
})

test('convertCursorJsonl: tool_use → tool/call + 合成空 tool/result，input 对象序列化', () => {
  const out = convertCursorJsonl(load('cursor-tool.jsonl'))
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].data.callId, calls[1].data.callId)
  assert.equal(calls[0].data.name, 'Glob')
  assert.equal(calls[0].data.arguments, '{"target_directory":".","glob_pattern":"**/*.rs"}')
  assert.equal(calls[1].data.name, 'Read')
  // transcript 不含 tool_result → synthesizeSession 为每个 call 补发空 tool/result
  // （空 content，不虚构文本），保证 resume 时 call/result 配对
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].data.message.content[0].content, [])
  assertToolPairing(out.events)
  // 平衡：最后（非 title）事件是 turn/end
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertCursorJsonl: 同一步多个 tool_use 不重复 callId（避免 DSH 历史加载失败）', () => {
  const out = convertCursorJsonl(load('cursor-dual-tool-same-step.jsonl'))
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  const ids = calls.map((e) => e.data.callId)
  assert.equal(new Set(ids).size, 2, 'callId 必须唯一：' + ids.join(', '))
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.ok(!user.content[0].text.includes('<timestamp>'), '用户正文应剥离 timestamp')
  assert.ok(!user.content[0].text.includes('<user_query>'), '用户正文应剥离 user_query')
  assertMessageOrderLegal(out.events)
})

test('convertCursorJsonl: pinSourcedSessionTitle 后标题为 Cursor · 话题', () => {
  const out = convertCursorJsonl(load('cursor-dual-tool-same-step.jsonl'))
  pinSourcedSessionTitle(out, 'Cursor')
  assert.match(out.title, /^Cursor · /)
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.match(titleEv.data.title, /^Cursor · /)
})

test('convertCursorJsonl: [REDACTED] 哨兵过滤', () => {
  const out = convertCursorJsonl(load('cursor-redacted.jsonl'))
  assert.equal(out.turns.length, 1)
  const texts = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  // 整段 [REDACTED] 被丢弃；含前缀的保留前缀
  assert.deepEqual(texts, ['Applied the refactor.'])
  assert.equal(out.messages, 2) // user + 一条有效 assistant
})

test('convertCursorJsonl: 多轮切分、畸形行计数、无 cursorId 回退时间戳 id', () => {
  const out = convertCursorJsonl('not json\n' + load('cursor-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 cursorId 时 id 仍合法（时间戳回退）
  assert.match(out.meta.id, /^import-\d+$/)
})

test('convertPiJsonl: 简单问答、头行元数据、平衡回合', () => {
  const out = convertPiJsonl(load('pi-simple.jsonl'), { sourcePath: 'D:\\demo\\pi-proj\\2025-06-01_pi-simple.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019f0a11-2222-7333-8444-555566667777')
  assert.equal(out.meta.sourceId, '019f0a11-2222-7333-8444-555566667777')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\pi-proj')
  assert.ok(out.meta.createdAt)
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal(types.at(-1), 'turn/end')
  assertSeqContinuity(out.events)
  assert.equal(out.events.filter((e) => e.type === 'turn/start').length, 2)
  // assistant source.model 来自消息级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'pi-coding-agent', model: 'claude-sonnet-4-5' })
})

test('convertPiJsonl: 畸形行与疑似 secret 走共享逐行解析器上报（行号明细 + secrets 位置，失败要大声）', () => {
  const lines = load('pi-simple.jsonl').trimEnd().split('\n')
  lines.splice(2, 0, '{"type":"message", not json')
  lines.push(JSON.stringify({ type: 'label', id: 'z1', parentId: null, label: 'token=abcdefgh12345678' }))
  const out = convertPiJsonl(lines.join('\n'), {})
  assert.equal(out.skipped, 1)
  assert.deepEqual(out.skippedLines.map((s) => s.line), [3])
  assert.deepEqual(out.secrets, [{ line: lines.length, kind: 'token' }])
})

test('convertPiJsonl: 工具历史（arguments 对象序列化、thinking→reasoning、配对、孤儿丢弃、bash 注入文本）', () => {
  const out = convertPiJsonl(load('pi-tool.jsonl'), {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 1) // call-missing 无对应调用 → 孤儿结果丢弃
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-1')
  assert.equal(call.data.name, 'bash')
  assert.equal(call.data.arguments, '{"command":"ls -la"}')
  assert.equal(result.data.message.content[0].toolCallId, 'call-1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // bashExecution 用 Pi 自身文本格式（Ran `cmd` + 输出）挂到当前轮最后一步
  const bash = out.turns[0].steps.at(-1).content.find((c) => c.type === 'text' && c.text.startsWith('Ran `git status`'))
  assert.ok(bash)
  assert.ok(bash.text.includes('On branch main'))
})

test('convertPiJsonl: 树结构——只重建活动分支、branch_summary→reasoning、session_info→标题、model_change→模型', () => {
  const out = convertPiJsonl(load('pi-branch.jsonl'), {})
  assert.equal(out.turns.length, 3) // 旁支「换成方案 B」不在活动路径上
  assert.deepEqual(out.turns.map((t) => t.prompt), ['重构这个模块', '试试方案 A', '继续方案 A'])
  // branch_summary 摘要用 Pi 固定措辞前置到下一个 assistant 步骤的 reasoning
  const head = out.turns[2].steps[0].content
  assert.equal(head[0].type, 'reasoning')
  assert.ok(head[0].text.includes('The following is a summary of a branch'))
  assert.ok(head[0].text.includes('方案 B 被放弃：性能不达标。'))
  // session_info 名称 → session/title；model_change 更新会话级模型
  assert.equal(out.title, '重构模块讨论')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '重构模块讨论')
  const assts = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(assts[0].data.message.source.model, 'claude-sonnet-4-5')
  assert.equal(assts[2].data.message.source.model, 'gpt-5')
  assertMessageOrderLegal(out.events)
})

test('convertPiJsonl: compaction → 原生压缩检查点（保留窗口起点为边界），fullHistory 不发', () => {
  const out = convertPiJsonl(load('pi-compaction.jsonl'), {})
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  // 三个问题都在日志里（全量），但「第一个问题」被检查点遮蔽
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assert.deepEqual(out.turns.map((t) => t.shadowed === true), [true, false, false])
  assert.equal(out.turns[1].compaction.summary, '用户问了两个问题，都已经回答。')
  assert.equal(assertNativeCompaction(out.events), 1)
  // 摘要不再作 reasoning 块（改由检查点承载）
  const reasoning = out.events.filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content).filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [])
  // 模型看到：head → 声明 → 摘要 → 保留窗口（第二个问题起）
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[2], 'user:用户问了两个问题，都已经回答。')
  assert.deepEqual(derived.slice(3), ['user:第二个问题', 'assistant:第二个回答', 'user:第三个问题', 'assistant:第三个回答'])
  assert.equal(validateSessionEvents(out.events).ok, true)
  assertMessageOrderLegal(out.events)

  const full = convertPiJsonl(load('pi-compaction.jsonl'), { fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(full.turns.length, 3) // 全量：三个问题都在
  assert.deepEqual(full.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assert.equal(derivedSurfaceMessages(full.events).length, 8) // head + 声明 + 3 轮问答
  assertMessageOrderLegal(full.events)
})

test('convertPiJsonl: v1 线性条目（无 id/parentId）顺序链兼容', () => {
  const out = convertPiJsonl(load('pi-v1.jsonl'), {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.meta.sourceId, '019f0a11-6666-7777-8888-999900001111')
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertToolPairing(out.events)
})

test('convertPiJsonl: 无 session 头行 / 无用户回合 → skipped', () => {
  const out = convertPiJsonl('not json\n', {})
  assert.equal(out.meta, null)
  assert.equal(out.skipped, 1)
  assert.match(out.skipReason, /no session header/)
  // 只有 session 头、没有任何消息 → 不落空会话
  const empty = convertPiJsonl('{"type":"session","version":3,"id":"x","timestamp":"2025-06-05T10:00:00.000Z","cwd":"D:\\\\demo"}', {})
  assert.equal(empty.meta, null)
  assert.equal(empty.skipped, 1)
})

// ── omp（oh-my-pi）：与 pi 同族（共用 pi-family 引擎），差异在标题载体、model_change 字段
//    与 reset_boundary（/clear）────────────────────────────────────────────────────

test('convertOmpJsonl: 定宽标题槽作标题、头行元数据、平衡回合', () => {
  const out = convertOmpJsonl(load('omp-simple.jsonl'), { sourcePath: 'D:\\demo\\omp\\2025-06-03_omp-simple.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019f0a22-1111-7222-8333-444455556666')
  assert.equal(out.meta.sourceId, '019f0a22-1111-7222-8333-444455556666')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\omp-proj')
  // 标题取定宽标题槽（源侧列表用的就是它），不是头里的 title 兜底
  assert.equal(out.title, '重构模块讨论')
  assert.equal(out.events.find((e) => e.type === 'session/title').data.title, '重构模块讨论')
  assertEnvelopeHygiene(out.events)
  assertSeqContinuity(out.events)
  // 有标题 → 标题事件收尾（无标题的来源以 turn/end 收尾）
  assert.equal(out.events.at(-1).type, 'session/title')
  assert.equal(out.events.filter((e) => e.type === 'turn/end').length, 2)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'oh-my-pi', model: 'claude-sonnet-4-5' })
})

test('convertOmpJsonl: 旧文件无标题槽 → title_change；model_change.model 供会话模型；python 执行与 @file 内联降级为文本', () => {
  const out = convertOmpJsonl(load('omp-tool.jsonl'), {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.title, '目录与执行') // 无标题槽 → 活动路径上最后的 title_change
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.arguments, '{"command":"ls -la"}')
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // 消息自身不带 model：会话级模型来自 model_change 的 `model`（pi 的字段名是 modelId）
  const assts = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(assts.length, 2)
  for (const a of assts) assert.equal(a.data.message.source.model, 'openai/gpt-5')
  // pythonExecution / fileMention 用源自身 convertToLlm 的文本形态降级（挂到当前轮）
  const texts = out.turns[0].steps.flatMap((s) => s.content).filter((c) => c.type === 'text').map((c) => c.text)
  assert.ok(texts.some((t) => t.startsWith('Ran Python:\n```python\nprint(1)\n```') && t.includes('Output:')), 'python 执行文本缺失')
  assert.ok(texts.some((t) => t === '<file path="README.md">\n# demo\n</file>'), '@file 内联文本缺失')
})

test('convertOmpJsonl: reset_boundary（/clear）切掉清空点之前的内容并上报；fullHistory 保留全量', () => {
  const out = convertOmpJsonl(load('omp-reset.jsonl'), {})
  // 源侧模型视角从最后一次 /clear 之后开始 → 只重建清空点之后的轮
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第二个问题'])
  assert.equal(out.resetBoundaries, 1)
  assert.equal(out.compacted, undefined)
  assert.equal(out.events.some((e) => e.type.startsWith('compaction/')), false)
  assertMessageOrderLegal(out.events)
  assert.equal(validateSessionEvents(out.events).ok, true)

  const full = convertOmpJsonl(load('omp-reset.jsonl'), { fullHistory: true })
  assert.deepEqual(full.turns.map((t) => t.prompt), ['第一个问题', '第二个问题'])
  assert.equal(full.resetBoundaries, undefined) // 保留全量时没有可上报的丢弃
  assertMessageOrderLegal(full.events)
})

test('convertOmpJsonl: compaction → 原生压缩检查点（firstKeptEntryId 定保留窗口），fullHistory 不发', () => {
  const out = convertOmpJsonl(load('omp-compaction.jsonl'), {})
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assert.deepEqual(out.turns.map((t) => t.shadowed === true), [true, false, false])
  assert.equal(out.turns[1].compaction.summary, '用户问了两个问题，都已经回答。')
  assert.equal(assertNativeCompaction(out.events), 1)
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[2], 'user:用户问了两个问题，都已经回答。')
  assert.deepEqual(derived.slice(3), ['user:第二个问题', 'assistant:第二个回答', 'user:第三个问题', 'assistant:第三个回答'])
  assert.equal(validateSessionEvents(out.events).ok, true)
  assertMessageOrderLegal(out.events)

  const full = convertOmpJsonl(load('omp-compaction.jsonl'), { fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.deepEqual(full.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assertMessageOrderLegal(full.events)
})

test('convertOmpJsonl: 无 session 头行 → skipped（跳过原因点名来源）', () => {
  const out = convertOmpJsonl('not json\n', {})
  assert.equal(out.meta, null)
  assert.equal(out.skipped, 1)
  assert.match(out.skipReason, /oh-my-pi/)
})
