import { test } from 'node:test'
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import {
  convertCopilotVscodeJson, readCopilotVscodeSession, copilotVscodeCwd, copilotVscodeMetadata,
} from '../lib/convert/copilot-vscode.mjs'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { copilotVscodeRoots } from '../lib/discovery/copilot-vscode.mjs'
import { readCopilotVscodeWorkspace } from '../lib/sources/copilot-vscode.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { copilotVscodeFixture, COPILOT_TIME as TS } from './_support/copilot-vscode.mjs'

const convert = (fixture) => convertCopilotVscodeJson(JSON.stringify(fixture))
const oneRequest = (response, extra = {}) => copilotVscodeFixture({
  requests: [{ message: 'Example question', timestamp: TS + 1, response, ...extra }],
})
const call = (extra = {}) => ({
  kind: 'toolInvocationSerialized', toolCallId: 'tool-one', toolId: 'exampleTool',
  toolSpecificData: { kind: 'input', rawInput: { value: 1 } },
  resultDetails: { input: '{"value":1}', output: [{ type: 'embed', isText: true, value: 'result' }] },
  isComplete: true, ...extra,
})

test('Copilot v3 preserves ordered prose, reasoning, paired tools, title and source time', () => {
  const out = convert(copilotVscodeFixture())
  assert.equal(out.turns.length, 3)
  assert.equal(out.title, 'Named example')
  assert.equal(out.meta.sourceId, 'copilot-example')
  assert.equal(out.meta.createdAt, TS)
  const first = out.turns[0]
  assert.equal(first.prompt, 'Inspect example')
  assert.deepEqual(first.steps[0].content.map((b) => b.type), ['text', 'reasoning', 'tool-call'])
  assert.equal(first.steps[0].content[0].text, 'First look.')
  assert.deepEqual(first.steps[0].toolCalls, [{ type: 'tool-call', id: 'read-one', name: 'readFile', arguments: '{"path":"example.txt"}' }])
  assert.deepEqual(first.steps[0].toolResults[0].content, [{ type: 'text', text: 'example output' }])
  assert.equal(first.steps[1].content[0].text, 'Done.')
  assert.equal(out.turns[1].prompt, 'Explain the result')
  assert.equal(out.turns[2].prompt, 'Keep the context')
  assert.equal(out.toolCalls, 1)
  assert.equal(out.missingToolInputs, 0)
  assert.equal(out.missingToolOutputs, 0)
  assert.equal(out.metaMessages, 2)
  assertEnvelopeHygiene(out.events)
  assert.equal(out.events.find((e) => e.type === 'user/message').time, TS + 100)
  assert.ok(out.events.some((e) => e.time === TS + 130))
  assert.ok(out.events.some((e) => e.type === 'session/title' && e.data.title === 'Named example'))
})

for (const [name, value] of [
  ['invalid JSON', '{'], ['null', 'null'], ['array', '[]'],
  ['future version', JSON.stringify(copilotVscodeFixture({ version: 4 }))],
  ['different format', '{"sessionId":"other","history":[]}'],
  ['missing identity', JSON.stringify(copilotVscodeFixture({ sessionId: '' }))],
]) {
  test('Copilot rejects ' + name + ' without echoing source content', () => {
    const out = convertCopilotVscodeJson(value)
    assert.equal(out.meta, null)
    assert.equal(out.skipped, 1)
    assert.match(out.skipReason, /Copilot VS Code v3/)
    assert.equal(readCopilotVscodeSession(value), null)
  })
}

test('Copilot empty requests do not create a session', () => {
  assert.equal(convert(copilotVscodeFixture({ requests: [] })).meta, null)
  assert.equal(convert(oneRequest([], { message: '' })).meta, null)
})

test('Copilot title falls back to parsed prompt; invalid custom title is not used', () => {
  assert.equal(convert(copilotVscodeFixture({ customTitle: '' })).title, 'Inspect example')
  assert.equal(convert(copilotVscodeFixture({ customTitle: 42 })).title, 'Inspect example')
})

