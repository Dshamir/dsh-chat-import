import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultRoots, discoverSessions } from '../lib/discovery.mjs'
import { readHermesDbSummaries } from '../lib/sources/hermes.mjs'
import { diskHost } from './_support/discovery-host.mjs'

function platformEnv(t, platform, localAppData) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const previous = process.env.LOCALAPPDATA
  Object.defineProperty(process, 'platform', { value: platform })
  if (localAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = localAppData
  t.after(() => {
    Object.defineProperty(process, 'platform', descriptor)
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
  })
}

function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hermes-roots-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function createDb(path, id) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
    db.exec('CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, created_at REAL)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(id, 'Synthetic Hermes session', dirname(path), 1786000000)
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)').run(id, 'user', 'Synthetic prompt', 1786000001)
  } finally {
    db.close()
  }
}

function hermesHost() {
  return diskHost({
    readSessions(format, path) {
      assert.equal(format, 'hermes')
      const rows = readHermesDbSummaries(path)
      return rows === null ? null : rows.map((s) => ({ ...s, directory: s.cwd }))
    },
  })
}

test('Hermes default roots use injected LOCALAPPDATA and retain the home layout on Windows', (t) => {
  const home = join(tmpdir(), 'hermes-home')
  const local = join(tmpdir(), 'hermes-local')
  platformEnv(t, 'win32', join(tmpdir(), 'ambient-local'))
  assert.deepEqual(defaultRoots({ home, env: { LOCALAPPDATA: local } }).hermes, [
    join(local, 'hermes'), join(home, '.hermes'),
  ])
})

for (const localAppData of [undefined, '']) {
  test(`Hermes Windows default roots fall back to AppData/Local when LOCALAPPDATA is ${localAppData === undefined ? 'missing' : 'empty'}`, (t) => {
    const home = join(tmpdir(), 'hermes-home')
    platformEnv(t, 'win32', join(tmpdir(), 'ambient-local'))
    const env = localAppData === undefined ? {} : { LOCALAPPDATA: localAppData }
    assert.deepEqual(defaultRoots({ home, env }).hermes, [
      join(home, 'AppData', 'Local', 'hermes'), join(home, '.hermes'),
    ])
  })
}

for (const platform of ['linux', 'darwin']) {
  test(`Hermes ${platform} default roots use the home layout`, (t) => {
    const home = join(tmpdir(), 'hermes-home')
    platformEnv(t, platform, join(tmpdir(), 'hermes-local'))
    assert.equal(defaultRoots({ home }).hermes, join(home, '.hermes'))
  })
}

test('Hermes default discovery finds a real database in Windows LOCALAPPDATA', async (t) => {
  const home = temporaryHome(t)
  const local = join(home, 'custom-local')
  const dbPath = join(local, 'hermes', 'state.db')
  createDb(dbPath, 'local-session')
  platformEnv(t, 'win32', local)
  const emitted = []
  const result = await discoverSessions({
    home, format: 'hermes', host: hermesHost(), imports: {}, cache: new Map(),
    onEntry: (entry) => emitted.push(entry),
  })
  assert.equal(result.total, 1)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.sessions[0].sessionId, 'local-session')
  assert.equal(result.sessions[0].format, 'hermes')
  assert.equal(result.sessions[0].sourcePath, dbPath)
  assert.equal(result.sessions[0].title, 'Synthetic Hermes session')
  assert.deepEqual(emitted.map((s) => s.sessionId), ['local-session'])
})

test('Hermes Windows default discovery combines the local database and home JSONL fallback', async (t) => {
  const home = temporaryHome(t)
  const local = join(home, 'AppData', 'Local')
  createDb(join(local, 'hermes', 'state.db'), 'local-session')
  const jsonl = join(home, '.hermes', 'sessions', 'legacy.jsonl')
  mkdirSync(dirname(jsonl), { recursive: true })
  writeFileSync(jsonl, JSON.stringify({ role: 'user', content: 'Synthetic legacy prompt', ts: 1786000002 }) + '\n')
  platformEnv(t, 'win32', local)
  const host = hermesHost()
  const result = await discoverSessions({ home, format: 'hermes', host, imports: {}, cache: new Map() })
  assert.deepEqual(result.sessions.map((s) => s.sessionId).sort(), ['legacy', 'local-session'])
  const explicit = await discoverSessions({ path: join(local, 'hermes', 'state.db'), format: 'hermes', host, imports: {}, cache: new Map() })
  assert.deepEqual(explicit.sessions.map((s) => s.sessionId), ['local-session'])
})

test('Hermes Windows default discovery uses AppData/Local when the environment variable is absent', async (t) => {
  const home = temporaryHome(t)
  const dbPath = join(home, 'AppData', 'Local', 'hermes', 'state.db')
  createDb(dbPath, 'fallback-session')
  platformEnv(t, 'win32', undefined)
  const result = await discoverSessions({ home, format: 'hermes', host: hermesHost(), imports: {}, cache: new Map() })
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['fallback-session'])
})

test('Hermes Windows default discovery retains databases in the home layout', async (t) => {
  const home = temporaryHome(t)
  const dbPath = join(home, '.hermes', 'state.db')
  createDb(dbPath, 'home-session')
  platformEnv(t, 'win32', join(home, 'empty-local'))
  const result = await discoverSessions({ home, format: 'hermes', host: hermesHost(), imports: {}, cache: new Map() })
  assert.deepEqual(result.sessions.map((s) => s.sessionId), ['home-session'])
})
