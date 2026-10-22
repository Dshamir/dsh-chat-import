// lib/session-actions.mjs — per-row panel actions on discovered (not yet imported) sessions:
// hide / unhide, delete the source file, and resolving a sidebar workspace for drag-and-drop.
//
// Hide is a 'hidden' entry in the ignore table (lib/ignore.mjs): the panel list filters it and
// rescans / /import-all skip it, Undo removes the entry. Deleting the source is the only
// destructive action in the panel, so the route layer only offers it for paths the current
// scan discovered, never for one-file-many-sessions sources, and only with confirm:true; the
// file goes to the OS Recycle Bin (Windows) or a plugin-owned trash folder (elsewhere) — never
// an unlink.
import { execFile } from 'node:child_process'
import { mkdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { findIgnore, forgetIgnore, rememberIgnore, sourceIgnoreKey } from './ignore.mjs'

/** Ignore key of one discovered row (multi-session sources are keyed per session). */
export function rowIgnoreKey(entry, multiSession) {
  return multiSession && entry.sessionId ? sourceIgnoreKey(entry.sourcePath, 'sessions', entry.sessionId) : entry.sourcePath
}

/** True when the row was hidden by the user (other ignore reasons keep the row visible). */
export function isHiddenRow(ignores, entry, multiSession) {
  const hit = findIgnore(ignores, entry.sourcePath, 'sessions', multiSession ? entry.sessionId : undefined)
  return !!hit && hit.reason === 'hidden'
}

export async function hideRows(registryDir, rows) {
  for (const r of rows) {
    await rememberIgnore(registryDir, {
      key: r.key, reason: 'hidden',
      ...(r.subKey ? { subTable: 'sessions', subKey: r.subKey } : {}),
    })
  }
}

export async function unhideRows(registryDir, rows) {
  for (const r of rows) await forgetIgnore(registryDir, r.key)
}

/**
 * Files that make up one single-session source. Claude Code keeps sub-agent transcripts and
 * spilled tool results in a sibling folder named after the session id; it goes with the file.
 */
export async function sourceFilesOf(format, sourcePath) {
  const files = [sourcePath]
  if (format === 'claude' && extname(sourcePath).toLowerCase() === '.jsonl') {
    const sibling = join(dirname(sourcePath), basename(sourcePath, extname(sourcePath)))
    try {
      if ((await stat(sibling)).isDirectory()) files.push(sibling)
    } catch {
      // no sibling folder
    }
  }
  return files
}

function recycleWindows(paths) {
  // the paths travel in an environment variable, never in the script text (no quoting / injection)
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    "foreach ($p in ($env:DCI_RECYCLE -split \"`n\")) {",
    '  if (-not $p) { continue }',
    "  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    "  elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    '}',
  ].join('\n')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, DCI_RECYCLE: paths.join('\n') }, windowsHide: true, timeout: 60_000,
    }, (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()))
  })
}

async function moveToTrash(registryDir, paths) {
  const dir = join(registryDir, 'trash', String(Date.now()))
  await mkdir(dir, { recursive: true })
  for (const p of paths) await rename(p, join(dir, basename(p)))
  return dir
}

/**
 * Send one source's files to the Recycle Bin. Returns { ok, removed, where } or throws.
 * `recycle` is injectable for tests.
 */
export async function deleteSourceFiles(registryDir, format, sourcePath, { recycle, platform = process.platform } = {}) {
  const info = await stat(sourcePath)
  if (!info.isFile()) throw new Error('not a file: ' + sourcePath)
  const files = await sourceFilesOf(format, sourcePath)
  if (recycle) {
    await recycle(files)
    return { ok: true, removed: files, where: 'recycle-bin' }
  }
  if (platform === 'win32') {
    await recycleWindows(files)
    return { ok: true, removed: files, where: 'recycle-bin' }
  }
  return { ok: true, removed: files, where: await moveToTrash(registryDir, files) }
}

/** Sidebar workspace id → { id, path } from the host registry (null when unknown). */
export function resolveWorkspace(ctx, id) {
  const wr = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
  if (!wr || typeof wr.list !== 'function' || typeof id !== 'string' || !id) return null
  for (const ws of wr.list()) {
    if (ws && ws.id === id && typeof ws.path === 'string' && ws.path) return { id: ws.id, path: ws.path, name: ws.name || basename(ws.path) }
  }
  return null
}
