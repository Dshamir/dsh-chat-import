// qoder.test.mjs — Qoder CLI 源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertQoderJsonl } from '../lib/convert/qoder.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'

function qoder(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = 'sess-qoder-1'
const CWD = '/home/u/my-project'
const TS = '2026-01-02T03:04:05.000Z'

function userRec(content) {
  return { type: 'user', uuid: 'u' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD, message: { role: 'user', content } }
}
function assistantRec(content) {
  return { type: 'assistant', uuid: 'a' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD, message: { role: 'assistant', content } }
}

test('简单 user/assistant 轮次 → 1 轮对话、cwd/createdAt 落 meta', () => {
  const raw = qoder([
    userRec('帮我看看这个项目'),
    assistantRec([{ type: 'text', text: '好的，我先读一下结构。' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/-home-u-my-project/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.ok(out.meta.createdAt > 0)
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2) // user + assistant
  assert.equal(out.toolCalls, 0)
})

test('tool_use + tool_result 按 tool_use_id 配对', () => {
  const raw = qoder([
    userRec('读一下 README'),
    assistantRec([
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
    ]),
    userRec([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '# 项目标题' }] },
    ]),
    assistantRec([{ type: 'text', text: '已读完。' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
  // tool/result 的文本进入结果内容
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, '# 项目标题')
})

test('tool_result 缺 tool_use_id 时按未决调用顺序回退配对', () => {
  const raw = qoder([
    userRec('跑个命令'),
    assistantRec([
      { type: 'tool_use', id: 'toolu_a', name: 'run_in_terminal', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_b', name: 'run_in_terminal', input: { command: 'pwd' } },
    ]),
    userRec([
      { type: 'tool_result', content: [{ type: 'text', text: 'a' }] },
      { type: 'tool_result', content: [{ type: 'text', text: 'b' }] },
    ]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 2)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('孤儿 tool_result（无对应调用）丢弃并计数', () => {
  const raw = qoder([
    userRec('hi'),
    userRec([{ type: 'tool_result', tool_use_id: 'missing', content: [{ type: 'text', text: 'x' }] }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.droppedToolResults, 1)
})

test('标题选取 ai-title > last-prompt > 首问', () => {
  const aiTitle = qoder([
    userRec('第一个问题'),
    { type: 'ai-title', aiTitle: '自定义标题', sessionId: SID },
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(aiTitle, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '自定义标题')

  const lastPrompt = qoder([
    userRec('第一个问题'),
    { type: 'last-prompt', lastPrompt: '末次提问标题', sessionId: SID },
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(lastPrompt, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '末次提问标题')

  const firstUser = qoder([
    userRec('只有首问的标题'),
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(firstUser, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '只有首问的标题')
})

test('子代理/辅助 transcript（fileStem != sessionId）跳过', () => {
  const raw = qoder([
    userRec('子代理里的消息'),
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  const out = convertQoderJsonl(raw, { fileStem: 'subagent-name', sourcePath: '/home/u/.qoder/projects/p/' + SID + '/subagents/subagent-name.jsonl' })
  assert.equal(out.meta, null)
  assert.ok(out.skipReason.includes('subagent'))
  assert.equal(out.turns.length, 0)
})

test('多轮对话：每条直连 user 提问开新轮', () => {
  const raw = qoder([
    userRec('第一问'),
    assistantRec([{ type: 'text', text: '一答' }]),
    userRec('第二问'),
    assistantRec([{ type: 'text', text: '二答' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
})

test('导入归属外置 registry：日志无标记，环境变更声明在首个 step/start 之后（issue #34 / #66）', () => {
  const raw = qoder([
    userRec('hi'),
    assistantRec([{ type: 'text', text: 'yo' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  // 首个 step/start 之后依次是 system head（宿主 v3→v4 迁移要求 surface 首事件是它）
  // 与环境变更声明（issue #66：声明不再早于首个 step/start，宿主 v2→v3 迁移对该形状 fail-closed）
  assert.deepEqual(out.events.slice(0, 4).map((e) => e.type), ['turn/start', 'step/start', 'system/message', 'user/message'])
  assert.equal(out.events[2].data.message.role, 'system')
  assert.equal(out.events[2].data.message.source.kind, 'plugin')
  assert.equal(out.events[3].data.source.kind, 'plugin')
})

test('数组 content 的直连提问开新轮，含 tool_result 的数组只做配对', () => {
  const raw = qoder([
    userRec([{ type: 'text', text: '读一下' }, { type: 'text', text: 'README' }]),
    assistantRec([
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'README.md' } },
    ]),
    userRec([{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: '# 标题' }] }]),
    assistantRec([{ type: 'text', text: '读完了' }]),
    userRec([{ type: 'text', text: '第二问' }]),
    assistantRec([{ type: 'text', text: '二答' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, '读一下\nREADME')
  assert.equal(out.turns[0].steps.length, 2)
  assert.equal(out.turns[1].prompt, '第二问')
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assert.equal(out.title, '读一下 README')
  assertToolPairing(out.events)
})

// ── 上下文压缩 ────────────────────────────────────────────────────────────────
// Qoder CLI 压缩时落「边界标记 + 摘要正文」两条记录（与 Claude Code 同款）。
// 不认它们会让压缩前的全部历史留在 surface 上，导入会话直接超模型窗口、每轮 400。

function boundaryRec() {
  return {
    type: 'system', subtype: 'compact_boundary', isCompactSummary: true,
    uuid: 'sb' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD,
    content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 421159, postTokens: 13571 },
  }
}
function summaryRec(text) {
  return {
    type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
    uuid: 'us' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD,
    message: { role: 'user', content: text },
  }
}

const SUM1 = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. 第一段要点'
const SUM2 = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. 第二段要点'

test('压缩边界：边界+摘要发原生检查点，压缩前的轮不进模型投影', () => {
  const raw = qoder([
    userRec('问题1'), assistantRec([{ type: 'text', text: '回答1' }]),
    boundaryRec(), summaryRec(SUM1),
    userRec('问题2'), assistantRec([{ type: 'text', text: '回答2' }]),
    boundaryRec(), summaryRec(SUM2),
    userRec('继续问题'), assistantRec([{ type: 'text', text: '继续回答' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 2)
  // isCompactSummary 记录不是人类提问
  assert.equal(out.turns.length, 3)
  assert.deepEqual(out.turns.map((t) => t.prompt), ['问题1', '问题2', '继续问题'])
  const summaries = out.events.filter((e) => e.type === 'compaction/summary')
  assert.deepEqual(summaries.map((e) => e.data.summary[0].text), [SUM1, SUM2])
  assert.equal(assertNativeCompaction(out.events), 2)
  assert.equal(summaries[0].data.provider, 'qoder')
  // 模型视角：最后一次摘要 + 压缩点之后的内容；之前的对话被遮蔽
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[2], 'user:' + SUM2)
  assert.ok(derived.some((d) => d.includes('继续回答')))
  assert.ok(!derived.some((d) => d.includes('回答1') || d.includes('回答2')))
  // 全量正文仍在日志里（log-only，不是删除）
  const allText = out.events.map((e) => JSON.stringify(e.data)).join('\n')
  assert.ok(allText.includes('回答1') && allText.includes('回答2'))
  assertToolPairing(out.events)
})

test('压缩边界：fullHistory 不发检查点，摘要按普通 user 记录导入', () => {
  const raw = qoder([
    userRec('问题1'), assistantRec([{ type: 'text', text: '回答1' }]),
    boundaryRec(), summaryRec(SUM1),
    userRec('问题2'), assistantRec([{ type: 'text', text: '回答2' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl', fullHistory: true })
  assert.equal(out.compacted, undefined)
  assert.equal(out.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(out.turns.length, 3) // 2 条提问 + 1 条摘要（按普通 user 导入，正文不丢）
  assert.ok(out.turns.some((t) => t.prompt === SUM1))
})

test('压缩边界：只有 boundary 没有摘要正文 → 不发检查点，也不丢后半段', () => {
  const raw = qoder([
    userRec('问题1'), assistantRec([{ type: 'text', text: '回答1' }]),
    boundaryRec(),
    userRec('问题2'), assistantRec([{ type: 'text', text: '回答2' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.compacted, undefined)
  assert.equal(out.turns.length, 2)
  assert.deepEqual(out.turns.map((t) => t.prompt), ['问题1', '问题2'])
})

test('压缩边界：压缩后无新提问的续跑内容归入压缩边界轮，不丢步', () => {
  const raw = qoder([
    userRec('做一件事'), assistantRec([{ type: 'text', text: '开始' }]),
    boundaryRec(), summaryRec(SUM1),
    // 压缩后 Qoder 直接续跑，没有新的人类提问
    assistantRec([{ type: 'text', text: '续跑第一步' }]),
    assistantRec([{ type: 'text', text: '续跑第二步' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  // 1 条真实提问 + 1 条承载检查点的空 prompt 轮
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[1].prompt, '')
  assert.equal(out.turns[1].steps.length, 2)
  const derived = derivedSurfaceMessages(out.events)
  assert.ok(derived.some((d) => d.includes('续跑第一步')))
  assert.ok(derived.some((d) => d.includes('续跑第二步')))
  assert.ok(!derived.some((d) => d.includes('开始')))
})

test('压缩边界：会话正好停在压缩点（末尾无后续记录）→ 检查点仍发射', () => {
  const raw = qoder([
    userRec('问题1'), assistantRec([{ type: 'text', text: '回答1' }]),
    boundaryRec(), summaryRec(SUM1),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
})