test('Copilot result input and legacy string output retain their stored values', () => {
  const out = convert(oneRequest([
    call({ toolSpecificData: undefined, resultDetails: { input: '{"path":"a"}', output: 'stored result', isError: true } }),
  ]))
  assert.equal(out.turns[0].steps[0].toolCalls[0].arguments, '{"path":"a"}')
  assert.equal(out.turns[0].steps[0].toolResults[0].isError, true)
  assert.equal(out.turns[0].steps[0].toolResults[0].content[0].text, 'stored result')
  assert.equal(out.missingToolInputs, 0)
  const shell = convert(oneRequest([call({ toolSpecificData: undefined, resultDetails: { input: 'echo example', output: '' } })]))
  assert.equal(JSON.parse(shell.turns[0].steps[0].toolCalls[0].arguments), 'echo example')
  assert.equal(shell.missingToolOutputs, 0)
})

test('Copilot preparation and final update yield one tool call with final result', () => {
  const out = convert(oneRequest([
    { kind: 'prepareToolInvocation', toolCallId: 'tool-one', toolSpecificData: { kind: 'input', rawInput: { path: 'a' } } },
    call({ toolSpecificData: undefined, isComplete: false, resultDetails: undefined }),
    call({ toolSpecificData: undefined, resultDetails: { output: 'final' } }),
  ]))
  assert.equal(out.toolCalls, 1)
  assert.equal(out.turns[0].steps[0].toolCalls[0].arguments, '{"path":"a"}')
  assert.equal(out.turns[0].steps[0].toolResults[0].content[0].text, 'final')
})

test('Copilot parallel calls keep ids and results in source order', () => {
  const out = convert(oneRequest([call(), call({ toolCallId: 'tool-two' }), { value: 'after both' }]))
  assert.equal(out.turns[0].steps[0].toolCalls.length, 2)
  assert.deepEqual(out.turns[0].steps[0].toolResults.map((r) => r.toolCallId), ['tool-one', 'tool-two'])
  assert.equal(out.turns[0].steps[1].content[0].text, 'after both')
})

test('Copilot reports missing parameters/results while retaining invocation evidence', () => {
  const out = convert(oneRequest([call({
    toolSpecificData: undefined, resultDetails: undefined, invocationMessage: { value: 'Read example.txt' },
  })]))
  assert.equal(out.missingToolInputs, 1)
  assert.equal(out.missingToolOutputs, 1)
  assert.equal(out.turns[0].steps[0].content[0].text, 'Read example.txt')
  assert.equal(out.turns[0].steps[0].toolCalls[0].arguments, '{}')
  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [])
})

test('Copilot retains terminal command and stored output without claiming original parameters', () => {
  const out = convert(oneRequest([call({
    toolSpecificData: { kind: 'terminal', commandLine: { original: 'echo example' }, terminalCommandOutput: { text: 'example' } },
    resultDetails: undefined, resultError: 'failed',
  })]))
  assert.match(out.turns[0].steps[0].content[0].text, /echo example/)
  assert.equal(out.turns[0].steps[0].toolResults[0].content[0].text, 'example')
  assert.equal(out.turns[0].steps[0].toolResults[0].isError, true)
  assert.equal(out.missingToolInputs, 1)
  assert.equal(out.missingToolOutputs, 0)
})

test('Copilot counts unsupported output, malformed requests and editor metadata', () => {
  const fixture = oneRequest([
    { kind: 'textEditGroup' }, { kind: 'codeblockUri' }, { kind: 'undoStop' }, { kind: 'mcpServersStarting' },
    { kind: 'futurePart', value: 'not prose' }, null, { kind: 'toolInvocationSerialized' },
    call({ resultDetails: { output: [{ type: 'ref', uri: 'file:///not-read' }, { type: 'embed', isText: false, value: 'AAAA' }] } }),
    { kind: 'markdownContent', content: { value: '' } },
  ])
  fixture.requests.unshift(null)
  const out = convert(fixture)
  assert.equal(out.metaMessages, 4)
  assert.equal(out.droppedMalformedOutputs, 3)
  assert.equal(out.droppedToolResultBlocks, 2)
  assert.equal(out.skipped, 1)
})

test('Copilot uses each request model and activity time', () => {
  const fixture = copilotVscodeFixture()
  fixture.requests[1].modelId = 'second-model'
  const out = convert(fixture)
  assert.ok(out.events.some((e) => e.data?.message?.source?.model === 'second-model'))
  assert.equal(copilotVscodeMetadata(fixture).lastActiveAt, TS + 300)
  assert.equal(copilotVscodeMetadata({ ...fixture, lastMessageDate: TS + 500 }).lastActiveAt, TS + 500)
})

