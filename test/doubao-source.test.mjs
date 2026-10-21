// test/doubao-source.test.mjs — 豆包来源的 host 面：库定位、摘要、导入编排与失败路径
//
// 库是 LevelDB **目录**（不是单文件），所以这里覆盖的是「目录形态目标」的解析：
// 用户数据根 / profile / IndexedDB 目录 / 具体库目录四种入口 + 默认根 + 缺库/坏库的报错口径。
// 库内容用合成的 LevelDB `.log` 拼（与 test/doubao-indexeddb.test.mjs 同一套字节构造思路），
// 不依赖本机装没装豆包。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOUBAO_CHAT_ORIGIN,
  DOUBAO_IDB_SUFFIX,
  doubaoFingerprint,
  doubaoIndexedDbDirs,
  doubaoUserDataDirs,
  findDoubaoDatabases,
  previewDoubaoDirectory,
  readDoubaoDb,
  readDoubaoSessionSummaries,
} from '../lib/sources/doubao.mjs'
import { doubaoSource } from '../lib/discovery/indexeddb.mjs'

// ── 合成库 ────────────────────────────────────────────────────────────────────

function varintBytes(value) {
  const out = []
  let n = value
  do {
    let byte = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) byte |= 0x80
    out.push(byte)
  } while (n > 0)
  return Buffer.from(out)
}

function v8OneByteString(text) {
  const body = Buffer.from(text, 'latin1')
  return Buffer.concat([Buffer.from([0x22, body.length]), body])
}

// 只够构造「一个扁平的 JS 对象」：{"k1":"v1","k2":"v2",…}
function v8FlatObject(pairs) {
  const parts = [Buffer.from([0x6f])]
  for (const [k, v] of pairs) {
    parts.push(v8OneByteString(k))
    parts.push(v8OneByteString(v))
  }
  parts.push(Buffer.from([0x7b, pairs.length * 2]))
  return Buffer.concat(parts)
}

function ssv(payload) {
  return Buffer.concat([Buffer.from([0xff, 0x15, 0xfe]), Buffer.alloc(12), payload])
}

function dataRecordKey(db, os, userKey) {
  const prefix = Buffer.from([0x00, db, os, 0x01])
  const body = Buffer.alloc(userKey.length * 2)
  for (let i = 0; i < userKey.length; i++) body.writeUInt16BE(userKey.charCodeAt(i), i * 2)
  return Buffer.concat([prefix, Buffer.from([1]), varintBytes(userKey.length), body])
}

function logFile(entries) {
  const parts = [Buffer.alloc(8), Buffer.alloc(4)]
  parts[1].writeUInt32LE(entries.length)
  for (const { key, value } of entries) {
    parts.push(Buffer.from([1]), varintBytes(key.length), key, varintBytes(value.length), value)
  }
  const batch = Buffer.concat(parts)
  const header = Buffer.alloc(7)
  header.writeUInt16LE(batch.length, 4)
  header[6] = 1
  return Buffer.concat([header, batch])
}

/** 写一个能读出「1 个会话 / 1 轮」的最小豆包库目录。 */
function writeFakeDoubaoDb(dir, { conversationId = 'conv-1', title = '示例会话' } = {}) {
  mkdirSync(dir, { recursive: true })
  // 会话列表记录（schema 前缀正确即可被识别）
  const listValue = ssv(v8FlatObject([
    ['schema', 'conversation-list-data-overall-v2'],
    ['conversation_id', conversationId],
    ['name', title],
  ]))
  // 协议存储：一层嵌套太深，这里只放一个能通过 decodeIdbValue 的对象；正文由读出的
  // sessions 断言兜底（详见转换器测试），本文件关心的是「定位与入口形态」。
  const protocolValue = ssv(v8FlatObject([['state', 'ok']]))
  writeFileSync(join(dir, '000001.log'), logFile([
    { key: dataRecordKey(3, 2, 'overall'), value: listValue },
    { key: dataRecordKey(1, 1, 'default-chat-im-protocol-store'), value: protocolValue },
  ]))
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doubao-src-'))
  // 回调可能是异步的：先等结果再清理，否则临时目录会在断言前被删掉
  const result = fn(dir)
  if (result && typeof result.then === 'function') {
    return result.finally(() => rmSync(dir, { recursive: true, force: true }))
  }
  rmSync(dir, { recursive: true, force: true })
  return result
}

