import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.mjs'
import { discoverSessions, clearScanCache } from '../lib/discovery.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { copilotVscodeFixture, COPILOT_TIME as TS } from './_support/copilot-vscode.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('copilot-home-')
  clearScanCache()
})

const CWD = hostAbs('D:/copilot-project')
const ROOT = join(CWD, 'Code', 'User', 'workspaceStorage')
const PATH = join(ROOT, 'workspace-one', 'chatSessions', 'session.json')
const WORKSPACE = join(dirname(dirname(PATH)), 'workspace.json')
function setup(fixture = copilotVscodeFixture()) {
  const tree = {
    [CWD]: 'dir', [ROOT]: 'dir',
    [join(ROOT, 'workspace-one')]: 'dir', [dirname(PATH)]: 'dir',
    [PATH]: JSON.stringify(fixture),
    [WORKSPACE]: JSON.stringify({ folder: pathToFileURL(CWD).href }),
  }
  const result = makeCtx(tree)
  apply(result.ctx)
  return { ...result, tree, def: chatDef(result.ctx, 'copilot-vscode') }
}
const extraRequest = { message: 'Another question', timestamp: TS + 400, response: [{ value: 'Another answer' }] }

test('Copilot public preview shows the conversation and writes no session', async () => {
  const { def, persistence } = setup()
  const value = await def.execute({ path: PATH, preview: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 3)
  assert.equal(value.toolCalls, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

for (const version of [3, 4]) {
  test('Copilot public import preserves title, workspace, source times and valid V' + version + ' envelopes', async () => {
    const { def, ctx, persistence, attached } = setup()
    ctx.sessionPersistence.formatVersion = version
    const value = await def.execute({ path: PATH })
    assert.equal(value.mode, 'single')
    assert.equal(value.turns, 3)
    assert.equal(value.toolCalls, 1)
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
    const saved = persistence.sessions.get(value.sessionId)
    assert.equal(saved.meta.createdAt, TS)
    assert.equal(saved.meta.cwd, CWD)
    assert.equal(saved.meta.version, version)
    assert.match(saved.events.find((e) => e.type === 'session/title').data.title, /Copilot VS Code.*Named example/)
    assertEnvelopeHygiene(saved.events)
    assert.equal(attached.length, 1)
    const again = await def.execute({ path: PATH })
    assert.equal(again.alreadyImported, true)
    assert.equal(persistence.sessions.size, 1)
  })
}

test('Copilot source growth appends to an untouched imported session', async () => {
  const { def, ctx, persistence } = setup()
  const first = await def.execute({ path: PATH })
  const grown = copilotVscodeFixture()
  grown.requests.push(extraRequest)
  await ctx.fs.writeText(await ctx.fs.resolve(PATH), JSON.stringify(grown))
  const second = await def.execute({ path: PATH })
  assert.equal(second.status, 'appended')
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.appendedTurns, 1)
  assert.equal(persistence.sessions.size, 1)
  assertEnvelopeHygiene(persistence.sessions.get(first.sessionId).events)
})

test('Copilot source growth after DSH activity creates a copy and preserves the prior log', async () => {
  const { def, ctx, persistence } = setup()
  const first = await def.execute({ path: PATH })
  const saved = persistence.sessions.get(first.sessionId)
  const fromSeq = saved.events.length
  await persistence.append(first.sessionId, [
    { type: 'user/message', seq: fromSeq, time: TS + 350, surfaceOp: 'append',
      data: { id: 'live-user', role: 'user', content: [{ type: 'text', text: 'Question in DSH' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: fromSeq + 1, time: TS + 351, surfaceOp: 'append',
      data: { id: 'live-answer', role: 'assistant', content: [{ type: 'text', text: 'Answer in DSH' }], source: { kind: 'model', provider: 'dsh' } } },
  ])
  const original = JSON.stringify(saved.events)
  const grown = copilotVscodeFixture()
  grown.requests.push(extraRequest)
  await ctx.fs.writeText(await ctx.fs.resolve(PATH), JSON.stringify(grown))
  const second = await def.execute({ path: PATH })
  assert.equal(second.reimported.reason, 'continued-in-dsh')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(persistence.sessions.size, 2)
  assert.equal(JSON.stringify(saved.events), original)
})

test('Copilot missing-data counts reach the public schema and render', async () => {
  const fixture = copilotVscodeFixture()
  const tool = fixture.requests[0].response.find((p) => p.kind === 'toolInvocationSerialized')
  delete tool.toolSpecificData
  delete tool.resultDetails
  const { def } = setup(fixture)
  const value = await def.execute({ path: PATH })
  assert.equal(value.missingToolInputs, 1)
  assert.equal(value.missingToolOutputs, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const rendered = JSON.stringify(def.output.render({ format: 'copilot-vscode' }, value))
  assert.match(rendered, /源未保存工具参数/)
  assert.match(rendered, /源未保存工具结果/)
})

test('Copilot directory preview and batch results retain missing-data counts', async () => {
  const fixture = copilotVscodeFixture()
  const tool = fixture.requests[0].response.find((p) => p.kind === 'toolInvocationSerialized')
  delete tool.toolSpecificData
  delete tool.resultDetails
  const { def, persistence } = setup(fixture)
  const preview = await def.execute({ path: ROOT, preview: true })
  assert.equal(preview.total, 1)
  assert.equal(preview.results[0].missingToolInputs, 1)
  assert.equal(preview.results[0].missingToolOutputs, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, preview), [])
  assert.match(JSON.stringify(def.output.render({ format: 'copilot-vscode' }, preview)), /源未保存工具参数/)
  assert.equal(persistence.sessions.size, 0)
  const imported = await def.execute({ path: ROOT })
  assert.equal(imported.results[0].missingToolInputs, 1)
  assert.equal(imported.results[0].missingToolOutputs, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, imported), [])
})

test('Copilot explicit working directory wins over workspace hints; force creates a copy', async () => {
  const sourceCwd = hostAbs('D:/saved-project')
  const { def, persistence } = setup(copilotVscodeFixture({ workingDirectory: pathToFileURL(sourceCwd).href }))
  const first = await def.execute({ path: PATH })
  assert.equal(persistence.sessions.get(first.sessionId).meta.cwd, sourceCwd)
  const copy = await def.execute({ path: PATH, force: true })
  assert.notEqual(copy.sessionId, first.sessionId)
  assert.equal(persistence.sessions.size, 2)
})

test('Copilot imports a copied session without workspace metadata', async () => {
  const { def, ctx, persistence } = setup()
  const copied = join(CWD, 'copied.json')
  await ctx.fs.writeText(await ctx.fs.resolve(copied), JSON.stringify(copilotVscodeFixture()))
  const result = await def.execute({ path: copied })
  assert.equal(result.turns, 3)
  assert.equal(persistence.sessions.size, 1)
})

test('Copilot directory import selects chatSessions files and excludes workspace metadata', async () => {
  const { def, ctx, persistence, tree } = setup()
  const secondPath = join(ROOT, 'workspace-two', 'chatSessions', 'second.json')
  tree[join(ROOT, 'workspace-two')] = 'dir'
  tree[dirname(secondPath)] = 'dir'
  await ctx.fs.writeText(await ctx.fs.resolve(secondPath), JSON.stringify(copilotVscodeFixture({ sessionId: 'second-session' })))
  const value = await def.execute({ path: ROOT, recursive: true })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.skipped, 0)
  assert.equal(persistence.sessions.size, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

for (const sep of ['/', '\\']) {
  test('Copilot discovery reads source metadata and folder hint with ' + sep + ' paths', async () => {
    const root = ['home', 'example', 'Code', 'User', 'workspaceStorage'].join(sep)
    const file = root + sep + ['one', 'chatSessions', 'session.json'].join(sep)
    const workspace = root + sep + ['one', 'workspace.json'].join(sep)
    const files = withDirs(root, new Map([
      [file, { type: 'file', text: JSON.stringify(copilotVscodeFixture()), mtimeMs: TS + 900 }],
      [workspace, { type: 'file', text: '{"folder":"file:///home/project"}' }],
      [root + sep + 'unrelated.json', { type: 'file', text: '{}' }],
    ]))
    const result = await discoverSessions({ path: root, format: 'copilot-vscode', host: memoryHost(files), imports: {} })
    assert.equal(result.total, 1)
    const entry = result.sessions[0]
    assert.equal(entry.sessionId, 'copilot-example')
    assert.equal(entry.title, 'Named example')
    assert.equal(entry.cwd, '/home/project')
    assert.equal(entry.project, 'project')
    assert.equal(entry.createdAt, TS)
    assert.equal(entry.lastActiveAt, TS + 300)
    assert.equal(entry.sourcePath, file)
    const direct = await discoverSessions({ path: file, host: memoryHost(files), imports: {} })
    assert.equal(direct.total, 1)
    assert.equal(direct.sessions[0].format, 'copilot-vscode')
  })
}

test('Copilot discovery ignores unreadable, invalid, empty and unrelated JSON sessions', async () => {
  const root = '/home/example/Code/User/workspaceStorage'
  const files = withDirs(root, new Map([
    [root + '/one/chatSessions/bad.json', { type: 'file', text: '{' }],
    [root + '/one/chatSessions/empty.json', { type: 'file', text: JSON.stringify(copilotVscodeFixture({ requests: [] })) }],
    [root + '/one/unrelated.json', { type: 'file', text: JSON.stringify(copilotVscodeFixture()) }],
  ]))
  const host = memoryHost(files)
  assert.equal((await discoverSessions({ path: root, format: 'copilot-vscode', host, imports: {} })).total, 0)
  assert.equal((await discoverSessions({ path: root + '/absent', format: 'copilot-vscode', host, imports: {} })).total, 0)
})