test('Copilot metadata handles long histories without spreading timestamps into a call', () => {
  const session = { sessionId: 'long', creationDate: TS, requests: Array.from({ length: 100000 }, (_, i) => ({ timestamp: TS + i })) }
  assert.equal(copilotVscodeMetadata(session).lastActiveAt, TS + 99999)
})

test('Copilot retains multiline thinking and Markdown content variants', () => {
  const out = convert(oneRequest([
    { kind: 'thinking', value: ['First thought', null, 'Second thought'] },
    { kind: 'markdownContent', content: 'Plain content' },
    { kind: 'markdownVuln', content: { value: ' with annotations' } },
  ]))
  assert.equal(out.turns[0].steps[0].content[0].text, 'First thought\nSecond thought')
  assert.equal(out.turns[0].steps[0].content[1].text, 'Plain content with annotations')
})

test('Copilot request token totals appear once after tools; invalid totals are omitted', () => {
  const response = [{ value: 'Before' }, call(), { value: 'After' }]
  const out = convert(oneRequest(response, { promptTokens: 12, completionTokens: 34 }))
  const used = out.events.filter((e) => e.data?.usage)
  assert.equal(used.length, 1)
  assert.deepEqual(used[0].data.usage, { inputTokens: 12, outputTokens: 34 })
  assert.equal(used[0].data.message.content[0].text, 'After')
  for (const extra of [{ promptTokens: -1, completionTokens: 1 }, { promptTokens: 1.5, completionTokens: 1 }, { promptTokens: 1 }]) {
    assert.equal(convert(oneRequest(response, extra)).events.some((e) => e.data?.usage), false)
  }
})

test('Copilot cwd accepts local file URIs and rejects nonlocal/relative resources', () => {
  assert.equal(copilotVscodeCwd('file:///home/example/a%20b'), '/home/example/a b')
  assert.equal(copilotVscodeCwd('file:///C%3A/example/a%20b'), 'C:\\example\\a b')
  assert.equal(copilotVscodeCwd('file://server/share/example'), '\\\\server\\share\\example')
  for (const value of [undefined, '', 'relative/path', 'vscode-remote://ssh-remote/example', 'file:///%ZZ']) {
    assert.equal(copilotVscodeCwd(value), null)
  }
  assert.equal(readCopilotVscodeWorkspace('{"folder":"file:///home/example"}'), '/home/example')
  assert.equal(readCopilotVscodeWorkspace('{"workspace":"file:///home/example.code-workspace"}'), null)
  assert.equal(readCopilotVscodeWorkspace('{'), null)
})

test('Copilot default roots cover the host platform and explicit portable storage', () => {
  assert.deepEqual(copilotVscodeRoots('C:\\Users\\example', { APPDATA: 'D:\\Roaming' }, 'win32'),
    ['Code', 'Code - Insiders', 'VSCodium'].map((name) => win32.join('D:\\Roaming', name, 'User', 'workspaceStorage')))
  assert.equal(copilotVscodeRoots('/home/example', {}, 'linux')[0], '/home/example/.config/Code/User/workspaceStorage')
  assert.equal(copilotVscodeRoots('/home/example', { XDG_CONFIG_HOME: '/config' }, 'linux')[0], '/config/Code/User/workspaceStorage')
  assert.equal(copilotVscodeRoots('/Users/example', {}, 'darwin')[0], posix.join('/Users/example', 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'))
  assert.deepEqual(copilotVscodeRoots('/home/example', { COPILOT_VSCODE_STORAGE_DIR: '/portable' }, 'linux'), ['/portable'])
})

test('Copilot is recognized through the public file parser with path hints and content', () => {
  const raw = JSON.stringify(copilotVscodeFixture())
  for (const sourcePath of ['/vscode/workspaceStorage/a/chatSessions/s.json', 'C:\\Code\\chatSessions\\s.json', '/copied.json']) {
    const out = convertLocalJsonl(raw, { sourcePath })
    assert.equal(out.detectedFormat, 'copilot-vscode')
    assert.equal(out.turns.length, 3)
  }
  assert.equal(convertLocalJsonl(raw, { format: 'copilot-vscode' }).detectedBy, 'override')
})