/** findDoubaoDatabases 需要的 host（真实磁盘）。 */
function diskHost() {
  return {
    async stat(path) {
      try {
        const st = statSync(path)
        return { type: st.isDirectory() ? 'directory' : 'file' }
      } catch {
        return null
      }
    },
    async readDir(path) {
      try {
        const names = readdirSync(path, { withFileTypes: true })
        return names.map((d) => ({ name: d.name, type: d.isDirectory() ? 'directory' : 'file', path: join(path, d.name) }))
      } catch {
        return null
      }
    },
  }
}

// ── 路径规则 ──────────────────────────────────────────────────────────────────

test('doubaoUserDataDirs：Windows 用 %LOCALAPPDATA%\\Doubao\\User Data', () => {
  const dirs = doubaoUserDataDirs('C:/Users/tester', { LOCALAPPDATA: 'C:/Users/tester/AppData/Local' }, 'win32')
  assert.deepEqual(dirs, [join('C:/Users/tester/AppData/Local', 'Doubao', 'User Data')])
})

test('doubaoUserDataDirs：LOCALAPPDATA 缺席时回退 home 下的 AppData\\Local', () => {
  const dirs = doubaoUserDataDirs('C:/Users/tester', {}, 'win32')
  assert.deepEqual(dirs, [join('C:/Users/tester', 'AppData', 'Local', 'Doubao', 'User Data')])
})

test('doubaoUserDataDirs：macOS / Linux 走各自的应用数据目录', () => {
  assert.deepEqual(doubaoUserDataDirs('/Users/t', {}, 'darwin'), [join('/Users/t', 'Library', 'Application Support', 'Doubao')])
  assert.deepEqual(doubaoUserDataDirs('/home/t', {}, 'linux'), [join('/home/t', '.config', 'Doubao')])
})

test('doubaoIndexedDbDirs：默认只留 chat 库（正文只在它里面），前缀为空时全收', () => {
  const entries = [
    { name: 'chrome_doubao-launcher_0.indexeddb.leveldb', path: '/p/launcher' },
    { name: 'chrome_doubao-chat_0.indexeddb.leveldb', path: '/p/chat' },
    { name: 'OtherThing', path: '/p/other' },
  ]
  assert.deepEqual(doubaoIndexedDbDirs(entries), ['/p/chat'])
  assert.deepEqual(doubaoIndexedDbDirs(entries, ''), ['/p/chat', '/p/launcher'])
})

test('doubaoIndexedDbDirs：指定前缀时只留匹配项', () => {
  const entries = [
    { name: 'chrome_doubao-chat_0.indexeddb.leveldb', path: '/p/chat' },
    { name: 'chrome_doubao-background_0.indexeddb.leveldb', path: '/p/bg' },
  ]
  assert.deepEqual(doubaoIndexedDbDirs(entries, DOUBAO_CHAT_ORIGIN), ['/p/chat'])
  assert.deepEqual(doubaoIndexedDbDirs(entries, ''), ['/p/chat', '/p/bg'])
})

// ── 库定位（四种入口形态）──────────────────────────────────────────────────────

test('findDoubaoDatabases：直接给库目录时返回它自己', () =>
  withTempDir((root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    return findDoubaoDatabases(diskHost(), dbDir).then((got) => {
      assert.deepEqual(got, [dbDir])
    })
  }))

test('findDoubaoDatabases：给 IndexedDB 目录时枚举其中的库', () =>
  withTempDir((root) => {
    const idbDir = join(root, 'Default', 'IndexedDB')
    writeFakeDoubaoDb(join(idbDir, `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`))
    writeFakeDoubaoDb(join(idbDir, `chrome_doubao-background_0${DOUBAO_IDB_SUFFIX}`))
    return findDoubaoDatabases(diskHost(), idbDir).then((got) => {
      assert.equal(got.length, 1)
      assert.ok(got[0].includes('chrome_doubao-chat'))
    })
  }))

test('findDoubaoDatabases：给 profile 目录时向下找到 IndexedDB 库', () =>
  withTempDir((root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    return findDoubaoDatabases(diskHost(), join(root, 'Default')).then((got) => {
      assert.deepEqual(got, [dbDir])
    })
  }))

test('findDoubaoDatabases：给用户数据根时递归找到 profile 下的库', () =>
  withTempDir((root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    return findDoubaoDatabases(diskHost(), root).then((got) => {
      assert.deepEqual(got, [dbDir])
    })
  }))

test('findDoubaoDatabases：目录不存在 / 是文件时返回空', () =>
  withTempDir((root) => {
    writeFileSync(join(root, 'a.txt'), 'x')
    return Promise.all([
      findDoubaoDatabases(diskHost(), join(root, 'missing')),
      findDoubaoDatabases(diskHost(), join(root, 'a.txt')),
    ]).then(([missing, file]) => {
      assert.deepEqual(missing, [])
      assert.deepEqual(file, [])
    })
  }))

test('findDoubaoDatabases：空的 IndexedDB 目录（没有 LevelDB 文件）不算库', () =>
  withTempDir((root) => {
    const empty = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    mkdirSync(empty, { recursive: true })
    return findDoubaoDatabases(diskHost(), join(root, 'Default')).then((got) => {
      assert.deepEqual(got, [])
    })
  }))

// ── 读取 ─────────────────────────────────────────────────────────────────────

test('readDoubaoDb：不是豆包库（无记录）返回 null', () =>
  withTempDir((root) => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(readDoubaoDb(empty), null)
  }))

test('readDoubaoSessionSummaries：与读库同源，非库返回 null', () =>
  withTempDir((root) => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    assert.equal(readDoubaoSessionSummaries(empty), null)
  }))

test('doubaoFingerprint：随 LevelDB 文件变化而变化（不是恒定的目录签名）', () =>
  withTempDir((dir) => {
    const entries = [{ key: Buffer.from('a'), value: Buffer.from('1') }]
    writeFileSync(join(dir, '000001.log'), logFile(entries))
    const before = doubaoFingerprint(dir)
    writeFileSync(join(dir, '000001.log'), logFile([...entries, { key: Buffer.from('b'), value: Buffer.from('2') }]))
    const after = doubaoFingerprint(dir)
    assert.notEqual(before, after)
    assert.match(before, /^000001\.log:\d+:/)
  }))

test('previewDoubaoDirectory：没有可导入会话时大声失败并点名路径', () =>
  withTempDir((root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    // 合成库只有元数据、没有正文回合 → 预览必须抛带路径的错，不能安静返回 0 条
    const ctx = { fs: { processPath: (t) => t } }
    return assert.rejects(
      () => previewDoubaoDirectory(ctx, { displayPath: dbDir }, {}),
      (err) => {
        assert.match(err.message, /没有可导入的会话正文/)
        assert.ok(err.message.includes(dbDir))
        return true
      },
    )
  }))

// ── 发现层描述符 ──────────────────────────────────────────────────────────────

test('doubaoSource：描述符字段齐全（format / roots / scan / sessionsFromHost）', () => {
  assert.equal(doubaoSource.format, 'doubao')
  assert.equal(doubaoSource.sessionsFromHost, true)
  assert.equal(typeof doubaoSource.scan, 'function')
  assert.equal(typeof doubaoSource.roots, 'function')
  const roots = doubaoSource.roots('C:/Users/tester', { LOCALAPPDATA: 'C:/Users/tester/AppData/Local' })
  assert.deepEqual(roots, [join('C:/Users/tester/AppData/Local', 'Doubao', 'User Data')])
})

test('doubaoSource：不给 matchFile（库是目录，单文件形态不存在）', () => {
  assert.equal(doubaoSource.matchFile, undefined)
  assert.equal(doubaoSource.fileFallback, undefined)
})

test('doubaoSource.scan：目标不是豆包库目录时返回空（自拒，不抛）', async () => {
  await withTempDir(async (root) => {
    const empty = join(root, 'nothing')
    mkdirSync(empty, { recursive: true })
    const host = diskHost()
    host.readSessions = async () => null
    const got = await doubaoSource.scan(host, empty, { bm: null, emit: null })
    assert.deepEqual(got, [])
  })
})

// ── 发现层扫描器（scanDoubao 的四种入口 + 摘要拼装 + 流式产出）────────────────────

/** 扫描器需要的 host 形状（stat / readDir / readSessions）。 */
function scanHost({ sessions = null, dirs = null } = {}) {
  const base = diskHost()
  const host = {
    stat: base.stat,
    readDir: base.readDir,
    async readSessions() {
      return sessions
    },
  }
  if (dirs) host.readDir = dirs
  return host
}

test('doubaoSource.scan：直接给库目录 → 经 readSessions 产出条目并流入 emit', async () => {
  await withTempDir(async (root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    const emitted = []
    const host = scanHost({
      sessions: [{ id: 'conv-1', title: '标题', createdAt: 1000, lastActiveAt: 2000 }],
    })
    const got = await doubaoSource.scan(host, dbDir, { bm: null, emit: async (e) => emitted.push(e) })
    assert.equal(got.length, 1)
    assert.equal(got[0].format, 'doubao')
    assert.equal(got[0].sessionId, 'conv-1')
    assert.equal(got[0].title, '标题')
    assert.equal(got[0].sourcePath, dbDir)
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].sessionId, 'conv-1')
  })
})

test('doubaoSource.scan：给用户数据根 → 向下找到库并产出条目', async () => {
  await withTempDir(async (root) => {
    writeFakeDoubaoDb(join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`))
    const host = scanHost({ sessions: [{ id: 'c1', title: 't', createdAt: 1, lastActiveAt: 2 }] })
    const got = await doubaoSource.scan(host, root, { bm: null, emit: null })
    assert.equal(got.length, 1)
    assert.equal(got[0].sessionId, 'c1')
  })
})

test('doubaoSource.scan：readSessions 返回 null（不是这个库）时不产出条目', async () => {
  await withTempDir(async (root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    const s = doubaoSource.scan(scanHost({ sessions: null }), dbDir, { bm: null, emit: null })
    assert.deepEqual(await s, [])
  })
})

test('doubaoSource.scan：readDir 全失败时静默返回空（缺库 ≠ 扫描失败）', async () => {
  await withTempDir(async (root) => {
    const host = scanHost({ dirs: async () => null })
    const got = await doubaoSource.scan(host, root, { bm: null, emit: null })
    assert.deepEqual(got, [])
  })
})

test('doubaoSource.scan：书签命中时走缓存路径（probeSource 的 bm 分支）', async () => {
  await withTempDir(async (root) => {
    const dbDir = join(root, 'Default', 'IndexedDB', `chrome_doubao-chat_0${DOUBAO_IDB_SUFFIX}`)
    writeFakeDoubaoDb(dbDir)
    let probed = 0
    const bm = {
      async get() {
        return [{ format: 'doubao', sessionId: 'cached', title: '缓存', sourcePath: dbDir }]
      },
      async remember() {},
    }
    const host = scanHost({
      sessions: [{ id: 'live', title: '实读', createdAt: 1, lastActiveAt: 2 }],
    })
    const got = await doubaoSource.scan(host, dbDir, { bm, emit: null })
    probed++
    assert.equal(probed, 1)
    assert.equal(got.length, 1)
    assert.equal(got[0].sessionId, 'cached')
  })
})

test('doubaoSource.scan：目标为文件时返回空（库是目录）', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'x')
    const got = await doubaoSource.scan(scanHost({}), file, { bm: null, emit: null })
    assert.deepEqual(got, [])
  })
})
